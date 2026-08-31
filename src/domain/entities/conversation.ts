import { InvalidStateTransitionError, InvariantViolationError } from '../errors';
import {
  toAssetId,
  toConversationId,
  toFileReferenceId,
  toMessageId,
  toProjectId,
  type AssetId,
  type ConversationId,
  type FileReferenceId,
  type MessageId,
  type ProjectId
} from '../ids';
import {
  assertTimestampNotBefore,
  toIsoTimestamp,
  type IsoTimestamp
} from '../timestamps';
import {
  parseDocumentGenerationStatus,
  parseDocumentMessageResult,
  type DocumentGenerationStatus,
  type DocumentMessageResult
} from './document-generation';

export const conversationStatuses = ['active', 'archived', 'deleted'] as const;
export type ConversationStatus = (typeof conversationStatuses)[number];

export const messageRoles = ['user', 'assistant'] as const;
export type MessageRole = (typeof messageRoles)[number];

export const messageStates = [
  'pending',
  'streaming',
  'completed',
  'failed',
  'cancelled'
] as const;
export type MessageState = (typeof messageStates)[number];

export const messageFailureReasons = [
  'unavailable',
  'interrupted',
  'invalid_response',
  'truncated',
  'unknown'
] as const;
export type MessageFailureReason = (typeof messageFailureReasons)[number];

export type ConversationAttachmentReference =
  | {
      readonly kind: 'asset';
      readonly projectId: ProjectId;
      readonly assetId: AssetId;
    }
  | {
      readonly kind: 'file_reference';
      readonly projectId: ProjectId;
      readonly fileReferenceId: FileReferenceId;
    };

