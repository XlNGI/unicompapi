import { describe, expect, it, vi } from 'vitest';
import { createAddElementBinding } from '../../src/application/add-element-tool';
import { createDeleteElementBinding } from '../../src/application/delete-element-tool';
import type { DocumentMutationCoordinator, DocumentMutationResult } from '../../src/application/document-mutation-coordinator';
import type { DocumentAtomicExecutionContext } from '../../src/application/document-atomic-tools';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';

const pin: DocumentVersionPin = { documentLineageId: 'lineage-test', headWorkId: 'work-p3-1', fileId: 'file-p3-1', sourceExecutionId: 'execution-p3-1', checksumSha256: 'a'.repeat(64), runtimeRevision: 1, identityIndexVersion: 1 };

function context(toolId: 'add_element' | 'delete_element'): DocumentAtomicExecutionContext {
  return { callId: `call-${toolId}`, idempotencyKey: `call-${toolId}`, currentDocumentId: pin.headWorkId,
    currentDocumentIR: { operation: 'edit', attachmentRefs: [] }, revision: 1, operation: 'edit', capabilities: [toolId],
    projectContext: { projectId: 'project-p3' }, authorization: { canRead: true, canWrite: true, allowedToolIds: [toolId] },
    abortSignal: new AbortController().signal, taskContext: { taskId: `task-${toolId}` } };
}

function result(contextValue: DocumentAtomicExecutionContext): DocumentMutationResult {
  return { status: 'session_refreshed', record: { schemaVersion: 1, mutationId: 'mutation-p3', idempotencyKey: contextValue.idempotencyKey, state: 'session_refreshed', basePin: pin, patchFingerprint: 'b'.repeat(64) } };
}

describe('P3 element mutation bindings', () => {
  it('generates the add identity in the host and never accepts it from the model', async () => {
    const mutate = vi.fn(async () => result(context('add_element')));
    const binding = createAddElementBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator, resolveVersionPin: async () => pin, revalidateAuthorization: async () => true });
    const value = await binding.execute({ pageId: 'page-1', type: 'text', text: '相同文本', placement: 'default' }, context('add_element'));
    expect(value).toMatchObject({ status: 'success', observation: { pageId: 'page-1', operation: 'added' } });
    const observation = value.observation as { elementId: string };
    expect(observation.elementId).toMatch(/^element-[a-f0-9]{48}$/u);
    expect(JSON.stringify(value)).not.toMatch(/work-p3|lineage-test|slidePart|shapeId|revision/);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ expectedPin: pin, signal: expect.anything(), authorize: expect.any(Function), patch: expect.objectContaining({ operations: [expect.objectContaining({ op: 'add_text', elementId: observation.elementId })] }) }));
    expect(await binding.execute({ pageId: 'page-1', type: 'text', text: 'x', elementId: 'model-id' }, context('add_element'))).toMatchObject({ diagnostics: [{ code: 'invalid_arguments' }] });
  });

  it('deletes only the supplied opaque identity and maps cancellation/revocation', async () => {
    const mutate = vi.fn(async () => result(context('delete_element')));
    const auth = vi.fn(async () => true);
    const binding = createDeleteElementBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator, resolveVersionPin: async () => pin, revalidateAuthorization: auth });
    const value = await binding.execute({ elementId: 'element-target' }, context('delete_element'));
    expect(value).toMatchObject({ status: 'success', observation: { elementId: 'element-target', operation: 'deleted' } });
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ patch: { schemaVersion: 1, operations: [{ op: 'delete_element', target: { elementId: 'element-target' } }] } }));
    auth.mockResolvedValue(false);
    expect(await binding.execute({ elementId: 'element-target' }, context('delete_element'))).toMatchObject({ diagnostics: [{ code: 'authorization_denied' }] });
    const controller = new AbortController(); controller.abort();
    expect(await binding.execute({ elementId: 'element-target' }, { ...context('delete_element'), abortSignal: controller.signal })).toMatchObject({ status: 'cancelled' });
  });

  it('reuses the Host idempotency key for add retries and does not allocate another identity', async () => {
    const mutate = vi.fn(async () => result(context('add_element')));
    const binding = createAddElementBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator,
      resolveVersionPin: async () => pin, revalidateAuthorization: async () => true });
    const firstContext = { ...context('add_element'), callId: 'provider-call-a', idempotencyKey: 'stable-add-key' };
    const retryContext = { ...firstContext, callId: 'provider-call-b' };
    const first = await binding.execute({ pageId: 'page-1', type: 'text', text: '重试文本', placement: 'default' }, firstContext);
    const retry = await binding.execute({ pageId: 'page-1', type: 'text', text: '重试文本', placement: 'default' }, retryContext);
    expect(retry.observation?.elementId).toBe(first.observation?.elementId);
    const calls = mutate.mock.calls as unknown as Array<[{ readonly mutationId: string }]>;
    expect(calls[0]?.[0].mutationId).toBe(calls[1]?.[0].mutationId);
  });

  it('does not allocate an add identity when cancellation arrives after pin resolution', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const resolved = new Promise<void>(resolve => { release = resolve; });
    const mutate = vi.fn(async () => result(context('add_element')));
    const binding = createAddElementBinding({ coordinator: { mutate } as unknown as DocumentMutationCoordinator,
      resolveVersionPin: async () => { await resolved; return pin; }, revalidateAuthorization: async () => true });
    const pending = binding.execute({ pageId: 'page-1', type: 'text', text: '取消文本', placement: 'default' },
      { ...context('add_element'), abortSignal: controller.signal });
    controller.abort();
    release();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(mutate).not.toHaveBeenCalled();
  });
});
