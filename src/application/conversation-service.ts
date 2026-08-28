import {
  addUserMessage,
  appendAssistantMessageChunk,
  archiveConversation,
  beginAssistantMessage,
  cancelAssistantMessage,
  completeAssistantMessage,
  attachDocumentResultToMessage,
  createConversation,
  deleteConversation,
  editUserMessageAfterCancelledResponse,
  failAssistantMessage,
  InvalidStateTransitionError,
  renameConversation,
  restoreConversation,
  setDocumentGenerationStatusOnMessage,
  startAssistantMessageStreaming,
  toIsoTimestamp,
  type Conversation,
  type ConversationId,
  type ConversationListOptions,
  type ConversationRepository,
  type DocumentMessageResult,
  type DocumentGenerationStatus,
  type MessageFailureReason,
  type MessageId,
  type ProjectId
} from '../domain';

export type ConversationApplicationErrorCode =
  | 'conversation_not_found'
  | 'message_not_editable'
  | 'revision_conflict';

export class ConversationApplicationError extends Error {
  constructor(
    readonly code: ConversationApplicationErrorCode,
    message: string,
    readonly currentRevision?: number
  ) {
    super(message);
    this.name = 'ConversationApplicationError';
  }
}

export interface ConversationIdFactory {
  nextConversationId(): ConversationId;
  nextMessageId(): MessageId;
}

export class ConversationApplicationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly ids: ConversationIdFactory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async create(input: {
    readonly title: string;
    readonly projectId?: ProjectId | null;
  }): Promise<Conversation> {
    const conversation = createConversation({
      id: this.ids.nextConversationId(),
      title: input.title,
      projectId: input.projectId ?? null,
      createdAt: toIsoTimestamp(this.now())
    });
    await this.repository.create(conversation);
    return conversation;
  }

  async get(conversationId: ConversationId): Promise<Conversation> {
    return this.requireConversation(conversationId);
  }

  list(options?: ConversationListOptions): Promise<readonly Conversation[]> {
    return this.repository.list(options);
  }

  async rename(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
    readonly title: string;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      renameConversation(conversation, input.title, toIsoTimestamp(this.now()))
    );
  }

  async archive(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      archiveConversation(conversation, toIsoTimestamp(this.now()))
    );
  }

  async restore(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      restoreConversation(conversation, toIsoTimestamp(this.now()))
    );
  }

  async delete(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      deleteConversation(conversation, toIsoTimestamp(this.now()))
    );
  }

  async addUserMessage(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
    readonly content: string;
    readonly displayContent?: string;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      addUserMessage(conversation, {
        id: this.ids.nextMessageId(),
        content: input.content,
        ...(input.displayContent !== undefined
          ? { displayContent: input.displayContent }
          : {}),
        createdAt: toIsoTimestamp(this.now())
      })
    );
  }

  async editCancelledUserMessage(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
    readonly messageId: MessageId;
    readonly content: string;
    readonly displayContent?: string;
  }): Promise<Conversation> {
    try {
      return await this.update(input, (conversation) =>
        editUserMessageAfterCancelledResponse(conversation, {
          messageId: input.messageId,
          content: input.content,
          ...(input.displayContent !== undefined
            ? { displayContent: input.displayContent }
            : {}),
          editedAt: toIsoTimestamp(this.now())
        })
      );
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        throw new ConversationApplicationError(
          'message_not_editable',
          'Only the last user message with cancelled responses can be edited'
        );
      }
      throw error;
    }
  }

  private async update(
    input: {
      readonly conversationId: ConversationId;
      readonly expectedRevision: number;
    },
    operation: (conversation: Conversation) => Conversation
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(input.conversationId);
    assertRevision(conversation, input.expectedRevision);
    const updated = operation(conversation);
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  private async requireConversation(
    conversationId: ConversationId
  ): Promise<Conversation> {
    const conversation = await this.repository.get(conversationId);
    if (!conversation) {
      throw new ConversationApplicationError(
        'conversation_not_found',
        'Conversation does not exist'
      );
    }
    return conversation;
  }
}

