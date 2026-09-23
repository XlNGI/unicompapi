import { describe, expect, it } from 'vitest';
import { ConversationApplicationService, ConversationContextBuilder } from '../../src/application';
import { analyzeLocalConversationIntent } from '../../src/application/conversation-intent-orchestrator';
import { conversationWorkflowReply } from '../../src/application/conversation-workflow-reply';
import {
  addUserMessage, createConversation, createConversationWorkflow, parseConversation, parseConversationWorkflow,
  toConversationId, toConversationWorkflowId, toIsoTimestamp, toMessageId, toProjectId,
  type Conversation, type ConversationRepository
} from '../../src/domain';

const now = toIsoTimestamp('2026-09-10T00:00:00.000Z');
const conversationId = toConversationId('conversation-reply');
function fixture() {
  let saved: Conversation = addUserMessage(createConversation({
    id: conversationId, title: 'PPT', projectId: toProjectId('project-reply'), createdAt: now
  }), { id: toMessageId('message-request'), content: '我想做一个 PPT', createdAt: now });
  const repository: ConversationRepository = {
    async get() { return saved; }, async list() { return [saved]; },
    async create(value) { saved = parseConversation(value); },
    async save(value, revision) {
      if (saved.revision !== revision) throw new Error('revision conflict');
      saved = parseConversation(value);
    }
  };
  let sequence = 0;
  const service = () => new ConversationApplicationService(repository, {
    nextConversationId: () => conversationId,
    nextMessageId: () => toMessageId(`message-reply-${++sequence}`)
  }, () => now);
  const workflow = createConversationWorkflow({
    id: toConversationWorkflowId('workflow-reply'), conversationId,
    projectId: toProjectId('project-reply'), sourceMessageId: toMessageId('message-request'),
    plan: analyzeLocalConversationIntent({ rawText: '我想做一个 PPT' }).plan,
    pendingQuestions: [{ field: 'document_topic', question: '你想做什么主题的 PPT？', required: true }],
    createdAt: now
  });
  return { service, workflow, repository };
}

describe('Persisted assistant workflow replies', () => {
  it('restores a missing planning-failure reply once and rejects execution with a failure marker', async () => {
    const { service, workflow } = fixture();
    const failed = parseConversationWorkflow({ ...workflow, status: 'failed',
      planningFailureCode: 'classification_unavailable', pendingQuestions: [] });
    const first = await service().ensureWorkflowReply(failed);
    expect(first.messages.at(-1)?.content).toContain('未能启动模型调用或确认调用状态');
    expect(first.messages.at(-1)?.content).not.toContain('请求已发出');
    expect(first.messages.at(-1)?.content).toContain('后续文档执行未开始');
    expect(first.messages.at(-1)?.content).not.toContain('本轮尚未开始');
    expect(await service().ensureWorkflowReply(failed)).toEqual(first);
    expect(() => parseConversationWorkflow({ ...failed, status: 'ready' })).toThrow();
    expect(() => parseConversationWorkflow({ ...failed, planningFailureCode: 'unrecognized' })).toThrow();
    expect(() => parseConversationWorkflow({ ...failed, pendingQuestions: workflow.pendingQuestions })).toThrow();
  });

  it('describes a planning timeout without claiming that the model request was never started', async () => {
    const { service, workflow } = fixture();
    const failed = parseConversationWorkflow({ ...workflow, status: 'failed',
      planningFailureCode: 'classification_timeout', pendingQuestions: [] });
    const conversation = await service().ensureWorkflowReply(failed);
    const reply = conversation.messages.at(-1)?.content ?? '';
    expect(reply).toContain('理解需求在时间预算内未完成');
    expect(reply).toContain('后续文档执行未开始');
    expect(reply).not.toContain('本轮尚未开始');
  });
  it('replays a saved workflow after a missing projection and is idempotent across service restarts', async () => {
    const { service, workflow } = fixture();
    const first = await service().ensureWorkflowReply(workflow);
    const replay = await service().ensureWorkflowReply(workflow);
    expect(replay).toEqual(first);
    expect(replay.messages).toHaveLength(2);
    expect(replay.messages[1]).toMatchObject({ role: 'assistant', state: 'completed', content: '你想做什么主题的 PPT？', workflowReply: { workflowId: workflow.id, revision: 0 } });
    expect(parseConversation(JSON.parse(JSON.stringify(replay)))).toEqual(replay);
  });

  it('rejects stale projections and omits system-authored replies from model history', async () => {
    const { service, workflow } = fixture();
    const current = await service().ensureWorkflowReply({ ...workflow, revision: 2 });
    expect(await service().ensureWorkflowReply(workflow)).toEqual(current);
    const conversation = await service().addUserMessage({ conversationId, expectedRevision: current.revision, content: '仓储管理产品介绍' });
    const context = new ConversationContextBuilder().build({ conversation, currentUserMessageId: conversation.messages.at(-1)!.id });
    expect(context.messages.some((item) => item.content.includes('你想做什么主题'))).toBe(false);
    expect(context.messages.at(-1)?.content).toBe('仓储管理产品介绍');
  });

  it('renders the validated physical page scope in the confirmation reply', async () => {
    const { service, workflow } = fixture();
    const conversation = await service().get(conversationId);
    const reply = conversationWorkflowReply({ ...workflow, status: 'needs_confirmation',
      plan: { ...workflow.plan, action: 'revise' },
      resolvedTarget: { artifactRef: 'message-result', version: 1, presentation: {
        workId: 'work-ppt', checksumSha256: 'a'.repeat(64), unit: 'section', ordinal: 2, heading: '销售分析', pages: [3, 4]
      } }
    }, conversation);
    expect(reply).toContain('第 2 章，销售分析');
    expect(reply).toContain('第 3、4 页');
  });

  it('rejects workflow metadata on user messages or with unsupported fields', async () => {
    const { service, workflow } = fixture();
    const conversation = await service().ensureWorkflowReply(workflow);
    expect(() => parseConversation({ ...conversation, messages: conversation.messages.map((message) => ({ ...message, workflowReply: { workflowId: workflow.id, revision: 0 } })) })).toThrow();
    expect(() => parseConversation({ ...conversation, messages: conversation.messages.map((message) => message.workflowReply ? { ...message, workflowReply: { ...message.workflowReply, path: 'not-allowed' } } : message) })).toThrow();
  });
});
