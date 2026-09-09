import {
  createConversationWorkflow,
  parseConversationIntentPlan,
  parseConversationWorkflow,
  toConversationWorkflowId,
  toIsoTimestamp,
  updateConversationWorkflow,
  type ConversationId,
  type ConversationWorkflowId,
  type ConversationWorkflowRepository,
  type ConversationWorkflowV1,
  type ConversationWorkflowDelivery,
  type ConversationIntentPlan,
  type ConversationWorkflowStatus,
  type MessageId,
  type ProjectId
} from '../domain';
import {
  ConversationIntentOrchestrationError,
  type ConversationIntentOrchestrator,
  type ConversationSemanticContext
} from './conversation-intent-orchestrator';
import { conversationClarificationKey, conversationClarificationLabel } from './conversation-clarification-fields';

export type ConversationWorkflowApplicationErrorCode =
  | 'workflow_not_found'
  | 'workflow_revision_conflict'
  | 'clarification_required'
  | 'confirmation_required'
  | 'confirmation_expired'
  | 'workflow_not_ready';

export class ConversationWorkflowApplicationError extends Error {
  constructor(
    readonly code: ConversationWorkflowApplicationErrorCode,
    message: string,
    readonly currentRevision?: number
  ) {
    super(message);
    this.name = 'ConversationWorkflowApplicationError';
  }
}

export class ConversationWorkflowService {
  constructor(
    private readonly repository: ConversationWorkflowRepository,
    private readonly orchestrator: ConversationIntentOrchestrator,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly nextId: () => ConversationWorkflowId = () =>
      toConversationWorkflowId(`conversation-workflow-${secureRandomUuid()}`),
    private readonly confirmationTtlMs = 10 * 60 * 1_000
  ) {}

