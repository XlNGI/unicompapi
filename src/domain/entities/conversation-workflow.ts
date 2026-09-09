import {
  toConversationId,
  toConversationWorkflowId,
  toMessageId,
  toProjectId,
  type ConversationId,
  type ConversationWorkflowId,
  type MessageId,
  type ProjectId
} from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import {
  assessConversationIntentPlan,
  parseConversationIntentPlan,
  type ConversationIntentAssessment,
  type ConversationIntentPlan
} from './conversation-intent-plan';
import { parsePresentationRevisionSelection, type PresentationRevisionSelection, type DocumentWorkspaceKind } from './document-generation';

export interface ConversationWorkflowDelivery {
  readonly kind: DocumentWorkspaceKind;
  readonly status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  readonly executionId?: string;
  readonly resultMessageId?: string;
  readonly workId?: string;
  readonly failureReason?: 'execution_failed' | 'outcome_unknown' | 'interrupted' | 'input_required';
}

export const conversationWorkflowStatuses = [
  'draft',
  'needs_clarification',
  'needs_confirmation',
  'ready',
  'executing',
  'completed',
  'failed',
  'cancelled'
] as const;
export type ConversationWorkflowStatus = (typeof conversationWorkflowStatuses)[number];

export interface ConversationWorkflowQuestion {
  readonly field: string;
  readonly question: string;
  readonly required: boolean;
}

