import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
