import { describe, expect, it } from 'vitest';
import {
  publishDocumentCandidate,
  type DocumentPublishCandidate,
  type DocumentPublishPort
} from '../../src/platform/documents';

const candidate: DocumentPublishCandidate = {
  kind: 'ppt',
  fileName: '报告.pptx',
  temporaryHandle: 'temporary-document-1',
  finalHandle: 'final-document-1',
  sizeBytes: 128,
  checksumSha256: 'a'.repeat(64),
  expectedRevision: 3,
  idempotencyKey: 'revision-3-request-1',
  contentFingerprint: 'outline-fingerprint-1',
  diagnosticsPassed: true
};

function port(overrides: Partial<DocumentPublishPort> = {}): DocumentPublishPort {
  return {
    readCurrentRevision: async () => 3,
    findByIdempotencyKey: async () => undefined,
    verifyTemporary: async () => ({ exists: true, sizeBytes: 128, checksumSha256: 'a'.repeat(64), packageValid: true }),
    publishAtomic: async () => ({ revision: 4 }),
    registerWork: async () => ({ workId: 'work-1', idempotencyKey: candidate.idempotencyKey, checksumSha256: candidate.checksumSha256, revision: 4 }),
    ...overrides
  };
}

describe('document atomic publish workflow', () => {
  it('verifies, publishes atomically and registers only after all checks pass', async () => {
    const calls: string[] = [];
    const result = await publishDocumentCandidate(candidate, port({
      verifyTemporary: async () => { calls.push('verify'); return { exists: true, sizeBytes: 128, checksumSha256: 'a'.repeat(64), packageValid: true }; },
      publishAtomic: async () => { calls.push('publish'); return { revision: 4 }; },
      registerWork: async () => { calls.push('register'); return { workId: 'work-1', idempotencyKey: candidate.idempotencyKey, checksumSha256: candidate.checksumSha256, revision: 4 }; }
    }));
    expect(result.status).toBe('published');
    expect(calls).toEqual(['verify', 'publish', 'register']);
  });

  it('is idempotent and rejects stale revisions or invalid temporary files', async () => {
    const replay = await publishDocumentCandidate(candidate, port({
      findByIdempotencyKey: async () => ({ workId: 'work-1', idempotencyKey: candidate.idempotencyKey, checksumSha256: candidate.checksumSha256, revision: 4 })
    }));
    expect(replay.status).toBe('idempotent_replay');

    const conflict = await publishDocumentCandidate(candidate, port({ readCurrentRevision: async () => 2 }));
    expect(conflict.status).toBe('revision_conflict');
    const invalid = await publishDocumentCandidate(candidate, port({ verifyTemporary: async () => ({ exists: true, sizeBytes: 3, checksumSha256: 'b'.repeat(64), packageValid: false }) }));
    expect(invalid.status).toBe('rejected');
  });

  it('does not publish when diagnostics fail, cancellation arrives, or candidate is unsafe', async () => {
    let published = false;
    const failed = await publishDocumentCandidate({ ...candidate, diagnosticsPassed: false }, port({ publishAtomic: async () => { published = true; return { revision: 4 }; } }));
    expect(failed.status).toBe('rejected');
    expect(published).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await publishDocumentCandidate(candidate, port(), { signal: controller.signal });
    expect(cancelled.status).toBe('cancelled');
    const unsafe = await publishDocumentCandidate({ ...candidate, temporaryHandle: 'C:\\private\\draft.tmp' }, port());
    expect(unsafe.status).toBe('rejected');
  });
});
