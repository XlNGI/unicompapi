import { describe, expect, it } from 'vitest';
import {
  createConversationWorkflow, parseConversationIntentPlan, parseConversationWorkflow,
  toConversationId, toConversationWorkflowId, toIsoTimestamp, toMessageId, toProjectId
} from '../../src/domain';

const plan = {
  schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'word',
  deliverables: ['word', 'ppt'], parameters: {}, sourcePolicy: 'none',
  missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false
};

describe('Office conversation deliverables contract', () => {
  it.each([
    [], ['word', 'word'], ['word', 'ppt', 'excel', 'word'], ['image'], ['ppt']
  ].map((deliverables) => ({ deliverables })))('rejects an empty, duplicate, unsupported, oversized or inactive output list $deliverables', ({ deliverables }) => {
    expect(() => parseConversationIntentPlan({ ...plan, deliverables })).toThrow();
  });

  it('persists only registered document completions and rejects invented fields', () => {
    const workflow = createConversationWorkflow({
      id: toConversationWorkflowId('workflow-deliverables'), conversationId: toConversationId('conversation-deliverables'),
      projectId: toProjectId('project-deliverables'), sourceMessageId: toMessageId('message-deliverables'),
      plan: parseConversationIntentPlan(plan), createdAt: toIsoTimestamp('2026-09-09T00:00:00.000Z')
    });
    expect(workflow.deliveries).toEqual([{ kind: 'word', status: 'pending' }, { kind: 'ppt', status: 'pending' }]);
    expect(() => parseConversationWorkflow({ ...workflow, deliveries: [{ kind: 'word', status: 'completed' }] })).toThrow('registered work');
    expect(() => parseConversationWorkflow({ ...workflow, deliveries: [{ kind: 'word', status: 'pending', outputPath: 'arbitrary' }] })).toThrow('unsupported');
  });
});

describe('compound conversation steps contract', () => {
  const base = {
    schemaVersion: 1,
    kind: 'document' as const,
    action: 'create' as const,
    documentKind: 'ppt' as const,
    parameters: { topic: '销售分析' },
    sourcePolicy: 'internal' as const,
    missing: [],
    ambiguities: [],
    confidence: 'high' as const,
    needsConfirmation: false
  };

  it('accepts ordered steps and preserves dependencies', () => {
    const plan = parseConversationIntentPlan({
      ...base,
      steps: [
        { stepId: 'retrieve', kind: 'document', action: 'analyze', documentKind: 'auto', dependsOn: [], parameters: { topic: '销售表' }, sourcePolicy: 'internal', missing: [], confidence: 'high', needsConfirmation: false },
        { stepId: 'deck', kind: 'document', action: 'create', documentKind: 'ppt', dependsOn: ['retrieve'], parameters: { audience: '管理层' }, sourcePolicy: 'internal', missing: [], confidence: 'high', needsConfirmation: false }
      ]
    });
    expect(plan.steps?.map((step) => [step.stepId, step.dependsOn])).toEqual([
      ['retrieve', []],
      ['deck', ['retrieve']]
    ]);
  });

  it('rejects unknown dependencies and cycles', () => {
    expect(() => parseConversationIntentPlan({
      ...base,
      steps: [{ stepId: 'deck', kind: 'document', action: 'create', documentKind: 'ppt', dependsOn: ['missing'], parameters: {}, sourcePolicy: 'none', missing: [], confidence: 'high', needsConfirmation: false }]
    })).toThrow();
    expect(() => parseConversationIntentPlan({
      ...base,
      steps: [
        { stepId: 'a', kind: 'document', action: 'analyze', documentKind: 'auto', dependsOn: ['b'], parameters: {}, sourcePolicy: 'none', missing: [], confidence: 'high', needsConfirmation: false },
        { stepId: 'b', kind: 'document', action: 'create', documentKind: 'ppt', dependsOn: ['a'], parameters: {}, sourcePolicy: 'none', missing: [], confidence: 'high', needsConfirmation: false }
      ]
    })).toThrow();
  });
});
