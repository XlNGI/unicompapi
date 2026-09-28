import { parseDocumentIRPatch, patchFingerprint, type DocumentIRPatch } from '../domain/entities/document-ir-patch';
import { parseDocumentVersionPin, type DocumentVersionPin } from '../domain/entities/document-version-pin';
import type { PresentationIdentityManifest } from '../platform/documents/presentation-identity-manifest';

export type DocumentMutationState =
  | 'pinned' | 'identity_resolved' | 'patch_validated' | 'candidate_prepared'
  | 'materialized' | 'qa_verified' | 'commit_prepared' | 'committed'
  | 'session_refreshed' | 'committed_pending_refresh' | 'cancelled'
  | 'revision_conflict' | 'failed' | 'unknown' | 'reconciliation_required';

export interface DocumentMutationRecord {
  readonly schemaVersion: 1;
  readonly mutationId: string;
  readonly idempotencyKey: string;
  readonly state: DocumentMutationState;
  readonly basePin: DocumentVersionPin;
  readonly patchFingerprint: string;
  readonly candidateChecksumSha256?: string;
  readonly candidateWorkId?: string;
  readonly candidatePin?: DocumentVersionPin;
  readonly registrationAttempted?: boolean;
  readonly headCommitAttempted?: boolean;
  readonly diagnostic?: string;
}

export interface DocumentMutationHead {
  readonly pin: DocumentVersionPin;
  readonly buffer: Uint8Array;
  readonly identity: PresentationIdentityManifest;
}

export interface DocumentMutationCandidate extends DocumentMutationHead {
  readonly workId: string;
}

export interface DocumentMutationCommitContext {
  readonly signal: AbortSignal;
  readonly authorize: () => Promise<boolean>;
}

export interface DocumentMutationPorts {
  readonly readHead: () => Promise<DocumentMutationHead>;
  /** Durable ledger, scoped to the project. A restarted host must consult it before materializing. */
  readonly loadRecord: (idempotencyKey: string) => Promise<DocumentMutationRecord | undefined>;
  readonly saveRecord: (record: DocumentMutationRecord) => Promise<void>;
  readonly runExclusive: (idempotencyKey: string, operation: () => Promise<DocumentMutationResult>) => Promise<DocumentMutationResult>;
  readonly materialize: (input: {
    readonly head: DocumentMutationHead; readonly patch: DocumentIRPatch;
    readonly mutationId: string; readonly idempotencyKey: string; readonly signal: AbortSignal;
  }) => Promise<Omit<DocumentMutationCandidate, 'workId'>>;
  /** Verifies exact bytes, full pin, manifest uniqueness and all concrete object locators. */
  readonly verifyCandidate: (candidate: Omit<DocumentMutationCandidate, 'workId'>, signal: AbortSignal) => Promise<void>;
  readonly registerCandidate: (candidate: Omit<DocumentMutationCandidate, 'workId'> & {
    readonly idempotencyKey: string; readonly signal: AbortSignal;
  }) => Promise<DocumentMutationCandidate>;
  /** Final head switch; authorization, signal and authoritative pin are checked again under the storage lock. */
  readonly compareAndSwapHead: (expected: DocumentVersionPin, candidate: DocumentMutationCandidate, context: DocumentMutationCommitContext) => Promise<boolean>;
  readonly cleanupCandidate: (candidate: DocumentMutationCandidate) => Promise<void>;
  readonly reconcile: (record: DocumentMutationRecord) => Promise<void>;
  /** Must read the registered artifact again, not a cached candidate/Outline IR. */
  readonly refreshSession: (candidate: DocumentMutationCandidate) => Promise<void>;
  readonly qa: (buffer: Uint8Array, signal: AbortSignal) => Promise<void>;
}

export interface DocumentMutationResult {
  readonly status: Extract<DocumentMutationState, 'committed' | 'session_refreshed' | 'committed_pending_refresh' | 'cancelled' | 'revision_conflict' | 'failed' | 'reconciliation_required'>;
  readonly record: DocumentMutationRecord;
  readonly candidate?: DocumentMutationCandidate;
}

