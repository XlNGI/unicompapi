import { describe, expect, it, vi } from 'vitest';
import { createUpdateElementBinding } from '../../src/application/update-element-tool';
import type { DocumentMutationCoordinator, DocumentMutationResult } from '../../src/application/document-mutation-coordinator';
import type { DocumentAtomicExecutionContext } from '../../src/application/document-atomic-tools';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';

const pin: DocumentVersionPin = { documentLineageId: 'lineage-test', headWorkId: 'work-update-1', fileId: 'file-update-1',
  sourceExecutionId: 'execution-update-1', checksumSha256: 'a'.repeat(64), runtimeRevision: 1, identityIndexVersion: 1 };

function fixture() {
  const context: DocumentAtomicExecutionContext = {
    callId: 'call-update-1', idempotencyKey: 'call-update-1', currentDocumentId: 'work-update-1',
    currentDocumentIR: { operation: 'edit', attachmentRefs: [] }, revision: 1, operation: 'edit', capabilities: ['update_element'],
    projectContext: { projectId: 'project-update' }, authorization: { canRead: true, canWrite: true, allowedToolIds: ['update_element'] },
    abortSignal: new AbortController().signal, taskContext: { taskId: 'task-update-1' }
  };
  const result: DocumentMutationResult = { status: 'session_refreshed', record: { schemaVersion: 1, mutationId: 'mutation-test',
    idempotencyKey: context.idempotencyKey, state: 'session_refreshed', basePin: pin, patchFingerprint: 'b'.repeat(64) } };
  const updateText = vi.fn(async () => result);
  const resolveVersionPin = vi.fn(async () => pin);
  const revalidateAuthorization = vi.fn(async () => true);
  const binding = createUpdateElementBinding({ coordinator: { updateText } as unknown as DocumentMutationCoordinator, resolveVersionPin, revalidateAuthorization });
  return { context, result, updateText, resolveVersionPin, revalidateAuthorization, binding };
}

describe('update_element runtime binding', () => {
  it('accepts only business arguments and injects the captured Runtime pin and cancellation', async () => {
    const { binding, context, updateText } = fixture();
    expect(Object.keys(binding.contract.input.fields).sort()).toEqual(['elementId', 'text']);
    const result = await binding.execute({ elementId: 'element-public', text: '新文本' }, context);
    expect(result).toMatchObject({ status: 'success', observation: { elementId: 'element-public', changed: true, field: 'text' },
      irPatch: { schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId: 'element-public' }, text: '新文本' }] } });
    expect(updateText).toHaveBeenCalledWith(expect.objectContaining({ expectedPin: pin, signal: context.abortSignal,
      idempotencyKey: expect.stringMatching(/^mutation-[a-f0-9]{64}$/u), authorize: expect.any(Function) }));
    expect(result.artifactRefs).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/lineage-test|work-update|execution-update|file-update/);
  });

  it.each(['revision', 'workId', 'documentId', 'filePath', 'slidePart', 'shapeId', 'rootDirectory'])('rejects model-supplied internal %s', async key => {
    const { binding, context, updateText } = fixture();
    const result = await binding.execute({ elementId: 'element-public', text: '新文本', [key]: 'private' }, context);
    expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'invalid_arguments' }] });
    expect(updateText).not.toHaveBeenCalled();
  });

  it('uses a distinct deterministic mutation identity for each call in the same task', async () => {
    const { binding, context, updateText } = fixture();
    const args = { elementId: 'element-public', text: '新文本' };
    await binding.execute(args, context);
    await binding.execute(args, { ...context, callId: 'call-update-2', idempotencyKey: 'call-update-2' });
    await binding.execute(args, context);
    const calls = updateText.mock.calls as unknown as Array<[{ mutationId: string; idempotencyKey: string }]>;
    expect(calls[0][0].mutationId).toMatch(/^mutation-[a-f0-9]{64}$/u);
    expect(calls[0][0].mutationId).not.toBe(calls[1][0].mutationId);
    expect(calls[0][0].mutationId).toBe(calls[2][0].mutationId);
    expect(calls[0][0].idempotencyKey).toBe(calls[0][0].mutationId);
  });

  it('does not invoke the coordinator after authorization is revoked', async () => {
    const { binding, context, updateText, revalidateAuthorization } = fixture();
    expect(await binding.authorize({ elementId: 'element-public', text: 'x' }, context)).toBe(true);
    revalidateAuthorization.mockResolvedValue(false);
    expect(await binding.execute({ elementId: 'element-public', text: 'x' }, context)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'authorization_denied' }] });
    expect(updateText).not.toHaveBeenCalled();
  });

  it('does not silently rebase a stale Runtime context to the new head', async () => {
    const { binding, context, updateText, resolveVersionPin } = fixture();
    resolveVersionPin.mockResolvedValue({ ...pin, runtimeRevision: 2 });
    expect(await binding.execute({ elementId: 'element-public', text: 'x' }, context)).toMatchObject({ diagnostics: [{ code: 'revision_conflict' }] });
    expect(updateText).not.toHaveBeenCalled();
  });

  it('does not start a mutation when cancellation wins before adapter execution', async () => {
    const { binding, context, updateText } = fixture();
    const controller = new AbortController(); controller.abort();
    expect(await binding.execute({ elementId: 'element-public', text: 'x' }, { ...context, abortSignal: controller.signal })).toMatchObject({ status: 'cancelled' });
    expect(updateText).not.toHaveBeenCalled();
  });

  it('preserves the committed fact when Session refresh did not complete', async () => {
    const { binding, context, updateText, result } = fixture();
    updateText.mockResolvedValue({ ...result, status: 'committed_pending_refresh' });
    expect(await binding.execute({ elementId: 'element-public', text: 'x' }, context)).toMatchObject({ status: 'unknown',
      observation: { changed: true, elementId: 'element-public', mutationState: 'committed_pending_refresh' },
      diagnostics: [{ code: 'committed_pending_refresh' }] });
  });

  it('maps durable uncertainty to unknown rather than a retryable failed write', async () => {
    const { binding, context, updateText, result } = fixture();
    updateText.mockResolvedValue({ ...result, status: 'reconciliation_required' });
    expect(await binding.execute({ elementId: 'element-public', text: 'x' }, context)).toMatchObject({ status: 'unknown', diagnostics: [{ code: 'reconciliation_required' }] });
  });
});
