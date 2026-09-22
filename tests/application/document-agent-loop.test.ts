import { describe, expect, it } from 'vitest';
import { runDocumentAgentLoop } from '../../src/application';

const request = {
  toolId: 'read_document_structure',
  input: { section: 'summary' },
  reason: 'inspect the current structure'
};

describe('bounded document agent loop', () => {
  it('fails closed when a failed-tool observation cannot be persisted', async () => {
    let calls = 0;
    let commits = 0;
    const result = await runDocumentAgentLoop({
      execute: async () => { calls++; throw new Error('read_failed'); },
      onObservation: async () => { commits++; throw new Error('disk_failed'); },
      nextDecision: async () => ({ kind: 'tool', request })
    });
    expect(result).toMatchObject({ state: 'failed', summary: 'agent.checkpoint_failed' });
    expect(calls).toBe(1);
    expect(commits).toBe(1);
    expect(result.observations).toHaveLength(0);
  });

  it('signals execution cancellation on timeout even without an external signal', async () => {
    let toolSignal: AbortSignal | undefined;
    const result = await runDocumentAgentLoop({
      timeoutMs: 10,
      execute: async (_request, context) => {
        toolSignal = context.signal;
        return new Promise(() => undefined);
      },
      nextDecision: async () => ({ kind: 'tool', request })
    });
    expect(result.state).toBe('timeout');
    expect(toolSignal?.aborted).toBe(true);
  });

  it('honours synchronous cancellation inside an executor', async () => {
    const controller = new AbortController();
    const result = await runDocumentAgentLoop({
      signal: controller.signal,
      execute: async () => { controller.abort(); return new Promise(() => undefined); },
      nextDecision: async () => ({ kind: 'tool', request })
    });
    expect(result.state).toBe('cancelled');
  });

  it('keeps prior observations and budget when continuing the next step', async () => {
    let calls = 0;
    const result = await runDocumentAgentLoop({
      budgetUnits: 1,
      initialObservations: [{ step: 1, toolId: 'read_document_structure', ok: true, data: {} }],
      execute: async () => { calls++; return {}; },
      nextDecision: async () => ({ kind: 'tool', request })
    });
    expect(result).toMatchObject({ state: 'budget_exceeded', costUnits: 1, steps: 1 });
    expect(calls).toBe(0);
  });

  it('executes at most one registered tool per round and returns sanitized observations', async () => {
    let calls = 0;
    const result = await runDocumentAgentLoop({
      maxSteps: 3,
      execute: async () => {
        calls += 1;
        return {
          revision: 2,
          path: 'C:\\private\\file.pptx',
          status: 'ok',
          nested: {
            filePath: 'C:\\private\\nested.pptx',
            result: 'safe'
          }
        };
      },
      nextDecision: async (observations) =>
        observations.length === 0
          ? { kind: 'tool', request }
          : { kind: 'complete', summary: 'done' }
    });
    expect(calls).toBe(1);
    expect(result.state).toBe('completed');
    expect(result.observations[0].data).toEqual({
      revision: 2,
      status: 'ok',
      nested: { result: 'safe' }
    });
  });

  it('stops on budget and repeated diagnostics', async () => {
    const budget = await runDocumentAgentLoop({
      budgetUnits: 1,
      execute: async () => ({}),
      nextDecision: async () => ({ kind: 'tool', request: { ...request, toolId: 'apply_document_patch' } })
    });
    expect(budget.state).toBe('budget_exceeded');

    const repeated = await runDocumentAgentLoop({
      maxSteps: 5,
      repeatedDiagnosticLimit: 2,
      execute: async () => { throw new Error('layout overflow'); },
      nextDecision: async () => ({ kind: 'tool', request })
    });
    expect(repeated.state).toBe('repeated_diagnosis');
    expect(repeated.observations).toHaveLength(2);
  });

  it('honours cancellation before invoking the next tool', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runDocumentAgentLoop({
      signal: controller.signal,
      execute: async () => ({}),
      nextDecision: async () => ({ kind: 'tool', request })
    });
    expect(result.state).toBe('cancelled');
    expect(result.steps).toBe(0);
  });

  it('interrupts an in-flight tool when cancellation is requested', async () => {
    const controller = new AbortController();
    const resultPromise = runDocumentAgentLoop({
      signal: controller.signal,
      execute: async () => new Promise(() => undefined),
      nextDecision: async () => ({ kind: 'tool', request })
    });
    setTimeout(() => controller.abort(), 5);

    await expect(resultPromise).resolves.toMatchObject({
      state: 'cancelled',
      steps: 0
    });
  });

  it('enforces a total timeout around model decisions and tool execution', async () => {
    const result = await runDocumentAgentLoop({
      timeoutMs: 5,
      execute: async () => ({}),
      nextDecision: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { kind: 'tool', request };
      }
    });
    expect(result.state).toBe('timeout');
  });

  it('caps a child loop by the parent budget and emits safe ordered progress', async () => {
    const events: { sequence: number; stage: string; status: string; safeCode?: string }[] = [];
    const result = await runDocumentAgentLoop({
      budgetUnits: 8,
      parentBudgetUnits: 1,
      execute: async () => ({}),
      onEvent: (event) => { events.push(event); },
      nextDecision: async () => ({ kind: 'tool', request: { ...request, toolId: 'apply_document_patch' } })
    });
    expect(result.state).toBe('budget_exceeded');
    expect(events.at(-1)).toMatchObject({ stage: 'completed', status: 'failed', safeCode: 'agent.budget_exceeded' });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });
});
