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
