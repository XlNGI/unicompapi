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
import { conversationClarificationKey } from './conversation-clarification-fields';
import { hasDocumentSubject } from './document-request-completeness';

export interface ConversationSemanticContext extends OfficeRequestContext {
  readonly recentUserMessages?: readonly string[];
  readonly requestedIntentKind?: 'document';
  readonly requestedDocumentKind?: DocumentWorkspaceKind | 'auto';
  readonly semanticCandidate?: {
    readonly candidateId: string;
    readonly productFeature: 'text_chat' | 'text_reasoning';
  };
}

export interface ConversationIntentDecision {
  readonly plan: ConversationIntentPlan;
  readonly assessment: ConversationIntentAssessment;
  readonly route: 'local' | 'classifier' | 'fallback';
  readonly resolvedTarget?: OfficeDocumentContext;
  /** A trusted user cancellation never becomes a model execution plan. */
  readonly cancelled?: boolean;
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
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    const context = input.context ?? {};
    const local = analyzeLocalConversationIntent({
      rawText: input.rawText,
      context,
      workflow: input.workflow
    });
    if (local.cancelled || local.plan.kind !== 'unknown' || !this.options.classifier ||
      local.plan.ambiguities.some((item) => ['single_copy_per_kind', 'single_revision_target'].includes(item))) return local;
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = this.options.classifierTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new TypeError('classifierTimeoutMs is invalid');
    }
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs
    );
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(new Error('Intent classification aborted'));
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    try {
      let candidate: unknown;
      try {
        candidate = await Promise.race([this.options.classifier.classify({
          rawText: input.rawText,
          context,
          signal: controller.signal
        }), aborted]);
        if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
        if (controller.signal.aborted) throw new Error('Intent classification timed out');
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
      const trustedRequirements = input.workflow && context.recentUserMessages?.length
        ? context.recentUserMessages.join('\n')
        : input.rawText;
      const sourcePolicy = inferSourcePolicy(trustedRequirements);
      if (classified.kind === 'document' && classified.action !== 'create' && classified.action !== 'revise') {
        return { ...local, route: 'fallback', failureCode: 'invalid_intent_plan' };
      }
      const target = classified.action === 'revise'
        ? resolveSemanticTarget(input.rawText, inferExplicitKind(input.rawText), context.documents ?? [])
        : undefined;
      const missing = new Set(classified.missing.map(conversationClarificationKey));
      if (classified.action === 'revise' && !target) missing.add('document_target');
      if (classified.kind === 'document' && classified.action === 'create' && classified.documentKind === 'ppt' && !hasDocumentSubject(trustedRequirements)) {
        missing.add('document_topic');
      }
      const plan = parseConversationIntentPlan({
        ...classified,
        sourcePolicy,
        ...(target ? { documentKind: target.kind } : {}),
        ...(classified.kind === 'document' ? {
          parameters: { ...classified.parameters, requirements: trustedRequirements },
          targetHint: targetHintFromText(input.rawText) ?? (target ? { unit: 'document', name: target.fileName } : undefined)
        } : {}),
        missing: [...missing],
        confidence: missing.size > 0 ? 'low' : classified.confidence,
        needsConfirmation: classified.needsConfirmation || (classified.kind === 'document' && isDestructiveRevision(trustedRequirements))
      });
      return { plan, assessment: assessConversationIntentPlan(plan), route: 'classifier', ...(target ? { resolvedTarget: target } : {}) };
    } finally {
      clearTimeout(timeout);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
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
  if (!text) return decision(unknownPlan('empty_input'), 'local');
  if (isExplicitInformationOnly(text)) return decision(chatPlan(text), 'local');
  if (isConversationCancellation(text)) {
    return { ...decision(unknownPlan('已取消当前请求'), 'local'), cancelled: true };
  }
  if (input.workflow?.status === 'needs_clarification' && input.workflow.plan.missing.includes('document_topic') &&
    /^(?:好的?|继续|谢谢|收到|其他你来安排)[。！!\s]*$/u.test(text)) return decision(input.workflow.plan, 'local');
  // Writing a prompt or describing an image is an inline response even when a
  // previous turn left a document workflow or output preference behind.
  if (isInlineContentRequest(text)) return decision(chatPlan(text), 'local');
  // An explicit question overrides a stale output preference and a pending task.
  if (isQuestionOrAnalysis(text)) return decision(chatPlan(text), 'local');
  const unsupported = unsupportedOutputScope(text);
  if (unsupported) return decision(unknownPlan(unsupported, text), 'local');
  if (requiresSemanticReview(text)) return decision(unknownPlan('semantic_operation', text), 'local');
  if (input.workflow?.plan.deliverables?.every((kind) => negatedDocumentKinds(text).includes(kind))) {
    return { ...decision(unknownPlan('已取消当前请求'), 'local'), cancelled: true };
  }
  if (input.workflow && ['needs_clarification', 'needs_confirmation', 'ready'].includes(input.workflow.status)) {
    const merged = mergeWorkflowClarification(input.workflow.plan, text, context);
    if (merged) {
      return {
        ...decision(merged.plan, 'local'),
        ...(merged.resolvedTarget ? { resolvedTarget: merged.resolvedTarget } : {})
      };
    }
    if (input.workflow.plan.missing.includes('document_topic') && !hasDocumentSubject(text)) {
      return decision(input.workflow.plan, 'local');
    }
  }
  if (context.requestedIntentKind === 'document' && inferExplicitKinds(text).length < 2) {
    const explicitKind = inferExplicitKind(text);
    const requestedKind = explicitKind ?? context.requestedDocumentKind ?? 'auto';
    const office = analyzeOfficeRequest(text, context);
    const action = office.kind === 'document' && office.action === 'revise'
      ? 'revise'
      : 'create';
    const target = action === 'revise'
      ? resolveSemanticTarget(text, requestedKind === 'auto' ? undefined : requestedKind, context.documents ?? [])
      : undefined;
    const missing = action === 'revise' && !target
      ? ['document_target']
      : [];
    const plan = documentPlan(
      action,
      requestedKind,
      text,
      missing.length > 0 ? 'low' : 'high',
      missing,
      missing.length > 0 && (context.documents?.length ?? 0) > 1 ? ['multiple_document_targets'] : [],
      targetHintFromText(text) ?? (target ? { unit: 'document', name: target.fileName } : undefined)
    );
    return { ...decision(plan, 'local'), ...(target ? { resolvedTarget: target } : {}) };
  }
  const explicitKinds = inferExplicitKinds(text);
  if (explicitKinds.length > 1 && /(?:并|同时|以及|和|再|然后)/.test(text)) {
    return decision(documentPlan(
      'create',
      explicitKinds[0],
      text,
      'high',
      [],
      [],
      undefined,
      explicitKinds
    ), 'local');
  }
  if (looksLikeProblemReport(text) && !hasStrongCreateCommand(text)) {
    return decision(unknownPlan('intent_operation'), 'local');
  }
  if (isBareTableCreation(text)) {
    return decision(documentPlan('create', 'excel', text, 'high'), 'local');
  }
  if (isSummaryDeliverable(text) && inferExplicitKind(text) === undefined) {
    return decision(documentPlan(
      'create',
      'auto',
      text,
      'low',
      ['document_kind']
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
      return decision(unknownPlan('intent_operation'), 'local');
    }
    return decision(chatPlan(text), 'local');
  }
  if (office.action === 'create' && !hasStrongCreateCommand(text)) {
    return decision(unknownPlan('create_instruction'), 'local');
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
      ['document_target'],
      ['multiple_document_targets']
    ), 'local');
  }
  const plan = documentPlan(
    office.action,
    office.documentKind ?? 'auto',
    text,
    office.missing.length > 0 ? 'low' : 'high',
    office.missing.map(conversationClarificationKey),
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
    if (plan.ambiguities.includes('single_copy_per_kind') && /(?:先|只)(?:做|生成|制作|要)/.test(answer)) {
      const kind = inferExplicitKind(answer);
      if (kind) return { plan: documentPlan('create', kind, `${String(plan.parameters.requirements ?? '')}\n本次仅执行：${answer}`, 'high') };
    }
    if (plan.ambiguities.includes('single_revision_target') && /(?:先|只)(?:修改|调整|修订|改)/.test(answer)) {
      const selected = analyzeLocalConversationIntent({ rawText: answer, context });
      if (selected.plan.kind === 'document' && selected.plan.action === 'revise') {
        const requirements = `${String(plan.parameters.requirements ?? '')}\n本次仅修改：${answer}`;
        return { ...selected, plan: parseConversationIntentPlan({ ...selected.plan, parameters: { ...selected.plan.parameters, requirements } }) };
      }
    }
    const recent = context.recentUserMessages ?? [];
    const turns = recent.at(-1)?.trim() === answer.trim()
      ? recent
      : [...recent, answer];
    const recovered = analyzeLocalConversationIntent({
      rawText: turns.slice(-8).join('\n'),
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
  if (plan.kind !== 'document') return undefined;
  // A complete new request starts its own semantic plan; terse answers update
  // the pending one. This prevents an unrelated new task inheriting old targets.
  if (hasStrongCreateCommand(answer) && /(?:关于|一份|一个|培训|报告|方案|课件)/.test(answer)) {
    return undefined;
  }
  const parameters = { ...plan.parameters };
  const remaining = new Set(plan.missing.map(conversationClarificationKey));
  const answersTopic = remaining.has('document_topic') && hasDocumentSubject(answer);
  if (answersTopic) remaining.delete('document_topic');
  const excludedKinds = negatedDocumentKinds(answer);
  const retainedKinds = plan.deliverables?.filter((item) => !excludedKinds.includes(item));
  const kind = inferExplicitKind(answer) ?? retainedKinds?.[0];
  if (kind) {
    remaining.delete('document_kind');
    remaining.delete('single_deliverable');
    if (kind !== 'ppt') remaining.delete('document_topic');
  }
  const pageCount = answer.match(/(?:共|做|要)?\s*(\d{1,3})\s*(?:页|张)/)?.[1];
  if (pageCount) {
    parameters.pageCount = Number(pageCount);
    remaining.delete('page_count');
  }
  const audience = answer.match(/(?:给|面向|用于)([^，。；]{2,30})(?:看|使用|汇报|，|。|；|$)/)?.[1];
  if (audience) {
    parameters.audience = audience.trim();
    remaining.delete('audience');
  }
  const style = answer.match(/(简洁|简约|商务|专业|科技|自然|正式|活泼)(?:风|一点|一些)?/)?.[1];
  if (style) {
    parameters.style = style;
    remaining.delete('style');
  }
  const target = plan.action === 'revise'
    ? resolveSemanticTarget(
        answer,
        kind ?? (plan.documentKind === 'auto' ? undefined : plan.documentKind),
        context.documents ?? []
      )
    : undefined;
  if (target) {
    remaining.delete('document_target');
  }
  const isSupplement = /(?:重点|保留|不要|不用|不做|改为|改成|改得|补充|加入|增加|删除|删掉|清空|用|只|再|先)/.test(answer);
  if (!kind && !pageCount && !audience && !style && !target && !isSupplement && !answersTopic) return undefined;
  const ambiguities = plan.ambiguities.map(conversationClarificationKey).filter((item) =>
    !(target && item === 'multiple_document_targets') &&
    !(kind && item === 'multiple_deliverable_kinds')
  );
  const previous = typeof parameters.requirements === 'string'
    ? parameters.requirements
    : typeof parameters.topic === 'string' ? parameters.topic : '';
  const requirements = `${previous}\n后续要求（与此前冲突时以此为准）：${answer}`;
  if (requirements.length > 16_000) throw new TypeError('累计需求超过当前任务的 16000 字符上限，请开始新任务或缩短补充内容');
  parameters.requirements = requirements;
  parameters.topic = requirements.slice(0, 2_000);
  if (plan.action === 'create' && (kind ?? plan.documentKind) === 'ppt' && !hasDocumentSubject(requirements)) {
    remaining.add('document_topic');
  }
  const sourcePolicy = inferSourcePolicy(requirements);
  const merged = parseConversationIntentPlan({
    ...plan,
    documentKind: kind ?? target?.kind ?? plan.documentKind,
    ...(plan.deliverables && kind ? {
      deliverables: /(?:只做|只要|仅做)/.test(answer)
        ? [kind]
        : [kind, ...(retainedKinds ?? plan.deliverables).filter((item) => item !== kind)]
    } : {}),
    ...(target ? { targetHint: { unit: 'document', name: target.fileName } } : {}),
    parameters,
    sourcePolicy,
    missing: [...remaining],
    ambiguities,
    confidence: remaining.size === 0 && ambiguities.length === 0 ? 'high' : plan.confidence,
    needsConfirmation: plan.needsConfirmation || isDestructiveRevision(answer)
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
  targetHint?: ConversationIntentPlan['targetHint'],
  deliverables?: readonly DocumentWorkspaceKind[]
): ConversationIntentPlan {
  return parseConversationIntentPlan({
    schemaVersion: 1,
    kind: 'document',
    action,
    documentKind,
    ...(deliverables ? { deliverables } : {}),
    ...(targetHint ? { targetHint } : {}),
    parameters: { topic: topic.slice(0, 2_000), requirements: topic },
    sourcePolicy: inferSourcePolicy(topic),
    missing: action === 'create' && documentKind === 'ppt' && !hasDocumentSubject(topic)
      ? [...new Set([...missing, 'document_topic'])] : missing,
    ambiguities,
    confidence,
    needsConfirmation: isDestructiveRevision(topic)
  });
}

function unknownPlan(reason: string, requirements?: string): ConversationIntentPlan {
  return parseConversationIntentPlan({
    schemaVersion: 1,
    kind: 'unknown',
    parameters: requirements ? { requirements } : {},
    sourcePolicy: 'none',
    missing: [],
    ambiguities: [reason],
    confidence: 'low',
    needsConfirmation: false
  });
}

function chatPlan(text: string): ConversationIntentPlan {
  return parseConversationIntentPlan({
    schemaVersion: 1,
    kind: 'chat',
    parameters: {},
    sourcePolicy: inferSourcePolicy(text),
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
  return inferExplicitKinds(text)[0];
}

function inferExplicitKinds(text: string): readonly DocumentWorkspaceKind[] {
  const positive = affirmativeClauses(text);
  const kinds: DocumentWorkspaceKind[] = [];
  if (/(?:\bpptx?\b|幻灯片|演示文稿|课件)/i.test(positive)) kinds.push('ppt');
  if (/(?:\bexcel\b|\bxlsx\b|工作簿|电子表格)/i.test(positive)) kinds.push('excel');
  if (/(?:\bword\b|\bdocx\b|文字文档)/i.test(positive)) kinds.push('word');
  // A table inside Word/PPT is content, not another Excel deliverable.
  if (kinds.length === 0 && /(?:表格|台账)/.test(positive)) kinds.push('excel');
  const position = (kind: DocumentWorkspaceKind) => positive.search(kind === 'ppt'
    ? /(?:\bpptx?\b|幻灯片|演示文稿|课件)/i
    : kind === 'word' ? /(?:\bword\b|\bdocx\b|文字文档)/i
      : /(?:\bexcel\b|\bxlsx\b|工作簿|电子表格|表格|台账)/i);
  return kinds.sort((a, b) => position(a) - position(b));
}

function affirmativeClauses(text: string): string {
  return text.split(/[，,。；;\n]/).map((clause) =>
    clause.replace(/(?:取消|不要|不是|不用|不需要|无需)(?:再)?(?:做|生成|制作)?\s*(?:PPTX?|Word|DOCX|Excel|XLSX|幻灯片|演示文稿|课件|表格|工作簿|文字文档)/ig, '')
      .replace(/(?:PPTX?|Word|DOCX|Excel|XLSX|幻灯片|演示文稿|课件|表格|工作簿|文字文档)\s*(?:不做|不要|不用做|取消)(?:了)?/ig, '')
  ).join('，');
}

function negatedDocumentKinds(text: string): readonly DocumentWorkspaceKind[] {
  const negativeText = text.split(/[，,。；;\n]/).filter((clause) =>
    /^(?:取消|不要|不用|不做|不需要)/.test(clause.trim()) || /(?:PPTX?|Word|DOCX|Excel|XLSX)\s*(?:不做|不要|取消|不用做)/i.test(clause)
  ).join('，');
  const matches = negativeText.match(/PPTX?|Word|DOCX|Excel|XLSX/ig) ?? [];
  return [...new Set(matches.flatMap((item) => {
    if (/ppt/i.test(item)) return ['ppt' as const];
    if (/word|docx/i.test(item)) return ['word' as const];
    return ['excel' as const];
  }))];
}

function unsupportedOutputScope(text: string): 'single_copy_per_kind' | 'single_revision_target' | undefined {
  if (/(?:做|生成|制作|创建|导出)[^，。；]{0,20}(?:[2-9]|\d{2,}|两|二|三|四|五|六|七|八|九|十|多|若干)\s*(?:份|个|套|本)[^，。；]{0,15}(?:PPT|Word|Excel|报告|方案|文档|演示)/i.test(text)) return 'single_copy_per_kind';
  const types = [...text.matchAll(/\b(pptx?|word|docx|excel|xlsx)\b/ig)].map((match) => match[1].toLowerCase().replace('pptx', 'ppt').replace('docx', 'word').replace('xlsx', 'excel'));
  if (types.length > new Set(types).size && /(?:分别|各做|各生成|两份|另做|另一份)/.test(text)) return 'single_copy_per_kind';
  if (/(?:修改|调整|更新|修订|删除|改)/.test(text) &&
    (/(?:这两份|这几份|两份|所有文档|全部文档)/.test(text) ||
      (inferExplicitKinds(text).length > 1 && /(?:和|以及|同时|都|分别)/.test(text)))) return 'single_revision_target';
  return undefined;
}

function requiresSemanticReview(text: string): boolean {
  const topicText = text.split(/(?:关于|介绍|解释|讲解|比较|对比|转换|转成|转为)/).slice(1).join(' ');
  if (hasStrongCreateCommand(text) && inferExplicitKinds(text).length > 1 &&
    inferExplicitKinds(topicText).length > 0) return true;
  return !hasStrongCreateCommand(text) &&
    /(?:准备|压缩|转换|变成|转成|转为|重写|梳理)/.test(text) &&
    /(?:资料|材料|附件|文件|文档|演示|汇报|领导|董事会|客户)/.test(text) &&
    !/(?:怎么|如何|为什么|是什么|[？?])/.test(text);
}

function hasStrongCreateCommand(text: string): boolean {
  return (
    /^(?:我)?(?:想|想要|要|需要)(?:请你)?\s*(?:做|制作|生成|创建|写|导出)/u.test(text) ||
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

function isInlineContentRequest(text: string): boolean {
  const promptRequest = /(?:提示词|\bprompts?\b)/i.test(text);
  const imageAnalysis = /(?:图片|图像|截图|照片|这张图)/.test(text) &&
    /(?:分析|识别|描述|解释|提取|反推|解读|看看|看一下)/.test(text);
  if (!promptRequest && !imageAnalysis) return false;
  // “生成 PPT 的提示词” asks for text; “生成提示词 PPT” asks for a file.
  // Remove only the former content reference before checking file delivery.
  const delivery = affirmativeClauses(text).replace(
    /(?:PPTX?|Word|DOCX|Excel|XLSX|幻灯片|演示文稿|课件|文档)\s*(?:制作|生成)?(?:的|用的)\s*(?:提示词|prompts?)/ig,
    ''
  );
  return inferDeliverableKind(delivery) === 'auto' &&
    !/(?:保存|导出|输出|整理)(?:成|为)?(?:一份|一个)?(?:文件|文档)/.test(delivery);
}

function isQuestionOrAnalysis(text: string): boolean {
  if (/(?:在这里|在会话里|直接|只要|只需)(?:回复|回答)|(?:不用|无需|不要)(?:生成|创建|导出)(?:文件|文档)/.test(text)) return true;
  if (/^(?:谢谢|感谢|好的|收到|你好|您好)[！!。\s]*$/.test(text)) return true;
  const explicitDeliverable = hasStrongCreateCommand(text) && inferDeliverableKind(text) !== 'auto';
  const informationAboutCreating =
    /(?:怎么|如何)(?:做|生成|制作|创建|写|编写|导出)/.test(text) ||
    /(?:生成|制作|创建|编写|导出)[^，。；]{0,30}(?:时|的过程|的步骤)[^，。；]{0,20}(?:注意|如何|怎么|什么)/.test(text);
  if (explicitDeliverable && !informationAboutCreating) return false;
  if (/(?:告诉我|给我解释|帮我看看|主要讲了什么)/.test(text)) return true;
  const hasQuestionConstruction =
    /(?:怎么|如何|为什么|是什么|有哪些|有什么区别|需要注意什么|是否|能否|能不能|可不可以|可以吗)/u.test(text);
  const politeDocumentRequest =
    /^(?:请问)?(?:能否|能不能|可不可以|可以(?:请你)?)(?:帮我|给我)?\s*(?:做|生成|制作|创建|写|编写|起草|整理|输出|导出)/.test(text) ||
    /^(?:请|帮我|给我|麻烦(?:你)?)[\s\S]{0,20}(?:做|生成|制作|创建|写|编写|起草|整理|输出|导出)[\s\S]*[？?]$/.test(text);
  return (
    ((hasQuestionConstruction || /[？?]\s*$/u.test(text)) && !politeDocumentRequest) ||
    /^(?:请|帮我)?分析(?:这|一下)?/.test(text) ||
    /^(?:请|帮我)?(?:总结|概括|提炼|解释|评价|点评|翻译)(?!成|为|一份|一个)/.test(text)
  );
}

export function isConversationCancellation(text: string): boolean {
  const clauses = text.trim().split(/[，,。；;\n]/).map((item) => item.trim()).filter(Boolean);
  if (clauses.some((clause) => /^(?:请|帮我|麻烦)?(?:先|立即|现在)?(?:撤销|取消|停止)(?:(?:刚才|这个|本次|当前|全部|所有|的|任务|操作|生成|制作|修改|执行|吧|了)|\s)*[！!]?$/u.test(clause))) return true;
  const negatedOperation = /^(?:我)?(?:不要|别|不用|无需|不需要|不必|不想)(?:再|继续|帮我)?(?:做|生成|制作|创建|写|修改|调整|删除|清空|导出)[^？?]{0,60}$/;
  const cancellation = clauses.some((clause) => negatedOperation.test(clause) || /^(?:先)?(?:不做|不改|不生成|不需要做)(?:了|啦|吧)?[！!]?$/.test(clause));
  // A positive replacement such as “不要做 PPT，改做 Word” is a correction.
  const replacement = clauses.some((clause) =>
    !negatedOperation.test(clause) && /^(?:而是|改为|改成|改做|只要|只做|要|做|生成)/.test(clause) && inferExplicitKind(clause) !== undefined
  );
  return cancellation && !replacement;
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
  // This policy only proposes sources. Network authorization remains a separate
  // application gate; neither a recency match nor a model plan can grant it.
  let web = false;
  let disabled = false;
  const internal = INTERNAL_SOURCE_REFERENCE.test(text);
  // Requirements append trusted user follow-ups on new lines. A later refusal
  // wins over old research needs, and only a later explicit request lifts it.
  for (const requirement of text.split(/\n/)) {
    if (declinesWebResearch(requirement)) {
      disabled = true;
      web = false;
    } else if (requestsWebResearch(requirement)) {
      disabled = false;
      web = true;
    } else if (!disabled && needsCurrentPublicFacts(requirement)) {
      web = true;
    }
  }
  if (web && internal) return 'mixed';
  if (web) return 'web';
  if (internal) return 'internal';
  return 'none';
}

const INTERNAL_SOURCE_REFERENCE = /(?:项目资料|附件|上传[^，。；;\n]{0,8}(?:文件|资料|数据)|内部资料|知识库|本地资料)/;
const CURRENT_INFORMATION_MARKER = /(?:最新|近期|最近|今天|当前|目前|现今|当下|今年|实时)/;
const PUBLIC_FACT_SUBJECT = /(?:数据|信息|政策|法规|标准|趋势|进展|动态|新闻|报道|行情|天气|股价|汇率|价格|市场|行业|产业|竞品|统计)/;

export function declinesWebResearch(text: string): boolean {
  const exclusiveSource = text.match(/(?:仅|只)(?:参考|依据|根据|使用|用)([^，。；;\n]{1,24})/)?.[1];
  return /(?:不要|不用|无需|禁止|不需要|不允许|别|不|停止|取消|关闭)(?:再|进行|使用|启用)?\s*(?:联网|上网|(?:网络|网上|互联网)(?:搜索|检索)|(?:搜索|检索)(?:网络|网上|互联网))/.test(text) ||
    /(?:联网|上网|网络)(?:搜索|检索)?(?:先)?(?:不用|不需要|不要|禁止|停止|取消)/.test(text) ||
    (exclusiveSource !== undefined && INTERNAL_SOURCE_REFERENCE.test(exclusiveSource));
}

function requestsWebResearch(text: string): boolean {
  // Network concepts and product features are subjects, not search requests.
  const request = text.replace(/(?:物联网|联网|上网|网络|互联网)(?:检索|搜索)?(?:的)?(?:工作原理|原理|是什么|有什么|怎么配置|配置|设置|功能|协议|技术|安全|基础|知识|教程)/g, '');
  return /(?<!物)(?:联网|上网)/.test(request) ||
    /(?:网上|网络|互联网)(?:上)?(?:搜索|检索|查询|查找|查一下|查查|核实|搜集|收集)/.test(request) ||
    /(?:搜索|检索|查询|查找|查一下|查查|核实|搜集|收集)(?:一下)?(?:网上|网络|互联网)/.test(request) ||
    /(?:根据|结合|使用|用)(?:网上|网络|互联网)(?:的)?(?:资料|信息|数据|来源|新闻|报道|内容)/.test(request);
}

function needsCurrentPublicFacts(text: string): boolean {
  return text.split(/[，,。；;\n]/).some((clause) => {
    // File recency describes the user's material; it does not request fresh
    // public information. Keep other recency markers in the same clause.
    const facts = clause
      .replace(/(?:最新|近期|最近|当前|今天)(?:的|刚)?(?:上传|提供|提交|编辑|修改|保存)(?:的)?/g, '')
      .replace(/(?:最新|当前)(?:的)?(?:附件|文件|文档|版本|草稿|模板)/g, '');
    if (CURRENT_INFORMATION_MARKER.test(facts) && PUBLIC_FACT_SUBJECT.test(facts)) return true;
    // “行业现状” already asks about the present without saying “最新”. A
    // clause grounded in local material keeps using that material by default.
    return !INTERNAL_SOURCE_REFERENCE.test(clause) &&
      /(?:行业|产业|市场|竞品)[^，。；;\n]{0,12}(?:现状|趋势|动态|格局)/.test(facts);
  });
}
