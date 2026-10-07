import { describe, expect, it, vi } from 'vitest';
import { createGeneratePptxBinding } from '../../src/application/generate-pptx-tool';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import type { DocumentAtomicExecutionContext } from '../../src/application/document-atomic-tools';
import { createCanonicalToolRegistry, validateDocumentToolResult } from '../../src/domain/entities/canonical-tool-contract';
import { sanitizeControlledToolResult } from '../../src/platform/providers/provider-tool-calling';
import type { PresentationPageRequirement } from '../../src/domain/entities/presentation-page-requirement';
import { DocumentDraftCompilationError, DocumentGenerationApplicationError,
  type DocumentGenerationExecutionInput } from '../../src/application/document-generation-service';

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
  it('rejects an invalid draft before execution and omits private compiler errors', async () => {
    const run = vi.fn();
    const binding = createGeneratePptxBinding({ compiler: { compile: () => {
      throw new DocumentDraftCompilationError('invalid_structure', 'PRIVATE_SOURCE_AND_PROMPT');
    } } as never, executor: { run } as never, revalidateAuthorization: async () => true });
    const result = await binding.preflight!(args(), { ...context(), callId: 'invalid', idempotencyKey: 'invalid' });
    expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'invalid_outline' }] });
    expect(() => validateDocumentToolResult(binding.contract, result)).not.toThrow();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE');
    expect(run).not.toHaveBeenCalled();
  });

  it('gives one page-plan feedback then permits an explicit target deviation without padding or duplicate compilation', async () => {
    const shortOutline: DocumentOutline = { ...outline, sections: Array.from({ length: 4 }, (_, index) =>
      ({ ...outline.sections[0], heading: `Fact ${index + 1}` })) };
    const compile = vi.fn(() => shortOutline);
    const pageCountAssessment = { actualPages: 6, actualTotalPages: 6, targetPages: 12,
      countBasis: 'total' as const, mode: 'target' as const, satisfied: false, blocking: false };
    const run = vi.fn(async (_input: DocumentGenerationExecutionInput) => ({ taskId: 'task', executionId: 'exec', workId: 'work',
      fileName: 'deck.pptx', sizeBytes: 123, pageCountAssessment }));
    const binding = createGeneratePptxBinding({ compiler: { compile } as never, executor: { run } as never,
      pageRequirement: { mode: 'target', targetPages: 12, countBasis: 'total' }, revalidateAuthorization: async () => true });
    const firstContext = { ...context(), callId: 'planning-1', idempotencyKey: 'planning-1' };
    const feedback = await binding.preflight!({ ...args(), requestedTotalPages: 6 }, firstContext);
    expect(feedback).toMatchObject({ status: 'failed', diagnostics: [{ code: 'page_plan_incomplete' }],
      observation: { planningTargetTotalPages: 12, plannedTotalPages: 6, plannedBodySections: 4,
        systemGeneratedPages: 2, planningFeedbackRemaining: 0, planningTargetIsBlocking: false } });
    expect(() => validateDocumentToolResult(binding.contract, feedback)).not.toThrow();
    expect(run).not.toHaveBeenCalled();
    const secondContext = { ...firstContext, callId: 'planning-2', idempotencyKey: 'planning-2' };
    expect(await binding.preflight!({ ...args(), requestedTotalPages: 6 }, secondContext)).toBeUndefined();
    expect(await binding.execute({ ...args(), requestedTotalPages: 6 }, secondContext)).toMatchObject({ status: 'success',
      observation: { pageCount: 6, planningTargetTotalPages: 12 }, diagnostics: [{ code: 'page_count_deviation' }] });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ outline: shortOutline, requestedTotalPages: 12 });
    expect(shortOutline.sections).toHaveLength(4);
  });

  it('accepts an improved body plan while leaving explicit exact counts to the physical output gate', async () => {
    const expandedOutline: DocumentOutline = { ...outline, sections: Array.from({ length: 10 }, (_, index) =>
      ({ ...outline.sections[0], heading: `Distinct topic ${index + 1}` })) };
    const compile = vi.fn(() => expandedOutline), run = vi.fn(async () => {
      throw new DocumentGenerationApplicationError('page_count_mismatch', 'Actual pagination does not match');
    });
    const binding = createGeneratePptxBinding({ compiler: { compile } as never, executor: { run } as never,
      pageRequirement: { mode: 'exact', targetPages: 12, countBasis: 'total' }, revalidateAuthorization: async () => true });
    const ownedContext = { ...context(), callId: 'exact', idempotencyKey: 'exact' };
    expect(await binding.preflight!(args(), ownedContext)).toBeUndefined();
    expect(await binding.execute(args(), ownedContext)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'page_count_mismatch' }] });
    expect(compile).toHaveBeenCalledOnce();
  });

  it('rechecks live authorization after a cached plan and never executes after revocation', async () => {
    let permitted = true;
    const compile = vi.fn(() => outline), run = vi.fn();
    const binding = createGeneratePptxBinding({ compiler: { compile } as never, executor: { run } as never,
      revalidateAuthorization: async () => permitted });
    const ownedContext = { ...context(), callId: 'revoked', idempotencyKey: 'revoked' };
    expect(await binding.preflight!(args(), ownedContext)).toBeUndefined();
    permitted = false;
    expect(await binding.execute(args(), ownedContext)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'authorization_or_revision_invalid' }] });
    expect(run).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledOnce();
  });

  it('stores a body-page target as a total-page receipt only after the executor publishes', async () => {
    const pageCountAssessment = { actualPages: 4, actualTotalPages: 6, targetPages: 10,
      countBasis: 'content' as const, mode: 'target' as const, satisfied: false, blocking: false };
    const binding = createGeneratePptxBinding({ compiler: { compile: () => outline } as never,
      executor: { run: async () => ({ taskId: 'task', executionId: 'exec', workId: 'work', fileName: 'deck.pptx',
        sizeBytes: 123, pageCountAssessment }) } as never, revalidateAuthorization: async () => true });
    const result = await binding.execute(args(), { ...context(), callId: 'body-goal', idempotencyKey: 'body-goal' });
    expect(result).toMatchObject({ status: 'success', observation: { pageCount: 6, planningTargetTotalPages: 12 } });
    expect(() => validateDocumentToolResult(binding.contract, result)).not.toThrow();
  });

  it.each([
    { mode: 'target', targetPages: 10, countBasis: 'total' },
    { mode: 'exact', targetPages: 10, countBasis: 'total' },
    { mode: 'max', targetPages: 10, maximumPages: 10, countBasis: 'total' },
    { mode: 'range', targetPages: 10, minimumPages: 8, maximumPages: 12, countBasis: 'total' }
  ] satisfies PresentationPageRequirement[])('pins the host-owned $mode requirement despite model/factory page numbers', async pageRequirement => {
    const run = vi.fn(async (_input) => ({ taskId: 'task', executionId: 'exec', workId: 'work', fileName: 'deck.pptx', sizeBytes: 123 }));
    const binding = createGeneratePptxBinding({ compiler: { compile: () => outline, recover: () => outline }, executor: { run } as never,
      pageRequirement, revalidateAuthorization: async () => true,
      createExecutionInput: () => ({ requestedTotalPages: 20 } as never) });
    const result = await binding.execute({ ...args(), requestedTotalPages: 8 }, { ...context(), callId: 'call', idempotencyKey: 'key' });
    expect(result.status).toBe('success');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ pageRequirement, requestedTotalPages: 10 }));
  });

  it('treats a model-only requested number as a target and returns a safe deviation warning after real publication', async () => {
    const pageCountAssessment = { actualPages: 12, actualTotalPages: 12, targetPages: 10,
      countBasis: 'total' as const, mode: 'target' as const, satisfied: false, blocking: false };
    const run = vi.fn(async (_input) => ({ taskId: 'task-private', executionId: 'exec-private', workId: 'work-private',
      fileName: 'deck.pptx', sizeBytes: 123, pageCountAssessment }));
    const binding = createGeneratePptxBinding({ compiler: { compile: () => outline, recover: () => outline }, executor: { run } as never,
      revalidateAuthorization: async () => true });
    const result = await binding.execute({ ...args(), requestedTotalPages: 10 }, { ...context(), callId: 'call', idempotencyKey: 'key' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ pageRequirement: { mode: 'target', targetPages: 10, countBasis: 'total' } }));
    expect(result).toMatchObject({ status: 'success', observation: { generated: true, pageCount: 12, pageCountAssessment },
      diagnostics: [{ code: 'page_count_deviation', severity: 'warning' }] });
    const contract = createCanonicalToolRegistry().get('generate_pptx')!;
    expect(() => validateDocumentToolResult(contract, result)).not.toThrow();
    const wire = sanitizeControlledToolResult({ ...result, metadata: { toolId: 'generate_pptx' } });
    expect(wire).toMatchObject({ status: 'success', observation: { pageCount: 12, pageCountAssessment: { targetPages: 10 } } });
    expect(JSON.stringify(wire)).not.toMatch(/task-private|exec-private|work-private/);
  });

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