interface MutationInput extends DocumentMutationCommitContext {
  readonly mutationId: string;
  readonly idempotencyKey: string;
  readonly expectedPin: DocumentVersionPin;
  readonly patch: unknown;
}

/** Coordinates the existing candidate lifecycle; Platform owns bytes, identity verification and storage. */
export class DocumentMutationCoordinator {
  private readonly pending = new Map<string, { readonly fingerprint: string; readonly mutationId: string; readonly result: Promise<DocumentMutationResult> }>();

  constructor(private readonly ports: DocumentMutationPorts) {}

  async updateText(input: MutationInput): Promise<DocumentMutationResult> {
    let patch: DocumentIRPatch;
    let fingerprint: string;
    try {
      patch = parseDocumentIRPatch(input.patch);
      parseDocumentVersionPin(input.expectedPin);
      fingerprint = await patchFingerprint(patch);
    } catch {
      return this.failure(input, 'invalid_arguments');
    }
    const pending = this.pending.get(input.idempotencyKey);
    if (pending) return pending.fingerprint === fingerprint && pending.mutationId === input.mutationId
      ? pending.result : this.failure(input, 'idempotency_conflict', fingerprint);
    const result = this.ports.runExclusive(input.idempotencyKey, () => this.run(input, patch, fingerprint));
    this.pending.set(input.idempotencyKey, { fingerprint, mutationId: input.mutationId, result });
    try { return await result; }
    catch { return this.uncertain(input, fingerprint); }
    finally { this.pending.delete(input.idempotencyKey); }
  }

