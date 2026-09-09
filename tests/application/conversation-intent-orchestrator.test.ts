import { describe, expect, it } from 'vitest';
import {
  ConversationIntentOrchestrationError,
  ConversationIntentOrchestrator,
  analyzeLocalConversationIntent
} from '../../src/application';
import { createConversationWorkflow, toConversationId, toConversationWorkflowId, toIsoTimestamp, toMessageId, toProjectId } from '../../src/domain';

function pending(rawText: string) {
  return createConversationWorkflow({
    id: toConversationWorkflowId('workflow-language-regression'),
    conversationId: toConversationId('conversation-language-regression'),
    projectId: toProjectId('project-language-regression'),
    sourceMessageId: toMessageId('message-language-regression'),
    plan: analyzeLocalConversationIntent({ rawText }).plan,
    createdAt: toIsoTimestamp('2026-09-09T00:00:00.000Z')
  });
}

describe('Conversation intent orchestrator', () => {
  it.each([
    '帮我做一份关于如何提高销售额的 PPT',
    '可不可以帮我做一份 PPT，介绍公司的产品',
    '帮我做一份 PPT，不要太花哨',
    '帮我做个总结 PPT'
  ])('recognizes a concrete creation request: %s', (rawText) => {
    expect(analyzeLocalConversationIntent({ rawText })).toMatchObject({
      plan: { kind: 'document', action: 'create', documentKind: 'ppt' },
      assessment: { readiness: 'ready' }
    });
  });

  it('keeps analysis followed by a deliverable in the document workflow', () => {
    expect(analyzeLocalConversationIntent({
      rawText: '分析附件里的销售数据，然后做一份 Excel 报表'
    }).plan).toMatchObject({ kind: 'document', action: 'create', documentKind: 'excel', sourcePolicy: 'internal' });
  });

  it('does not treat an embedded Word table as another deliverable', () => {
    expect(analyzeLocalConversationIntent({ rawText: '做一份 Word 报告，并插入一个数据表格' })).toMatchObject({
      plan: { kind: 'document', documentKind: 'word' }, assessment: { readiness: 'ready' }
    });
  });

  it.each(['不用做 PPT 了，取消', '先取消这个任务，PPT 以后再做', 'PPT，不要修改了'])('cancels before extracting clarification keywords: %s', async (rawText) => {
    let classifierCalls = 0;
    const orchestrator = new ConversationIntentOrchestrator({ classifier: {
      async classify() { classifierCalls++; throw new Error('must not classify cancellation'); }
    } });
    expect(await orchestrator.analyze({ rawText, workflow: pending('帮我做个总结') })).toMatchObject({ cancelled: true });
    expect(classifierCalls).toBe(0);
  });

  it('replaces a negated output kind and retains the effective requirements', () => {
    const result = analyzeLocalConversationIntent({
      rawText: '不要 PPT，要 Word，重点讲第三季度销售', workflow: pending('帮我做个总结')
    });
    expect(result).toMatchObject({
      plan: { documentKind: 'word', missing: [], ambiguities: [], parameters: { requirements: expect.stringContaining('第三季度销售') } },
      assessment: { readiness: 'ready' }
    });
    expect(result.cancelled).not.toBe(true);
  });

  it('resolves persisted legacy clarification labels as stable fields', () => {
    const workflow = pending('帮我做个总结');
    const result = analyzeLocalConversationIntent({
      rawText: '先做 PPT',
      workflow: { ...workflow, plan: { ...workflow.plan, missing: ['单一交付类型'], ambiguities: ['同时识别到 PPT、Word'] } }
    });
    expect(result).toMatchObject({ plan: { documentKind: 'ppt', missing: [], ambiguities: [] }, assessment: { readiness: 'ready' } });
  });

  it('preserves long initial requirements and later changes without silent truncation', () => {
    const rawText = `帮我做个总结${'甲'.repeat(7_960)}末尾事实：现金余额为123万元`;
    const workflow = pending(rawText);
    const result = analyzeLocalConversationIntent({ rawText: 'Word，保留末尾现金余额并加入风险说明', workflow });
    expect(result.plan.parameters.requirements).toContain('末尾事实：现金余额为123万元');
    expect(result.plan.parameters.requirements).toContain('加入风险说明');
    expect(String(result.plan.parameters.requirements).length).toBeGreaterThan(7_960);
    const full = { ...workflow, plan: { ...workflow.plan, parameters: { requirements: '甲'.repeat(15_990) } } };
    expect(() => analyzeLocalConversationIntent({ rawText: 'Word，保留全部原始资料并加入风险说明', workflow: full })).toThrow('16000');
  });

  it('honors cancellation before a local fast path and bounds classifiers that ignore AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new ConversationIntentOrchestrator().analyze({ rawText: '你好', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    const timedOut = await new ConversationIntentOrchestrator({
      classifierTimeoutMs: 5,
      classifier: { classify: () => new Promise(() => {}) }
    }).analyze({ rawText: '这个报告出了问题' });
    expect(timedOut).toMatchObject({ route: 'fallback', failureCode: 'classification_timeout' });
  });

  it('applies real target and user source gates to model plans', async () => {
    const orchestrator = new ConversationIntentOrchestrator({ classifier: { async classify() {
      return { schemaVersion: 1, kind: 'document', action: 'revise', documentKind: 'ppt',
        targetHint: { unit: 'document', name: '模型猜测的文档.pptx' }, parameters: {}, sourcePolicy: 'web',
        missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false };
    } } });
    const result = await orchestrator.analyze({ rawText: '这个报告出了问题', context: { documents: [
      { messageId: 'ppt-a', kind: 'ppt', fileName: 'A.pptx' },
      { messageId: 'ppt-b', kind: 'ppt', fileName: 'B.pptx' }
    ] } });
    // “这个” is an explicit latest-document reference; a model-chosen filename is ignored.
    expect(result.resolvedTarget?.messageId).toBe('ppt-b');
    expect(result.plan.sourcePolicy).toBe('none');
    expect(result.plan.targetHint?.name).toBe('B.pptx');
    const missing = await orchestrator.analyze({ rawText: '报告出了问题', context: { documents: [
      { messageId: 'ppt-a', kind: 'ppt', fileName: 'A.pptx' }, { messageId: 'ppt-b', kind: 'ppt', fileName: 'B.pptx' }
    ] } });
    expect(missing).toMatchObject({ plan: { missing: ['document_target'] }, assessment: { readiness: 'needs_clarification' } });
    expect(missing.resolvedTarget).toBeUndefined();
  });

  it.each([
    '做一份介绍 Word 和 Excel 区别的 PPT',
    '把这份材料压缩成一页给领导',
    '我明天给客户演示，用这份资料准备一下'
  ])('reviews complex expressions instead of trusting a broad local match: %s', async (rawText) => {
    expect(analyzeLocalConversationIntent({ rawText }).plan.kind).toBe('unknown');
    let calls = 0;
    const orchestrator = new ConversationIntentOrchestrator({ classifier: { async classify() {
      calls++;
      return { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt', parameters: {}, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false };
    } } });
    expect((await orchestrator.analyze({ rawText })).route).toBe('classifier');
    expect(calls).toBe(1);
  });

  it.each(['做两份 PPT', '分别做一份产品 PPT 和另一份培训 PPT', '同时修改 Word 和 PPT', '修改这两份文档'])('does not silently collapse unsupported output multiplicity: %s', async (rawText) => {
    let calls = 0;
    const orchestrator = new ConversationIntentOrchestrator({ classifier: { async classify() { calls++; throw new Error('must not bypass output scope'); } } });
    const result = await orchestrator.analyze({ rawText });
    expect(result.assessment.readiness).toBe('needs_clarification');
    expect(result.plan.kind).toBe('unknown');
    expect(calls).toBe(0);
  });

  it('uses textual ordering and explicit exclusions in pending delivery corrections', () => {
    const workflow = pending('做 Word 和 PPT');
    expect(analyzeLocalConversationIntent({ rawText: '先做 Word，再做 PPT', workflow }).plan.deliverables).toEqual(['word', 'ppt']);
    expect(analyzeLocalConversationIntent({ rawText: '取消 Word，先做 PPT', workflow }).plan.deliverables).toEqual(['ppt']);
    expect(analyzeLocalConversationIntent({ rawText: '取消 Word 和 PPT', workflow }).cancelled).toBe(true);
    expect(analyzeLocalConversationIntent({ rawText: '做一份 Word 和 PPT，介绍公司的产品' })).toMatchObject({
      plan: { kind: 'document', deliverables: ['word', 'ppt'] }, assessment: { readiness: 'ready' }
    });
  });

  it.each([
    ['总结附件主要观点，在这里回复就行', 'internal'],
    ['联网核实最新公开数据并告诉我结果', 'web'],
    ['谢谢', 'none'],
    ['这份报告主要讲了什么？', 'none']
  ])('preserves explicit questions and source policy despite a document hint: %s', (rawText, sourcePolicy) => {
    expect(analyzeLocalConversationIntent({
      rawText, context: { requestedIntentKind: 'document', requestedDocumentKind: 'ppt' }
    }).plan).toMatchObject({ kind: 'chat', sourcePolicy });
  });

  it('keeps ambiguous problem reports out of automatic document creation', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '这个报告出了问题'
    });
    expect(decision.plan.kind).toBe('unknown');
    expect(decision.assessment.readiness).toBe('needs_clarification');
  });

  it('recognizes omitted but clear table creation and incomplete summary delivery', () => {
    expect(analyzeLocalConversationIntent({ rawText: '给我一个表格' }).plan).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'excel',
      confidence: 'high'
    });
    const summary = analyzeLocalConversationIntent({ rawText: '帮我做个总结' });
    expect(summary.plan).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'auto',
      confidence: 'low'
    });
    expect(summary.assessment.readiness).toBe('needs_clarification');
  });

  it('recognizes focused natural-language PPT creation requests', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '帮我只做一个关于龙的ppt'
    });
    expect(decision).toMatchObject({
      plan: {
        kind: 'document',
        action: 'create',
        documentKind: 'ppt',
        confidence: 'high',
        parameters: { topic: '帮我只做一个关于龙的ppt' }
      },
      assessment: { readiness: 'ready' }
    });
  });

  it('does not guess among multiple document targets for an underspecified edit', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '再加一个例子',
      context: {
        documents: [
          { messageId: 'ppt-1', kind: 'ppt', fileName: '汇报.pptx' },
          { messageId: 'word-1', kind: 'word', fileName: '方案.docx' }
        ]
      }
    });
    expect(decision.plan).toMatchObject({
      kind: 'document',
      action: 'revise',
      confidence: 'low'
    });
    expect(decision.resolvedTarget).toBeUndefined();
  });

  it('uses a bounded structured classifier only for unknown local decisions', async () => {
    let calls = 0;
    const orchestrator = new ConversationIntentOrchestrator({
      classifier: {
        async classify() {
          calls += 1;
          return {
            schemaVersion: 1,
            kind: 'chat',
            parameters: {},
            sourcePolicy: 'none',
            missing: [],
            ambiguities: [],
            confidence: 'high',
            needsConfirmation: false
          };
        }
      }
    });
    const result = await orchestrator.analyze({ rawText: '这个报告出了问题' });
    expect(result.route).toBe('classifier');
    expect(result.plan.kind).toBe('chat');
    expect(calls).toBe(1);
  });

  it('fails closed when the structured classifier returns an invalid plan', async () => {
    const orchestrator = new ConversationIntentOrchestrator({
      classifier: { async classify() { return { kind: 'document', path: 'C:/unsafe' }; } }
    });
    const result = await orchestrator.analyze({ rawText: '这个报告出了问题' });
    expect(result.route).toBe('fallback');
    expect(result.plan.kind).toBe('unknown');
    expect(result.failureCode).toBe('invalid_intent_plan');
  });

  it('distinguishes a bounded classifier timeout from caller cancellation', async () => {
    const classifier = {
      classify({ signal }: { readonly signal: AbortSignal }) {
        return new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    };
    const timedOut = await new ConversationIntentOrchestrator({
      classifier,
      classifierTimeoutMs: 5
    }).analyze({ rawText: '这个报告出了问题' });
    expect(timedOut).toMatchObject({
      route: 'fallback',
      failureCode: 'classification_timeout',
      plan: { kind: 'unknown' }
    });

    const controller = new AbortController();
    const cancelled = new ConversationIntentOrchestrator({
      classifier,
      classifierTimeoutMs: 1_000
    }).analyze({ rawText: '这个报告出了问题', signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ConversationIntentOrchestrationError);
  });

  it('uses an explicit document-mode hint as semantic input instead of a renderer-side route', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '季度经营情况，8页，面向管理层',
      context: {
        requestedIntentKind: 'document',
        requestedDocumentKind: 'ppt'
      }
    });
    expect(decision).toMatchObject({
      plan: {
        kind: 'document',
        action: 'create',
        documentKind: 'ppt',
        confidence: 'high'
      },
      assessment: { readiness: 'ready' }
    });
  });
});
