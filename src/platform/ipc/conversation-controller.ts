import type { ConversationApplicationService } from '../../application';
import {
  toConversationId,
  toMessageId,
  type Conversation,
  type ConversationStatus,
  type Message
} from '../../domain';
import {
  chatContextRequestParsers,
  type ChatContextIpcResult,
  type ConversationCandidateDto,
  type ConversationDto,
  type MessageDto
} from '../../shared/chat-context-ipc';
import type { StorageProjectSession } from './storage-ipc-controller';
import { chatContextFailure, failure } from './chat-context-errors';

export interface ConversationControllerDependencies {
  readonly service: ConversationApplicationService;
  getSession(): StorageProjectSession | undefined;
  readonly projectRequired?: boolean;
  readonly storageScope?: ConversationDto['storageScope'];
  readonly readOnly?: boolean;
  onError?(error: unknown): void;
}

export class ConversationController {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly dependencies: ConversationControllerDependencies) {}

  create(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.createConversation(request);
      const session = input.bindToCurrentProject || this.dependencies.projectRequired
        ? this.dependencies.getSession()
        : undefined;
      if ((input.bindToCurrentProject || this.dependencies.projectRequired) && !session) {
        return failure('project_not_open', 'A project must be open to bind a conversation');
      }
      if (this.dependencies.projectRequired && !input.bindToCurrentProject) {
        return failure(
          'invalid_request',
          'New conversations must belong to the current project'
        );
      }
      return {
        ok: true,
        value: this.toDto(await this.dependencies.service.create({
          title: input.title,
          projectId: session?.projectId ?? null
        }))
      };
    });
  }

  get(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.conversationId(request);
      return {
        ok: true,
        value: this.toDto(
          await this.dependencies.service.get(toConversationId(input.conversationId))
        )
      };
    });
  }

  list(request: unknown): Promise<ChatContextIpcResult<readonly ConversationDto[]>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.listConversations(request);
      const statuses: ConversationStatus[] = ['active'];
      if (input.includeArchived) statuses.push('archived');
      if (input.includeDeleted) statuses.push('deleted');
      const conversations = await this.dependencies.service.list({ statuses });
      return { ok: true, value: conversations.map((conversation) => this.toDto(conversation)) };
    });
  }

  listCandidates(): Promise<
    ChatContextIpcResult<readonly ConversationCandidateDto[]>
  > {
    return this.execute(async () => {
      const session = this.dependencies.getSession();
      if (!session) {
        return failure(
          'project_not_open',
          'A project must be open to list conversation candidates'
        );
      }
      const conversations = await this.dependencies.service.list({
        statuses: ['active', 'archived'],
        projectId: session.projectId
      });
      return {
        ok: true,
        value: conversations.flatMap((conversation) =>
          conversation.status === 'deleted'
            ? []
            : [{
                conversationId: conversation.id,
                projectId: session.projectId,
                title: conversation.title,
                status: conversation.status,
                messageCount: conversation.messages.length,
                completedMessageCount: conversation.messages.filter(
                  (message) => message.state === 'completed'
                ).length,
                updatedAt: conversation.updatedAt
              }]
        )
      };
    });
  }

  rename(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    if (this.dependencies.readOnly) return this.readOnlyFailure();
    return this.executeMutation(request, 'rename');
  }

  archive(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    if (this.dependencies.readOnly) return this.readOnlyFailure();
    return this.executeMutation(request, 'archive');
  }

  restore(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    if (this.dependencies.readOnly) return this.readOnlyFailure();
    return this.executeMutation(request, 'restore');
  }

  delete(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    if (this.dependencies.readOnly) return this.readOnlyFailure();
    return this.executeMutation(request, 'delete');
  }

  addUserMessage(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
    if (this.dependencies.readOnly) return this.readOnlyFailure();
    return this.execute(async () => {
      const input = chatContextRequestParsers.addUserMessage(request);
      const conversation = await this.dependencies.service.addUserMessage({
        conversationId: toConversationId(input.conversationId),
        expectedRevision: input.expectedRevision,
        content: input.content
      });
      return { ok: true, value: this.toDto(conversation) };
    });
  }

  editCancelledUserMessage(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationDto>> {
    if (this.dependencies.readOnly) return this.readOnlyFailure();
    return this.execute(async () => {
      const input = chatContextRequestParsers.editCancelledUserMessage(request);
      const conversation = await this.dependencies.service.editCancelledUserMessage({
        conversationId: toConversationId(input.conversationId),
        expectedRevision: input.expectedRevision,
        messageId: toMessageId(input.messageId),
        content: input.content
      });
      return { ok: true, value: this.toDto(conversation) };
    });
  }

  requestAssistantResponse(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.conversationRevision(request);
      const conversation = await this.dependencies.service.get(
        toConversationId(input.conversationId)
      );
      if (conversation.revision !== input.expectedRevision) {
        return failure(
          'revision_conflict',
          'Conversation revision has changed',
          conversation.revision
        );
      }
      return failure(
        'adapter_unavailable',
        'No conversation response adapter is available'
      );
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private executeMutation(
    request: unknown,
    operation: 'rename' | 'archive' | 'restore' | 'delete'
  ): Promise<ChatContextIpcResult<ConversationDto>> {
    return this.execute(async () => {
      if (operation === 'rename') {
        const input = chatContextRequestParsers.renameConversation(request);
        const conversation = await this.dependencies.service.rename({
          conversationId: toConversationId(input.conversationId),
          expectedRevision: input.expectedRevision,
          title: input.title
        });
        return { ok: true, value: this.toDto(conversation) };
      }
      const input = chatContextRequestParsers.conversationRevision(request);
      const conversation = await this.dependencies.service[operation]({
        conversationId: toConversationId(input.conversationId),
        expectedRevision: input.expectedRevision
      });
      return { ok: true, value: this.toDto(conversation) };
    });
  }

  private async execute<T>(
    operation: () => Promise<ChatContextIpcResult<T>>
  ): Promise<ChatContextIpcResult<T>> {
    const current = (async () => {
      try {
        return await operation();
      } catch (error) {
        return chatContextFailure<T>(error, this.dependencies.onError);
      }
    })();
    this.operations.add(current);
    void current.then(
      () => this.operations.delete(current),
      () => this.operations.delete(current)
    );
    return current;
  }

  private toDto(conversation: Conversation): ConversationDto {
    return toConversationDto(
      conversation,
      this.dependencies.storageScope ?? 'current_project',
      this.dependencies.readOnly ?? false
    );
  }

  private readOnlyFailure<T>(): Promise<ChatContextIpcResult<T>> {
    return Promise.resolve(failure(
      'legacy_conversation_read_only',
      'Legacy conversations are read-only and must be copied into the current project'
    ));
  }
}

export function toConversationDto(
  conversation: Conversation,
  storageScope: ConversationDto['storageScope'] = 'current_project',
  readOnly = false
): ConversationDto {
  return {
    conversationId: conversation.id,
    revision: conversation.revision,
    projectId: conversation.projectId,
    title: conversation.title,
    status: conversation.status,
    storageScope,
    readOnly,
    messages: conversation.messages.map(toMessageDto),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.status === 'archived'
      ? { archivedAt: conversation.archivedAt }
      : {}),
    ...(conversation.status === 'deleted'
      ? { deletedAt: conversation.deletedAt }
      : {})
  };
}

