import { describe, expect, it, vi } from 'vitest';
import { createGeneratePptxBinding } from '../../src/application/generate-pptx-tool';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import type { DocumentAtomicExecutionContext } from '../../src/application/document-atomic-tools';

const outline: DocumentOutline = {
  kind: 'ppt', title: 'Test deck', sections: [{ heading: 'Summary', level: 1,
    blocks: [{ type: 'paragraph', text: 'Hello' }] }]
};

function context(overrides: Partial<DocumentAtomicExecutionContext> = {}): DocumentAtomicExecutionContext {
  const controller = new AbortController();
  return {
    operation: 'create', capabilities: ['generate_pptx'],
    projectContext: { projectId: 'project-test' },
    authorization: { canRead: true, canWrite: true, allowedToolIds: ['generate_pptx'], generationAuthorization: 'approved' },
    abortSignal: controller.signal,
    taskContext: { taskId: 'task-generate-1', checkpoint: { revision: 0, step: 0 } },
    ...overrides
  } as DocumentAtomicExecutionContext;
}

function args() {
  return { title: 'Test deck', content: '# Summary\nHello', theme: 'blueprint', presentationTemplate: 'work_report' };
}

describe('generate_pptx canonical binding', () => {
  it('compiles business input and delegates runtime-owned execution fields', async () => {
    const run = vi.fn(async (_input) => ({ taskId: 'task-generate-1', executionId: 'exec-1', workId: 'work-1', fileName: 'deck.pptx', sizeBytes: 123 }));
    const binding = createGeneratePptxBinding({
      compiler: { compile: vi.fn(() => outline) } as never,
      executor: { run } as never,
      revalidateAuthorization: vi.fn(async () => true)
    });
    const result = await binding.execute(args(), { ...context(), callId: 'call-1', idempotencyKey: 'key-1' });
    expect(result).toMatchObject({ status: 'success', observation: { generated: true }, artifactRefs: [{ kind: 'work', ref: 'work-1' }] });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ppt', title: 'Test deck', outline, signal: expect.any(AbortSignal) }));
    const input = run.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty('rootDirectory');
    expect(input).not.toHaveProperty('documentRef');
  });

  it('refuses generation without approved authorization', async () => {
    const run = vi.fn();
    const binding = createGeneratePptxBinding({ compiler: { compile: vi.fn(() => outline) } as never, executor: { run } as never,
      revalidateAuthorization: vi.fn(async () => true) });
    const denied = await binding.authorize(args(), { ...context(), authorization: {
      canRead: true, canWrite: true, allowedToolIds: ['generate_pptx'], generationAuthorization: 'awaiting_user'
    } as never, callId: 'call-1', idempotencyKey: 'key-1' });
    expect(denied).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('requires an explicit approved state even when write permission exists', async () => {
    const binding = createGeneratePptxBinding({ compiler: { compile: vi.fn(() => outline) } as never,
      executor: { run: vi.fn() } as never, revalidateAuthorization: vi.fn(async () => true) });
    const denied = await binding.authorize(args(), { ...context(), authorization: {
      canRead: true, canWrite: true, allowedToolIds: ['generate_pptx']
    } as never, callId: 'call-1', idempotencyKey: 'key-1' });
    expect(denied).toBe(false);
  });

  it('passes cancellation through and reports cancellation without a publish result', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (input: { signal: AbortSignal }) => {
      expect(input.signal.aborted).toBe(true);
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    const binding = createGeneratePptxBinding({ compiler: { compile: vi.fn(() => outline) } as never, executor: { run } as never,
      revalidateAuthorization: vi.fn(async () => true) });
    controller.abort();
    const result = await binding.execute(args(), { ...context({ abortSignal: controller.signal }), callId: 'call-1', idempotencyKey: 'key-1' });
    expect(result).toMatchObject({ status: 'cancelled', diagnostics: [{ code: 'cancelled' }] });
  });

  it('reports a real artifact when stop arrives after the executor registered it', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return { taskId: 'task-generate-1', executionId: 'exec-1', workId: 'work-1', fileName: 'deck.pptx', sizeBytes: 123 };
    });
    const binding = createGeneratePptxBinding({ compiler: { compile: vi.fn(() => outline) } as never,
      executor: { run } as never, revalidateAuthorization: vi.fn(async () => true) });
    const result = await binding.execute(args(), { ...context({ abortSignal: controller.signal }), callId: 'call-1', idempotencyKey: 'key-1' });
    expect(result).toMatchObject({ status: 'success', observation: { generated: true, cancelRequested: true } });
    expect(result.observation).not.toHaveProperty('taskId');
    expect(result.observation).not.toHaveProperty('executionId');
  });

  it('reports a real artifact when cancellation arrives after the executor returns', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return { taskId: 'task-generate-1', executionId: 'exec-1', workId: 'work-1', fileName: 'deck.pptx', sizeBytes: 123 };
    });
    const binding = createGeneratePptxBinding({ compiler: { compile: vi.fn(() => outline) } as never,
      executor: { run } as never, revalidateAuthorization: async () => true });
    const result = await binding.execute(args(), { ...context({ abortSignal: controller.signal }), callId: 'call-1', idempotencyKey: 'key-1' });
    expect(result).toMatchObject({ status: 'success', observation: { generated: true, cancelRequested: true }, artifactRefs: [{ ref: 'work-1' }] });
  });
});
