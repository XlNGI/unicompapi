import {
  assessConversationIntentPlan,
  parseConversationIntentPlan,
  type ConversationIntentAssessment,
  type ConversationIntentPlan,
  type ConversationWorkflowV1,
  type DocumentContextSnapshot,
  type DocumentWorkspaceKind
} from '../domain';
import { conversationClarificationKey } from './conversation-clarification-fields';

export interface OfficeDocumentContext {
  readonly messageId: string;
  readonly kind: DocumentWorkspaceKind;
  readonly fileName: string;
}

export interface ConversationSemanticContext {
  readonly documents?: readonly OfficeDocumentContext[];
  readonly latestDocumentKind?: DocumentWorkspaceKind;
  readonly availableDocumentKinds?: readonly DocumentWorkspaceKind[];
  readonly currentTask?: { readonly status: ConversationWorkflowV1['status']; readonly plan: ConversationIntentPlan };
  readonly recentUserMessages?: readonly string[];
  readonly recentConversationMessages?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly attachmentFiles?: readonly { readonly fileName: string }[];
  readonly contextTruncated?: boolean;
  readonly contextSnapshot?: DocumentContextSnapshot;
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
  readonly route: 'classifier' | 'unavailable';
  readonly resolvedTarget?: OfficeDocumentContext;
  /** Structured cancellation stops this workflow without exposing document tools. */
  readonly cancelled?: boolean;
  readonly failureCode?:
    | 'classification_timeout'
    | 'classification_unavailable'
    | 'classification_invalid_response'
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

/** Provider adapters use this without passing model output into UI or diagnostics. */
export class ConversationSemanticPlanError extends Error {
  constructor(readonly reason: 'json_invalid' | 'schema_invalid' = 'schema_invalid') {
    super('invalid_intent_plan');
    this.name = 'ConversationSemanticPlanError';
  }
}

/** A provider response was received but could not supply a complete usable answer. */
export class ConversationSemanticResponseError extends Error {
  constructor() {
    super('classification_invalid_response');
    this.name = 'ConversationSemanticResponseError';
  }
}

/**
 * A bounded semantic call exceeded its complete response budget. This remains
 * distinct from a transport failure so the workflow can accurately report a
 * timeout even when the provider had already accepted the request.
 */
export class ConversationSemanticTimeoutError extends Error {
  constructor() {
    super('classification_timeout');
    this.name = 'ConversationSemanticTimeoutError';
  }
}

export interface ConversationIntentOrchestratorOptions {
  readonly classifier?: ConversationIntentClassifierPort;
  readonly classifierTimeoutMs?: number;
  /**
   * A bounded completion/parse grace after the main classifier budget. The
   * classifier is not aborted until this window expires, which avoids losing
   * a response that has already reached result_received while local audit and
   * schema parsing are still completing.
   */
  readonly classifierTimeoutGraceMs?: number;
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
    const unavailable = unavailableDecision();
    const classifier = this.options.classifier;
    if (!classifier) {
      return {
        ...unavailable,
        route: 'unavailable',
        failureCode: 'classification_unavailable'
      };
    }
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = this.options.classifierTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TypeError('classifierTimeoutMs is invalid');
    }
    const timeoutGraceMs = this.options.classifierTimeoutGraceMs ?? 250;
    if (!Number.isSafeInteger(timeoutGraceMs) || timeoutGraceMs < 0 || timeoutGraceMs > 10_000) {
      throw new TypeError('classifierTimeoutGraceMs is invalid');
    }
    let timeoutExpired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let graceTimeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(new ConversationSemanticTimeoutError());
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    timeout = setTimeout(() => {
      // Keep the provider request alive for a short, explicit completion
      // window. This is deliberately finite and is never a retry.
      if (timeoutGraceMs === 0) {
        timeoutExpired = true;
        controller.abort();
        rejectAborted?.();
        return;
      }
      graceTimeout = setTimeout(() => {
        timeoutExpired = true;
        controller.abort();
        rejectAborted?.();
      }, timeoutGraceMs);
    }, timeoutMs);
    try {
      let candidate: unknown;
      try {
        candidate = await Promise.race([classifier.classify({
          rawText: input.rawText,
          context: input.workflow ? { ...context, currentTask: { status: input.workflow.status, plan: input.workflow.plan } } : context,
          signal: controller.signal
        }), aborted]);
        if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
        if (controller.signal.aborted) throw new ConversationSemanticTimeoutError();
      } catch (error) {
        if (input.signal?.aborted) {
          throw new ConversationIntentOrchestrationError('cancelled');
        }
        return {
          ...unavailable,
          route: 'unavailable',
          failureCode: error instanceof ConversationSemanticPlanError ? 'invalid_intent_plan'
            : error instanceof ConversationSemanticResponseError ? 'classification_invalid_response'
              : timeoutExpired || controller.signal.aborted || error instanceof ConversationSemanticTimeoutError
                ? 'classification_timeout' : 'classification_unavailable'
        };
      }
      let classified: ConversationIntentPlan;
      try {
        classified = parseConversationIntentPlan(candidate);
      } catch {
        return { ...unavailable, route: 'unavailable', failureCode: 'invalid_intent_plan' };
      }
      return validateAgentDecision(classified, context);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (graceTimeout) clearTimeout(graceTimeout);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

function validateAgentDecision(
  classified: ConversationIntentPlan,
  context: ConversationSemanticContext
): ConversationIntentDecision {
  const missing = new Set(classified.missing.map(conversationClarificationKey));
  if (classified.kind === 'document' && (!classified.documentKind || classified.documentKind === 'auto')) missing.add('document_kind');
  let target: OfficeDocumentContext | undefined;
  if (classified.kind === 'document' && classified.action === 'revise') {
    const candidates = (context.documents ?? []).filter((document) =>
      classified.documentKind === 'auto' || document.kind === classified.documentKind);
    const hint = classified.targetHint;
    const matching = hint?.name
      ? candidates.filter((document) => document.fileName === hint.name)
      : candidates;
    if (matching.length === 1) target = matching[0];
    else missing.add('document_target');
  }
  const plan = parseConversationIntentPlan({
    ...classified,
    ...(target ? { documentKind: target.kind } : {}),
    missing: [...missing],
    confidence: missing.size ? 'low' : classified.confidence,
    needsConfirmation: classified.needsConfirmation
  });
  // sourcePolicy expresses requested capability; the research service still
  // requires a separate scoped authorization before any network operation.
  return { plan, assessment: assessConversationIntentPlan(plan), route: 'classifier', ...(plan.kind === 'cancel' ? { cancelled: true } : {}), ...(target ? { resolvedTarget: target } : {}) };
}

function unavailableDecision(): ConversationIntentDecision {
  const plan = parseConversationIntentPlan({ schemaVersion: 1, kind: 'unknown', parameters: {}, sourcePolicy: 'none',
    missing: [], ambiguities: ['semantic_plan_unavailable'], confidence: 'low', needsConfirmation: false });
  return { plan, assessment: assessConversationIntentPlan(plan), route: 'unavailable' };
}