function toMessageDto(message: Message): MessageDto {
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    revision: message.revision,
    role: message.role,
    state: message.state,
    content: message.displayContent ?? message.content,
    ...(message.reasoningContent !== undefined
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(message.documentGenerationStatus !== undefined
      ? { documentGenerationStatus: message.documentGenerationStatus }
      : {}),
    ...(message.documentResult !== undefined
      ? { documentResult: message.documentResult }
      : {}),
    attachments: message.attachments.map((attachment) =>
      attachment.kind === 'asset'
        ? {
            kind: attachment.kind,
            projectId: attachment.projectId,
            assetId: attachment.assetId
          }
        : {
            kind: attachment.kind,
            projectId: attachment.projectId,
            fileReferenceId: attachment.fileReferenceId
          }
    ),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...('streamSequence' in message
      ? { streamSequence: message.streamSequence }
      : {}),
    ...('failureReason' in message
      ? { failureReason: message.failureReason }
      : {}),
    ...('startedAt' in message ? { startedAt: message.startedAt } : {}),
    ...('completedAt' in message ? { completedAt: message.completedAt } : {}),
    ...('failedAt' in message ? { failedAt: message.failedAt } : {}),
    ...('cancelledAt' in message ? { cancelledAt: message.cancelledAt } : {})
  };
}
