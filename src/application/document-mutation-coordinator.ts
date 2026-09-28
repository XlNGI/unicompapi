import { parseDocumentIRPatch, patchFingerprint } from '../domain/entities/document-ir-patch';
import type { DocumentVersionPin } from '../domain/entities/document-version-pin';
import {
  applyPresentationTextPatch,
  carryForwardPresentationIdentityManifest,
  parsePresentationIdentityManifest,
  type PresentationIdentityManifest
} from '../platform/documents/presentation-identity-manifest';

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
  readonly diagnostic?: string;
}

export interface DocumentMutationHead {
  readonly pin: DocumentVersionPin;
  readonly buffer: Uint8Array;
  readonly identity: PresentationIdentityManifest;
}

export interface DocumentMutationCandidate {
  readonly pin: DocumentVersionPin;
  readonly buffer: Uint8Array;
  readonly identity: PresentationIdentityManifest;
  readonly workId: string;
}

export interface DocumentMutationPorts {
  readonly readHead: () => Promise<DocumentMutationHead>;
  readonly registerCandidate: (candidate: Omit<DocumentMutationCandidate, 'workId'> & { readonly idempotencyKey: string; readonly signal: AbortSignal }) => Promise<DocumentMutationCandidate>;
  /** This is the only authoritative head switch. Implement it under one serialized storage lock. */
  readonly compareAndSwapHead: (expected: DocumentVersionPin, candidate: DocumentMutationCandidate) => Promise<boolean>;
  readonly cleanupCandidate: (candidate: DocumentMutationCandidate) => Promise<void>;
  readonly reconcile: (record: DocumentMutationRecord) => Promise<void>;
  readonly refreshSession: (candidate: DocumentMutationCandidate) => Promise<void>;
  readonly qa: (buffer: Uint8Array, signal: AbortSignal) => Promise<void>;
}

export interface DocumentMutationResult {
  readonly status: Extract<DocumentMutationState, 'committed' | 'session_refreshed' | 'committed_pending_refresh' | 'cancelled' | 'revision_conflict' | 'failed' | 'reconciliation_required'>;
  readonly record: DocumentMutationRecord;
  readonly candidate?: DocumentMutationCandidate;
}

/** Coordinates candidate creation and the final authoritative head CAS. */
export class DocumentMutationCoordinator {
  private readonly completed = new Map<string, DocumentMutationResult>();

  constructor(private readonly ports: DocumentMutationPorts) {}

