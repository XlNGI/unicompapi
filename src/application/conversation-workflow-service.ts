import {
  createConversationWorkflow,
  parseConversationIntentPlan,
  toConversationWorkflowId,
  toIsoTimestamp,
  updateConversationWorkflow,
  type ConversationId,
  type ConversationWorkflowId,
  type ConversationWorkflowRepository,
  type ConversationWorkflowV1,
  type ConversationWorkflowStatus,
  type MessageId,
  type ProjectId
} from '../domain';
import type {
  ConversationIntentOrchestrator,
  ConversationSemanticContext
} from './conversation-intent-orchestrator';

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
  }): Promise<ConversationWorkflowV1> {
    if (input.projectId !== this.repository.projectId) throw new TypeError('Conversation workflow project does not match repository scope');
    const decision = await this.orchestrator.analyze({ rawText: input.rawText, context: input.context });
    const createdAt = toIsoTimestamp(this.now());
    const confirmation = await confirmationForPlan(
      decision.plan,
      createdAt,
      this.confirmationTtlMs
    );
    const workflow = createConversationWorkflow({
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
    await this.repository.createSupersedingPending(workflow);
    return workflow;
  }

  async answer(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
    readonly rawText: string;
    readonly context?: ConversationSemanticContext;
  }): Promise<ConversationWorkflowV1> {
    const current = await this.require(input.workflowId, input.expectedRevision);
    if (current.status !== 'needs_clarification') throw new TypeError('Conversation workflow is not awaiting clarification');
    const decision = await this.orchestrator.analyze({
      rawText: input.rawText,
      context: input.context,
      workflow: current
    });
    const updatedAt = toIsoTimestamp(this.now());
    const confirmation = await confirmationForPlan(
      decision.plan,
      updatedAt,
      this.confirmationTtlMs
    );
    const updated = updateConversationWorkflow(current, {
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
      updatedAt
    });
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
      ['needs_clarification', 'needs_confirmation', 'ready'].includes(workflow.status)
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
    const updated = updateConversationWorkflow(current, {
      status: 'executing',
      executionId: input.executionId,
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
    const updated = updateConversationWorkflow(current, {
      status,
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

function questionsForDecision(plan: ReturnType<typeof parseConversationIntentPlan>) {
  return [...plan.missing, ...plan.ambiguities].slice(0, 3).map((reason) => ({
    field: reason,
    question: `请补充或确认：${reason}`,
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
