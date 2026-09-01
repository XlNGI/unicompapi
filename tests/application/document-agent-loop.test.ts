import { describe, expect, it } from 'vitest';
import { runDocumentAgentLoop } from '../../src/application';

const request = {
  toolId: 'read_document_structure',
  input: { section: 'summary' },
  reason: 'inspect the current structure'
};

describe('bounded document agent loop', () => {
  it('executes at most one registered tool per round and returns sanitized observations', async () => {
    let calls = 0;
    const result = await runDocumentAgentLoop({
      maxSteps: 3,
      execute: async () => {
        calls += 1;
        return { revision: 2, path: 'C:\\private\\file.pptx', status: 'ok' };
      },
      nextDecision: async (observations) =>
        observations.length === 0
          ? { kind: 'tool', request }
          : { kind: 'complete', summary: 'done' }
    });
    expect(calls).toBe(1);
    expect(result.state).toBe('completed');
    expect(result.observations[0].data).toEqual({ revision: 2, status: 'ok' });
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
});
