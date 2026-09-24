import { describe, expect, it } from 'vitest';
import { runBoundedRepairWorkflow, type DocumentQualityDiagnostic } from '../../src/platform/documents';

const outline = {
  kind: 'word' as const,
  title: '报告',
  sections: [{
    heading: '摘要',
    level: 1 as const,
    blocks: [{ type: 'paragraph' as const, text: '过长内容' }]
  }]
};
const error: DocumentQualityDiagnostic = { code: 'capacity_exceeded', severity: 'error', scope: 'sections[0]', message: 'overflow' };

describe('bounded repair workflow', () => {
  it('stops without changing the document when no LLM repair planner is present', async () => {
    let diagnosed = 0;
    const result = await runBoundedRepairWorkflow({
      outline,
      diagnostics: [error],
      diagnose: () => {
        diagnosed += 1;
        return [error];
      }
    });
    expect(result.status).toBe('needs_user');
    expect(diagnosed).toBe(0);
    expect(result.outline).toEqual(outline);
    expect(result.summaries).toEqual([]);
  });

  it('validates the LLM RepairPlan and detects repeated diagnostics', async () => {
    let plans = 0;
    const result = await runBoundedRepairWorkflow({
      outline,
      diagnostics: [error],
      maxAttempts: 3,
      diagnose: () => [error],
      nextRepairPlan: async () => {
        plans += 1;
        return {
          kind: 'repair', diagnosisCodes: ['capacity_exceeded'],
          operations: [{ operation: 'replace_text', target: { sectionIndex: 0, blockIndex: 0 }, value: 'still overflow' }],
          preserve: [], reason: 'retry', expectedRevision: 2
        };
      },
      expectedRevision: 2
    });
    expect(result.status).toBe('repeated_diagnosis');
    expect(plans).toBe(1);
  });

  it('fails closed on revision mismatch and honours cancellation', async () => {
    const failed = await runBoundedRepairWorkflow({
      outline, diagnostics: [error], diagnose: () => [], expectedRevision: 1,
      nextRepairPlan: async () => ({
        kind: 'repair', diagnosisCodes: ['capacity_exceeded'],
        operations: [{ operation: 'replace_text', target: { sectionIndex: 0, blockIndex: 0 }, value: 'x' }],
        preserve: [], reason: 'retry', expectedRevision: 2
      })
    });
    expect(failed.status).toBe('failed');
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runBoundedRepairWorkflow({ outline, diagnostics: [error], diagnose: () => [], signal: controller.signal });
    expect(cancelled.status).toBe('cancelled');
  });
});