  private async run(input: MutationInput, patch: DocumentIRPatch, fingerprint: string): Promise<DocumentMutationResult> {
    let record: DocumentMutationRecord = { schemaVersion: 1, mutationId: input.mutationId,
      idempotencyKey: input.idempotencyKey, state: 'pinned', basePin: input.expectedPin, patchFingerprint: fingerprint };
    let candidate: DocumentMutationCandidate | undefined;
    let committed = false;
    let ledgerLoaded = false;
    let replaying = false;
    let failureCode = 'commit_failed';
    const save = async (next: DocumentMutationRecord): Promise<void> => { record = next; await this.ports.saveRecord(record); };
    const finish = async (status: DocumentMutationResult['status'], diagnostic?: string): Promise<DocumentMutationResult> => {
      await save({ ...record, state: status, ...(diagnostic ? { diagnostic } : {}) });
      return { status, record, ...(candidate ? { candidate } : {}) };
    };
    const permitted = async (): Promise<boolean> => !input.signal.aborted && await input.authorize() && !input.signal.aborted;
    try {
      const previous = await this.ports.loadRecord(input.idempotencyKey);
      ledgerLoaded = true;
      if (previous) {
        if (previous.mutationId !== input.mutationId || previous.patchFingerprint !== fingerprint) {
          return this.failure(input, 'idempotency_conflict', fingerprint);
        }
        record = previous;
        replaying = true;
        return await this.replay(previous);
      }
      if (input.signal.aborted) return await finish('cancelled', 'cancelled');
      if (!await permitted()) return await finish(input.signal.aborted ? 'cancelled' : 'failed', input.signal.aborted ? 'cancelled' : 'authorization_denied');
      failureCode = 'identity_stale';
      const head = await this.ports.readHead();
      if (!samePin(input.expectedPin, head.pin)) return await finish('revision_conflict', 'revision_conflict');
      await save(record);
      await this.ports.verifyCandidate(head, input.signal);
      await save({ ...record, state: 'identity_resolved' });
      await save({ ...record, state: 'patch_validated' });
      if (input.signal.aborted) return await finish('cancelled', 'cancelled');
      failureCode = 'materialization_failed';
      const prepared = await this.ports.materialize({ head, patch, mutationId: input.mutationId,
        idempotencyKey: input.idempotencyKey, signal: input.signal });
      await save({ ...record, state: 'candidate_prepared' });
      assertCandidateVersion(head.pin, prepared.pin);
      await this.ports.verifyCandidate(prepared, input.signal);
      await save({ ...record, state: 'materialized', candidateChecksumSha256: prepared.pin.checksumSha256,
        candidateWorkId: prepared.pin.headWorkId, candidatePin: prepared.pin });
      failureCode = 'qa_failed';
      await this.ports.qa(prepared.buffer, input.signal);
      // QA/rendering must not invalidate the exact candidate bytes bound by its manifest.
      await this.ports.verifyCandidate(prepared, input.signal);
      await save({ ...record, state: 'qa_verified' });
      if (input.signal.aborted) return await finish('cancelled', 'cancelled');
      if (!await permitted()) return await finish(input.signal.aborted ? 'cancelled' : 'failed', input.signal.aborted ? 'cancelled' : 'authorization_denied');
      // The candidate and its identity are verified before any artifact/Work registration.
      failureCode = 'commit_failed';
      await save({ ...record, state: 'commit_prepared', registrationAttempted: true });
      candidate = await this.ports.registerCandidate({ ...prepared, idempotencyKey: input.idempotencyKey, signal: input.signal });
      if (!samePin(candidate.pin, prepared.pin) || candidate.workId !== prepared.pin.headWorkId) throw new Error('commit_failed');
      if (input.signal.aborted) {
        await this.ports.cleanupCandidate(candidate);
        return await finish('cancelled', 'cancelled');
      }
      await this.ports.verifyCandidate(candidate, input.signal);
      if (!await permitted()) {
        await this.ports.cleanupCandidate(candidate);
        return await finish(input.signal.aborted ? 'cancelled' : 'failed', input.signal.aborted ? 'cancelled' : 'authorization_denied');
      }
      const live = await this.ports.readHead();
      if (!samePin(input.expectedPin, live.pin)) {
        await this.ports.reconcile({ ...record, state: 'revision_conflict', diagnostic: 'revision_conflict' });
        return await finish('revision_conflict', 'revision_conflict');
      }
      await save({ ...record, headCommitAttempted: true });
      let swapped: boolean;
      try {
        swapped = await this.ports.compareAndSwapHead(input.expectedPin, candidate, { signal: input.signal, authorize: input.authorize });
      } catch (error) {
        // These explicit precondition codes mean the host lock rejected before its head write.
        const diagnostic = safeDiagnostic(error, 'unknown_result');
        if (diagnostic === 'cancelled' || diagnostic === 'authorization_denied') {
          await this.ports.cleanupCandidate(candidate);
          return await finish(diagnostic === 'cancelled' ? 'cancelled' : 'failed', diagnostic);
        }
        throw error;
      }
      if (!swapped) {
        await this.ports.reconcile({ ...record, state: 'revision_conflict', diagnostic: 'revision_conflict' });
        return await finish('revision_conflict', 'revision_conflict');
      }
      committed = true;
      await save({ ...record, state: 'committed' });
      if (input.signal.aborted) return await finish('committed_pending_refresh', 'committed_pending_refresh');
      try {
        await this.ports.refreshSession(candidate);
        return await finish('session_refreshed');
      } catch {
        return await finish('committed_pending_refresh', 'committed_pending_refresh');
      }
    } catch (error) {
      if (!ledgerLoaded) return this.uncertain(input, fingerprint);
      if (replaying) return { status: 'reconciliation_required', record: { ...record, state: 'reconciliation_required', diagnostic: 'reconciliation_required' } };
      if (committed) {
        record = { ...record, state: 'committed_pending_refresh', diagnostic: 'committed_pending_refresh' };
        await this.ports.saveRecord(record).catch(() => undefined);
        await this.ports.reconcile(record).catch(() => undefined);
        return { status: 'committed_pending_refresh', record, candidate };
      }
      if (candidate && !record.headCommitAttempted && safeDiagnostic(error, 'unknown_result') === 'revision_conflict') {
        // A verified source change before the head write is a known refusal.
        // Keep the registered candidate detached and recoverable without retrying it.
        record = { ...record, state: 'revision_conflict', diagnostic: 'revision_conflict' };
        await this.ports.saveRecord(record).catch(() => undefined);
        await this.ports.reconcile(record).catch(() => undefined);
        return { status: 'revision_conflict', record, candidate };
      }
      if (record.registrationAttempted) {
        record = { ...record, state: 'reconciliation_required', diagnostic: 'unknown_result' };
        await this.ports.saveRecord(record).catch(() => undefined);
        await this.ports.reconcile(record).catch(() => undefined);
        return { status: 'reconciliation_required', record, ...(candidate ? { candidate } : {}) };
      }
      const status = input.signal.aborted ? 'cancelled' : 'failed';
      record = { ...record, state: status, diagnostic: input.signal.aborted ? 'cancelled' : safeDiagnostic(error, failureCode) };
      await this.ports.saveRecord(record).catch(() => undefined);
      return { status, record };
    }
  }