export interface ConversationWorkflowV1 {
  readonly schemaVersion: 1;
  readonly id: ConversationWorkflowId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly revision: number;
  readonly status: ConversationWorkflowStatus;
  readonly plan: ConversationIntentPlan;
  readonly deliveries?: readonly ConversationWorkflowDelivery[];
  readonly pendingQuestions: readonly ConversationWorkflowQuestion[];
  readonly resolvedTarget?: {
    readonly artifactRef: string;
    readonly version: number;
    readonly presentation?: PresentationRevisionSelection;
  };
  readonly confirmationId?: string;
  readonly planHash?: string;
  readonly confirmationExpiresAt?: IsoTimestamp;
  readonly executionId?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface CreateConversationWorkflowInput {
  readonly id: ConversationWorkflowId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly plan: ConversationIntentPlan;
  readonly pendingQuestions?: readonly ConversationWorkflowQuestion[];
  readonly resolvedTarget?: {
    readonly artifactRef: string;
    readonly version: number;
    readonly presentation?: PresentationRevisionSelection;
  };
  readonly confirmationId?: string;
  readonly planHash?: string;
  readonly confirmationExpiresAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

export function createConversationWorkflow(
  input: CreateConversationWorkflowInput
): ConversationWorkflowV1 {
  const plan = parseConversationIntentPlan(input.plan);
  const assessment = assessConversationIntentPlan(plan);
  const pendingQuestions = input.pendingQuestions ?? questionsFromAssessment(assessment);
  return parseConversationWorkflow({
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId,
    revision: 0,
    status: statusFromAssessment(assessment),
    plan,
    ...(plan.kind === 'document' && plan.documentKind && plan.documentKind !== 'auto'
      ? { deliveries: (plan.deliverables ?? [plan.documentKind]).map((kind) => ({ kind, status: 'pending' })) }
      : {}),
    pendingQuestions,
    ...(input.resolvedTarget !== undefined ? { resolvedTarget: input.resolvedTarget } : {}),
    ...(input.confirmationId !== undefined ? { confirmationId: input.confirmationId } : {}),
    ...(input.planHash !== undefined ? { planHash: input.planHash } : {}),
    ...(input.confirmationExpiresAt !== undefined
      ? { confirmationExpiresAt: input.confirmationExpiresAt }
      : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function updateConversationWorkflow(
  workflow: ConversationWorkflowV1,
  input: {
    readonly plan?: ConversationIntentPlan;
    readonly deliveries?: readonly ConversationWorkflowDelivery[];
    readonly pendingQuestions?: readonly ConversationWorkflowQuestion[];
    readonly resolvedTarget?: {
      readonly artifactRef: string;
      readonly version: number;
      readonly presentation?: PresentationRevisionSelection;
    };
    readonly status?: ConversationWorkflowStatus;
    readonly confirmationId?: string;
    readonly planHash?: string;
    readonly confirmationExpiresAt?: IsoTimestamp;
    readonly executionId?: string;
    readonly updatedAt: IsoTimestamp;
  }
): ConversationWorkflowV1 {
  const plan = input.plan === undefined ? workflow.plan : parseConversationIntentPlan(input.plan);
  const assessment = assessConversationIntentPlan(plan);
  const status = input.status ?? statusFromAssessment(assessment);
  const deliveries = input.deliveries ?? (status === 'cancelled'
    ? workflow.deliveries?.map((item) => item.status === 'completed' ? item : { ...item, status: 'cancelled' as const })
    : workflow.deliveries);
  assertWorkflowTransition(workflow.status, status);
  return parseConversationWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status,
    plan,
    ...(deliveries !== undefined ? { deliveries } : {}),
    pendingQuestions: input.pendingQuestions ?? workflow.pendingQuestions,
    ...(input.resolvedTarget !== undefined ? { resolvedTarget: input.resolvedTarget } : {}),
    ...(input.confirmationId !== undefined ? { confirmationId: input.confirmationId } : {}),
    ...(input.planHash !== undefined ? { planHash: input.planHash } : {}),
    ...(input.confirmationExpiresAt !== undefined
      ? { confirmationExpiresAt: input.confirmationExpiresAt }
      : {}),
    ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
    updatedAt: input.updatedAt
  });
}

export function parseConversationWorkflow(value: unknown): ConversationWorkflowV1 {
  if (!isRecord(value)) throw new TypeError('Conversation workflow must be an object');
  const allowed = new Set([
    'schemaVersion', 'id', 'projectId', 'conversationId', 'sourceMessageId',
    'revision', 'status', 'plan', 'deliveries', 'pendingQuestions', 'resolvedTarget', 'confirmationId',
    'planHash', 'confirmationExpiresAt', 'executionId', 'createdAt', 'updatedAt'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.schemaVersion !== 1) {
    throw new TypeError('Conversation workflow contains unsupported fields');
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new TypeError('Conversation workflow revision is invalid');
  if (typeof value.status !== 'string' || !conversationWorkflowStatuses.includes(value.status as ConversationWorkflowStatus)) throw new TypeError('Conversation workflow status is invalid');
  if (!Array.isArray(value.pendingQuestions) || value.pendingQuestions.length > 16) throw new TypeError('Conversation workflow questions are invalid');
  const pendingQuestions = value.pendingQuestions.map(parseQuestion);
  const resolvedTarget = value.resolvedTarget === undefined
    ? undefined
    : parseResolvedTarget(value.resolvedTarget);
  const createdAt = toIsoTimestamp(String(value.createdAt));
  const updatedAt = toIsoTimestamp(String(value.updatedAt));
  if (updatedAt < createdAt) throw new TypeError('Conversation workflow updatedAt is stale');
  const plan = parseConversationIntentPlan(value.plan);
  const deliveries = value.deliveries === undefined ? undefined : parseDeliveries(value.deliveries);
  if (value.confirmationId !== undefined && !boundedString(value.confirmationId, 256)) throw new TypeError('Conversation workflow confirmationId is invalid');
  if (value.planHash !== undefined && !boundedString(value.planHash, 256)) throw new TypeError('Conversation workflow planHash is invalid');
  const confirmationExpiresAt = value.confirmationExpiresAt === undefined
    ? undefined
    : toIsoTimestamp(String(value.confirmationExpiresAt));
  if (value.executionId !== undefined && !boundedString(value.executionId, 256)) throw new TypeError('Conversation workflow executionId is invalid');
  return {
    schemaVersion: 1,
    id: toConversationWorkflowId(nonBlank(value.id, 'workflow.id')),
    projectId: toProjectId(nonBlank(value.projectId, 'workflow.projectId')),
    conversationId: toConversationId(nonBlank(value.conversationId, 'workflow.conversationId')),
    sourceMessageId: toMessageId(nonBlank(value.sourceMessageId, 'workflow.sourceMessageId')),
    revision: Number(value.revision),
    status: value.status as ConversationWorkflowStatus,
    plan,
    ...(deliveries ? { deliveries } : {}),
    pendingQuestions,
    ...(resolvedTarget !== undefined ? { resolvedTarget } : {}),
    ...(value.confirmationId !== undefined ? { confirmationId: value.confirmationId as string } : {}),
    ...(value.planHash !== undefined ? { planHash: value.planHash as string } : {}),
    ...(confirmationExpiresAt !== undefined ? { confirmationExpiresAt } : {}),
    ...(value.executionId !== undefined ? { executionId: value.executionId as string } : {}),
    createdAt,
    updatedAt
  };
}

export function assessConversationWorkflow(
  workflow: ConversationWorkflowV1
): ConversationIntentAssessment {
  return assessConversationIntentPlan(workflow.plan);
}

function statusFromAssessment(assessment: ConversationIntentAssessment): ConversationWorkflowStatus {
  if (assessment.readiness === 'needs_clarification') return 'needs_clarification';
  if (assessment.readiness === 'needs_confirmation') return 'needs_confirmation';
  return 'ready';
}

function questionsFromAssessment(assessment: ConversationIntentAssessment): readonly ConversationWorkflowQuestion[] {
  return assessment.reasons.slice(0, 3).map((reason) => ({
    field: reason,
    question: `请补充或确认：${reason}`,
    required: true
  }));
}

function assertWorkflowTransition(from: ConversationWorkflowStatus, to: ConversationWorkflowStatus): void {
  if (from === to) return;
  const allowed: Readonly<Record<ConversationWorkflowStatus, readonly ConversationWorkflowStatus[]>> = {
    draft: ['needs_clarification', 'needs_confirmation', 'ready', 'cancelled'],
    needs_clarification: ['needs_clarification', 'needs_confirmation', 'ready', 'cancelled'],
    needs_confirmation: ['ready', 'cancelled', 'needs_clarification'],
    ready: ['executing', 'needs_clarification', 'needs_confirmation', 'cancelled'],
    executing: ['completed', 'failed', 'cancelled', 'ready'],
    completed: [],
    failed: ['ready', 'executing', 'cancelled'],
    cancelled: []
  };
  if (!allowed[from].includes(to)) throw new TypeError(`Conversation workflow cannot transition from ${from} to ${to}`);
}

function parseDeliveries(value: unknown): readonly ConversationWorkflowDelivery[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new TypeError('Conversation workflow deliveries are invalid');
  const kinds = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !['kind', 'status', 'executionId', 'resultMessageId', 'workId', 'failureReason'].includes(key))) {
      throw new TypeError('Conversation workflow delivery contains unsupported fields');
    }
    if (typeof item.kind !== 'string' || !['word', 'excel', 'ppt'].includes(item.kind) || kinds.has(item.kind)) throw new TypeError('Conversation workflow delivery kind is invalid');
    kinds.add(item.kind);
    if (typeof item.status !== 'string' || !['pending', 'executing', 'completed', 'failed', 'cancelled'].includes(item.status)) throw new TypeError('Conversation workflow delivery status is invalid');
    for (const key of ['executionId', 'resultMessageId', 'workId']) {
      if (item[key] !== undefined && !boundedString(item[key], 256)) throw new TypeError(`Conversation workflow delivery ${key} is invalid`);
    }
    if (item.failureReason !== undefined && !['execution_failed', 'outcome_unknown', 'interrupted', 'input_required'].includes(String(item.failureReason))) throw new TypeError('Conversation workflow delivery failure reason is invalid');
    if (item.status === 'completed' && (!item.resultMessageId || !item.workId)) throw new TypeError('Completed document delivery requires a registered work and result message');
    return item as unknown as ConversationWorkflowDelivery;
  });
}

function parseQuestion(value: unknown): ConversationWorkflowQuestion {
  if (!isRecord(value) || Object.keys(value).some((key) => !['field', 'question', 'required'].includes(key)) || !boundedString(value.field, 128) || !boundedString(value.question, 500) || typeof value.required !== 'boolean') {
    throw new TypeError('Conversation workflow question is invalid');
  }
  return { field: value.field as string, question: value.question as string, required: value.required };
}

function parseResolvedTarget(value: unknown): NonNullable<ConversationWorkflowV1['resolvedTarget']> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['artifactRef', 'version', 'presentation'].includes(key)) ||
    !boundedString(value.artifactRef, 256) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  ) {
    throw new TypeError('Conversation workflow resolved target is invalid');
  }
  return { artifactRef: value.artifactRef as string, version: Number(value.version),
    ...(value.presentation !== undefined ? { presentation: parsePresentationRevisionSelection(value.presentation) } : {}) };
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
