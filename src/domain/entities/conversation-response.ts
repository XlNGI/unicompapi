import { InvariantViolationError } from '../errors';
import {
  toConversationId,
  toConversationResponseDraftId,
  toMessageId,
  toProjectId,
  type ConversationId,
  type ConversationResponseDraftId,
  type MessageId,
  type ProjectId
} from '../ids';
import { assertTimestampNotBefore, toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import { parseProductFeature, type ProductFeature } from './product-feature';
import {
  parsePinnedProjectContextSelection,
  type PinnedProjectContextSelectionV1
} from './project-context-selection';

export type ConversationResponseProductFeature = Extract<
  ProductFeature,
  'text_chat' | 'text_reasoning'
>;

export interface ConversationResponseDraftV1 {
  readonly schemaVersion: 1;
  readonly id: ConversationResponseDraftId;
  readonly revision: number;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly conversationRevision: number;
  readonly userMessageId: MessageId;
  readonly userMessageRevision: number;
  readonly productFeature: ConversationResponseProductFeature;
  readonly contextSelections: readonly PinnedProjectContextSelectionV1[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface CreateConversationResponseDraftInput {
  readonly id: ConversationResponseDraftId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly conversationRevision: number;
  readonly userMessageId: MessageId;
  readonly userMessageRevision: number;
  readonly productFeature: ConversationResponseProductFeature;
  readonly contextSelections?: readonly PinnedProjectContextSelectionV1[];
  readonly createdAt: IsoTimestamp;
}

export function createConversationResponseDraft(
  input: CreateConversationResponseDraftInput
): ConversationResponseDraftV1 {
  return parseConversationResponseDraft({
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    projectId: input.projectId,
    conversationId: input.conversationId,
    conversationRevision: input.conversationRevision,
    userMessageId: input.userMessageId,
    userMessageRevision: input.userMessageRevision,
    productFeature: input.productFeature,
    contextSelections: input.contextSelections ?? [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function replaceConversationResponseContextSelections(
  draft: ConversationResponseDraftV1,
  contextSelections: readonly PinnedProjectContextSelectionV1[],
  updatedAt: IsoTimestamp
): ConversationResponseDraftV1 {
  return parseConversationResponseDraft({
    ...draft,
    revision: draft.revision + 1,
    contextSelections,
    updatedAt
  });
}

export function updateConversationResponseProductFeature(
  draft: ConversationResponseDraftV1,
  productFeature: ConversationResponseProductFeature,
  updatedAt: IsoTimestamp
): ConversationResponseDraftV1 {
  return parseConversationResponseDraft({
    ...draft,
    revision: draft.revision + 1,
    productFeature,
    updatedAt
  });
}

export function parseConversationResponseDraft(
  value: unknown
): ConversationResponseDraftV1 {
  const item = record(value);
  const keys = new Set([
    'schemaVersion',
    'id',
    'revision',
    'projectId',
    'conversationId',
    'conversationRevision',
    'userMessageId',
    'userMessageRevision',
    'productFeature',
    'contextSelections',
    'createdAt',
    'updatedAt'
  ]);
  if (
    Object.keys(item).length !== keys.size ||
    Object.keys(item).some((key) => !keys.has(key)) ||
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    !Number.isSafeInteger(item.conversationRevision) ||
    Number(item.conversationRevision) < 0 ||
    !Number.isSafeInteger(item.userMessageRevision) ||
    Number(item.userMessageRevision) < 0 ||
    !Array.isArray(item.contextSelections)
  ) {
    throw new InvariantViolationError('conversation response draft is invalid');
  }
  const productFeature = parseProductFeature(item.productFeature);
  if (productFeature !== 'text_chat' && productFeature !== 'text_reasoning') {
    throw new InvariantViolationError(
      'conversation response draft requires an explicit text ProductFeature'
    );
  }
  const createdAt = toIsoTimestamp(String(item.createdAt));
  const updatedAt = toIsoTimestamp(String(item.updatedAt));
  const contextSelections = item.contextSelections.map(
    parsePinnedProjectContextSelection
  );
  const contextIds = contextSelections.map((selection) => selection.contextId);
  if (new Set(contextIds).size !== contextIds.length) {
    throw new InvariantViolationError(
      'conversation response draft context selections must be unique'
    );
  }
  assertTimestampNotBefore(updatedAt, createdAt, 'conversationResponseDraft.updatedAt');
  return {
    schemaVersion: 1,
    id: toConversationResponseDraftId(nonBlank(item.id, 'draft.id')),
    revision: Number(item.revision),
    projectId: toProjectId(nonBlank(item.projectId, 'draft.projectId')),
    conversationId: toConversationId(nonBlank(item.conversationId, 'draft.conversationId')),
    conversationRevision: Number(item.conversationRevision),
    userMessageId: toMessageId(nonBlank(item.userMessageId, 'draft.userMessageId')),
    userMessageRevision: Number(item.userMessageRevision),
    productFeature,
    contextSelections,
    createdAt,
    updatedAt
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError('conversation response draft must be an object');
  }
  return value as Record<string, unknown>;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${label} cannot be empty`);
  }
  return value.trim();
}
