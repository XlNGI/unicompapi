import {
  assessConversationIntentPlan,
  parseConversationIntentPlan,
  type ConversationIntentAssessment,
  type ConversationIntentPlan,
  type ConversationWorkflowV1,
  type DocumentWorkspaceKind
} from '../domain';
import {
  analyzeOfficeRequest,
  type OfficeDocumentContext,
  type OfficeRequestContext
} from './office-request-intent';

export interface ConversationSemanticContext extends OfficeRequestContext {
  readonly recentUserMessages?: readonly string[];
  readonly requestedIntentKind?: 'document';
  readonly requestedDocumentKind?: DocumentWorkspaceKind | 'auto';
}

export interface ConversationIntentDecision {
  readonly plan: ConversationIntentPlan;
  readonly assessment: ConversationIntentAssessment;
  readonly route: 'local' | 'classifier' | 'fallback';
  readonly resolvedTarget?: OfficeDocumentContext;
  readonly failureCode?:
    | 'classification_timeout'
    | 'classification_unavailable'
    | 'invalid_intent_plan';
}

export class ConversationIntentOrchestrationError extends Error {
  constructor(readonly code: 'cancelled') {
    super(code);
    this.name = 'ConversationIntentOrchestrationError';
  }
}

export interface ConversationIntentClassifierPort {
  classify(input: {
    readonly rawText: string;
    readonly context: ConversationSemanticContext;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface ConversationIntentOrchestratorOptions {
  readonly classifier?: ConversationIntentClassifierPort;
  readonly classifierTimeoutMs?: number;
}

export class ConversationIntentOrchestrator {
  constructor(private readonly options: ConversationIntentOrchestratorOptions = {}) {}

  async analyze(input: {
    readonly rawText: string;
    readonly context?: ConversationSemanticContext;
    readonly workflow?: ConversationWorkflowV1;
    readonly signal?: AbortSignal;
  }): Promise<ConversationIntentDecision> {
    const context = input.context ?? {};
    const local = analyzeLocalConversationIntent({
      rawText: input.rawText,
      context,
      workflow: input.workflow
    });
    if (local.plan.kind !== 'unknown' || !this.options.classifier) return local;
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = this.options.classifierTimeoutMs ?? 3_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new TypeError('classifierTimeoutMs is invalid');
    }
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs
    );
    try {
      let candidate: unknown;
      try {
        candidate = await this.options.classifier.classify({
          rawText: input.rawText,
          context,
          signal: controller.signal
        });
      } catch {
        if (input.signal?.aborted) {
          throw new ConversationIntentOrchestrationError('cancelled');
        }
        return {
          ...local,
          route: 'fallback',
          failureCode: controller.signal.aborted
            ? 'classification_timeout'
            : 'classification_unavailable'
        };
      }
      let classified: ConversationIntentPlan;
      try {
        classified = parseConversationIntentPlan(candidate);
      } catch {
        return { ...local, route: 'fallback', failureCode: 'invalid_intent_plan' };
      }
      const assessment = assessConversationIntentPlan(classified);
      return { plan: classified, assessment, route: 'classifier' };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

export function analyzeLocalConversationIntent(input: {
  readonly rawText: string;
  readonly context?: ConversationSemanticContext;
  readonly workflow?: ConversationWorkflowV1;
}): ConversationIntentDecision {
  const text = input.rawText.trim();
  const context = input.context ?? {};
  if (input.workflow && input.workflow.status === 'needs_clarification') {
    const merged = mergeWorkflowClarification(input.workflow.plan, text, context);
    if (merged) {
      return {
        ...decision(merged.plan, 'local'),
        ...(merged.resolvedTarget ? { resolvedTarget: merged.resolvedTarget } : {})
      };
    }
  }
  if (!text) return decision(unknownPlan('empty_input'), 'local');
  if (isNegatedExecutionRequest(text)) {
    return isExplicitInformationOnly(text)
      ? decision(chatPlan(), 'local')
      : decision(unknownPlan('检测到否定或撤销表达，请明确是否只需要咨询'), 'local');
  }
  if (context.requestedIntentKind === 'document') {
    const explicitKind = inferExplicitKind(text);
    const requestedKind = context.requestedDocumentKind === 'auto'
      ? explicitKind ?? 'auto'
      : context.requestedDocumentKind ?? explicitKind ?? 'auto';
    const office = analyzeOfficeRequest(text, context);
    const action = office.kind === 'document' && office.action === 'revise'
      ? 'revise'
      : 'create';
    const target = action === 'revise'
      ? resolveSemanticTarget(text, requestedKind === 'auto' ? undefined : requestedKind, context.documents ?? [])
      : undefined;
    const missing = action === 'revise' && !target && (context.documents?.length ?? 0) > 1
      ? ['要修改的文档']
      : [];
    const plan = documentPlan(
      action,
      requestedKind,
      text,
      missing.length > 0 ? 'low' : 'high',
      missing,
      missing.length > 0 ? ['当前会话中有多份候选文档'] : [],
      targetHintFromText(text) ?? (target ? { unit: 'document', name: target.fileName } : undefined)
    );
    return { ...decision(plan, 'local'), ...(target ? { resolvedTarget: target } : {}) };
  }
  if (isQuestionOrAnalysis(text)) return decision(chatPlan(), 'local');
  const explicitKinds = inferExplicitKinds(text);
  if (explicitKinds.length > 1 && /(?:并|同时|以及|和|再|然后)/.test(text)) {
    return decision(documentPlan(
      'create',
      'auto',
      text,
      'low',
      ['单一交付类型'],
      [`同时识别到 ${explicitKinds.map(documentKindLabel).join('、')}`]
    ), 'local');
  }
  if (looksLikeProblemReport(text) && !hasStrongCreateCommand(text)) {
    return decision(unknownPlan('请求是在分析问题还是创建/修改文档'), 'local');
  }
  if (isBareTableCreation(text)) {
    return decision(documentPlan('create', 'excel', text, 'high'), 'local');
  }
  if (isSummaryDeliverable(text)) {
    return decision(documentPlan(
      'create',
      'auto',
      text,
      'low',
      ['文档类型（Word、Excel 或 PPT）']
    ), 'local');
  }

  const office = analyzeOfficeRequest(text, context);
  if (office.kind === 'chat') {
    if (hasStrongCreateCommand(text) && inferDeliverableKind(text) !== 'auto') {
      return decision(documentPlan(
        'create',
        inferDeliverableKind(text),
        text,
        'high'
      ), 'local');
    }
    if (
      looksLikeOfficeOperation(text) ||
      looksLikeUnderspecifiedOperation(text) ||
      hasStrongCreateCommand(text)
    ) {
      return decision(unknownPlan('无法确定是普通问答还是文档操作'), 'local');
    }
    return decision(chatPlan(), 'local');
  }
  if (office.action === 'create' && !hasStrongCreateCommand(text)) {
    return decision(unknownPlan('未识别到明确的创建指令'), 'local');
  }

  const target = office.action === 'revise'
    ? resolveSemanticTarget(text, inferExplicitKind(text), context.documents ?? []) ??
      (office.targetMessageId && hasExplicitTargetReference(text, context.documents ?? [])
        ? (context.documents ?? []).find((document) => document.messageId === office.targetMessageId)
        : undefined)
    : undefined;
  if (
    office.action === 'revise' &&
    target === undefined &&
    (context.documents?.length ?? 0) > 1
  ) {
    return decision(documentPlan(
      'revise',
      office.documentKind ?? 'auto',
      text,
      'low',
      ['要修改的文档'],
      ['当前会话中有多份候选文档']
    ), 'local');
  }
  const plan = documentPlan(
    office.action,
    office.documentKind ?? 'auto',
    text,
    office.missing.length > 0 ? 'low' : 'high',
    office.missing,
    [],
    targetHintFromText(text) ?? (target ? { unit: 'document', name: target.fileName } : undefined)
  );
  return { ...decision(plan, 'local'), ...(target ? { resolvedTarget: target } : {}) };
}

function mergeWorkflowClarification(
  plan: ConversationIntentPlan,
  answer: string,
  context: ConversationSemanticContext
): { readonly plan: ConversationIntentPlan; readonly resolvedTarget?: OfficeDocumentContext } | undefined {
  if (!answer) return undefined;
  if (plan.kind === 'unknown') {
    const recent = context.recentUserMessages ?? [];
    const previous = recent.length > 1 ? recent.at(-2) : undefined;
    const recovered = analyzeLocalConversationIntent({
      rawText: previous ? `${previous}\n${answer}` : answer,
      context: {
        ...context,
        recentUserMessages: undefined
      }
    });
    if (recovered.plan.kind !== 'unknown') {
      return {
        plan: recovered.plan,
        ...(recovered.resolvedTarget ? { resolvedTarget: recovered.resolvedTarget } : {})
      };
    }
  }
  const parameters = { ...plan.parameters };
  const remaining = new Set(plan.missing);
  const kind = inferExplicitKind(answer);
  if (kind) remaining.delete('文档类型（Word、Excel 或 PPT）');
  const pageCount = answer.match(/(?:共|做|要)?\s*(\d{1,3})\s*(?:页|张)/)?.[1];
  if (pageCount) {
    parameters.pageCount = Number(pageCount);
    remaining.delete('页数');
  }
  const audience = answer.match(/(?:给|面向|用于)([^，。；]{2,30})(?:看|使用|汇报|，|。|；|$)/)?.[1];
  if (audience) {
    parameters.audience = audience.trim();
    remaining.delete('受众');
  }
  const style = answer.match(/(简洁|简约|商务|专业|科技|自然|正式|活泼)(?:风|一点|一些)?/)?.[1];
  if (style) {
    parameters.style = style;
    remaining.delete('风格');
  }
  const target = plan.action === 'revise'
    ? resolveSemanticTarget(
        answer,
        kind ?? (plan.documentKind === 'auto' ? undefined : plan.documentKind),
        context.documents ?? []
      )
    : undefined;
  if (target) {
    remaining.delete('要修改的文档');
  }
  if (!kind && !pageCount && !audience && !style && !target) return undefined;
  const ambiguities = target
    ? plan.ambiguities.filter((item) => item !== '当前会话中有多份候选文档')
    : plan.ambiguities;
  const merged = parseConversationIntentPlan({
    ...plan,
    documentKind: kind ?? target?.kind ?? plan.documentKind,
    ...(target ? { targetHint: { unit: 'document', name: target.fileName } } : {}),
    parameters,
    missing: [...remaining],
    ambiguities,
    confidence: remaining.size === 0 && ambiguities.length === 0 ? 'high' : plan.confidence
  });
  return { plan: merged, ...(target ? { resolvedTarget: target } : {}) };
}

function documentPlan(
  action: 'create' | 'revise',
  documentKind: DocumentWorkspaceKind | 'auto',
  topic: string,
  confidence: 'high' | 'medium' | 'low',
  missing: readonly string[] = [],
  ambiguities: readonly string[] = [],
  targetHint?: ConversationIntentPlan['targetHint']
): ConversationIntentPlan {
  return parseConversationIntentPlan({
    schemaVersion: 1,
    kind: 'document',
    action,
    documentKind,
    ...(targetHint ? { targetHint } : {}),
    parameters: { topic: topic.slice(0, 2_000) },
    sourcePolicy: inferSourcePolicy(topic),
    missing,
    ambiguities,
    confidence,
    needsConfirmation: isDestructiveRevision(topic)
  });
}

function unknownPlan(reason: string): ConversationIntentPlan {
  return parseConversationIntentPlan({
    schemaVersion: 1,
    kind: 'unknown',
    parameters: {},
    sourcePolicy: 'none',
    missing: [],
    ambiguities: [reason],
    confidence: 'low',
    needsConfirmation: false
  });
}

function chatPlan(): ConversationIntentPlan {
  return parseConversationIntentPlan({
    schemaVersion: 1,
    kind: 'chat',
    parameters: {},
    sourcePolicy: 'none',
    missing: [],
    ambiguities: [],
    confidence: 'high',
    needsConfirmation: false
  });
}

function decision(
  plan: ConversationIntentPlan,
  route: ConversationIntentDecision['route']
): ConversationIntentDecision {
  return { plan, assessment: assessConversationIntentPlan(plan), route };
}

function resolveSemanticTarget(
  text: string,
  kind: DocumentWorkspaceKind | undefined,
  documents: readonly OfficeDocumentContext[]
): OfficeDocumentContext | undefined {
  const named = [...documents].reverse().find((document) =>
    text.toLocaleLowerCase().includes(document.fileName.toLocaleLowerCase())
  );
  if (named) return named;
  const candidates = kind ? documents.filter((document) => document.kind === kind) : documents;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && /(?:前一个版本|上一版|前一版)/.test(text)) {
    return candidates.at(-2);
  }
  if (candidates.length > 1 && /(?:刚才|当前|这份|这个|最新)/.test(text)) return candidates.at(-1);
  return undefined;
}

function targetHintFromText(text: string): ConversationIntentPlan['targetHint'] | undefined {
  const cell = text.match(/\b([A-Z]{1,3}\d{1,7})\b/i)?.[1];
  if (cell) return { unit: 'cell', name: cell.toUpperCase() };
  const page = text.match(/第\s*([一二两三四五六七八九十百\d]+)\s*(?:页|张)/)?.[1];
  if (page) return { unit: 'page', ordinal: parseOrdinal(page) };
  const section = text.match(/第\s*([一二两三四五六七八九十百\d]+)\s*(?:章|节|部分)/)?.[1];
  if (section) return { unit: 'section', ordinal: parseOrdinal(section) };
  if (/(?:上一版|前一版|前一个版本)/.test(text)) return { unit: 'version', ordinal: 1 };
  return undefined;
}

function inferExplicitKind(text: string): DocumentWorkspaceKind | undefined {
  if (/(?:\bpptx?\b|幻灯片|演示文稿|课件)/i.test(text)) return 'ppt';
  if (/(?:\bexcel\b|\bxlsx\b|工作簿|电子表格|表格)/i.test(text)) return 'excel';
  if (/(?:\bword\b|\bdocx\b|文字文档)/i.test(text)) return 'word';
  return undefined;
}

function inferExplicitKinds(text: string): readonly DocumentWorkspaceKind[] {
  const kinds: DocumentWorkspaceKind[] = [];
  if (/(?:\bpptx?\b|幻灯片|演示文稿|课件)/i.test(text)) kinds.push('ppt');
  if (/(?:\bexcel\b|\bxlsx\b|工作簿|电子表格|表格|台账)/i.test(text)) kinds.push('excel');
  if (/(?:\bword\b|\bdocx\b|文字文档)/i.test(text)) kinds.push('word');
  return kinds;
}

function hasStrongCreateCommand(text: string): boolean {
  return (
    /(?:帮我|给我|麻烦(?:你)?|请(?:你)?)\s*(?:(?:只|就|先|再|直接|简单(?:地)?|尽量|最好)\s*)*(?:做|生成|制作|创建|写|编写|起草|拟定|整理|输出|导出)(?:成|个|一份|一个)?/.test(text) ||
    /^(?:(?:只|就|先|再|直接|简单(?:地)?|尽量|最好)\s*)*(?:做|生成|制作|创建|写|编写|起草|拟定|整理|输出|导出|出)(?:成|个|一份|一个)?/.test(text) ||
    /^(?:把|将)[\s\S]{1,100}(?:做成|整理成|输出为|导出为)/.test(text) ||
    /(?:根据|结合|使用|用|拿)[\s\S]{1,100}(?:做|生成|制作|创建|写|编写|起草|整理|输出|导出)/.test(text) ||
    /(?:并|然后|再)\s*(?:做|生成|制作|创建|写|编写|起草|整理|输出|导出)/.test(text) ||
    /(?:生成|制作|创建|编写|起草|拟定|导出)[\s\S]{0,80}(?:PPT|Word|Excel|报告|报表|方案|纪要|合同|文档|表格|课件)/i.test(text) ||
    /(?:新建|另做|重新做|从头做|来一份|整一个|我要一份|我想要一份|需要一份)/.test(text)
  );
}

function isBareTableCreation(text: string): boolean {
  return /^(?:请)?(?:给我|帮我)?(?:做|生成|创建)?(?:一份|一个|个)?表格[。！!？?]?$/.test(text);
}

function isSummaryDeliverable(text: string): boolean {
  return /(?:帮我|请|给我|麻烦)(?:做|写|生成|整理)(?:个|一份|一个)?总结/.test(text);
}

function isQuestionOrAnalysis(text: string): boolean {
  const hasQuestionConstruction =
    /(?:怎么|如何|为什么|是什么|有哪些|有什么区别|需要注意什么|是否|能否|能不能|可不可以|可以吗)/u.test(text);
  const politeDocumentRequest =
    /^(?:请问)?(?:能否|能不能|可以(?:请你)?)(?:帮我|给我)?\s*(?:做|生成|制作|创建|写|编写|起草|整理|输出|导出)/.test(text) ||
    /^(?:请|帮我|给我|麻烦(?:你)?)[\s\S]{0,20}(?:做|生成|制作|创建|写|编写|起草|整理|输出|导出)[\s\S]*[？?]$/.test(text);
  return (
    ((hasQuestionConstruction || /[？?]\s*$/u.test(text)) && !politeDocumentRequest) ||
    /^(?:请|帮我)?分析(?:这|一下)?/.test(text) ||
    /^(?:请|帮我)?(?:总结|概括|提炼|解释|评价|点评|翻译)(?!成|为|一份|一个)/.test(text)
  );
}

function isNegatedExecutionRequest(text: string): boolean {
  return (
    /(?:不要|别|不用|无需|不需要|不必|不想)[\s\S]{0,30}(?:做|生成|制作|创建|写|修改|调整|删除|清空|导出)/.test(text) ||
    /(?:做|生成|制作|创建|写|修改|调整|删除|清空|导出)[\s\S]{0,15}(?:不要|别|不用|无需)/.test(text) ||
    /(?:撤销|取消)(?:刚才|这个|本次)?(?:任务|操作|生成|修改)?/.test(text)
  );
}

function isExplicitInformationOnly(text: string): boolean {
  return /(?:只想|只是|仅仅?)(?:问|了解|咨询|分析|看看)|不要[\s\S]{0,30}(?:只想|只是)[\s\S]{0,20}(?:问|了解|咨询)/.test(text);
}

function looksLikeProblemReport(text: string): boolean {
  return /(?:有问题|出了问题|不对|失败|异常|打不开|没反应|太少|太多)/.test(text);
}

function looksLikeOfficeOperation(text: string): boolean {
  return /(?:报告|报表|汇报|总结|方案|纪要|文档|表格|台账|PPT|Excel|Word|幻灯片|工作簿|第\s*[一二三四五六七八九十百\d]+\s*(?:章|节|页|张|部分))/i.test(text);
}

function looksLikeUnderspecifiedOperation(text: string): boolean {
  return /^(?:再)?(?:改|修改|调整|优化|删除|删掉|清空|替换|加上?|补充)(?:一下|一点|一个)?[。！!？?]?$/.test(text) ||
    /^(?:做|生成|创建|整理|处理)(?:一个|一份|一下)?[。！!？?]?$/.test(text);
}

function inferDeliverableKind(text: string): DocumentWorkspaceKind | 'auto' {
  const explicit = inferExplicitKind(text);
  if (explicit) return explicit;
  if (/(?:汇报|演示|路演|宣讲|课件)/.test(text)) return 'ppt';
  if (/(?:表格|报表|清单|台账|统计表|数据表|销售表|工资表|库存表)/.test(text)) return 'excel';
  if (/(?:报告|方案|纪要|计划|简历|合同|通知|说明书|文档)/.test(text)) return 'word';
  return 'auto';
}

function parseOrdinal(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Readonly<Record<string, number>> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9
  };
  if (value === '十') return 10;
  if (value === '百') return 100;
  const hundred = value.indexOf('百');
  if (hundred >= 0) {
    const hundreds = digits[value[hundred - 1]] ?? 1;
    const remainder = value.slice(hundred + 1);
    return hundreds * 100 + (remainder ? parseOrdinal(remainder) : 0);
  }
  const ten = value.indexOf('十');
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : digits[value[ten - 1]] ?? 0;
    const ones = digits[value[ten + 1]] ?? 0;
    return tens * 10 + ones;
  }
  return digits[value] ?? 1;
}

function documentKindLabel(kind: DocumentWorkspaceKind): string {
  if (kind === 'ppt') return 'PPT';
  if (kind === 'excel') return 'Excel';
  return 'Word';
}

function hasExplicitTargetReference(
  text: string,
  documents: readonly OfficeDocumentContext[]
): boolean {
  return (
    targetHintFromText(text) !== undefined ||
    /(?:刚才|当前|这份|这个|最新|前一个|上一个)/.test(text) ||
    documents.some((document) =>
      text.toLocaleLowerCase().includes(document.fileName.toLocaleLowerCase())
    )
  );
}

function isDestructiveRevision(text: string): boolean {
  return /(?:删除|删掉|清空|清除|移除)/.test(text) && !/(?:不要|不能|别|保留)[\s\S]{0,20}(?:删除|删掉|清空|清除|移除)|(?:删除|删掉|清空|清除|移除)[\s\S]{0,10}(?:不要|不能|别)/.test(text);
}

function inferSourcePolicy(text: string): ConversationIntentPlan['sourcePolicy'] {
  const web = /(?:联网|网上|网络|最新公开|实时信息)/.test(text);
  const internal = /(?:项目资料|附件|上传文件|内部资料|知识库)/.test(text);
  if (web && internal) return 'mixed';
  if (web) return 'web';
  if (internal) return 'internal';
  return 'none';
}