interface MessageBase {
  readonly schemaVersion: 1;
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly revision: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly displayContent?: string;
  readonly reasoningContent?: string;
  readonly documentGenerationStatus?: DocumentGenerationStatus;
  readonly documentResult?: DocumentMessageResult;
  readonly attachments: readonly ConversationAttachmentReference[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface PendingMessage extends MessageBase {
  readonly state: 'pending';
  readonly role: 'assistant';
  readonly content: '';
}

export interface StreamingMessage extends MessageBase {
  readonly state: 'streaming';
  readonly role: 'assistant';
  readonly startedAt: IsoTimestamp;
  readonly streamSequence: number;
}

export interface CompletedMessage extends MessageBase {
  readonly state: 'completed';
  readonly completedAt: IsoTimestamp;
  readonly streamSequence: number;
}

export interface FailedMessage extends MessageBase {
  readonly state: 'failed';
  readonly role: 'assistant';
  readonly failedAt: IsoTimestamp;
  readonly failureReason: MessageFailureReason;
  readonly streamSequence: number;
}

export interface CancelledMessage extends MessageBase {
  readonly state: 'cancelled';
  readonly role: 'assistant';
  readonly cancelledAt: IsoTimestamp;
  readonly streamSequence: number;
}

export type Message =
  | PendingMessage
  | StreamingMessage
  | CompletedMessage
  | FailedMessage
  | CancelledMessage;

interface ConversationBase {
  readonly schemaVersion: 1;
  readonly id: ConversationId;
  readonly revision: number;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly messages: readonly Message[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ActiveConversation extends ConversationBase {
  readonly status: 'active';
}

export interface ArchivedConversation extends ConversationBase {
  readonly status: 'archived';
  readonly archivedAt: IsoTimestamp;
}

export interface DeletedConversation extends ConversationBase {
  readonly status: 'deleted';
  readonly deletedAt: IsoTimestamp;
}

export type Conversation =
  | ActiveConversation
  | ArchivedConversation
  | DeletedConversation;

export interface CreateConversationInput {
  readonly id: ConversationId;
  readonly title: string;
  readonly projectId?: ProjectId | null;
  readonly createdAt: IsoTimestamp;
}

export interface AddUserMessageInput {
  readonly id: MessageId;
  readonly content: string;
  readonly displayContent?: string;
  readonly attachments?: readonly ConversationAttachmentReference[];
  readonly createdAt: IsoTimestamp;
}

export interface EditCancelledUserMessageInput {
  readonly messageId: MessageId;
  readonly content: string;
  readonly displayContent?: string;
  readonly editedAt: IsoTimestamp;
}

export interface BeginAssistantMessageInput {
  readonly id: MessageId;
  readonly createdAt: IsoTimestamp;
}

const conversationBaseKeys = [
  'schemaVersion',
  'id',
  'revision',
  'projectId',
  'title',
  'messages',
  'createdAt',
  'updatedAt',
  'status'
] as const;

const messageBaseKeys = [
  'schemaVersion',
  'id',
  'conversationId',
  'revision',
  'role',
  'state',
  'content',
  'attachments',
  'createdAt',
  'updatedAt'
] as const;

export function createConversation(input: CreateConversationInput): ActiveConversation {
  return parseConversation({
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    projectId: input.projectId ?? null,
    title: input.title,
    status: 'active',
    messages: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  }) as ActiveConversation;
}

export function createProjectConversation(
  input: CreateConversationInput & { readonly projectId: ProjectId }
): ActiveConversation {
  if (input.projectId === null || input.projectId === undefined) {
    throw new InvariantViolationError('new project conversations require a project ID');
  }
  return createConversation(input);
}

export function assertConversationBelongsToProject(
  conversation: Conversation,
  projectId: ProjectId
): void {
  if (conversation.projectId === null || conversation.projectId !== projectId) {
    throw new InvariantViolationError('conversation does not belong to the active project');
  }
}

export function renameConversation(
  conversation: Conversation,
  title: string,
  updatedAt: IsoTimestamp
): Conversation {
  assertConversationNotDeleted(conversation, 'rename');
  return updateConversation(conversation, { title }, updatedAt);
}

export function archiveConversation(
  conversation: Conversation,
  archivedAt: IsoTimestamp
): ArchivedConversation {
  if (conversation.status !== 'active') {
    throw new InvalidStateTransitionError(
      'conversation',
      conversation.status,
      'archived'
    );
  }
  return parseConversation({
    ...conversation,
    revision: conversation.revision + 1,
    status: 'archived',
    archivedAt,
    updatedAt: archivedAt
  }) as ArchivedConversation;
}

export function restoreConversation(
  conversation: Conversation,
  restoredAt: IsoTimestamp
): ActiveConversation {
  if (conversation.status !== 'archived') {
    throw new InvalidStateTransitionError(
      'conversation',
      conversation.status,
      'active'
    );
  }
  const rest = omitArchivedAt(conversation);
  return parseConversation({
    ...rest,
    revision: conversation.revision + 1,
    status: 'active',
    updatedAt: restoredAt
  }) as ActiveConversation;
}

export function deleteConversation(
  conversation: Conversation,
  deletedAt: IsoTimestamp
): DeletedConversation {
  if (conversation.status === 'deleted') {
    throw new InvalidStateTransitionError('conversation', 'deleted', 'deleted');
  }
  const rest = conversation.status === 'archived'
    ? omitArchivedAt(conversation)
    : conversation;
  return parseConversation({
    ...rest,
    revision: conversation.revision + 1,
    status: 'deleted',
    deletedAt,
    updatedAt: deletedAt
  }) as DeletedConversation;
}

export function addUserMessage(
  conversation: Conversation,
  input: AddUserMessageInput
): ActiveConversation {
  assertConversationActive(conversation, 'append messages');
  assertUniqueMessageId(conversation, input.id);
  const message = parseMessage({
    schemaVersion: 1,
    id: input.id,
    conversationId: conversation.id,
    revision: 0,
    role: 'user',
    state: 'completed',
    content: input.content,
    ...(input.displayContent !== undefined
      ? { displayContent: input.displayContent }
      : {}),
    attachments: input.attachments ?? [],
    streamSequence: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: input.createdAt
  });
  return appendMessage(conversation, message, input.createdAt);
}

export function editUserMessageAfterCancelledResponse(
  conversation: Conversation,
  input: EditCancelledUserMessageInput
): ActiveConversation {
  assertConversationActive(conversation, 'edit messages');
  const index = conversation.messages.findIndex((message) => message.id === input.messageId);
  const message = conversation.messages[index];
  const following = conversation.messages.slice(index + 1);
  if (
    !message ||
    message.role !== 'user' ||
    message.state !== 'completed' ||
    following.length === 0 ||
    following.some((item) => item.role !== 'assistant' || item.state !== 'cancelled')
  ) {
    throw new InvalidStateTransitionError(
      'message',
      message ? `${message.role}:${message.state}` : 'missing',
      'edited_after_cancelled_response'
    );
  }
  const messages = [...conversation.messages];
  const messageWithoutDisplayContent = { ...message };
  delete messageWithoutDisplayContent.displayContent;
  messages[index] = parseMessage({
    ...messageWithoutDisplayContent,
    revision: message.revision + 1,
    content: input.content,
    ...(input.displayContent !== undefined
      ? { displayContent: input.displayContent }
      : {}),
    completedAt: input.editedAt,
    updatedAt: input.editedAt
  });
  return updateConversation(
    conversation,
    { messages },
    input.editedAt
  ) as ActiveConversation;
}

export function beginAssistantMessage(
  conversation: Conversation,
  input: BeginAssistantMessageInput
): ActiveConversation {
  assertConversationActive(conversation, 'append messages');
  assertUniqueMessageId(conversation, input.id);
  const message = parseMessage({
    schemaVersion: 1,
    id: input.id,
    conversationId: conversation.id,
    revision: 0,
    role: 'assistant',
    state: 'pending',
    content: '',
    attachments: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
  return appendMessage(conversation, message, input.createdAt);
}

export function startAssistantMessageStreaming(
  conversation: Conversation,
  messageId: MessageId,
  startedAt: IsoTimestamp
): ActiveConversation {
  return replaceAssistantMessage(conversation, messageId, startedAt, (message) => {
    if (message.state !== 'pending') {
      throw new InvalidStateTransitionError('message', message.state, 'streaming');
    }
    return parseMessage({
      ...message,
      revision: message.revision + 1,
      state: 'streaming',
      streamSequence: 0,
      startedAt,
      updatedAt: startedAt
    });
  });
}

export function appendAssistantMessageChunk(
  conversation: Conversation,
  messageId: MessageId,
  chunk: string,
  appendedAt: IsoTimestamp
): ActiveConversation {
  if (chunk.length === 0) {
    throw new InvariantViolationError('message stream chunk cannot be empty');
  }
  return replaceAssistantMessage(conversation, messageId, appendedAt, (message) => {
    if (message.state !== 'streaming') {
      throw new InvalidStateTransitionError('message', message.state, 'streaming');
    }
    return parseMessage({
      ...message,
      revision: message.revision + 1,
      content: `${message.content}${chunk}`,
      streamSequence: message.streamSequence + 1,
      updatedAt: appendedAt
    });
  });
}

export function completeAssistantMessage(
  conversation: Conversation,
  messageId: MessageId,
  completedAt: IsoTimestamp,
  reasoningContent?: string,
  documentResult?: DocumentMessageResult
): ActiveConversation {
  return replaceAssistantMessage(conversation, messageId, completedAt, (message) => {
    if (message.state !== 'streaming') {
      throw new InvalidStateTransitionError('message', message.state, 'completed');
    }
    if (message.content.trim().length === 0) {
      throw new InvariantViolationError('completed assistant message cannot be empty');
    }
    const rest = omitStartedAt(message);
    return parseMessage({
      ...rest,
      revision: message.revision + 1,
      state: 'completed',
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(documentResult ? { documentResult } : {}),
      completedAt,
      updatedAt: completedAt
    });
  });
}

export function attachDocumentResultToMessage(
  conversation: Conversation,
  messageId: MessageId,
  documentResult: DocumentMessageResult,
  updatedAt: IsoTimestamp
): ActiveConversation {
  assertConversationActive(conversation, 'attach document result');
  return replaceAssistantMessage(conversation, messageId, updatedAt, (message) => {
    if (message.state !== 'completed' || message.role !== 'assistant') {
      throw new InvalidStateTransitionError(
        'message',
        message.state,
        'attach_document_result'
      );
    }
    return parseMessage({
      ...message,
      revision: message.revision + 1,
      documentGenerationStatus: {
        state: 'completed',
        kind: documentResult.kind
      },
      documentResult,
      completedAt: updatedAt,
      updatedAt
    });
  });
}

export function setDocumentGenerationStatusOnMessage(
  conversation: Conversation,
  messageId: MessageId,
  status: DocumentGenerationStatus,
  updatedAt: IsoTimestamp
): ActiveConversation {
  assertConversationActive(conversation, 'update document generation status');
  return replaceAssistantMessage(conversation, messageId, updatedAt, (message) => {
    if (message.role !== 'assistant') {
      throw new InvalidStateTransitionError(
        'message',
        message.role,
        'update_document_generation_status'
      );
    }
    if (status.state === 'completed' && message.documentResult === undefined) {
      throw new InvariantViolationError(
        'completed document generation requires a document result'
      );
    }
    return parseMessage({
      ...message,
      revision: message.revision + 1,
      documentGenerationStatus: status,
      ...(message.state === 'completed' ? { completedAt: updatedAt } : {}),
      ...(message.state === 'failed' ? { failedAt: updatedAt } : {}),
      ...(message.state === 'cancelled' ? { cancelledAt: updatedAt } : {}),
      updatedAt
    });
  });
}

export function failAssistantMessage(
  conversation: Conversation,
  messageId: MessageId,
  failureReason: MessageFailureReason,
  failedAt: IsoTimestamp,
  reasoningContent?: string
): ActiveConversation {
  return replaceAssistantMessage(conversation, messageId, failedAt, (message) => {
    if (message.state !== 'pending' && message.state !== 'streaming') {
      throw new InvalidStateTransitionError('message', message.state, 'failed');
    }
    const streamSequence = message.state === 'streaming' ? message.streamSequence : 0;
    const content = message.state === 'streaming' ? message.content : '';
    const rest = message.state === 'streaming'
      ? omitStartedAt(message)
      : message;
    return parseMessage({
      ...rest,
      revision: message.revision + 1,
      state: 'failed',
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      streamSequence,
      failureReason,
      failedAt,
      updatedAt: failedAt
    });
  });
}

export function cancelAssistantMessage(
  conversation: Conversation,
  messageId: MessageId,
  cancelledAt: IsoTimestamp,
  reasoningContent?: string
): ActiveConversation {
  return replaceAssistantMessage(conversation, messageId, cancelledAt, (message) => {
    if (message.state !== 'pending' && message.state !== 'streaming') {
      throw new InvalidStateTransitionError('message', message.state, 'cancelled');
    }
    const streamSequence = message.state === 'streaming' ? message.streamSequence : 0;
    const content = message.state === 'streaming' ? message.content : '';
    const rest = message.state === 'streaming'
      ? omitStartedAt(message)
      : message;
    return parseMessage({
      ...rest,
      revision: message.revision + 1,
      state: 'cancelled',
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      streamSequence,
      cancelledAt,
      updatedAt: cancelledAt
    });
  });
}

export function parseConversation(value: unknown): Conversation {
  const record = requireRecord(value, 'conversation');
  const status = oneOf(record.status, conversationStatuses, 'conversation.status');
  const allowedKeys = status === 'active'
    ? conversationBaseKeys
    : status === 'archived'
      ? [...conversationBaseKeys, 'archivedAt']
      : [...conversationBaseKeys, 'deletedAt'];
  requireExactKeys(record, allowedKeys, 'conversation');
  if (record.schemaVersion !== 1) {
    throw new TypeError('conversation.schemaVersion must be 1');
  }
  const id = toConversationId(requireNonBlankString(record.id, 'conversation.id'));
  const revision = requireNonNegativeInteger(record.revision, 'conversation.revision');
  const projectId = record.projectId === null
    ? null
    : toProjectId(requireNonBlankString(record.projectId, 'conversation.projectId'));
  const title = requireBoundedNonBlankString(record.title, 200, 'conversation.title');
  const createdAt = toIsoTimestamp(requireString(record.createdAt, 'conversation.createdAt'));
  const updatedAt = toIsoTimestamp(requireString(record.updatedAt, 'conversation.updatedAt'));
  assertTimestampNotBefore(updatedAt, createdAt, 'conversation.updatedAt');
  if (!Array.isArray(record.messages)) {
    throw new TypeError('conversation.messages must be an array');
  }
  const messageIds = new Set<string>();
  let previousCreatedAt = createdAt;
  const messages = record.messages.map((item, index) => {
    const message = parseMessage(item);
    if (message.conversationId !== id) {
      throw new TypeError(`conversation.messages[${index}] belongs to another conversation`);
    }
    if (messageIds.has(message.id)) {
      throw new TypeError(`conversation contains duplicate message id ${message.id}`);
    }
    if (message.createdAt < previousCreatedAt) {
      throw new TypeError('conversation messages must be ordered by creation time');
    }
    if (message.updatedAt > updatedAt) {
      throw new TypeError('conversation message cannot be newer than the conversation');
    }
    assertAttachmentsMatchProject(message.attachments, projectId);
    previousCreatedAt = message.createdAt;
    messageIds.add(message.id);
    return message;
  });
  const base = {
    schemaVersion: 1 as const,
    id,
    revision,
    projectId,
    title,
    messages,
    createdAt,
    updatedAt
  };
  if (status === 'active') return { ...base, status };
  if (status === 'archived') {
    const archivedAt = toIsoTimestamp(requireString(record.archivedAt, 'conversation.archivedAt'));
    assertTimestampNotBefore(archivedAt, createdAt, 'conversation.archivedAt');
    if (archivedAt > updatedAt) {
      throw new TypeError('conversation.archivedAt cannot be after updatedAt');
    }
    return { ...base, status, archivedAt };
  }
  const deletedAt = toIsoTimestamp(requireString(record.deletedAt, 'conversation.deletedAt'));
  assertTimestampNotBefore(deletedAt, createdAt, 'conversation.deletedAt');
  if (deletedAt !== updatedAt) {
    throw new TypeError('conversation.deletedAt must equal updatedAt');
  }
  return { ...base, status, deletedAt };
}

export function parseMessage(value: unknown): Message {
  const record = requireRecord(value, 'message');
  const state = oneOf(record.state, messageStates, 'message.state');
  const hasReasoningContent = Object.prototype.hasOwnProperty.call(
    record,
    'reasoningContent'
  );
  const hasDisplayContent = Object.prototype.hasOwnProperty.call(
    record,
    'displayContent'
  );
  const hasDocumentResult = Object.prototype.hasOwnProperty.call(
    record,
    'documentResult'
  );
  const hasDocumentGenerationStatus = Object.prototype.hasOwnProperty.call(
    record,
    'documentGenerationStatus'
  );
  const stateKeys: Record<MessageState, readonly string[]> = {
    pending: [],
    streaming: ['startedAt', 'streamSequence'],
    completed: ['completedAt', 'streamSequence'],
    failed: ['failedAt', 'failureReason', 'streamSequence'],
    cancelled: ['cancelledAt', 'streamSequence']
  };
  requireExactKeys(
    record,
    [
      ...messageBaseKeys,
      ...(hasDisplayContent ? ['displayContent'] : []),
      ...(hasReasoningContent ? ['reasoningContent'] : []),
      ...(hasDocumentGenerationStatus ? ['documentGenerationStatus'] : []),
      ...(hasDocumentResult ? ['documentResult'] : []),
      ...stateKeys[state]
    ],
    'message'
  );
  if (record.schemaVersion !== 1) {
    throw new TypeError('message.schemaVersion must be 1');
  }
  const id = toMessageId(requireNonBlankString(record.id, 'message.id'));
  const conversationId = toConversationId(
    requireNonBlankString(record.conversationId, 'message.conversationId')
  );
  const revision = requireNonNegativeInteger(record.revision, 'message.revision');
  const role = oneOf(record.role, messageRoles, 'message.role');
  const content = requireString(record.content, 'message.content');
  if (content.length > 1_000_000) {
    throw new TypeError('message.content exceeds the maximum length');
  }
  const displayContent = hasDisplayContent
    ? requireString(record.displayContent, 'message.displayContent')
    : undefined;
  if (
    displayContent !== undefined &&
    (role !== 'user' ||
      displayContent.trim().length === 0 ||
      displayContent.length > 8_000)
  ) {
    throw new TypeError('message.displayContent is invalid');
  }
  const reasoningContent = hasReasoningContent
    ? requireString(record.reasoningContent, 'message.reasoningContent')
    : undefined;
  const documentResult = hasDocumentResult
    ? parseDocumentMessageResult(record.documentResult)
    : undefined;
  const documentGenerationStatus = hasDocumentGenerationStatus
    ? parseDocumentGenerationStatus(record.documentGenerationStatus)
    : undefined;
  if (
    reasoningContent !== undefined &&
    (reasoningContent.trim().length === 0 || reasoningContent.length > 1_000_000)
  ) {
    throw new TypeError('message.reasoningContent is invalid');
  }
  if (!Array.isArray(record.attachments)) {
    throw new TypeError('message.attachments must be an array');
  }
  const attachments = record.attachments.map(parseAttachmentReference);
  assertUniqueAttachments(attachments);
  const createdAt = toIsoTimestamp(requireString(record.createdAt, 'message.createdAt'));
  const updatedAt = toIsoTimestamp(requireString(record.updatedAt, 'message.updatedAt'));
  assertTimestampNotBefore(updatedAt, createdAt, 'message.updatedAt');
  const base = {
    schemaVersion: 1 as const,
    id,
    conversationId,
    revision,
    role,
    content,
    ...(displayContent !== undefined ? { displayContent } : {}),
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(documentGenerationStatus !== undefined
      ? { documentGenerationStatus }
      : {}),
    ...(documentResult !== undefined ? { documentResult } : {}),
    attachments,
    createdAt,
    updatedAt
  };
  if (role === 'assistant' && attachments.length > 0) {
    throw new TypeError('assistant messages cannot persist input attachments');
  }
  if (role !== 'assistant' && reasoningContent !== undefined) {
    throw new TypeError('only assistant messages can persist reasoning content');
  }
  if (role !== 'assistant' && documentGenerationStatus !== undefined) {
    throw new TypeError(
      'only assistant messages can persist document generation status'
    );
  }
  if (
    documentGenerationStatus?.state === 'completed' &&
    (documentResult === undefined ||
      documentResult.kind !== documentGenerationStatus.kind)
  ) {
    throw new TypeError(
      'completed document generation status requires a matching document result'
    );
  }
  if (
    documentResult !== undefined &&
    (role !== 'assistant' || state !== 'completed')
  ) {
    throw new TypeError(
      'only completed assistant messages can persist a document result'
    );
  }
  if (state === 'pending') {
    if (role !== 'assistant' || content !== '') {
      throw new TypeError('pending messages must be empty assistant messages');
    }
    return { ...base, role, state, content } as PendingMessage;
  }
  const streamSequence = requireNonNegativeInteger(
    record.streamSequence,
    'message.streamSequence'
  );
  if (state === 'streaming') {
    if (role !== 'assistant') {
      throw new TypeError('streaming messages must be assistant messages');
    }
    const startedAt = parseTerminalTimestamp(record.startedAt, createdAt, updatedAt, 'startedAt', false);
    return { ...base, role, state, startedAt, streamSequence } as StreamingMessage;
  }
  if (state === 'completed') {
    if (content.trim().length === 0) {
      throw new TypeError('completed message content cannot be empty');
    }
    if (role === 'user' && streamSequence !== 0) {
      throw new TypeError('completed user messages cannot have stream revisions');
    }
    const completedAt = parseTerminalTimestamp(
      record.completedAt,
      createdAt,
      updatedAt,
      'completedAt',
      true
    );
    return { ...base, state, completedAt, streamSequence } as CompletedMessage;
  }
  if (role !== 'assistant') {
    throw new TypeError(`${state} messages must be assistant messages`);
  }
  if (state === 'failed') {
    const failedAt = parseTerminalTimestamp(record.failedAt, createdAt, updatedAt, 'failedAt', true);
    const failureReason = oneOf(
      record.failureReason,
      messageFailureReasons,
      'message.failureReason'
    );
    return {
      ...base,
      role,
      state,
      failedAt,
      failureReason,
      streamSequence
    } as FailedMessage;
  }
  const cancelledAt = parseTerminalTimestamp(
    record.cancelledAt,
    createdAt,
    updatedAt,
    'cancelledAt',
    true
  );
  return { ...base, role, state, cancelledAt, streamSequence } as CancelledMessage;
}

function updateConversation(
  conversation: Exclude<Conversation, DeletedConversation>,
  changes: Readonly<Record<string, unknown>>,
  updatedAt: IsoTimestamp
): Conversation {
  return parseConversation({
    ...conversation,
    ...changes,
    revision: conversation.revision + 1,
    updatedAt
  });
}

function appendMessage(
  conversation: ActiveConversation,
  message: Message,
  updatedAt: IsoTimestamp
): ActiveConversation {
  return updateConversation(
    conversation,
    { messages: [...conversation.messages, message] },
    updatedAt
  ) as ActiveConversation;
}

function replaceAssistantMessage(
  conversation: Conversation,
  messageId: MessageId,
  updatedAt: IsoTimestamp,
  mutate: (message: PendingMessage | StreamingMessage | CompletedMessage | FailedMessage | CancelledMessage) => Message
): ActiveConversation {
  assertConversationActive(conversation, 'modify messages');
  const index = conversation.messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    throw new InvariantViolationError(`message ${messageId} does not exist`);
  }
  const current = conversation.messages[index];
  if (current.role !== 'assistant') {
    throw new InvariantViolationError('user messages are immutable facts');
  }
  const messages = [...conversation.messages];
  messages[index] = mutate(current);
  return updateConversation(conversation, { messages }, updatedAt) as ActiveConversation;
}

function assertConversationActive(
  conversation: Conversation,
  operation: string
): asserts conversation is ActiveConversation {
  if (conversation.status !== 'active') {
    throw new InvariantViolationError(
      `cannot ${operation} while conversation is ${conversation.status}`
    );
  }
}

function assertConversationNotDeleted(
  conversation: Conversation,
  operation: string
): asserts conversation is ActiveConversation | ArchivedConversation {
  if (conversation.status === 'deleted') {
    throw new InvariantViolationError(`cannot ${operation} a deleted conversation`);
  }
}

function assertUniqueMessageId(conversation: Conversation, messageId: MessageId): void {
  if (conversation.messages.some((message) => message.id === messageId)) {
    throw new InvariantViolationError(`message ${messageId} already exists`);
  }
}

function parseAttachmentReference(value: unknown): ConversationAttachmentReference {
  const record = requireRecord(value, 'message attachment');
  if (record.kind === 'asset') {
    requireExactKeys(record, ['kind', 'projectId', 'assetId'], 'asset attachment');
    return {
      kind: 'asset',
      projectId: toProjectId(requireNonBlankString(record.projectId, 'attachment.projectId')),
      assetId: toAssetId(requireNonBlankString(record.assetId, 'attachment.assetId'))
    };
  }
  if (record.kind === 'file_reference') {
    requireExactKeys(
      record,
      ['kind', 'projectId', 'fileReferenceId'],
      'file reference attachment'
    );
    return {
      kind: 'file_reference',
      projectId: toProjectId(requireNonBlankString(record.projectId, 'attachment.projectId')),
      fileReferenceId: toFileReferenceId(
        requireNonBlankString(record.fileReferenceId, 'attachment.fileReferenceId')
      )
    };
  }
  throw new TypeError('message attachment kind is unsupported');
}

function assertAttachmentsMatchProject(
  attachments: readonly ConversationAttachmentReference[],
  projectId: ProjectId | null
): void {
  if (attachments.length > 0 && projectId === null) {
    throw new TypeError('unbound conversations cannot persist attachments');
  }
  if (attachments.some((attachment) => attachment.projectId !== projectId)) {
    throw new TypeError('message attachment belongs to another project');
  }
}

function assertUniqueAttachments(
  attachments: readonly ConversationAttachmentReference[]
): void {
  const keys = new Set<string>();
  for (const attachment of attachments) {
    const key = attachment.kind === 'asset'
      ? `asset:${attachment.assetId}`
      : `file_reference:${attachment.fileReferenceId}`;
    if (keys.has(key)) {
      throw new TypeError(`message contains duplicate attachment ${key}`);
    }
    keys.add(key);
  }
}

function parseTerminalTimestamp(
  value: unknown,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  field: string,
  requireUpdatedAtMatch: boolean
): IsoTimestamp {
  const timestamp = toIsoTimestamp(requireString(value, `message.${field}`));
  assertTimestampNotBefore(timestamp, createdAt, `message.${field}`);
  if (requireUpdatedAtMatch && timestamp !== updatedAt) {
    throw new TypeError(`message.${field} must equal updatedAt`);
  }
  if (!requireUpdatedAtMatch && timestamp > updatedAt) {
    throw new TypeError(`message.${field} cannot be after updatedAt`);
  }
  return timestamp;
}

function omitArchivedAt(conversation: ArchivedConversation): ConversationBase {
  const { archivedAt, ...rest } = conversation;
  void archivedAt;
  return rest;
}

function omitStartedAt(message: StreamingMessage): Omit<StreamingMessage, 'startedAt'> {
  const { startedAt, ...rest } = message;
  void startedAt;
  return rest;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unexpected or missing fields`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function requireNonBlankString(value: unknown, field: string): string {
  const stringValue = requireString(value, field).trim();
  if (stringValue.length === 0) {
    throw new TypeError(`${field} cannot be empty`);
  }
  return stringValue;
}

function requireBoundedNonBlankString(
  value: unknown,
  maximum: number,
  field: string
): string {
  const stringValue = requireNonBlankString(value, field);
  if (stringValue.length > maximum) {
    throw new TypeError(`${field} exceeds the maximum length`);
  }
  return stringValue;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string
): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as T;
}
