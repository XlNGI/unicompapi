import { describe, expect, it, vi } from 'vitest';
import { DocumentGenerationRuntimeBridge } from '../../src/application/document-generation-runtime-bridge';
import type { DocumentGenerationProgressEvent } from '../../src/application/document-generation-service';
import type { DocumentTaskRuntimeScope } from '../../src/application/document-task-runtime-service';
import type { DocumentToolObservation } from '../../src/domain';
import { toConversationId, toDocumentTaskRuntimeId, toProjectId, toWorkId } from '../../src/domain';

type FakeCall = { id: string; toolId: string; step: number; status?: string };
type FakeRuntime = { status: string; checkpoint: { step: number }; toolCalls: FakeCall[]; observations: DocumentToolObservation[] };

describe('document generation runtime bridge', () => {
  it('persists each real generation operation before allowing formal completion', async () => {
    const runtime: FakeRuntime = {
      status: 'running',
      checkpoint: { step: 0 },
      toolCalls: [],
      observations: []
    };
    const beginToolCall = vi.fn(async (_scope: DocumentTaskRuntimeScope, input: { callId: string; toolId: string }) => {
      runtime.checkpoint = { step: runtime.checkpoint.step + 1 };
      runtime.toolCalls.push({ id: input.callId, toolId: input.toolId, step: runtime.checkpoint.step });
      return { runtime: structuredClone(runtime), execute: true };
    });
    const recordObservation = vi.fn(async (_scope: DocumentTaskRuntimeScope, callId: string, observation: DocumentToolObservation) => {
      runtime.observations.push(observation);
      const call = runtime.toolCalls.find((item) => item.id === callId);
      if (call) call.status = observation.ok ? 'completed' : 'failed';
      return structuredClone(runtime);
    });
    const complete = vi.fn(async () => { runtime.status = 'completed'; });
    const service = { start: vi.fn(), require: vi.fn(async () => runtime), beginToolCall, recordObservation, complete, setStatus: vi.fn() } as unknown as ConstructorParameters<typeof DocumentGenerationRuntimeBridge>[0];
    const bridge = new DocumentGenerationRuntimeBridge(service, {
      id: toDocumentTaskRuntimeId('runtime-1'), projectId: toProjectId('project-1'), conversationId: toConversationId('conversation-1'), executionId: 'execution-1'
    }, 'execution-1');
    const start: DocumentGenerationProgressEvent = {
      code: 'document_render', status: 'started', operationId: 'render-1', facts: { documentKind: 'ppt' }
    };
    const done: DocumentGenerationProgressEvent = { ...start, status: 'completed' };

    await bridge.start();
    await bridge.progress(start);
    await bridge.progress(done);
    await bridge.complete(toWorkId('work-1'));

    expect(beginToolCall).toHaveBeenCalledOnce();
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      toolId: 'render_preview', ok: true
    }));
    expect(complete).toHaveBeenCalledWith(expect.anything(), 'work-1');
  });

  it('does not invent a completion when a generation operation is still unsettled', async () => {
    const runtime: FakeRuntime = { status: 'running', checkpoint: { step: 0 }, toolCalls: [], observations: [] };
    const service = {
      require: vi.fn(async () => runtime),
      beginToolCall: vi.fn(async () => ({ runtime: { checkpoint: { step: 1 } }, execute: true })),
      setStatus: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof DocumentGenerationRuntimeBridge>[0];
    const bridge = new DocumentGenerationRuntimeBridge(service, {
      id: toDocumentTaskRuntimeId('runtime-2'), projectId: toProjectId('project-1'), conversationId: toConversationId('conversation-1'), executionId: 'execution-2'
    }, 'execution-2');
    await bridge.progress({ code: 'document_check', status: 'started', operationId: 'check-1', facts: { documentKind: 'ppt' } });
    await bridge.complete(toWorkId('work-2'));
    expect(service.setStatus).toHaveBeenCalledWith(expect.anything(), 'failed');
  });
});
