import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createThreadV1,
  parseItemV1,
  parseThreadV1,
  parseTurnExecutionLinkV1,
  parseTurnV1,
  sha256Hex,
  type ItemV1,
  type ProjectId,
  type ThreadId,
  type ThreadV1,
  type TurnExecutionLinkV1,
  type TurnV1
} from '../../domain';
import { sharedFileWriteCoordinator } from '../storage/file-write-coordinator';

export type ThreadSegmentKind = 'turn' | 'item' | 'turn_execution_link';

export interface SegmentRecordV1<T = unknown> {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly sequence: number;
  readonly transactionId: string;
  readonly recordId: string;
  readonly recordKind: ThreadSegmentKind;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly previousRecordHash: string;
  readonly payload: T;
  readonly payloadHash: string;
  readonly recordHash: string;
}

export interface CommitParticipantV1 {
  readonly segmentId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly recordIds: readonly string[];
  readonly checksum: string;
}

export interface CommitRecordV1 {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly transactionId: string;
  readonly commitSequence: number;
  readonly previousCommitHash: string;
  readonly participants: readonly CommitParticipantV1[];
  readonly metadataDeltaHash: string;
  readonly commitHash: string;
}

export interface ThreadManifestV1 {
  readonly schemaVersion: 1;
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly committedSequence: number;
  readonly committedItemSequence: number;
  readonly committedTurnSequence: number;
  readonly lastCommitHash: string;
  readonly segments: readonly {
    readonly segmentId: string;
    readonly recordKind: ThreadSegmentKind;
    readonly committedBytes: number;
    readonly lastSequence: number;
    readonly checksum: string;
  }[];
  readonly snapshot?: { readonly snapshotId: string; readonly sequence: number; readonly checksum: string; readonly sourceCommitHash: string };
  readonly revision: number;
}

export interface ThreadSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly sequence: number;
  readonly sourceCommitHash: string;
  readonly thread: ThreadV1;
  readonly turns: readonly TurnV1[];
  readonly items: readonly ItemV1[];
  readonly executionLinks: readonly TurnExecutionLinkV1[];
  readonly checksum: string;
}

export interface ProjectionDebtV1 {
  readonly schemaVersion: 1;
  readonly threadId: ThreadId;
  readonly commitSequence: number;
  readonly projection: 'metadata' | 'summary_index' | 'snapshot';
  readonly error: string;
  readonly recordedAt: string;
}

export interface ThreadAppendInput {
  readonly threadId: ThreadId;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly expectedGeneration?: number;
  readonly thread?: Partial<Pick<ThreadV1, 'title' | 'status' | 'lastItemId' | 'lastItemSequence' | 'itemCount' | 'turnCount' | 'generation'>>;
  readonly turns?: readonly TurnV1[];
  readonly items?: readonly ItemV1[];
  readonly executionLinks?: readonly TurnExecutionLinkV1[];
}

export interface ThreadCommitResult {
  readonly transactionId: string;
  readonly commit: CommitRecordV1;
  readonly thread: ThreadV1;
  readonly alreadyCommitted: boolean;
  readonly projectionDebt: readonly ProjectionDebtV1[];
}

export interface ThreadFileRepositoryOptions {
  readonly rotationBytes?: number;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly fault?: (point: ThreadFaultPoint) => void | Promise<void>;
}

export type ThreadFaultPoint =
  | 'after_segment_append'
  | 'before_commit_append'
  | 'after_commit_sync'
  | 'before_manifest_update'
  | 'after_manifest_update'
  | 'before_projection_update'
  | 'snapshot_before_write'
  | 'snapshot_after_write';

const emptyHash = '0'.repeat(64);
const defaultRotationBytes = 4 * 1024 * 1024;

/**
 * Authoritative Thread file repository. It is intentionally independent from
 * the legacy Conversation repositories; callers must opt into it explicitly.
 */
export class ThreadFileRepository {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly rotationBytes: number;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly fault?: ThreadFileRepositoryOptions['fault'];

