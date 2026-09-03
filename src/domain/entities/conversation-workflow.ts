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
  readonly pendingQuestions: readonly ConversationWorkflowQuestion[];
  readonly resolvedTarget?: {
    readonly artifactRef: string;
    readonly version: number;
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
    readonly pendingQuestions?: readonly ConversationWorkflowQuestion[];
    readonly resolvedTarget?: {
      readonly artifactRef: string;
      readonly version: number;
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
  assertWorkflowTransition(workflow.status, status);
  return parseConversationWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status,
    plan,
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
    'revision', 'status', 'plan', 'pendingQuestions', 'resolvedTarget', 'confirmationId',
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
    ready: ['executing', 'needs_clarification', 'cancelled'],
    executing: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: ['ready', 'cancelled'],
    cancelled: []
  };
  if (!allowed[from].includes(to)) throw new TypeError(`Conversation workflow cannot transition from ${from} to ${to}`);
}

function parseQuestion(value: unknown): ConversationWorkflowQuestion {
  if (!isRecord(value) || Object.keys(value).some((key) => !['field', 'question', 'required'].includes(key)) || !boundedString(value.field, 128) || !boundedString(value.question, 500) || typeof value.required !== 'boolean') {
    throw new TypeError('Conversation workflow question is invalid');
  }
  return { field: value.field as string, question: value.question as string, required: value.required };
}

function parseResolvedTarget(value: unknown): { readonly artifactRef: string; readonly version: number } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !['artifactRef', 'version'].includes(key)) ||
    !boundedString(value.artifactRef, 256) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  ) {
    throw new TypeError('Conversation workflow resolved target is invalid');
  }
  return { artifactRef: value.artifactRef as string, version: Number(value.version) };
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
