import { describe, expect, it } from 'vitest';
import {
  assessLocalDocumentIntent,
  buildLocalDocumentIntentPlan
} from '../../src/application';

describe('local document intent planner', () => {
  it('keeps ordinary chat on the high-confidence local path', () => {
    const plan = buildLocalDocumentIntentPlan('今天给大家加油');
    expect(plan.task).toBe('chat');
    expect(assessLocalDocumentIntent('今天给大家加油').readiness).toBe('ready');
  });

  it('maps a clear document request without exposing message identifiers', () => {
    const plan = buildLocalDocumentIntentPlan('帮我做一份季度经营汇报 PPT');
    expect(plan).toMatchObject({
      task: 'create',
      documentKind: 'ppt',
      confidence: 'high'
    });
    expect(plan).not.toHaveProperty('targetMessageId');
  });

  it('marks a revision without a local target as clarification', () => {
    const plan = buildLocalDocumentIntentPlan('把刚才的 PPT 第二页改成时间线');
    expect(plan.task).toBe('revise');
    expect(plan.missing.length).toBeGreaterThan(0);
    expect(assessLocalDocumentIntent('把刚才的 PPT 第二页改成时间线').readiness).toBe(
      'needs_clarification'
    );
  });

  it('resolves a target as a safe name hint, never as an internal id', () => {
    const context = {
      documents: [
        { messageId: 'message-secret', kind: 'ppt' as const, fileName: '季度汇报.pptx' }
      ]
    };
    const plan = buildLocalDocumentIntentPlan('把季度汇报.pptx的结论页改简洁', context);
    expect(plan.target).toEqual({ documentName: '季度汇报.pptx' });
    expect(JSON.stringify(plan)).not.toContain('message-secret');
  });
});
