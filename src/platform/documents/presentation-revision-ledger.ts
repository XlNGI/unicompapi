import { createHash } from 'node:crypto';
import type { DocumentMutationRecord, DocumentMutationState } from '../../application/document-mutation-coordinator';
import { parseDocumentVersionPin, type DocumentVersionPin } from '../../domain/entities/document-version-pin';
import { toProjectRelativePath, type NodeProjectStorage } from '../storage';

const terminal = new Set(['session_refreshed', 'committed', 'committed_pending_refresh', 'cancelled', 'failed', 'revision_conflict']);
/** Shares the existing per-document mutation fence with object edits and crash inspection. */
export class PresentationRevisionLedger {
  private record: DocumentMutationRecord;
  private readonly indexPath;
  private readonly recordPath;
  private readonly key: string;
  claimed = false;
  finished = false;
  constructor(private readonly storage: NodeProjectStorage, input: { readonly basePin: DocumentVersionPin;
    readonly idempotencyKey: string; readonly requestFingerprint: string }) {
    const basePin = parseDocumentVersionPin(input.basePin);
    if (!/^[a-f0-9]{64}$/u.test(input.idempotencyKey) || !/^[a-f0-9]{64}$/u.test(input.requestFingerprint)) throw new TypeError('invalid_visual_ledger');
    this.key = hash(input.idempotencyKey);
    this.indexPath = toProjectRelativePath(`entities/document-mutations/index-${hash(basePin.documentLineageId)}.json`);
    this.recordPath = toProjectRelativePath(`entities/document-mutations/call-${this.key}.json`);
    this.record = { schemaVersion: 1, mutationId: `visual-${this.key}`, idempotencyKey: input.idempotencyKey,
      state: 'pinned', basePin, patchFingerprint: input.requestFingerprint };
  }
  async claim(): Promise<void> {
    await this.storage.withExclusiveAccess([this.indexPath], async () => {
      const index = parseIndex(await this.storage.readJson(this.indexPath));
      if (Object.values(index).some(state => !terminal.has(state)) || await this.storage.readJson(this.recordPath) !== undefined) throw new Error('reconciliation_required');
      // Index first: even a missing subsequent receipt must block new document writes.
      await this.storage.writeJsonAtomically(this.indexPath, { ...index, [this.key]: 'pinned' });
      this.claimed = true;
      await this.storage.writeJsonAtomically(this.recordPath, this.record);
    });
  }
  async finish(state: DocumentMutationState, candidatePin?: DocumentVersionPin): Promise<void> {
    if (!this.claimed) return;
    const record: DocumentMutationRecord = { ...this.record, state,
      ...(candidatePin ? { candidatePin: parseDocumentVersionPin(candidatePin), candidateWorkId: candidatePin.headWorkId,
        candidateChecksumSha256: candidatePin.checksumSha256, registrationAttempted: true,
        headCommitAttempted: ['commit_prepared', 'committed', 'committed_pending_refresh', 'reconciliation_required'].includes(state) } : {}) };
    await this.storage.writeJsonAtomically(this.recordPath, record);
    await this.storage.mutateJsonAtomically(this.indexPath, previous => ({ ...parseIndex(previous), [this.key]: state }));
    this.record = record;
    this.finished = terminal.has(state);
  }
  async beginPublication(): Promise<void> {
    this.record = { ...this.record, registrationAttempted: true };
    await this.finish('candidate_prepared');
  }
}
function parseIndex(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.entries(value).some(([key, state]) => !/^[a-f0-9]{64}$/u.test(key) || typeof state !== 'string')) throw new Error('reconciliation_required');
  return value as Record<string, string>;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
