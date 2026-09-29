import { describe, expect, it, vi } from 'vitest';
import { createAddSlideBinding } from '../../src/application/add-slide-tool';
import type { DocumentMutationCoordinator, DocumentMutationResult } from '../../src/application/document-mutation-coordinator';
import type { DocumentAtomicExecutionContext } from '../../src/application/document-atomic-tools';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';

const pin: DocumentVersionPin = {
  documentLineageId: 'lineage-p4-test', headWorkId: 'work-p4-1', fileId: 'file-p4-1',
  sourceExecutionId: 'execution-p4-1', checksumSha256: 'a'.repeat(64), runtimeRevision: 1, identityIndexVersion: 1
};

function context(idempotencyKey = 'stable-slide-key', signal = new AbortController().signal): DocumentAtomicExecutionContext {
  return {
    callId: 'provider-call', idempotencyKey, currentDocumentId: pin.headWorkId,
    currentDocumentIR: { operation: 'edit', attachmentRefs: [] }, revision: 1, operation: 'edit',
    capabilities: ['add_slide'], projectContext: { projectId: 'project-p4' },
    authorization: { canRead: true, canWrite: true, allowedToolIds: ['add_slide'] },
    abortSignal: signal, taskContext: { taskId: 'task-p4' }
  };
}

function committed(contextValue: DocumentAtomicExecutionContext): DocumentMutationResult {
  return {
    status: 'session_refreshed',
    record: { schemaVersion: 1, mutationId: 'mutation-p4', idempotencyKey: contextValue.idempotencyKey,
      state: 'session_refreshed', basePin: pin, patchFingerprint: 'b'.repeat(64) },
    candidate: { pin: { ...pin, headWorkId: 'work-p4-2', fileId: 'file-p4-2', sourceExecutionId: 'execution-p4-2', runtimeRevision: 2, checksumSha256: 'c'.repeat(64) },
      buffer: new Uint8Array([1]), identity: { schemaVersion: 1, documentLineageId: pin.documentLineageId, workId: 'work-p4-2', fileId: 'file-p4-2', sourceExecutionId: 'execution-p4-2', identityIndexVersion: 1, revision: 2, artifactChecksumSha256: 'c'.repeat(64), pages: [], elements: [], tombstones: [] }, workId: 'work-p4-2' }
  } as unknown as DocumentMutationResult;
}

describe('P4 add_slide binding', () => {
  it('creates the page identity in the host and keeps provider arguments narrow', async () => {
    const mutate = vi.fn(async (_input: { readonly expectedPin: DocumentVersionPin; readonly patch: unknown }) => committed(context('stable-slide-key')));
    const binding = createAddSlideBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator,
      resolveVersionPin: async () => pin, revalidateAuthorization: async () => true });
    const result = await binding.execute({ position: 'after', referencePageId: 'page-reference', title: '市场机会' }, context());
    expect(result).toMatchObject({ status: 'success', observation: { operation: 'slide_added', pageId: expect.stringMatching(/^page-[a-f0-9]{48}$/u) } });
    const patch = mutate.mock.calls[0]?.[0].patch as { operations: [{ pageId: string; titleElementId?: string }] };
    expect(patch.operations[0].pageId).toMatch(/^page-[a-f0-9]{48}$/u);
    expect(patch.operations[0].titleElementId).toMatch(/^element-[a-f0-9]{48}$/u);
    expect(JSON.stringify(result)).not.toMatch(/work-p4|file-p4|checksum|Runtime|slidePart|shapeId/);
  });

  it('reuses one host identity for an idempotent retry and cancels before mutation', async () => {
    const mutate = vi.fn(async () => committed(context()));
    const binding = createAddSlideBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator,
      resolveVersionPin: async () => pin, revalidateAuthorization: async () => true });
    const first = await binding.execute({ position: 'end', title: '新增' }, context());
    const retry = await binding.execute({ position: 'end', title: '新增' }, { ...context(), callId: 'retry-call' });
    expect((retry.observation as { pageId: string }).pageId).toBe((first.observation as { pageId: string }).pageId);
    const mutationCalls = mutate.mock.calls as unknown as Array<[{ readonly mutationId: string }] >;
    expect(mutationCalls[0]?.[0]?.mutationId).toBe(mutationCalls[1]?.[0]?.mutationId);
    const controller = new AbortController();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const cancelledBinding = createAddSlideBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator,
      resolveVersionPin: async () => { await wait; return pin; }, revalidateAuthorization: async () => true });
    const pending = cancelledBinding.execute({ position: 'end' }, context('cancel-key', controller.signal));
    controller.abort(); release();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  });
});