  async create(input: {
    readonly projectId: ProjectId;
    readonly conversationId: ConversationId;
    readonly sourceMessageId: MessageId;
    readonly rawText: string;
    readonly context?: ConversationSemanticContext;
    readonly signal?: AbortSignal;
  }): Promise<ConversationWorkflowV1> {
    if (input.projectId !== this.repository.projectId) throw new TypeError('Conversation workflow project does not match repository scope');
    const decision = await this.orchestrator.analyze({ rawText: input.rawText, context: input.context, signal: input.signal });
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    const createdAt = toIsoTimestamp(this.now());
    const confirmation = await confirmationForPlan(
      decision.plan,
      createdAt,
      this.confirmationTtlMs
    );
    const created = createConversationWorkflow({
      id: this.nextId(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      plan: decision.plan,
      pendingQuestions: questionsForDecision(decision.plan),
      ...(decision.resolvedTarget
        ? {
            resolvedTarget: {
              artifactRef: decision.resolvedTarget.messageId,
              version: 1
            }
          }
        : {}),
      ...confirmation,
      createdAt
    });
    const workflow = decision.cancelled
      ? parseConversationWorkflow({
          ...created, status: 'cancelled', pendingQuestions: [],
          ...(created.deliveries ? { deliveries: created.deliveries.map((item) => ({ ...item, status: 'cancelled' as const })) } : {})
        })
      : created;
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    await this.repository.createSupersedingPending(workflow);
    return workflow;
  }

  async answer(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
    readonly rawText: string;
    readonly sourceMessageId?: MessageId;
    readonly context?: ConversationSemanticContext;
    readonly signal?: AbortSignal;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    if (!['needs_clarification', 'needs_confirmation', 'ready'].includes(current.status)) {
      throw new TypeError('Conversation workflow cannot accept an answer in its current state');
    }
    const decision = await this.orchestrator.analyze({
      rawText: input.rawText,
      context: input.context,
      signal: input.signal,
      workflow: current
    });
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    const updatedAt = toIsoTimestamp(this.now());
    const deliveries = synchronizeDeliveries(current, decision.plan, decision.cancelled);
    const nextDelivery = deliveries?.find((item) => item.status === 'pending');
    const nextPlan = nextDelivery && decision.plan.kind === 'document'
      ? parseConversationIntentPlan({ ...decision.plan, documentKind: nextDelivery.kind })
      : decision.plan;
    const confirmation = await confirmationForPlan(nextPlan, updatedAt, this.confirmationTtlMs);
    const nextBase = {
      ...current,
      ...(input.sourceMessageId && (decision.plan.kind === 'chat' || decision.plan.parameters.requirements === input.rawText)
        ? { sourceMessageId: input.sourceMessageId } : {}),
      deliveries: undefined,
      resolvedTarget: undefined,
      confirmationId: undefined,
      planHash: undefined,
      confirmationExpiresAt: undefined
    };
    const updated = updateConversationWorkflow(nextBase, {
      plan: nextPlan,
      ...(deliveries !== undefined ? { deliveries } : {}),
      ...(decision.cancelled ? { status: 'cancelled' as const } : {}),
      pendingQuestions: decision.cancelled ? [] : questionsForDecision(decision.plan),
      ...(decision.resolvedTarget
        ? {
            resolvedTarget: {
              artifactRef: decision.resolvedTarget.messageId,
              version: 1
            }
          }
        : decision.plan.action === 'revise' && decision.plan.targetHint?.name === current.plan.targetHint?.name && current.resolvedTarget
          ? { resolvedTarget: current.resolvedTarget }
          : {}),
      ...confirmation,
      updatedAt
    });
    if (input.signal?.aborted) throw new ConversationIntentOrchestrationError('cancelled');
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  async confirm(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    if (current.status !== 'needs_confirmation') {
      throw new ConversationWorkflowApplicationError(
        'confirmation_required',
        'Conversation workflow does not require confirmation'
      );
    }
    const confirmedAt = toIsoTimestamp(this.now());
    if (!current.confirmationExpiresAt || current.confirmationExpiresAt <= confirmedAt) {
      const expired = updateConversationWorkflow(current, {
        status: 'cancelled',
        updatedAt: confirmedAt
      });
      await this.repository.save(expired, input.expectedRevision);
      throw new ConversationWorkflowApplicationError(
        'confirmation_expired',
        'Conversation workflow confirmation has expired',
        expired.revision
      );
    }
    if (!current.planHash || current.planHash !== await hashPlan(current.plan)) {
      throw new ConversationWorkflowApplicationError(
        'confirmation_required',
        'Conversation workflow confirmation no longer matches the plan'
      );
    }
    const plan = parseConversationIntentPlan({ ...current.plan, needsConfirmation: false, confidence: 'high' });
    const updated = updateConversationWorkflow(current, {
      plan,
      status: 'ready',
      pendingQuestions: [],
      updatedAt: confirmedAt
    });
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  async cancel(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    const updated = updateConversationWorkflow(current, {
      status: 'cancelled',
      ...(current.deliveries ? { deliveries: current.deliveries.map((item) => item.status === 'completed' ? item : { ...item, status: 'cancelled' as const }) } : {}),
      updatedAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  get(id: ConversationWorkflowId): Promise<ConversationWorkflowV1 | undefined> {
    return this.repository.get(id);
  }

  list(conversationId?: ConversationId): Promise<readonly ConversationWorkflowV1[]> {
    return this.repository.list(conversationId);
  }

  async getPending(conversationId: ConversationId): Promise<ConversationWorkflowV1 | undefined> {
    return (await this.repository.list(conversationId)).find((workflow) =>
      ['needs_clarification', 'needs_confirmation', 'ready'].includes(workflow.status) ||
      (workflow.status === 'failed' && workflow.deliveries?.some((item) => item.status === 'failed'))
    );
  }

  async beginExecution(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
    readonly executionId: string;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    if (current.status !== 'ready') {
      throw new ConversationWorkflowApplicationError(
        current.status === 'needs_clarification'
          ? 'clarification_required'
          : current.status === 'needs_confirmation'
            ? 'confirmation_required'
            : 'workflow_not_ready',
        'Conversation workflow is not ready to execute',
        current.revision
      );
    }
    if (current.deliveries && current.plan.kind === 'document' && !current.deliveries.some((item) => item.kind === current.plan.documentKind && item.status === 'pending')) {
      throw new ConversationWorkflowApplicationError('workflow_not_ready', 'The current document has already been delivered or cancelled', current.revision);
    }
    const updated = updateConversationWorkflow(current, {
      status: 'executing',
      executionId: input.executionId,
      ...(current.deliveries ? { deliveries: current.deliveries.map((item) =>
        item.kind === current.plan.documentKind && item.status === 'pending'
          ? { ...item, status: 'executing' as const, executionId: input.executionId }
          : item
      ) } : {}),
      updatedAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  async bindExecution(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
    readonly executionId: string;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    if (current.status !== 'executing') {
      throw new ConversationWorkflowApplicationError(
        'workflow_not_ready',
        'Conversation workflow is not executing',
        current.revision
      );
    }
    const updated = updateConversationWorkflow(current, {
      status: 'executing',
      executionId: input.executionId,
      ...(current.deliveries ? { deliveries: current.deliveries.map((item) =>
        item.status === 'executing' ? { ...item, executionId: input.executionId } : item
      ) } : {}),
      updatedAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  async finishExecution(
    executionId: string,
    status: Extract<ConversationWorkflowStatus, 'completed' | 'failed' | 'cancelled'>
  ): Promise<ConversationWorkflowV1 | undefined> {
    const current = (await this.repository.list()).find(
      (workflow) => workflow.status === 'executing' && workflow.executionId === executionId
    );
    if (!current) return undefined;
    // Provider text is only an intermediate Office input. Official completion
    // must arrive with the locally registered work through finishDocumentExecution.
    if (current.plan.kind === 'document') {
      if (status === 'completed') return current;
      return this.finishDocumentExecution(executionId, status);
    }
    const updated = updateConversationWorkflow(current, {
      status,
      updatedAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, current.revision);
    return updated;
  }

  async finishDocumentExecution(
    executionId: string,
    status: 'completed' | 'failed' | 'cancelled',
    result?: { readonly messageId: string; readonly workId?: string },
    failureReason: ConversationWorkflowDelivery['failureReason'] = 'outcome_unknown'
  ): Promise<ConversationWorkflowV1 | undefined> {
    const current = (await this.repository.list()).find((workflow) =>
      workflow.status === 'executing' && workflow.executionId === executionId && workflow.plan.kind === 'document');
    if (!current) return undefined;
    if (status === 'completed' && (!result?.messageId || !result.workId)) {
      throw new TypeError('Official document completion requires a registered work and result message');
    }
    const currentKind = current.plan.documentKind;
    if (!currentKind || currentKind === 'auto') throw new TypeError('An executing document needs an output kind');
    const existing = current.deliveries ?? [{ kind: currentKind, status: 'executing' as const, executionId }];
    const deliveries: readonly ConversationWorkflowDelivery[] = existing.map((item) => {
      if (item.kind === currentKind && item.status !== 'completed' && item.status !== 'cancelled') {
        return {
          ...item, status, executionId,
          ...(result ? { resultMessageId: result.messageId, ...(status === 'completed' ? { workId: result.workId } : {}) } : {}),
          ...(status === 'failed' ? { failureReason } : {})
        };
      }
      return status === 'cancelled' && item.status === 'pending' ? { ...item, status: 'cancelled' } : item;
    });
    const next = status === 'completed' ? deliveries.find((item) => item.status === 'pending') : undefined;
    const updated = updateConversationWorkflow(current, {
      deliveries,
      status: next ? 'ready' : status,
      ...(next ? { plan: parseConversationIntentPlan({ ...current.plan, documentKind: next.kind }) } : {}),
      updatedAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, current.revision);
    return updated;
  }

  async resumeFailedDelivery(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    const failed = current.deliveries?.find((item) => item.kind === current.plan.documentKind && item.status === 'failed');
    if (current.status !== 'failed' || failed?.failureReason !== 'execution_failed') {
      throw new ConversationWorkflowApplicationError('workflow_not_ready', '请先核对上次外部调用的实际结果，结果未知的请求不能直接重试', current.revision);
    }
    const updated = updateConversationWorkflow(current, {
      status: failed.resultMessageId && failed.executionId ? 'executing' : 'ready',
      deliveries: current.deliveries?.map((item) => item === failed
        ? failed.resultMessageId && failed.executionId
          ? { kind: item.kind, status: 'executing', resultMessageId: failed.resultMessageId, executionId: failed.executionId }
          : { kind: item.kind, status: 'pending' }
        : item),
      updatedAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, current.revision);
    return updated;
  }

  async recoverInterruptedExecutions(): Promise<number> {
    const executing = (await this.repository.list()).filter(
      (workflow) => workflow.status === 'executing'
    );
    for (const workflow of executing) {
      const failed = updateConversationWorkflow(workflow, {
        status: 'failed',
        ...(workflow.deliveries ? { deliveries: workflow.deliveries.map((item) => item.status === 'executing'
          ? { ...item, status: 'failed' as const, failureReason: 'interrupted' as const }
          : item) } : {}),
        updatedAt: toIsoTimestamp(this.now())
      });
      await this.repository.save(failed, workflow.revision);
    }
    return executing.length;
  }

  private async require(id: ConversationWorkflowId, expectedRevision: number): Promise<ConversationWorkflowV1> {
    const workflow = await this.repository.get(id);
    if (!workflow) {
      throw new ConversationWorkflowApplicationError(
        'workflow_not_found',
        'Conversation workflow does not exist'
      );
    }
    if (workflow.revision !== expectedRevision) {
      throw new ConversationWorkflowApplicationError(
        'workflow_revision_conflict',
        'Conversation workflow revision changed',
        workflow.revision
      );
    }
    return workflow;
  }
}

function synchronizeDeliveries(
  current: ConversationWorkflowV1,
  plan: ConversationIntentPlan,
  cancelled = false
): readonly ConversationWorkflowDelivery[] | undefined {
  if (cancelled) return current.deliveries?.map((item) => item.status === 'completed' ? item : { ...item, status: 'cancelled' });
  if (plan.kind !== 'document' || !plan.documentKind || plan.documentKind === 'auto') return undefined;
  const kinds = plan.deliverables ?? [plan.documentKind];
  const previous = current.deliveries ?? [];
  const completed = previous.filter((item) => item.status === 'completed');
  const remaining = kinds.filter((kind) => !completed.some((item) => item.kind === kind)).map((kind) => ({ kind, status: 'pending' as const }));
  const removed = previous.filter((item) => item.status !== 'completed' && !kinds.includes(item.kind)).map((item) => ({ ...item, status: 'cancelled' as const }));
  return [...completed, ...remaining, ...removed].slice(0, 3);
}

function questionsForDecision(plan: ReturnType<typeof parseConversationIntentPlan>) {
  return [...new Set([...plan.missing, ...plan.ambiguities].map(conversationClarificationKey))].slice(0, 3).map((reason) => ({
    field: reason,
    question: `请补充或确认：${conversationClarificationLabel(reason)}`,
    required: true
  }));
}

async function confirmationForPlan(
  plan: ReturnType<typeof parseConversationIntentPlan>,
  createdAt: string,
  ttlMs: number
): Promise<{
  readonly confirmationId?: string;
  readonly planHash?: string;
  readonly confirmationExpiresAt?: ReturnType<typeof toIsoTimestamp>;
}> {
  if (!plan.needsConfirmation && plan.confidence !== 'medium') return {};
  return {
    confirmationId: `workflow-confirmation-${secureRandomUuid()}`,
    planHash: await hashPlan(plan),
    confirmationExpiresAt: toIsoTimestamp(
      new Date(new Date(createdAt).getTime() + ttlMs).toISOString()
    )
  };
}

async function hashPlan(
  plan: ReturnType<typeof parseConversationIntentPlan>
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure plan hashing is unavailable');
  }
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(plan))
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function secureRandomUuid(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure workflow ID generation is unavailable');
  }
  return globalThis.crypto.randomUUID();
}
