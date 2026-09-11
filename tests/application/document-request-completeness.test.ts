import { describe, expect, it } from 'vitest';
import { analyzeLocalConversationIntent, ConversationIntentOrchestrator } from '../../src/application/conversation-intent-orchestrator';
import { createConversationWorkflow, toConversationWorkflowId, toConversationId, toMessageId, toProjectId, toIsoTimestamp } from '../../src/domain';

describe('PPT request completeness', () => {
  it('does not accept a topic invented by the semantic classifier', async () => {
    const orchestrator = new ConversationIntentOrchestrator({ classifier: { classify: async () => ({
      schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt',
      parameters: { topic: '模型猜测的公司业绩' }, sourcePolicy: 'none', missing: [], ambiguities: [],
      confidence: 'high', needsConfirmation: false
    }) } });
    const decision = await orchestrator.analyze({ rawText: '制作' });
    expect(decision.route).toBe('classifier');
    expect(decision.plan.missing).toContain('document_topic');
    expect(decision.assessment.readiness).toBe('needs_clarification');
  });
  it.each(['我要生成一个ppt', '我想做一个ppt', '我想做一个ppt？', '制作 PPT', '帮我做一个10页的PPT'])('asks for a subject before generating: %s', (rawText) => {
    const decision = analyzeLocalConversationIntent({ rawText });
    expect(decision.plan).toMatchObject({ kind: 'document', documentKind: 'ppt', missing: ['document_topic'] });
    expect(decision.assessment.readiness).toBe('needs_clarification');
  });

  it('accepts a subject as a natural follow-up and keeps acknowledgements pending', () => {
    const decision = analyzeLocalConversationIntent({ rawText: '我想做一个ppt' });
    const workflow = createConversationWorkflow({
      id: toConversationWorkflowId('workflow-topic'), conversationId: toConversationId('conversation-topic'),
      projectId: toProjectId('project-topic'), sourceMessageId: toMessageId('message-topic'),
      plan: decision.plan, createdAt: toIsoTimestamp('2026-09-10T00:00:00.000Z')
    });
    for (const rawText of ['好的', '继续', '其他你来安排']) {
      expect(analyzeLocalConversationIntent({ rawText, workflow }).assessment.readiness).toBe('needs_clarification');
    }
    const answered = analyzeLocalConversationIntent({ rawText: '仓储管理软件的产品介绍', workflow });
    expect(answered.plan.parameters.requirements).toContain('仓储管理软件');
    expect(answered.assessment.readiness).toBe('ready');
    const partial = analyzeLocalConversationIntent({ rawText: '10页，面向管理层，商务风格', workflow });
    expect(partial.assessment.readiness).toBe('needs_clarification');
    expect(partial.plan.parameters).toMatchObject({ pageCount: 10, audience: '管理层', style: '商务' });
    const changedKind = analyzeLocalConversationIntent({ rawText: 'Word', workflow });
    expect(changedKind.plan.documentKind).toBe('word');
    expect(changedKind.plan.missing).not.toContain('document_topic');
  });

  it('does not turn an explanation question into a creation task', () => {
    expect(analyzeLocalConversationIntent({ rawText: '我想知道怎么做一个PPT？' }).plan.kind).toBe('chat');
  });
});