  async updateText(input: {
    readonly mutationId: string;
    readonly idempotencyKey: string;
    readonly patch: unknown;
    readonly signal: AbortSignal;
  }): Promise<DocumentMutationResult> {
    const replay = this.completed.get(input.idempotencyKey);
    if (replay) return replay;
    let head: DocumentMutationHead | undefined;
    let candidate: DocumentMutationCandidate | undefined;
    try {
      head = await this.ports.readHead();
      const parsedPin = head.pin;
      let record = this.record(input, 'pinned', parsedPin, input.patch);
      const identity = parsePresentationIdentityManifest(head.identity);
      if (identity.artifactChecksumSha256 !== parsedPin.checksumSha256 || identity.workId !== parsedPin.headWorkId) {
        return this.finish(input, { status: 'failed', record: { ...record, state: 'failed', diagnostic: 'identity_pin_mismatch' } });
      }
      record = { ...record, state: 'identity_resolved' };
      const patch = parseDocumentIRPatch(input.patch);
      record = { ...record, state: 'patch_validated', patchFingerprint: patchFingerprint(patch) };
      if (input.signal.aborted) return this.finish(input, { status: 'cancelled', record: { ...record, state: 'cancelled' } });
      const candidateBuffer = await applyPresentationTextPatch({ buffer: head.buffer, manifest: identity, patch });
      record = { ...record, state: 'candidate_prepared' };
      await this.ports.qa(candidateBuffer, input.signal);
      record = { ...record, state: 'qa_verified' };
      if (input.signal.aborted) return this.finish(input, { status: 'cancelled', record: { ...record, state: 'cancelled' } });
      const candidateChecksum = await checksum(candidateBuffer);
      const candidateWorkId = `work-mutation-${input.mutationId}`;
      const candidateIdentity = await carryForwardPresentationIdentityManifest({ previous: identity, buffer: candidateBuffer,
        revision: parsedPin.runtimeRevision + 1, targetElementId: patch.operations[0].target.elementId, targetText: patch.operations[0].text });
      const candidatePin: DocumentVersionPin = { ...parsedPin, checksumSha256: candidateChecksum,
        runtimeRevision: parsedPin.runtimeRevision + 1, identityIndexVersion: 1, headWorkId: candidateWorkId };
      const boundCandidateIdentity = Object.freeze({ ...candidateIdentity, workId: candidateWorkId });
      record = { ...record, state: 'materialized', candidateChecksumSha256: candidateChecksum };
      candidate = await this.ports.registerCandidate({ pin: candidatePin, buffer: candidateBuffer, identity: boundCandidateIdentity,
        idempotencyKey: input.idempotencyKey, signal: input.signal });
      record = { ...record, state: 'commit_prepared', candidateWorkId: candidate.workId };
      if (input.signal.aborted) {
        await this.ports.cleanupCandidate(candidate);
        return this.finish(input, { status: 'cancelled', record: { ...record, state: 'cancelled' } });
      }
      if (!await this.ports.compareAndSwapHead(parsedPin, candidate)) {
        await this.ports.reconcile({ ...record, state: 'revision_conflict', diagnostic: 'revision_conflict' });
        return this.finish(input, { status: 'revision_conflict', record: { ...record, state: 'revision_conflict', diagnostic: 'revision_conflict' }, candidate });
      }
      record = { ...record, state: 'committed' };
      try {
        await this.ports.refreshSession(candidate);
        return this.finish(input, { status: 'session_refreshed', record: { ...record, state: 'session_refreshed' }, candidate });
      } catch {
        const result: DocumentMutationResult = { status: 'committed_pending_refresh', record: { ...record, state: 'committed_pending_refresh' as const, diagnostic: 'committed_pending_refresh' }, candidate };
        return this.finish(input, result);
      }
    } catch (error) {
      const state: DocumentMutationState = input.signal.aborted ? 'cancelled' : candidate ? 'unknown' : 'failed';
      const basePin = head?.pin ?? await this.ports.readHead().then(value => value.pin).catch(() => emptyPin());
      const record = this.record(input, state, basePin, input.patch, error instanceof Error ? error.message : 'mutation_failed');
      if (candidate) {
        await this.ports.reconcile({ ...record, state: 'reconciliation_required' });
        return this.finish(input, { status: 'reconciliation_required', record: { ...record, state: 'reconciliation_required' }, candidate });
      }
      return this.finish(input, { status: state === 'cancelled' ? 'cancelled' : 'failed', record });
    }
  }

  private finish(input: { readonly idempotencyKey: string }, result: DocumentMutationResult): DocumentMutationResult {
    this.completed.set(input.idempotencyKey, result);
    return result;
  }

  private record(input: { readonly mutationId: string; readonly idempotencyKey: string }, state: DocumentMutationState,
    pin: DocumentVersionPin, patch: unknown, diagnostic?: string): DocumentMutationRecord {
    return { schemaVersion: 1, mutationId: input.mutationId, idempotencyKey: input.idempotencyKey,
      state, basePin: pin, patchFingerprint: safePatchFingerprint(patch), ...(diagnostic ? { diagnostic } : {}) };
  }
}

function safePatchFingerprint(value: unknown): string {
  try { return patchFingerprint(parseDocumentIRPatch(value)); } catch { return 'invalid'; }
}
async function checksum(buffer: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function emptyPin(): DocumentVersionPin {
  return { documentLineageId: 'unknown', headWorkId: 'unknown', fileId: 'unknown', sourceExecutionId: 'unknown', checksumSha256: '0'.repeat(64), runtimeRevision: 0, identityIndexVersion: 1 };
}