  constructor(readonly rootDirectory: string, options: ThreadFileRepositoryOptions = {}) {
    if (!path.isAbsolute(rootDirectory)) throw new TypeError('Thread repository root must be absolute');
    this.rotationBytes = options.rotationBytes ?? defaultRotationBytes;
    if (!Number.isSafeInteger(this.rotationBytes) || this.rotationBytes < 1024) throw new TypeError('rotationBytes is invalid');
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => cryptoRandomId());
    this.fault = options.fault;
  }

  async initialize(): Promise<void> {
    await mkdir(this.threadsRoot(), { recursive: true });
    if (!(await exists(this.indexPath()))) await atomicWrite(this.indexPath(), { schemaVersion: 1, revision: 0, items: [] });
  }

  async createThread(input: { readonly threadId: ThreadId; readonly projectId: ProjectId | null; readonly title: string; readonly createdAt: string }): Promise<ThreadV1> {
    await this.initialize();
    return this.exclusive(input.threadId, async () => {
      const existing = await this.readThreadMetadata(input.threadId);
      if (existing) throw new Error('thread_already_exists');
      const thread = createThreadV1(input as Parameters<typeof createThreadV1>[0]);
      await this.prepareThreadDirectory(thread.threadId);
      await atomicWrite(this.threadMetadataPath(thread.threadId), thread);
      await atomicWrite(this.manifestPath(thread.threadId), emptyManifest(thread.threadId));
      await this.rebuildSummaryIndex();
      return thread;
    });
  }

  async getThread(threadId: ThreadId): Promise<ThreadV1 | undefined> {
    await this.initialize();
    return this.readThreadMetadata(threadId);
  }

  async getManifest(threadId: ThreadId): Promise<ThreadManifestV1> {
    const manifest = await readJson<ThreadManifestV1>(this.manifestPath(threadId));
    if (!manifest) throw new Error('thread_manifest_missing');
    return validateManifest(manifest, threadId);
  }

  async append(input: ThreadAppendInput): Promise<ThreadCommitResult> {
    await this.initialize();
    return this.exclusive(input.threadId, () => this.appendUnlocked(input));
  }

  async readItems(threadId: ThreadId, readAtSequence?: number): Promise<readonly ItemV1[]> {
    const manifest = await this.getManifest(threadId);
    const records = await this.readCommittedRecords<ItemV1>(threadId, manifest, 'item');
    return records.filter(record => readAtSequence === undefined || record.sequence <= readAtSequence).map(record => parseItemV1(record.payload));
  }

  async readTurns(threadId: ThreadId): Promise<readonly TurnV1[]> {
    const manifest = await this.getManifest(threadId);
    const records = await this.readCommittedRecords<TurnV1>(threadId, manifest, 'turn');
    return records.map(record => parseTurnV1(record.payload));
  }

  async readExecutionLinks(threadId: ThreadId): Promise<readonly TurnExecutionLinkV1[]> {
    const manifest = await this.getManifest(threadId);
    const records = await this.readCommittedRecords<TurnExecutionLinkV1>(threadId, manifest, 'turn_execution_link');
    return records.map(record => parseTurnExecutionLinkV1(record.payload));
  }

  async createSnapshot(threadId: ThreadId): Promise<ThreadSnapshotV1> {
    return this.exclusive(threadId, async () => {
      const manifest = await this.getManifest(threadId);
      const thread = await this.requireThread(threadId);
      const turns = await this.readTurns(threadId);
      const items = await this.readItems(threadId);
      const executionLinks = await this.readExecutionLinks(threadId);
      const snapshotId = `snapshot-${this.idFactory()}`;
      const body = { schemaVersion: 1 as const, snapshotId, threadId, generation: manifest.generation, sequence: manifest.committedSequence, sourceCommitHash: manifest.lastCommitHash, thread, turns, items, executionLinks };
      const snapshot: ThreadSnapshotV1 = { ...body, checksum: sha256Hex(canonicalJson(body)) };
      await this.faultAt('snapshot_before_write');
      await atomicWrite(this.snapshotPath(threadId, snapshotId), snapshot);
      await this.faultAt('snapshot_after_write');
      const nextManifest = { ...manifest, snapshot: { snapshotId, sequence: snapshot.sequence, checksum: snapshot.checksum, sourceCommitHash: snapshot.sourceCommitHash }, revision: manifest.revision + 1 };
      await atomicWrite(this.manifestPath(threadId), nextManifest);
      return snapshot;
    });
  }

  async recover(threadId: ThreadId): Promise<ThreadRecoveryResult> {
    return this.exclusive(threadId, () => this.recoverUnlocked(threadId));
  }

  async rebuildSummaryIndex(): Promise<void> {
    await this.initialize();
    const entries = [] as ThreadV1[];
    for (const name of await directoryNames(this.threadsRoot())) {
      if (name === 'index.v1.json') continue;
      const metadata = await readJson<ThreadV1>(path.join(this.threadsRoot(), name, 'thread.v1.json'));
      if (metadata) entries.push(parseThreadV1(metadata));
    }
    entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.threadId.localeCompare(right.threadId));
    await atomicWrite(this.indexPath(), { schemaVersion: 1, revision: Date.now(), items: entries.map(toSummary) });
  }

  async listThreadSummaries(): Promise<readonly ThreadSummaryProjection[]> {
    const index = await readJson<{ readonly items?: readonly ThreadSummaryProjection[] }>(this.indexPath());
    return index?.items ?? [];
  }

  private async appendUnlocked(input: ThreadAppendInput): Promise<ThreadCommitResult> {
    const thread = await this.requireThread(input.threadId);
    const manifest = await this.getManifest(input.threadId);
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== manifest.generation) throw new Error('generation_conflict');
    const existing = await this.findIdempotency(input.threadId, manifest, input);
    if (existing) {
      const metadata = await this.requireThread(input.threadId);
      if (existing.metadataDeltaHash !== commandHash(input)) throw new Error('idempotency_conflict');
      return { transactionId: existing.transactionId, commit: existing, thread: metadata, alreadyCommitted: true, projectionDebt: [] };
    }
    const transactionId = `tx-${this.idFactory()}`;
    const nextGeneration = manifest.generation + 1;
    const entries: readonly PendingRecord[] = [
      ...input.turns?.map(payload => ({ kind: 'turn' as const, payload, sequence: payload.turnSequence })) ?? [],
      ...input.items?.map(payload => ({ kind: 'item' as const, payload, sequence: payload.sequence })) ?? [],
      ...input.executionLinks?.map(payload => ({ kind: 'turn_execution_link' as const, payload, sequence: payload.linkSequence })) ?? []
    ];
    const participants = new Map<string, CommitParticipantDraft>();
    const previousHashes = new Map<string, string>();
    let recordIndex = 0;
    for (const entry of entries) {
      const segment = await this.segmentFor(input.threadId, entry.kind, nextGeneration, manifest);
      const previousHash = previousHashes.get(segment.segmentId) ?? await previousRecordHash(segment.path, segment.committedBytes);
      const recordId = `record-${transactionId}-${recordIndex++}`;
      const record = makeSegmentRecord({ generation: nextGeneration, sequence: entry.sequence, transactionId, recordId, recordKind: entry.kind, idempotencyKey: input.idempotencyKey, occurredAt: input.occurredAt, previousRecordHash: previousHash, payload: entry.payload });
      const bytes = Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
      const startOffset = (await safeStatSize(segment.path));
      await appendBytes(segment.path, bytes, false);
      const endOffset = startOffset + bytes.length;
      const key = segment.segmentId;
      const participant: CommitParticipantDraft = participants.get(key) ?? { segmentId: key, startOffset, endOffset, recordIds: [], checksum: emptyHash, recordKind: entry.kind, path: segment.path };
      participant.endOffset = endOffset;
      participant.recordIds.push(recordId);
      previousHashes.set(segment.segmentId, record.recordHash);
      participants.set(key, participant);
    }
    await this.faultAt('after_segment_append');
    for (const participant of participants.values()) participant.checksum = await checksumRange(participant.path, participant.startOffset, participant.endOffset);
    await syncFiles([...participants.values()].map(participant => participant.path));
    await this.faultAt('before_commit_append');
    const commit = makeCommit({ generation: nextGeneration, transactionId, commitSequence: manifest.committedSequence + 1, previousCommitHash: manifest.lastCommitHash, participants: [...participants.values()].map(({ path: _path, recordKind: _kind, ...participant }) => participant), metadataDeltaHash: commandHash(input) });
    const journal = this.commitJournalPath(input.threadId, nextGeneration);
    await appendBytes(journal, Buffer.from(`${canonicalJson(commit)}\n`, 'utf8'));
    await syncFile(journal);
    await this.faultAt('after_commit_sync');
    const nextThread = applyThreadDelta(thread, input.thread, input.items ?? [], input.turns ?? [], input.occurredAt);
    const nextManifest = advanceManifest(manifest, commit, participants.values(), input.items ?? [], input.turns ?? []);
    await this.faultAt('before_manifest_update');
    await atomicWrite(this.manifestPath(input.threadId), nextManifest);
    await this.faultAt('after_manifest_update');
    const debts: ProjectionDebtV1[] = [];
    try {
      await this.faultAt('before_projection_update');
      await atomicWrite(this.threadMetadataPath(input.threadId), nextThread);
      await this.rebuildSummaryIndex();
    } catch (error) {
      const debt = { schemaVersion: 1 as const, threadId: input.threadId, commitSequence: commit.commitSequence, projection: 'metadata' as const, error: error instanceof Error ? error.message : String(error), recordedAt: this.now() };
      debts.push(debt);
      try { await appendBytes(this.debtPath(input.threadId), Buffer.from(`${canonicalJson(debt)}\n`, 'utf8')); } catch { /* The durable commit remains recoverable from the journal. */ }
    }
    return { transactionId, commit, thread: nextThread, alreadyCommitted: false, projectionDebt: debts };
  }

  private async recoverUnlocked(threadId: ThreadId): Promise<ThreadRecoveryResult> {
    const manifest = await this.getManifest(threadId);
    const commits = await this.scanCommits(threadId, manifest);
    const reports: RecoveryReport[] = [];
    let current = manifest;
    let rolledForward = 0;
    for (const commit of commits.committedAfterManifest) {
      try {
        await this.verifyCommitParticipants(threadId, commit);
        current = advanceManifest(current, commit, commit.participants.map(participant => ({ ...participant, recordIds: Array.from(participant.recordIds), recordKind: segmentKindFromId(participant.segmentId), path: this.segmentPath(threadId, participant.segmentId) } as CommitParticipantDraft)), [], []);
        await atomicWrite(this.manifestPath(threadId), current);
        rolledForward += 1;
      } catch (error) {
        reports.push({ threadId, severity: 'degraded_read_only', code: 'commit_participant_invalid', detail: error instanceof Error ? error.message : String(error) });
        return { status: 'degraded_read_only', manifest: current, rolledForward, reports };
      }
    }
    const knownSegments = new Set(current.segments.map(segment => segment.segmentId));
    for (const segmentId of await directoryNames(this.segmentsDirectory(threadId))) {
      if (knownSegments.has(segmentId) || !segmentId.endsWith('.jsonl')) continue;
      const orphanPath = this.segmentPath(threadId, segmentId);
      const quarantine = `${orphanPath}.quarantine-${Date.now()}`;
      await rename(orphanPath, quarantine);
      reports.push({ threadId, severity: 'tail_quarantined', code: 'orphan_segment', detail: `orphan segment moved to ${quarantine}` });
    }
    for (const segment of current.segments) {
      try {
        const parsed = await parseJsonl<SegmentRecordV1>(this.segmentPath(threadId, segment.segmentId), value => value as SegmentRecordV1);
        if (parsed.nonTailCorrupt || parsed.lastCompleteOffset < segment.committedBytes) throw new Error('segment_jsonl_corrupt');
        for (const record of parsed.records) validateSegmentRecord(record);
      } catch (error) {
        reports.push({ threadId, severity: 'degraded_read_only', code: 'segment_checksum_mismatch', detail: error instanceof Error ? error.message : String(error) });
        return { status: 'degraded_read_only', manifest: current, rolledForward, reports };
      }
      const result = await inspectTail(this.segmentPath(threadId, segment.segmentId), segment.committedBytes);
      if (result.nonTailCorrupt) {
        reports.push({ threadId, severity: 'degraded_read_only', code: 'non_tail_corruption', detail: result.detail });
        return { status: 'degraded_read_only', manifest: current, rolledForward, reports };
      }
      if (result.tailBytes > 0) {
        const quarantine = `${this.segmentPath(threadId, segment.segmentId)}.quarantine-${Date.now()}`;
        await copyBytes(this.segmentPath(threadId, segment.segmentId), quarantine, segment.committedBytes);
        await truncateFile(this.segmentPath(threadId, segment.segmentId), segment.committedBytes);
        reports.push({ threadId, severity: 'tail_quarantined', code: 'torn_tail', detail: `${result.tailBytes} bytes quarantined at ${quarantine}` });
      }
    }
    if (current.snapshot) {
      const snapshot = await readJson<ThreadSnapshotV1>(this.snapshotPath(threadId, current.snapshot.snapshotId));
      if (!snapshot || snapshot.checksum !== current.snapshot.checksum || snapshot.sourceCommitHash !== current.snapshot.sourceCommitHash || sha256Hex(canonicalJson({ ...snapshot, checksum: undefined })) !== snapshot.checksum) {
        reports.push({ threadId, severity: 'snapshot_invalid', code: 'snapshot_checksum_mismatch', detail: 'snapshot ignored; committed segments remain authoritative' });
      }
    }
    await this.rebuildThreadMetadata(threadId, current);
    await this.rebuildSummaryIndex();
    return { status: reports.some(report => report.severity === 'degraded_read_only') ? 'degraded_read_only' : 'ready', manifest: current, rolledForward, reports };
  }

  private async scanCommits(threadId: ThreadId, manifest: ThreadManifestV1): Promise<{ readonly committedAfterManifest: readonly CommitRecordV1[] }> {
    const commits: CommitRecordV1[] = [];
    for (const generation of await generations(this.commitsDirectory(threadId))) {
      const file = this.commitJournalPath(threadId, generation);
      const parsed = await parseJsonl<CommitRecordV1>(file, value => validateCommit(value));
      commits.push(...parsed.records);
      if (parsed.nonTailCorrupt) throw new Error('commit_journal_corrupt');
      if (parsed.tailBytes > 0) {
        await copyBytes(file, `${file}.quarantine-${Date.now()}`, parsed.lastCompleteOffset);
        await truncateFile(file, parsed.lastCompleteOffset);
      }
    }
    commits.sort((left, right) => left.commitSequence - right.commitSequence);
    let previousSequence = 0;
    let previous = emptyHash;
    for (const commit of commits) {
      if (commit.commitSequence !== previousSequence + 1 || commit.previousCommitHash !== previous) throw new Error('commit_hash_chain_mismatch');
      previousSequence = commit.commitSequence;
      previous = commit.commitHash;
    }
    const after = commits.filter(commit => commit.commitSequence > manifest.committedSequence);
    return { committedAfterManifest: after };
  }

  private async verifyCommitParticipants(threadId: ThreadId, commit: CommitRecordV1): Promise<void> {
    for (const participant of commit.participants) {
      const file = this.segmentPath(threadId, participant.segmentId);
      const bytes = await readFile(file);
      if (participant.endOffset > bytes.length || sha256Hex(new Uint8Array(bytes.subarray(participant.startOffset, participant.endOffset))) !== participant.checksum) throw new Error(`participant_checksum_mismatch:${participant.segmentId}`);
    }
  }

  private async readCommittedRecords<T>(threadId: ThreadId, manifest: ThreadManifestV1, kind: ThreadSegmentKind): Promise<readonly SegmentRecordV1<T>[]> {
    const result: SegmentRecordV1<T>[] = [];
    for (const segment of manifest.segments.filter(segment => segment.recordKind === kind)) {
      const parsed = await parseJsonl<SegmentRecordV1<T>>(this.segmentPath(threadId, segment.segmentId), value => value as SegmentRecordV1<T>);
      if (parsed.nonTailCorrupt || parsed.lastCompleteOffset < segment.committedBytes) throw new Error('thread_segment_corrupt');
      for (const record of parsed.records) {
        validateSegmentRecord(record);
        result.push(record);
      }
    }
    return result.sort((left, right) => left.sequence - right.sequence);
  }

  private async rebuildThreadMetadata(threadId: ThreadId, manifest: ThreadManifestV1): Promise<void> {
    const thread = await this.requireThread(threadId);
    const items = await this.readCommittedRecords<ItemV1>(threadId, manifest, 'item');
    const turns = await this.readCommittedRecords<TurnV1>(threadId, manifest, 'turn');
    const last = items.at(-1);
    const next = parseThreadV1({
      ...thread,
      generation: manifest.generation,
      updatedAt: thread.updatedAt,
      itemCount: Math.max(thread.itemCount, items.length),
      turnCount: Math.max(thread.turnCount, turns.length),
      lastItemSequence: Math.max(thread.lastItemSequence, last?.sequence ?? 0),
      ...(last ? { lastItemId: last.payload.itemId } : {})
    });
    await atomicWrite(this.threadMetadataPath(threadId), next);
  }

  private async findIdempotency(threadId: ThreadId, manifest: ThreadManifestV1, input: ThreadAppendInput): Promise<CommitRecordV1 | undefined> {
    const key = input.idempotencyKey;
    const commitsDirectory = this.commitsDirectory(threadId);
    for (const generation of await generations(this.rootCommitsForManifest(manifest))) {
      const file = path.join(commitsDirectory, `commits-${generation}.jsonl`);
      const parsed = await parseJsonl<CommitRecordV1>(file, value => validateCommit(value));
      for (const record of parsed.records) {
        for (const participant of record.participants) {
          const records = await parseJsonl<SegmentRecordV1>(this.segmentPath(threadId, participant.segmentId), value => value as SegmentRecordV1);
          if (records.records.some(segment => participant.recordIds.includes(segment.recordId) && segment.idempotencyKey === key)) return record;
        }
      }
    }
    return undefined;
  }

  private async requireThread(threadId: ThreadId): Promise<ThreadV1> { const thread = await this.readThreadMetadata(threadId); if (!thread) throw new Error('thread_not_found'); return thread; }
  private async readThreadMetadata(threadId: ThreadId): Promise<ThreadV1 | undefined> { const value = await readJson<ThreadV1>(this.threadMetadataPath(threadId)); return value ? parseThreadV1(value) : undefined; }
  private async prepareThreadDirectory(threadId: ThreadId): Promise<void> { await Promise.all([mkdir(this.threadDirectory(threadId), { recursive: true }), mkdir(this.segmentsDirectory(threadId), { recursive: true }), mkdir(this.commitsDirectory(threadId), { recursive: true }), mkdir(this.snapshotsDirectory(threadId), { recursive: true })]); }
  private async segmentFor(threadId: ThreadId, kind: ThreadSegmentKind, generation: number, manifest: ThreadManifestV1): Promise<{ readonly segmentId: string; readonly path: string; readonly committedBytes: number }> {
    const existing = manifest.segments.filter(segment => segment.recordKind === kind).at(-1);
    if (existing && (await safeStatSize(this.segmentPath(threadId, existing.segmentId))) < this.rotationBytes) return { segmentId: existing.segmentId, path: this.segmentPath(threadId, existing.segmentId), committedBytes: existing.committedBytes };
    const segmentId = `${kind}s-${generation}-${(manifest.segments.filter(segment => segment.recordKind === kind).length + 1).toString().padStart(4, '0')}.jsonl`;
    const segmentPath = this.segmentPath(threadId, segmentId);
    await mkdir(path.dirname(segmentPath), { recursive: true });
    return { segmentId, path: segmentPath, committedBytes: 0 };
  }
  private async exclusive<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> { const key = this.threadDirectory(threadId); const previous = this.queues.get(key) ?? Promise.resolve(); let resolve!: () => void; const gate = new Promise<void>(accept => { resolve = accept; }); const tail = previous.catch(() => undefined).then(() => gate); this.queues.set(key, tail); await previous.catch(() => undefined); try { return await sharedFileWriteCoordinator.runExclusive(key, operation); } finally { resolve(); if (this.queues.get(key) === tail) this.queues.delete(key); } }
  private async faultAt(point: ThreadFaultPoint): Promise<void> { await this.fault?.(point); }
  private threadsRoot(): string { return path.join(this.rootDirectory, 'entities', 'threads'); }
  private indexPath(): string { return path.join(this.threadsRoot(), 'index.v1.json'); }
  private threadDirectory(threadId: ThreadId): string { assertSafeThreadId(threadId); return path.join(this.threadsRoot(), String(threadId)); }
  private threadMetadataPath(threadId: ThreadId): string { return path.join(this.threadDirectory(threadId), 'thread.v1.json'); }
  private manifestPath(threadId: ThreadId): string { return path.join(this.threadDirectory(threadId), 'manifest.v1.json'); }
  private segmentsDirectory(threadId: ThreadId): string { return path.join(this.threadDirectory(threadId), 'segments'); }
  private commitsDirectory(threadId: ThreadId): string { return path.join(this.threadDirectory(threadId), 'commits'); }
  private rootCommitsForManifest(manifest: ThreadManifestV1): string { return path.join(this.threadsRoot(), String(manifest.threadId), 'commits'); }
  private snapshotsDirectory(threadId: ThreadId): string { return path.join(this.threadDirectory(threadId), 'snapshots'); }
  private segmentPath(threadId: ThreadId, segmentId: string): string { return path.join(this.segmentsDirectory(threadId), segmentId); }
  private commitJournalPath(threadId: ThreadId, generation: number): string { return path.join(this.commitsDirectory(threadId), `commits-${generation}.jsonl`); }
  private snapshotPath(threadId: ThreadId, snapshotId: string): string { return path.join(this.snapshotsDirectory(threadId), `${snapshotId}.json`); }
  private debtPath(threadId: ThreadId): string { return path.join(this.threadDirectory(threadId), 'projection-debt.v1.jsonl'); }
}

