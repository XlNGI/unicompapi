import { describe, expect, it } from 'vitest';
import {
  ConversationIntentOrchestrationError,
  ConversationIntentOrchestrator,
  ConversationSemanticPlanError,
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
    '生成提示词',
    '根据这张图片生成提示词',
    '帮我反推这张图片的提示词',
    '优化刚才的提示词',
    '生成 PPT 的提示词',
    'Generate a prompt for this image',
    '给图片生成一段描述',
    '提取图片中的文字',
    '把图片详细分析一下'
  ])('routes inline prompt writing and image analysis directly to chat: %s', async (rawText) => {
    let classifierCalls = 0;
    const orchestrator = new ConversationIntentOrchestrator({ classifier: { async classify() {
      classifierCalls++;
      throw new Error('A clear inline request does not need semantic classification');
    } } });
    const result = await orchestrator.analyze({
      rawText,
      workflow: pending('我要生成 PPT'),
      context: {
        requestedIntentKind: 'document', requestedDocumentKind: 'ppt',
        documents: [{ messageId: 'old-document', kind: 'ppt', fileName: '旧文档.pptx' }]
      }
    });
    expect(result).toMatchObject({ route: 'local', plan: { kind: 'chat' }, assessment: { readiness: 'ready' } });
    expect(result.resolvedTarget).toBeUndefined();
    expect(classifierCalls).toBe(0);
  });

  it.each([
    ['生成提示词 PPT', 'ppt'],
    ['生成提示词并保存为 Word', 'word'],
    ['根据图片生成一份分析报告', 'word'],
    ['根据图片生成提示词并导出 Excel', 'excel']
  ])('keeps explicit document delivery in the document workflow: %s', (rawText, documentKind) => {
    expect(analyzeLocalConversationIntent({ rawText })).toMatchObject({
      plan: { kind: 'document', action: 'create', documentKind }, assessment: { readiness: 'ready' }
    });
  });

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

  it.each([
    ['做一份介绍最新行业趋势的 PPT', 'web'],
    ['做一份近期政策解读 PPT', 'web'],
    ['制作 PPT，使用 2026 年最新数据', 'web'],
    ['制作 PPT，分析新能源行业现状', 'web'],
    ['结合内部资料和最新行业数据做一份 PPT', 'mixed'],
    ['根据附件做一份 PPT，并补充当前市场数据', 'mixed'],
    ['做一份关于龙的 PPT', 'none'],
    ['根据最新上传附件里的行业趋势做一份 PPT', 'internal'],
    ['根据今天上传的销售数据做一份 PPT', 'internal'],
    ['根据最新版本文档做一份培训 PPT', 'none'],
    ['做一份介绍网络工作原理的 PPT', 'none'],
    ['制作 PPT，讲解物联网的应用', 'none'],
    ['做一份最新政策 PPT，不要联网', 'none'],
    ['只根据附件里的最新行业数据制作 PPT', 'internal'],
    ['根据 2025 年销售数据生成报表', 'none']
  ])('proposes research for current public facts without treating file recency as public research: %s', (rawText, sourcePolicy) => {
    const result = analyzeLocalConversationIntent({ rawText });
    expect(result.plan).toMatchObject({ kind: 'document', sourcePolicy });
  });

  it('retains current research needs through a topic answer, and honors a later refusal', () => {
    const workflow = pending('我要生成 PPT');
    const withTopic = analyzeLocalConversationIntent({ rawText: '重点讲最新行业趋势', workflow });
    expect(withTopic.plan).toMatchObject({ documentKind: 'ppt', sourcePolicy: 'web', missing: [] });
    const withStyle = analyzeLocalConversationIntent({
      rawText: '再简洁一点', workflow: { ...workflow, plan: withTopic.plan }
    });
    expect(withStyle.plan.sourcePolicy).toBe('web');
    const declined = analyzeLocalConversationIntent({
      rawText: '不需要联网，只根据附件', workflow: { ...workflow, plan: withStyle.plan }
    });
    expect(declined.plan.sourcePolicy).toBe('internal');
    const stillDeclined = analyzeLocalConversationIntent({
      rawText: '补充最新政策', workflow: { ...workflow, plan: declined.plan }
    });
    expect(stillDeclined.plan.sourcePolicy).toBe('internal');
    const requested = analyzeLocalConversationIntent({
      rawText: '再联网核实最新政策', workflow: { ...workflow, plan: stillDeclined.plan }
    });
    expect(requested.plan.sourcePolicy).toBe('mixed');
  });

  it('derives a semantic creation plan research suggestion from trusted user requirements', async () => {
    const orchestrator = new ConversationIntentOrchestrator({ classifier: { async classify() {
      return { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt',
        parameters: { requirements: '联网搜索模型伪造的企业资料' }, sourcePolicy: 'none',
        missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false };
    } } });
    const rawText = '我明天给客户演示，用这份资料准备一下，补充最新行业趋势';
    expect(await orchestrator.analyze({ rawText })).toMatchObject({
      route: 'classifier', plan: { sourcePolicy: 'web', parameters: { requirements: rawText } }
    });
    expect(await orchestrator.analyze({ rawText: `${rawText}，不要联网` })).toMatchObject({
      route: 'classifier', plan: { sourcePolicy: 'none' }
    });
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

  it('accepts a completed classifier response during the finite timeout grace', async () => {
    const plan = {
      schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt', parameters: { topic: '产品介绍' },
      sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false
    } as const;
    const result = await new ConversationIntentOrchestrator({
      classifierTimeoutMs: 5,
      classifierTimeoutGraceMs: 50,
      routingMode: 'agent_first',
      classifier: { classify: () => new Promise((resolve) => setTimeout(() => resolve(plan), 15)) }
    }).analyze({ rawText: '做一份产品介绍 PPT' });
    expect(result.route).toBe('classifier');
    expect(result.plan.kind).toBe('document');
    expect(result.plan.documentKind).toBe('ppt');
    expect(result.failureCode).toBeUndefined();
  });

  it('keeps a response validation failure distinct when it arrives during the grace', async () => {
    const result = await new ConversationIntentOrchestrator({
      classifierTimeoutMs: 5,
      classifierTimeoutGraceMs: 50,
      routingMode: 'agent_first',
      classifier: { classify: () => new Promise((_, reject) => setTimeout(() => reject(new ConversationSemanticPlanError('json_invalid')), 15)) }
    }).analyze({ rawText: '做一份产品介绍 PPT' });
    expect(result).toMatchObject({ route: 'fallback', failureCode: 'invalid_intent_plan' });
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

  it('uses the semantic classifier for clear business requests in agent-first mode', async () => {
    let calls = 0;
    const orchestrator = new ConversationIntentOrchestrator({
      routingMode: 'agent_first',
      classifier: {
        async classify() {
          calls += 1;
          return {
            schemaVersion: 1,
            kind: 'document',
            action: 'create',
            documentKind: 'ppt',
            parameters: { requirements: '分析销售表并做管理层汇报' },
            sourcePolicy: 'internal',
            missing: [],
            ambiguities: [],
            confidence: 'high',
            needsConfirmation: false
          };
        }
      }
    });
    const result = await orchestrator.analyze({
      rawText: '分析销售表并做管理层汇报 PPT',
      context: { requestedIntentKind: 'document', requestedDocumentKind: 'ppt' }
    });
    expect(result.route).toBe('classifier');
    expect(result.plan).toMatchObject({ kind: 'document', action: 'create', documentKind: 'ppt' });
    expect(calls).toBe(1);
  });

  it('fails closed when production agent-first routing has no classifier', async () => {
    const result = await new ConversationIntentOrchestrator({ routingMode: 'agent_first' }).analyze({
      rawText: '分析销售表并做管理层汇报 PPT'
    });
    expect(result).toMatchObject({
      route: 'fallback',
      failureCode: 'classification_unavailable',
      plan: { kind: 'unknown' }
    });
  });

  it('keeps model-inferred topic and source requirements without keyword overrides', async () => {
    const plan = { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt',
      parameters: { topic: '附件中的季度经营分析', pageCount: 8 }, sourcePolicy: 'internal',
      missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false };
    const result = await new ConversationIntentOrchestrator({ routingMode: 'agent_first',
      classifier: { classify: async () => plan } }).analyze({ rawText: '就按刚才讨论的来' });
    expect(result.plan).toMatchObject({ parameters: plan.parameters, sourcePolicy: 'internal', missing: [] });
    expect(result.assessment.readiness).toBe('ready');
  });

  it('keeps exact cancellation local but sends semantic corrections to the model', async () => {
    let calls = 0;
    const orchestrator = new ConversationIntentOrchestrator({ routingMode: 'agent_first', classifier: {
      classify: async () => { calls++; return { schemaVersion: 1, kind: 'chat', parameters: {}, sourcePolicy: 'none',
        missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false }; }
    } });
    expect((await orchestrator.analyze({ rawText: '取消当前任务' })).cancelled).toBe(true);
    expect(calls).toBe(0);
    expect((await orchestrator.analyze({ rawText: '不要做 PPT，改为解释这份材料' })).cancelled).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('resolves only the model-selected document and preserves its page hint', async () => {
    const result = await new ConversationIntentOrchestrator({ routingMode: 'agent_first', classifier: {
      classify: async () => ({ schemaVersion: 1, kind: 'document', action: 'revise', documentKind: 'ppt',
        parameters: {}, targetHint: { unit: 'page', ordinal: 4 }, sourcePolicy: 'none',
        missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false })
    } }).analyze({ rawText: '第二页改成我们刚才讨论的范围', context: {
      documents: [{ messageId: 'ppt-target', kind: 'ppt', fileName: '季度.pptx' }]
    } });
    expect(result.plan.targetHint).toEqual({ unit: 'page', ordinal: 4 });
    expect(result.resolvedTarget?.messageId).toBe('ppt-target');
  });

  it('does not choose the latest document by regex when the model target is ambiguous', async () => {
    const result = await new ConversationIntentOrchestrator({ routingMode: 'agent_first', classifier: {
      classify: async () => ({ schemaVersion: 1, kind: 'document', action: 'revise', documentKind: 'ppt',
        parameters: {}, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false })
    } }).analyze({ rawText: '修改最新的 PPT', context: {
      documents: [{ messageId: 'first', kind: 'ppt', fileName: '甲.pptx' }, { messageId: 'last', kind: 'ppt', fileName: '乙.pptx' }]
    } });
    expect(result.resolvedTarget).toBeUndefined();
    expect(result.plan.missing).toContain('document_target');
    expect(result.assessment.readiness).toBe('needs_clarification');
  });
});