  private async replay(record: DocumentMutationRecord): Promise<DocumentMutationResult> {
    switch (record.state) {
      case 'session_refreshed': case 'cancelled': case 'failed': case 'revision_conflict': case 'committed_pending_refresh':
        return { status: record.state, record };
      case 'committed':
        return { status: 'committed_pending_refresh', record: { ...record, state: 'committed_pending_refresh', diagnostic: 'committed_pending_refresh' } };
      default: {
        const uncertain: DocumentMutationRecord = { ...record, state: 'reconciliation_required', diagnostic: 'reconciliation_required' };
        await this.ports.saveRecord(uncertain);
        await this.ports.reconcile(uncertain);
        return { status: 'reconciliation_required', record: uncertain };
      }
    }
  }

  private failure(input: MutationInput, diagnostic: string, fingerprint = 'invalid'): DocumentMutationResult {
    return { status: 'failed', record: { schemaVersion: 1, mutationId: input.mutationId, idempotencyKey: input.idempotencyKey,
      state: 'failed', basePin: input.expectedPin, patchFingerprint: fingerprint, diagnostic } };
  }

  private uncertain(input: MutationInput, fingerprint: string): DocumentMutationResult {
    const result = this.failure(input, 'reconciliation_required', fingerprint);
    return { ...result, status: 'reconciliation_required', record: { ...result.record, state: 'reconciliation_required' } };
  }
}

function samePin(first: DocumentVersionPin, second: DocumentVersionPin): boolean {
  return first.documentLineageId === second.documentLineageId && first.headWorkId === second.headWorkId &&
    first.fileId === second.fileId && first.sourceExecutionId === second.sourceExecutionId &&
    first.checksumSha256 === second.checksumSha256 && first.runtimeRevision === second.runtimeRevision &&
    first.identityIndexVersion === second.identityIndexVersion;
}

function assertCandidateVersion(base: DocumentVersionPin, candidate: DocumentVersionPin): void {
  parseDocumentVersionPin(candidate);
  if (candidate.documentLineageId !== base.documentLineageId || candidate.runtimeRevision !== base.runtimeRevision + 1 ||
      candidate.headWorkId === base.headWorkId || candidate.fileId === base.fileId || candidate.sourceExecutionId === base.sourceExecutionId) {
    throw new Error('identity_stale');
  }
}

function safeDiagnostic(error: unknown, fallback: string): string {
  const known = new Set(['identity_unresolved', 'identity_ambiguous', 'identity_stale', 'revision_conflict',
    'authorization_denied', 'cancelled', 'materialization_failed', 'qa_failed', 'commit_failed']);
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && known.has(error.code)) return error.code;
  return error instanceof Error && known.has(error.message) ? error.message : fallback;
}