export interface ThreadSummaryProjection { readonly threadId: ThreadId; readonly projectId: ProjectId | null; readonly title: string; readonly status: ThreadV1['status']; readonly createdAt: string; readonly updatedAt: string; readonly itemCount: number; readonly turnCount: number; readonly lastItemId?: ThreadV1['lastItemId']; }
export interface RecoveryReport { readonly threadId: ThreadId; readonly severity: 'tail_quarantined' | 'snapshot_invalid' | 'degraded_read_only'; readonly code: string; readonly detail: string; }
export interface ThreadRecoveryResult { readonly status: 'ready' | 'degraded_read_only'; readonly manifest: ThreadManifestV1; readonly rolledForward: number; readonly reports: readonly RecoveryReport[]; }

interface PendingRecord { readonly kind: ThreadSegmentKind; readonly payload: ItemV1 | TurnV1 | TurnExecutionLinkV1; readonly sequence: number; }
interface CommitParticipantDraft { segmentId: string; startOffset: number; endOffset: number; recordIds: string[]; checksum: string; recordKind: ThreadSegmentKind; path: string; }

function emptyManifest(threadId: ThreadId): ThreadManifestV1 { return { schemaVersion: 1, threadId, generation: 0, committedSequence: 0, committedItemSequence: 0, committedTurnSequence: 0, lastCommitHash: emptyHash, segments: [], revision: 0 }; }
function makeSegmentRecord(input: Omit<SegmentRecordV1, 'payloadHash' | 'recordHash' | 'schemaVersion'>): SegmentRecordV1 { const payloadHash = sha256Hex(canonicalJson(input.payload)); const base = { schemaVersion: 1 as const, ...input, payloadHash }; return { ...base, recordHash: sha256Hex(canonicalJson(base)) }; }
function makeCommit(input: Omit<CommitRecordV1, 'schemaVersion' | 'commitHash'>): CommitRecordV1 { const base = { schemaVersion: 1 as const, ...input }; return { ...base, commitHash: sha256Hex(canonicalJson(base)) }; }
function commandHash(input: ThreadAppendInput): string { return sha256Hex(canonicalJson({ threadId: input.threadId, idempotencyKey: input.idempotencyKey, thread: input.thread ?? {}, turns: input.turns ?? [], items: input.items ?? [], executionLinks: input.executionLinks ?? [] })); }
function validateCommit(value: unknown): CommitRecordV1 { const item = value as CommitRecordV1; if (!item || item.schemaVersion !== 1 || typeof item.commitHash !== 'string' || item.commitHash !== sha256Hex(canonicalJson({ ...item, commitHash: undefined }))) throw new Error('commit_invalid'); return item; }
function validateSegmentRecord(value: SegmentRecordV1): SegmentRecordV1 { const payloadHash = sha256Hex(canonicalJson(value.payload)); const base = { schemaVersion: 1 as const, generation: value.generation, sequence: value.sequence, transactionId: value.transactionId, recordId: value.recordId, recordKind: value.recordKind, idempotencyKey: value.idempotencyKey, occurredAt: value.occurredAt, previousRecordHash: value.previousRecordHash, payload: value.payload, payloadHash }; if (value.payloadHash !== payloadHash || value.recordHash !== sha256Hex(canonicalJson(base))) throw new Error(`segment_checksum_mismatch:${value.recordId}`); return value; }
function validateManifest(value: ThreadManifestV1, threadId: ThreadId): ThreadManifestV1 { if (value.schemaVersion !== 1 || value.threadId !== threadId || value.generation < 0 || value.committedSequence < 0 || value.revision < 0) throw new Error('manifest_invalid'); return value; }
function advanceManifest(previous: ThreadManifestV1, commit: CommitRecordV1, participants: Iterable<CommitParticipantDraft>, items: readonly ItemV1[], turns: readonly TurnV1[]): ThreadManifestV1 { const map = new Map(previous.segments.map(segment => [segment.segmentId, segment])); for (const participant of participants) map.set(participant.segmentId, { segmentId: participant.segmentId, recordKind: participant.recordKind, committedBytes: participant.endOffset, lastSequence: Math.max(...items.map(item => item.sequence), ...turns.map(turn => turn.turnSequence), previous.committedSequence), checksum: participant.checksum }); return { ...previous, generation: commit.generation, committedSequence: commit.commitSequence, committedItemSequence: Math.max(previous.committedItemSequence, ...items.map(item => item.sequence), 0), committedTurnSequence: Math.max(previous.committedTurnSequence, ...turns.map(turn => turn.turnSequence), 0), lastCommitHash: commit.commitHash, segments: [...map.values()], revision: previous.revision + 1 }; }
function applyThreadDelta(thread: ThreadV1, patch: ThreadAppendInput['thread'] | undefined, items: readonly ItemV1[], turns: readonly TurnV1[], updatedAt: string): ThreadV1 { return parseThreadV1({ ...thread, ...patch, updatedAt, generation: thread.generation + 1, itemCount: Math.max(thread.itemCount, ...items.map(item => item.sequence), thread.itemCount), turnCount: Math.max(thread.turnCount, ...turns.map(turn => turn.turnSequence), thread.turnCount), lastItemSequence: Math.max(thread.lastItemSequence, ...items.map(item => item.sequence), thread.lastItemSequence) }); }
function toSummary(thread: ThreadV1): ThreadSummaryProjection { return { threadId: thread.threadId, projectId: thread.projectId, title: thread.title, status: thread.status, createdAt: thread.createdAt, updatedAt: thread.updatedAt, itemCount: thread.itemCount, turnCount: thread.turnCount, ...(thread.lastItemId ? { lastItemId: thread.lastItemId } : {}) }; }
function canonicalJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)])); return value; }
async function atomicWrite(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.tmp-${process.pid}-${Date.now()}`; await writeFile(temp, `${canonicalJson(value)}\n`, 'utf8'); const handle = await open(temp, 'r+'); await handle.sync(); await handle.close(); await rename(temp, file); }
async function appendBytes(file: string, bytes: Uint8Array, sync = true): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); const handle = await open(file, 'a'); await handle.write(bytes); if (sync) await handle.sync(); await handle.close(); }
async function syncFile(file: string): Promise<void> { const handle = await open(file, 'r+'); await handle.sync(); await handle.close(); }
async function syncFiles(files: readonly string[]): Promise<void> { for (const file of files) await syncFile(file); }
async function readJson<T>(file: string): Promise<T | undefined> { try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
async function safeStatSize(file: string): Promise<number> { try { return (await stat(file)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; } }
async function exists(file: string): Promise<boolean> { try { await stat(file); return true; } catch { return false; } }
async function directoryNames(directory: string): Promise<readonly string[]> { try { return (await import('node:fs/promises')).readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
async function generations(directory: string): Promise<readonly number[]> { return (await directoryNames(directory)).flatMap(name => { const match = /(?:commits|items|turns|turn_execution_links)-(\d+)-?/.exec(name); return match ? [Number(match[1])] : []; }).filter((value, index, values) => values.indexOf(value) === index).sort((left, right) => left - right); }
async function previousRecordHash(file: string, committedBytes: number): Promise<string> { if (!committedBytes) return emptyHash; const text = await readFile(file, 'utf8'); const lines = text.slice(0, committedBytes).trimEnd().split('\n'); return String((JSON.parse(lines.at(-1)!) as { readonly recordHash?: string }).recordHash ?? emptyHash); }
async function checksumRange(file: string, start: number, end: number): Promise<string> { const bytes = await readFile(file); return sha256Hex(new Uint8Array(bytes.subarray(start, end))); }
async function parseJsonl<T>(file: string, parser: (value: unknown) => T): Promise<{ readonly records: readonly T[]; readonly lastCompleteOffset: number; readonly tailBytes: number; readonly nonTailCorrupt: boolean }> { const bytes = await readFile(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }); const text = bytes.toString('utf8'); const lines = text.split('\n'); const records: T[] = []; let offset = 0; let lastCompleteOffset = 0; let nonTailCorrupt = false; for (let index = 0; index < lines.length; index += 1) { const raw = lines[index]!; const lineBytes = Buffer.byteLength(raw, 'utf8'); const complete = index < lines.length - 1; if (!raw && !complete) break; try { records.push(parser(JSON.parse(raw))); } catch { if (complete) nonTailCorrupt = true; break; } offset += lineBytes + (complete ? 1 : 0); if (complete) lastCompleteOffset = offset; } return { records, lastCompleteOffset, tailBytes: bytes.length - lastCompleteOffset, nonTailCorrupt }; }
async function inspectTail(file: string, committedBytes: number): Promise<{ readonly tailBytes: number; readonly nonTailCorrupt: boolean; readonly detail: string }> { const bytes = await readFile(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }); if (bytes.length < committedBytes) return { tailBytes: 0, nonTailCorrupt: true, detail: 'segment shorter than manifest committedBytes' }; const tail = bytes.subarray(committedBytes); if (!tail.length) return { tailBytes: 0, nonTailCorrupt: false, detail: '' }; const tailText = tail.toString('utf8'); const completeLines = tailText.split('\n').filter(Boolean); let nonTailCorrupt = false; for (const line of completeLines.slice(0, -1)) { try { JSON.parse(line); } catch { nonTailCorrupt = true; } } return { tailBytes: tail.length, nonTailCorrupt, detail: 'uncommitted tail bytes present' }; }
async function copyBytes(source: string, target: string, end: number): Promise<void> { const bytes = await readFile(source); await writeFile(target, bytes.subarray(end)); }
async function truncateFile(file: string, length: number): Promise<void> { const handle = await open(file, 'r+'); await handle.truncate(length); await handle.sync(); await handle.close(); }
function assertSafeThreadId(threadId: ThreadId): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(String(threadId)) || String(threadId) === '..') throw new Error('unsafe_thread_id'); }
function segmentKindFromId(segmentId: string): ThreadSegmentKind { if (segmentId.startsWith('turns-')) return 'turn'; if (segmentId.startsWith('turn_execution_links-')) return 'turn_execution_link'; return 'item'; }
function cryptoRandomId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