export interface ConversationStreamStartResult {
  readonly conversation: Conversation;
  readonly messageId: MessageId;
}

export interface ConversationStreamApplicationPort {
  start(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
  }): Promise<ConversationStreamStartResult>;
  append(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly chunk: string;
  }): Promise<Conversation>;
  complete(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
  }): Promise<Conversation>;
  fail(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly reason: MessageFailureReason;
  }): Promise<Conversation>;
  cancel(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
  }): Promise<Conversation>;
}

export class ConversationStreamingService
  implements ConversationStreamApplicationPort {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly ids: ConversationIdFactory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async start(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
  }): Promise<ConversationStreamStartResult> {
    const conversation = await this.requireConversation(input.conversationId);
    assertRevision(conversation, input.expectedRevision);
    const messageId = this.ids.nextMessageId();
    const updated = beginAssistantMessage(conversation, {
      id: messageId,
      createdAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(updated, input.expectedRevision);
    return { conversation: updated, messageId };
  }

  async append(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly chunk: string;
  }): Promise<Conversation> {
    let conversation = await this.requireConversation(input.conversationId);
    assertRevision(conversation, input.expectedRevision);
    const message = conversation.messages.find((item) => item.id === input.messageId);
    if (message?.state === 'pending') {
      const streaming = startAssistantMessageStreaming(
        conversation,
        input.messageId,
        toIsoTimestamp(this.now())
      );
      await this.repository.save(streaming, input.expectedRevision);
      conversation = streaming;
    }
    const updated = appendAssistantMessageChunk(
      conversation,
      input.messageId,
      input.chunk,
      toIsoTimestamp(this.now())
    );
    await this.repository.save(updated, conversation.revision);
    return updated;
  }

  async complete(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly documentResult?: DocumentMessageResult;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      completeAssistantMessage(
        conversation,
        input.messageId,
        toIsoTimestamp(this.now()),
        undefined,
        input.documentResult
      )
    );
  }

  async attachDocumentResult(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly documentResult: DocumentMessageResult;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      attachDocumentResultToMessage(
        conversation,
        input.messageId,
        input.documentResult,
        toIsoTimestamp(this.now())
      )
    );
  }

  async updateDocumentGenerationStatus(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly status: DocumentGenerationStatus;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      setDocumentGenerationStatusOnMessage(
        conversation,
        input.messageId,
        input.status,
        toIsoTimestamp(this.now())
      )
    );
  }

  async fail(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly reason: MessageFailureReason;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      failAssistantMessage(
        conversation,
        input.messageId,
        input.reason,
        toIsoTimestamp(this.now())
      )
    );
  }

  async cancel(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
  }): Promise<Conversation> {
    return this.update(input, (conversation) =>
      cancelAssistantMessage(
        conversation,
        input.messageId,
        toIsoTimestamp(this.now())
      )
    );
  }

  private async update(
    input: {
      readonly conversationId: ConversationId;
      readonly expectedRevision: number;
    },
    operation: (conversation: Conversation) => Conversation
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(input.conversationId);
    assertRevision(conversation, input.expectedRevision);
    const updated = operation(conversation);
    await this.repository.save(updated, input.expectedRevision);
    return updated;
  }

  private async requireConversation(
    conversationId: ConversationId
  ): Promise<Conversation> {
    const conversation = await this.repository.get(conversationId);
    if (!conversation) {
      throw new ConversationApplicationError(
        'conversation_not_found',
        'Conversation does not exist'
      );
    }
    return conversation;
  }
}

function assertRevision(
  conversation: Conversation,
  expectedRevision: number
): void {
  if (conversation.revision !== expectedRevision) {
    throw new ConversationApplicationError(
      'revision_conflict',
      'Conversation revision has changed',
      conversation.revision
    );
  }
}
