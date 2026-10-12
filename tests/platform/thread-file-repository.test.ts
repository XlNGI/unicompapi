import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as filesystem from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});
import {
  createItemV1,
  createTurnV1,
  toMessageItemId,
  toProjectId,
  toThreadId,
  toTurnId,
  toIsoTimestamp,
  type ItemV1,
  type TurnV1
} from '../../src/domain';
import { ThreadFileRepository, type ThreadFaultPoint } from '../../src/platform/repositories/thread-file-repository';

const roots: string[] = [];
const threadId = toThreadId('thread-repository-test');
const projectId = toProjectId('project-repository-test');
const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-08T00:00:01.000Z');

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(fault?: (point: ThreadFaultPoint) => void | Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-repository-'));
  roots.push(root);
  const repository = new ThreadFileRepository(root, { fault, idFactory: (() => { let i = 0; return () => `id-${++i}`; })() });
  await repository.createThread({ threadId, projectId, title: 'Repository test', createdAt: t0 });
  return { root, repository };
}

function records(sequence: number): { readonly turn: TurnV1; readonly item: ItemV1 } {
  const turnId = toTurnId(`turn-test-${sequence}`);
  const item = createItemV1({ itemId: toMessageItemId(`message-${sequence}`), threadId, turnId, sequence, type: 'user_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: `message-${sequence}` as never, messageRevision: 0 }, content: `request ${sequence}` });
  const turn = createTurnV1({ turnId, threadId, turnSequence: sequence, createdAt: t0, userItemId: item.itemId, provenance: 'native' });
  return { turn, item };
}

describe('ThreadFileRepository commit and recovery protocol', () => {
  it('reads only the committed UTF-8 prefix while another instance has appended uncommitted Chinese records', async () => {
    const { root, repository } = await setup();
    const first = records(1), second = records(2);
    const firstItem = { ...first.item, content: '已提交中文事实 🧪'.repeat(80) };
    await repository.append({ threadId, idempotencyKey: 'utf8-first', occurredAt: t1, turns: [first.turn], items: [firstItem] });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writer = new ThreadFileRepository(root, { fault: async point => {
      if (point === 'after_segment_append') { entered(); await gate; }
    } });
    const pending = writer.append({ threadId, idempotencyKey: 'utf8-second', occurredAt: t1,
      turns: [second.turn], items: [{ ...second.item, content: '尚未提交的中文内容' }] });
    try {
      await ready;
      const reader = new ThreadFileRepository(root);
      expect((await reader.readItems(threadId)).map(item => item.content)).toEqual([firstItem.content]);
      expect((await reader.readTurns(threadId)).map(turn => turn.turnId)).toEqual([first.turn.turnId]);
    } finally { release(); await pending; }
    expect((await repository.readItems(threadId)).map(item => item.content)).toEqual([firstItem.content, '尚未提交的中文内容']);
    expect((await new ThreadFileRepository(root).recover(threadId)).status).toBe('ready');
  });

  it('coordinates manifest replacement with readers across repository instances without retrying a commit', async () => {
    const { root, repository } = await setup();
    const first = records(1), second = records(2);
    await repository.append({ threadId, idempotencyKey: 'reader-before', occurredAt: t1, turns: [first.turn], items: [first.item] });
    const target = path.join(root, 'entities/threads', String(threadId), 'manifest.v1.json');
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    const read = actual.readFile, replace = actual.rename;
    let held = false, holdReader = false, entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(filesystem, 'readFile').mockImplementation((async (...args: Parameters<typeof read>) => {
      if (holdReader && String(args[0]) === target && !held) {
        held = true; entered(); await gate;
        try { return await read(...args); } finally { held = false; }
      }
      return read(...args);
    }) as typeof read);
    const rename = vi.spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === target && held) throw Object.assign(new Error('synthetic Windows sharing violation'), { code: 'EPERM' });
      return replace(source, destination);
    });
    let writerReady!: () => void, resumeWriter!: () => void;
    const beforeReplace = new Promise<void>(resolve => { writerReady = resolve; });
    const writerGate = new Promise<void>(resolve => { resumeWriter = resolve; });
    const blockedWriter = new ThreadFileRepository(root, { fault: async point => {
      if (point === 'before_manifest_update') { writerReady(); await writerGate; }
    } });
    const writer = blockedWriter.append({ threadId, idempotencyKey: 'reader-after', occurredAt: t1, turns: [second.turn], items: [second.item] });
    void writer.catch(() => undefined);
    await beforeReplace;
    holdReader = true;
    const reader = new ThreadFileRepository(root).getManifest(threadId);
    await ready;
    try {
      resumeWriter();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(rename.mock.calls.filter(([, destination]) => String(destination) === target)).toHaveLength(0);
    } finally { release(); }
    await Promise.all([reader, writer]);
    expect(rename.mock.calls.filter(([, destination]) => String(destination) === target)).toHaveLength(1);
    expect((await repository.getManifest(threadId)).committedSequence).toBe(2);
  });

  it('writes Thread metadata, JSONL segments and one durable Commit boundary', async () => {
    const { root, repository } = await setup();
    const { turn, item } = records(1);
    const result = await repository.append({ threadId, idempotencyKey: 'command-1', occurredAt: t1, turns: [turn], items: [item] });
    expect(result.alreadyCommitted).toBe(false);
    expect(result.commit.commitSequence).toBe(1);
    expect((await repository.readItems(threadId)).map(value => value.itemId.value)).toEqual(['message-1']);
    expect((await repository.readTurns(threadId)).map(value => value.turnId)).toEqual([turn.turnId]);
    const manifest = await repository.getManifest(threadId);
    expect(manifest.committedSequence).toBe(1);
    expect(manifest.lastCommitHash).toBe(result.commit.commitHash);
    expect(await readFile(path.join(root, 'entities', 'threads', String(threadId), 'manifest.v1.json'), 'utf8')).toContain('committedSequence');
  });

  it('commits a projection Outbox atomically and acknowledges it idempotently', async () => {
    const { repository } = await setup();
    const { turn, item } = records(1);
    const event = {
      schemaVersion: 1 as const,
      eventId: 'projection-event-1',
      threadId,
      eventType: 'item_upsert' as const,
      sequence: item.sequence,
      idempotencyKey: 'legacy-item:message-1',
      item,
      occurredAt: t1
    };
    await repository.append({ threadId, idempotencyKey: 'with-outbox', occurredAt: t1, turns: [turn], items: [item], projectionOutbox: [event] });
    expect(await repository.readProjectionOutbox(threadId)).toEqual([event]);
    await repository.acknowledgeProjection({ schemaVersion: 1, eventId: event.eventId, threadId, idempotencyKey: event.idempotencyKey, projectedAt: t1 });
    await repository.acknowledgeProjection({ schemaVersion: 1, eventId: event.eventId, threadId, idempotencyKey: event.idempotencyKey, projectedAt: t1 });
    expect((await repository.readProjectionReceipts(threadId)).map(item => item.eventId)).toEqual([event.eventId]);
  });

  it('returns one latest Turn after execution-link updates', async () => {
    const { repository } = await setup();
    const { turn, item } = records(1);
    await repository.append({ threadId, idempotencyKey: 'turn-initial', occurredAt: t1, turns: [turn], items: [item] });
    const updated = { ...turn, executionLinkRevision: 1 };
    await repository.append({ threadId, idempotencyKey: 'turn-update', occurredAt: t1, turns: [updated] });
    const turns = await repository.readTurns(threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.executionLinkRevision).toBe(1);
  });

  it('deduplicates the same idempotency key and rejects changed payloads', async () => {
    const { repository } = await setup();
    const { turn, item } = records(1);
    const input = { threadId, idempotencyKey: 'command-dup', occurredAt: t1, turns: [turn], items: [item] } as const;
    const first = await repository.append(input);
    const second = await repository.append(input);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.commit.commitHash).toBe(first.commit.commitHash);
    const changed = records(2);
    await expect(repository.append({ ...input, turns: [changed.turn], items: [changed.item] })).rejects.toThrow('idempotency_conflict');
    expect((await repository.readItems(threadId)).length).toBe(1);
  });

  it('builds a committed Item offset index and reads selected sequences without full JSON projection', async () => {
    const { root, repository } = await setup();
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      const { turn, item } = records(sequence);
      await repository.append({ threadId, idempotencyKey: `indexed-${sequence}`, occurredAt: t1, turns: [turn], items: [item] });
    }
    expect(await repository.listItemSequences(threadId, 10)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    const selected = await repository.readItemsBySequences(threadId, [2, 10, 20]);
    expect(selected.map(item => item.sequence)).toEqual([2, 10, 20]);
    expect(await readFile(path.join(root, 'entities', 'threads', String(threadId), 'item-index.v1.json'), 'utf8')).toContain('checksum');
  });

  it('rolls forward a durable Commit when Manifest update fails', async () => {
    let enabled = true;
    const first = await setup(point => { if (enabled && point === 'before_manifest_update') throw new Error('manifest_write_failed'); });
    const { turn, item } = records(1);
    await expect(first.repository.append({ threadId, idempotencyKey: 'manifest-failure', occurredAt: t1, turns: [turn], items: [item] })).rejects.toThrow('manifest_write_failed');
    enabled = false;
    const recovered = await new ThreadFileRepository(first.root, { idFactory: () => 'recovery-id' }).recover(threadId);
    expect(recovered.status).toBe('ready');
    expect(recovered.rolledForward).toBe(1);
    expect((await new ThreadFileRepository(first.root).readItems(threadId)).length).toBe(1);
  });

  it('rolls forward when the process exits immediately after Commit fsync', async () => {
    const first = await setup(point => { if (point === 'after_commit_sync') throw new Error('process_exit_after_commit'); });
    const { turn, item } = records(1);
    await expect(first.repository.append({ threadId, idempotencyKey: 'after-commit-fsync', occurredAt: t1, turns: [turn], items: [item] })).rejects.toThrow('process_exit_after_commit');
    const recovered = await new ThreadFileRepository(first.root).recover(threadId);
    expect(recovered.status).toBe('ready');
    expect(recovered.rolledForward).toBe(1);
    expect((await new ThreadFileRepository(first.root).readItems(threadId)).length).toBe(1);
  });

  it('quarantines segment writes that stop before the Commit record', async () => {
    const first = await setup(point => { if (point === 'before_commit_append') throw new Error('process_exit'); });
    const { turn, item } = records(1);
    await expect(first.repository.append({ threadId, idempotencyKey: 'segment-only', occurredAt: t1, turns: [turn], items: [item] })).rejects.toThrow('process_exit');
    const recovered = await new ThreadFileRepository(first.root).recover(threadId);
    expect(recovered.status).toBe('ready');
    expect(recovered.reports.some(report => report.code === 'orphan_segment' || report.code === 'torn_tail')).toBe(true);
    expect((await new ThreadFileRepository(first.root).readItems(threadId)).length).toBe(0);
  });

  it('marks non-tail checksum damage as degraded read-only', async () => {
    const { root, repository } = await setup();
    const { turn, item } = records(1);
    await repository.append({ threadId, idempotencyKey: 'corrupt-me', occurredAt: t1, turns: [turn], items: [item] });
    const manifest = await repository.getManifest(threadId);
    const segment = manifest.segments.find(value => value.recordKind === 'item')!;
    const file = path.join(root, 'entities', 'threads', String(threadId), 'segments', segment.segmentId);
    const bytes = Buffer.from(await readFile(file));
    bytes[Math.max(0, bytes.indexOf(0x22))] = 0x21;
    await (await import('node:fs/promises')).writeFile(file, bytes);
    const recovered = await new ThreadFileRepository(root).recover(threadId);
    expect(recovered.status).toBe('degraded_read_only');
    expect(recovered.reports.some(report => report.code === 'segment_checksum_mismatch' || report.code === 'non_tail_corruption')).toBe(true);
  });

  it('quarantines a JSONL half-record at the segment tail', async () => {
    const { root, repository } = await setup();
    const { turn, item } = records(1);
    await repository.append({ threadId, idempotencyKey: 'tail-source', occurredAt: t1, turns: [turn], items: [item] });
    const manifest = await repository.getManifest(threadId);
    const segment = manifest.segments.find(value => value.recordKind === 'item')!;
    const file = path.join(root, 'entities', 'threads', String(threadId), 'segments', segment.segmentId);
    await (await import('node:fs/promises')).appendFile(file, '{"schemaVersion":1,"partial');
    const recovered = await new ThreadFileRepository(root).recover(threadId);
    expect(recovered.status).toBe('ready');
    expect(recovered.reports.some(report => report.code === 'torn_tail')).toBe(true);
    expect((await new ThreadFileRepository(root).readItems(threadId)).length).toBe(1);
  });

  it('rebuilds a deleted summary index and serializes same-Thread writes', async () => {
    const { root, repository } = await setup();
    const first = records(1), second = records(2);
    await Promise.all([
      repository.append({ threadId, idempotencyKey: 'parallel-1', occurredAt: t1, turns: [first.turn], items: [first.item] }),
      repository.append({ threadId, idempotencyKey: 'parallel-2', occurredAt: t1, turns: [second.turn], items: [second.item] })
    ]);
    await unlink(path.join(root, 'entities', 'threads', 'index.v1.json'));
    await repository.rebuildSummaryIndex();
    expect((await repository.listThreadSummaries()).map(item => item.threadId)).toEqual([threadId]);
    expect((await repository.readItems(threadId)).map(item => item.sequence)).toEqual([1, 2]);
  });

  it('reports a corrupted Snapshot but keeps Segment/Commit data authoritative', async () => {
    const { root, repository } = await setup();
    const { turn, item } = records(1);
    await repository.append({ threadId, idempotencyKey: 'snapshot-source', occurredAt: t1, turns: [turn], items: [item] });
    const snapshot = await repository.createSnapshot(threadId);
    const file = path.join(root, 'entities', 'threads', String(threadId), 'snapshots', `${snapshot.snapshotId}.json`);
    await (await import('node:fs/promises')).writeFile(file, '{"broken":true}\n', 'utf8');
    const recovered = await new ThreadFileRepository(root).recover(threadId);
    expect(recovered.status).toBe('ready');
    expect(recovered.reports.some(report => report.code === 'snapshot_checksum_mismatch')).toBe(true);
    expect((await new ThreadFileRepository(root).readItems(threadId)).length).toBe(1);
  });

  it('rotates JSONL segments after the configured byte threshold', async () => {
    const { root } = await setup();
    const repository = new ThreadFileRepository(root, { rotationBytes: 1024 });
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      const { turn, item } = records(sequence);
      await repository.append({ threadId, idempotencyKey: `rotation-${sequence}`, occurredAt: t1, turns: [turn], items: [item] });
    }
    const manifest = await repository.getManifest(threadId);
    expect(manifest.segments.filter(segment => segment.recordKind === 'item').length).toBeGreaterThan(1);
    expect((await repository.readItems(threadId)).length).toBe(6);
  });
});
