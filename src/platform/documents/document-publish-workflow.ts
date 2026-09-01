import type { DocumentWorkspaceKind } from '../../domain';

export interface DocumentPublishCandidate {
  readonly kind: DocumentWorkspaceKind;
  readonly fileName: string;
  readonly temporaryHandle: string;
  readonly finalHandle: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly contentFingerprint: string;
  readonly diagnosticsPassed: boolean;
}

export interface PublishedDocumentRecord {
  readonly workId: string;
  readonly idempotencyKey: string;
  readonly checksumSha256: string;
  readonly revision: number;
}

export interface DocumentPublishPort {
  readonly readCurrentRevision: () => Promise<number>;
  readonly findByIdempotencyKey: (key: string) => Promise<PublishedDocumentRecord | undefined>;
  readonly verifyTemporary: (candidate: DocumentPublishCandidate) => Promise<{
    readonly exists: boolean;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly packageValid: boolean;
  }>;
  readonly publishAtomic: (input: {
    readonly candidate: DocumentPublishCandidate;
    readonly expectedRevision: number;
  }) => Promise<{ readonly revision: number }>;
  readonly registerWork: (input: {
    readonly candidate: DocumentPublishCandidate;
    readonly revision: number;
  }) => Promise<PublishedDocumentRecord>;
}

export type DocumentPublishStatus =
  | 'published'
  | 'idempotent_replay'
  | 'rejected'
  | 'revision_conflict'
  | 'cancelled'
  | 'failed';

export interface DocumentPublishResult {
  readonly status: DocumentPublishStatus;
  readonly record?: PublishedDocumentRecord;
  readonly reason?: string;
}

export async function publishDocumentCandidate(
  candidate: DocumentPublishCandidate,
  port: DocumentPublishPort,
  options: { readonly signal?: AbortSignal } = {}
): Promise<DocumentPublishResult> {
  if (options.signal?.aborted) return { status: 'cancelled' };
  try {
    validateCandidate(candidate);
  } catch (error) {
    return { status: 'rejected', reason: safeError(error) };
  }
  const existing = await port.findByIdempotencyKey(candidate.idempotencyKey);
  if (existing) {
    return existing.checksumSha256 === candidate.checksumSha256
      ? { status: 'idempotent_replay', record: existing }
      : { status: 'revision_conflict', reason: 'idempotency_key_conflict' };
  }
  const currentRevision = await port.readCurrentRevision();
  if (currentRevision !== candidate.expectedRevision) {
    return { status: 'revision_conflict', reason: 'expected_revision_mismatch' };
  }
  if (options.signal?.aborted) return { status: 'cancelled' };
  const verification = await port.verifyTemporary(candidate);
  if (
    !verification.exists ||
    !verification.packageValid ||
    verification.sizeBytes !== candidate.sizeBytes ||
    verification.checksumSha256 !== candidate.checksumSha256
  ) {
    return { status: 'rejected', reason: 'temporary_verification_failed' };
  }
  if (!candidate.diagnosticsPassed) {
    return { status: 'rejected', reason: 'quality_diagnostics_failed' };
  }
  if (options.signal?.aborted) return { status: 'cancelled' };
  let publishedRevision: number;
  try {
    publishedRevision = (await port.publishAtomic({
      candidate,
      expectedRevision: candidate.expectedRevision
    })).revision;
  } catch (error) {
    const reason = safeError(error);
    return /revision|conflict|stale/i.test(reason)
      ? { status: 'revision_conflict', reason }
      : { status: 'failed', reason };
  }
  try {
    const record = await port.registerWork({ candidate, revision: publishedRevision });
    return { status: 'published', record };
  } catch (error) {
    return { status: 'failed', reason: safeError(error) };
  }
}

function validateCandidate(candidate: DocumentPublishCandidate): void {
  if (!candidate || (candidate.kind !== 'word' && candidate.kind !== 'excel' && candidate.kind !== 'ppt')) throw new TypeError('candidate.kind is invalid');
  if (!safeText(candidate.fileName, 255) || !/\.(docx|xlsx|pptx)$/i.test(candidate.fileName)) throw new TypeError('candidate.fileName is invalid');
  if (!safeText(candidate.temporaryHandle, 500) || !safeText(candidate.finalHandle, 500)) throw new TypeError('candidate handles are invalid');
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0 || candidate.sizeBytes > 64 * 1024 * 1024) throw new TypeError('candidate.sizeBytes is invalid');
  if (!/^[a-f0-9]{64}$/i.test(candidate.checksumSha256)) throw new TypeError('candidate.checksumSha256 is invalid');
  if (!Number.isSafeInteger(candidate.expectedRevision) || candidate.expectedRevision < 0) throw new TypeError('candidate.expectedRevision is invalid');
  if (!safeText(candidate.idempotencyKey, 200) || !safeText(candidate.contentFingerprint, 200)) throw new TypeError('candidate identity is invalid');
  if (typeof candidate.diagnosticsPassed !== 'boolean') throw new TypeError('candidate.diagnosticsPassed is invalid');
}

function safeText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) return false;
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/i.test(value)) return false;
  if (/(?:api[_-]?key|token|secret|password|credential)/i.test(value)) return false;
  return true;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}
