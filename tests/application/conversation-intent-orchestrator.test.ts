import { describe, expect, it, vi } from 'vitest';
import { ConversationIntentOrchestrator, ConversationSemanticPlanError, ConversationSemanticResponseError } from '../../src/application/conversation-intent-orchestrator';
import { chatFixturePlan, pptFixturePlan } from '../fixtures/conversation-semantic-classifier';

const analyze = (value: unknown, rawText: string, context = {}) => new ConversationIntentOrchestrator({
  classifier: { classify: async () => value }
}).analyze({ rawText, context });

describe('one semantic plan with deterministic Host boundaries', () => {
  it.each(['我现在要制作一个ppt，先讨论内容', '随便生成吧，现在是测试', '不要再问了，按前面的做', '可以', '停止', 'Excel 是什么'])('always asks the selected semantic planner: %s', async rawText => {
    const classify = vi.fn(async (_input: unknown) => chatFixturePlan);
    const result = await new ConversationIntentOrchestrator({ classifier: { classify } }).analyze({ rawText });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0][0]).toMatchObject({ rawText });
    expect(result).toMatchObject({ route: 'classifier', plan: { kind: 'chat' } });
  });
  it('executes the returned creation meaning without rechecking keywords or an earlier discussion veto', async () => {
    const context = { recentUserMessages: ['先讨论PPT内容', '随便生成吧，现在是测试'] };
    const result = await analyze(pptFixturePlan, '随便生成吧，现在是测试', context);
    expect(result).toMatchObject({ plan: { kind: 'document', action: 'create', documentKind: 'ppt', parameters: {
      topic: pptFixturePlan.parameters.topic
    } }, assessment: { readiness: 'ready' } });
  });
  it('preserves a returned chat decision even if the wording contains a generation verb', async () => {
    expect(await analyze(chatFixturePlan, '生成PPT这件事先聊聊')).toMatchObject({ plan: { kind: 'chat' } });
  });
  it('accepts structured cancellation and does not locally interpret the word stop', async () => {
    expect(await analyze({ ...chatFixturePlan, kind: 'cancel' }, '本轮算了')).toMatchObject({ cancelled: true, plan: { kind: 'cancel' } });
    expect((await analyze(chatFixturePlan, '停止')).cancelled).toBeUndefined();
  });
  it('validates the selected file identity and preserves the model page scope', async () => {
    const plan = { ...pptFixturePlan, action: 'revise', targetHint: { unit: 'page', ordinal: 2, name: '当前.pptx' } };
    const result = await analyze(plan, '照刚才说的改', { documents: [
      { messageId: 'old', kind: 'ppt', fileName: '原版.pptx' }, { messageId: 'new', kind: 'ppt', fileName: '当前.pptx' }
    ] });
    expect(result.resolvedTarget?.messageId).toBe('new');
    expect(result.plan.targetHint).toEqual(plan.targetHint);
    expect(result.assessment.readiness).toBe('ready');
    const unavailable = await analyze(plan, '修改', { documents: [{ messageId: 'foreign', kind: 'ppt', fileName: '别的.pptx' }] });
    expect(unavailable.plan.missing).toContain('document_target');
    expect(unavailable.resolvedTarget).toBeUndefined();
  });
  it('does not pick a target or format based on user text when the plan is incomplete', async () => {
    const result = await analyze({ ...pptFixturePlan, action: 'revise', documentKind: 'auto' }, '最新那个PPT第二页', {
      documents: [{ messageId: 'a', kind: 'ppt', fileName: '甲.pptx' }, { messageId: 'b', kind: 'ppt', fileName: '乙.pptx' }]
    });
    expect(result.plan.missing).toEqual(expect.arrayContaining(['document_kind', 'document_target']));
    expect(result.assessment.readiness).toBe('needs_clarification');
  });
  it('does not add a business clarification after the model has returned a ready creation plan', async () => {
    const result = await analyze({ ...pptFixturePlan, parameters: {} }, '随便生成吧');
    expect(result.plan.missing).toEqual([]);
    expect(result.assessment.readiness).toBe('ready');
  });
  it('does not override the source policy or confirmation flag by scanning prose', async () => {
    const result = await analyze({ ...pptFixturePlan, sourcePolicy: 'internal', needsConfirmation: false }, '联网和删除是什么意思');
    expect(result.plan.sourcePolicy).toBe('internal');
    expect(result.plan.needsConfirmation).toBe(false);
  });
  it('rejects invented permission, path, provider and executable fields through the schema', async () => {
    for (const key of ['permission', 'path', 'provider', 'code']) {
      expect(await analyze({ ...pptFixturePlan, [key]: 'injected' }, '请求')).toMatchObject({ failureCode: 'invalid_intent_plan' });
    }
  });
  it('fails without a planner instead of falling back to a local business router', async () => {
    expect(await new ConversationIntentOrchestrator().analyze({ rawText: '直接生成PPT' })).toMatchObject({ route: 'unavailable', failureCode: 'classification_unavailable' });
  });
  it.each([[new ConversationSemanticPlanError(), 'invalid_intent_plan'], [new ConversationSemanticResponseError(), 'classification_invalid_response'], [new Error('transport'), 'classification_unavailable']] as const)(
    'preserves a bounded planner failure: %s', async (error, failureCode) => {
      expect(await new ConversationIntentOrchestrator({ classifier: { classify: async () => { throw error; } } }).analyze({ rawText: '请求' })).toMatchObject({ failureCode });
    });
  it('times out one planner call without retrying or generating a local replacement plan', async () => {
    const classify = vi.fn(async () => new Promise(() => {}));
    const result = await new ConversationIntentOrchestrator({ classifier: { classify }, classifierTimeoutMs: 5, classifierTimeoutGraceMs: 0 }).analyze({ rawText: '请求' });
    expect(result.failureCode).toBe('classification_timeout');
    expect(classify).toHaveBeenCalledOnce();
  });
  it('honors transport cancellation without treating a natural-language string as a control event', async () => {
    const controller = new AbortController(); controller.abort();
    const classify = vi.fn(async () => chatFixturePlan);
    await expect(new ConversationIntentOrchestrator({ classifier: { classify } }).analyze({ rawText: '请求', signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(classify).not.toHaveBeenCalled();
  });
});
