import {
  toConversationId,
  toMessageId,
  toWorkId,
  type Conversation,
  type ConversationId,
  type ConversationResponseExecutionState,
  type DocumentMessageResult,
  type DocumentGenerationFailureCode,
  type DocumentGenerationStatus,
  type DocumentOutline,
  type DocumentWorkspaceKind,
  type ExecutionId,
  type MessageId,
  type PresentationTemplateId,
  type ProjectId,
  type TaskId,
  type WorkId
} from '../domain';
import { ConversationApplicationError } from './conversation-service';

export type DocumentDraftCompilationErrorCode =
  | 'invalid_structure'
  | 'resource_limit';

export class DocumentDraftCompilationError extends Error {
  constructor(
    readonly code: DocumentDraftCompilationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DocumentDraftCompilationError';
  }
}

export type DocumentGenerationApplicationErrorCode =
  | 'conversation_not_found'
  | 'message_not_found'
  | 'invalid_structure'
  | 'resource_limit'
  | 'layout_overflow'
  | 'cancelled'
  | 'response_failed'
  | 'generation_failed'
  | 'storage_error';

export class DocumentGenerationApplicationError extends Error {
  constructor(
    readonly code: DocumentGenerationApplicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DocumentGenerationApplicationError';
  }
}

export interface DocumentDraftCompilerPort {
  compile(input: {
    readonly content: string;
    readonly kind: DocumentWorkspaceKind;
  }): DocumentOutline;
  recover(input: {
    readonly content: string;
    readonly kind: DocumentWorkspaceKind;
  }): DocumentOutline;
}

export interface DocumentGenerationConversationPort {
  load(conversationId: ConversationId): Promise<Conversation | undefined>;
  attachDocumentResult(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly documentResult: DocumentMessageResult;
  }): Promise<void>;
  updateDocumentGenerationStatus(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly status: DocumentGenerationStatus;
  }): Promise<void>;
}

export interface DocumentGenerationExecutionInput {
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly contentFingerprint: string;
  readonly draftRevision: number;
  readonly sourceDraftId: string;
  readonly outline: DocumentOutline;
  readonly parentWorkId?: WorkId;
  readonly theme?: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly presentationTemplate?: PresentationTemplateId;
  readonly signal: AbortSignal;
  readonly onCancellationClosed: () => void | Promise<void>;
  readonly images: readonly {
    readonly fileId?: string;
    readonly workId?: string;
    readonly caption?: string;
  }[];
}

export interface DocumentGenerationExecutionResult {
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly workId: WorkId;
  readonly fileName: string;
  readonly sizeBytes: number;
}

export interface DocumentGenerationExecutorPort {
  run(
    input: DocumentGenerationExecutionInput
  ): Promise<DocumentGenerationExecutionResult>;
}

export interface GenerateDocumentFromMessageInput {
  readonly conversationId: ConversationId;
  readonly expectedRevision: number;
  readonly messageId: MessageId;
  readonly kind: DocumentWorkspaceKind;
  readonly parentWorkId?: WorkId;
  readonly theme?: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly presentationTemplate?: PresentationTemplateId;
  readonly images: readonly {
    readonly fileId?: string;
    readonly workId?: string;
    readonly caption?: string;
  }[];
}

export interface GenerateDocumentFromMessageResult
  extends DocumentGenerationExecutionResult {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
}

export async function waitForDocumentResponseCompletion<
  T extends { readonly state: ConversationResponseExecutionState }
>(input: {
  readonly read: () => Promise<T>;
  readonly wait: (milliseconds: number) => Promise<void>;
}): Promise<T | undefined> {
  for (;;) {
    const response = await input.read();
    if (response.state === 'completed') return response;
    if (
      response.state === 'failed' ||
      response.state === 'cancelled' ||
      response.state === 'interrupted'
    ) {
      return undefined;
    }
    await input.wait(1_000);
  }
}

export class DocumentGenerationApplicationService {
  private static readonly maxRememberedOperations = 100;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly messageOperations = new Map<
    string,
    Promise<GenerateDocumentFromMessageResult>
  >();
  private readonly messageTails = new Map<string, Promise<void>>();
  private readonly preparedMessages = new Set<string>();
  private readonly activeOperations = new Map<
    string,
    {
      readonly input: GenerateDocumentFromMessageInput;
      readonly abortController: AbortController;
      cancellable: boolean;
    }
  >();

  constructor(
    private readonly dependencies: {
      readonly projectId: ProjectId;
      readonly conversations: DocumentGenerationConversationPort;
      readonly compiler: DocumentDraftCompilerPort;
      readonly generator: DocumentGenerationExecutorPort;
      readonly fingerprint: (content: string) => string;
      readonly wait?: (milliseconds: number) => Promise<void>;
    }
  ) {}

  async prepare(input: GenerateDocumentFromMessageInput): Promise<void> {
    const conversation = await this.requireAssistantMessage(input);
    const message = conversation.messages.find((item) => item.id === input.messageId)!;
    if (
      message.documentGenerationStatus !== undefined &&
      message.documentGenerationStatus.kind !== input.kind
    ) {
      throw new DocumentGenerationApplicationError(
        'invalid_structure',
        'The document format cannot change during one generation run'
      );
    }
    await this.persistStatus(input, {
      state: 'generating_content',
      kind: input.kind
    });
    this.preparedMessages.add(messageQueueKey(this.dependencies.projectId, input));
  }

  async reconcileInterrupted(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
    readonly messageId: MessageId;
  }): Promise<boolean> {
    const conversation = await this.requireAssistantMessage({
      ...input
    });
    const message = conversation.messages.find((item) => item.id === input.messageId)!;
    const status = message.documentGenerationStatus;
    if (
      !status ||
      !['generating_content', 'validating_outline', 'generating_file'].includes(
        status.state
      )
    ) {
      return false;
    }
    const key = `${this.dependencies.projectId}:${input.conversationId}:${input.messageId}`;
    const active = [...this.activeOperations.values()].some(
      (operation) =>
        operation.input.conversationId === input.conversationId &&
        operation.input.messageId === input.messageId
    );
    if (active || this.preparedMessages.has(key)) return false;
    await this.persistStatus(
      {
        ...input,
        kind: status.kind,
        images: []
      },
      { state: 'interrupted', kind: status.kind }
    );
    return true;
  }

  generateFromMessage(
    input: GenerateDocumentFromMessageInput
  ): Promise<GenerateDocumentFromMessageResult> {
    const key = operationKey(this.dependencies.projectId, input);
    const existing = this.messageOperations.get(key);
    if (existing) return existing;

    const abortController = new AbortController();
    const queueKey = messageQueueKey(this.dependencies.projectId, input);
    const previous = this.messageTails.get(queueKey) ?? Promise.resolve();
    const operation = this.track(
      previous
        .catch(() => undefined)
        .then(() => this.runGeneration(key, input, abortController))
    );
    const tail = operation.then(
      () => undefined,
      () => undefined
    );
    this.messageTails.set(queueKey, tail);
    void tail.finally(() => {
      if (this.messageTails.get(queueKey) === tail) {
        this.messageTails.delete(queueKey);
      }
    });
    if (
      this.messageOperations.size >=
      DocumentGenerationApplicationService.maxRememberedOperations
    ) {
      const oldest = this.messageOperations.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.messageOperations.delete(oldest);
    }
    this.messageOperations.set(key, operation);
    this.activeOperations.set(key, {
      input,
      abortController,
      cancellable: true
    });
    void operation
      .catch(() => {
        if (this.messageOperations.get(key) === operation) {
          this.messageOperations.delete(key);
        }
      })
      .finally(() => {
        const active = this.activeOperations.get(key);
        if (active?.abortController === abortController) {
          this.activeOperations.delete(key);
        }
        this.preparedMessages.delete(queueKey);
      });
    return operation;
  }

  async cancel(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
    readonly messageId: MessageId;
  }): Promise<boolean> {
    const conversation = await this.dependencies.conversations.load(
      input.conversationId
    );
    if (!conversation || conversation.projectId !== this.dependencies.projectId) {
      throw new ConversationApplicationError(
        'conversation_not_found',
        'Conversation does not exist'
      );
    }
    if (conversation.revision < input.expectedRevision) {
      throw new ConversationApplicationError(
        'revision_conflict',
        'Conversation revision has changed',
        conversation.revision
      );
    }
    const message = conversation.messages.find(
      (item) => item.id === input.messageId
    );
    if (!message || message.role !== 'assistant') {
      throw new DocumentGenerationApplicationError(
        'message_not_found',
        'messageId must identify an assistant message'
      );
    }

    const active = [...this.activeOperations.values()].filter(
      (operation) =>
        operation.input.conversationId === input.conversationId &&
        operation.input.messageId === input.messageId &&
        operation.input.expectedRevision === input.expectedRevision &&
        operation.cancellable
    );
    active.forEach((operation) => operation.abortController.abort());
    return active.length > 0;
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private async runGeneration(
    key: string,
    input: GenerateDocumentFromMessageInput,
    abortController: AbortController
  ): Promise<GenerateDocumentFromMessageResult> {
    try {
    const conversation = await this.waitForCompletedMessage(
      input.conversationId,
      input.messageId
    );
    const message = conversation.messages.find(
      (item) => item.id === input.messageId
    );
    if (!message || message.role !== 'assistant') {
      throw new DocumentGenerationApplicationError(
        'message_not_found',
        'Assistant message disappeared during document generation'
      );
    }
    const content = message.content.trim();
    if (!content) {
      throw new DocumentGenerationApplicationError(
        'invalid_structure',
        'The assistant response is empty'
      );
    }
    if (
      input.parentWorkId !== undefined &&
      !conversation.messages.some(
        (item) =>
          item.documentResult?.workId === input.parentWorkId &&
          item.documentResult?.kind === input.kind
      )
    ) {
      throw new DocumentGenerationApplicationError(
        'invalid_structure',
        'The previous document does not belong to this conversation or format'
      );
    }

      await this.persistStatus(input, {
        state: 'validating_outline',
        kind: input.kind
      });
      const outline = this.compileDraft(content, input.kind);
      await this.persistStatus(input, {
        state: 'generating_file',
        kind: input.kind
      });
      const generated = await this.dependencies.generator.run({
      kind: input.kind,
      title: outline.title,
      contentFingerprint: this.dependencies.fingerprint(content),
      draftRevision: 1,
      sourceDraftId: `message-${input.messageId}`,
      outline,
      ...(input.parentWorkId !== undefined
        ? { parentWorkId: input.parentWorkId }
        : {}),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
      ...(input.presentationTemplate !== undefined
        ? { presentationTemplate: input.presentationTemplate }
        : {}),
      signal: abortController.signal,
      onCancellationClosed: () =>
        this.closeCancellationWindow(key, abortController),
      images: input.images
      });

      await this.attachResult(input, generated);
      return {
        conversationId: input.conversationId,
        messageId: input.messageId,
        ...generated
      };
    } catch (error) {
      await this.persistTerminalFailure(input, error);
      throw error;
    }
  }

  private compileDraft(
    content: string,
    kind: DocumentWorkspaceKind
  ): DocumentOutline {
    try {
      return this.dependencies.compiler.compile({ content, kind });
    } catch (error) {
      if (
        error instanceof DocumentDraftCompilationError &&
        error.code === 'invalid_structure' &&
        /not valid JSON/i.test(error.message)
      ) {
        return this.dependencies.compiler.recover({ content, kind });
      }
      throw error;
    }
  }

  private async requireAssistantMessage(
    input: Pick<GenerateDocumentFromMessageInput, 'conversationId' | 'messageId'>
  ): Promise<Conversation> {
    const conversation = await this.dependencies.conversations.load(
      input.conversationId
    );
    if (!conversation || conversation.projectId !== this.dependencies.projectId) {
      throw new ConversationApplicationError(
        'conversation_not_found',
        'Conversation does not exist'
      );
    }
    const message = conversation.messages.find((item) => item.id === input.messageId);
    if (!message || message.role !== 'assistant') {
      throw new DocumentGenerationApplicationError(
        'message_not_found',
        'messageId must identify an assistant message'
      );
    }
    return conversation;
  }

  private async persistTerminalFailure(
    input: GenerateDocumentFromMessageInput,
    error: unknown
  ): Promise<void> {
    const cancelled =
      error instanceof DocumentGenerationApplicationError &&
      error.code === 'cancelled';
    const status: DocumentGenerationStatus = cancelled
      ? { state: 'cancelled', kind: input.kind }
      : {
          state: 'failed',
          kind: input.kind,
          errorCode: documentFailureCode(error)
        };
    try {
      await this.persistStatus(input, status);
    } catch {
      // Preserve the original generation failure. Persistence errors are logged
      // at the IPC boundary and never replaced with provider or parser details.
    }
  }

  private async persistStatus(
    input: GenerateDocumentFromMessageInput,
    status: DocumentGenerationStatus
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.requireAssistantMessage(input);
      try {
        await this.dependencies.conversations.updateDocumentGenerationStatus({
          conversationId: input.conversationId,
          messageId: input.messageId,
          expectedRevision: current.revision,
          status
        });
        return;
      } catch (error) {
        if (
          !(error instanceof ConversationApplicationError) ||
          error.code !== 'revision_conflict' ||
          attempt === 3
        ) {
          throw error;
        }
        await (this.dependencies.wait ?? defaultWait)(50);
      }
    }
  }

  private async attachResult(
    input: GenerateDocumentFromMessageInput,
    generated: DocumentGenerationExecutionResult
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.dependencies.conversations.load(
        input.conversationId
      );
      if (!current || current.projectId !== this.dependencies.projectId) {
        throw new ConversationApplicationError(
          'conversation_not_found',
          'Conversation disappeared during document generation'
        );
      }
      try {
        await this.dependencies.conversations.attachDocumentResult({
          conversationId: input.conversationId,
          messageId: input.messageId,
          expectedRevision: current.revision,
          documentResult: {
            workId: generated.workId,
            fileName: generated.fileName,
            kind: input.kind,
            sizeBytes: generated.sizeBytes
          }
        });
        return;
      } catch (error) {
        if (
          !(error instanceof ConversationApplicationError) ||
          error.code !== 'revision_conflict' ||
          attempt === 2
        ) {
          throw error;
        }
        await (this.dependencies.wait ?? defaultWait)(150);
      }
    }
  }

  private async waitForCompletedMessage(
    conversationId: ConversationId,
    messageId: MessageId
  ): Promise<Conversation> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const conversation = await this.dependencies.conversations.load(
        conversationId
      );
      if (!conversation || conversation.projectId !== this.dependencies.projectId) {
        throw new ConversationApplicationError(
          'conversation_not_found',
          'Conversation does not exist'
        );
      }
      const message = conversation.messages.find((item) => item.id === messageId);
      if (message?.state === 'completed') return conversation;
      if (message?.state === 'failed' || message?.state === 'cancelled') {
        throw new DocumentGenerationApplicationError(
          message.state === 'cancelled' ? 'cancelled' : 'response_failed',
          `Assistant message ended in ${message.state} state`
        );
      }
      await (this.dependencies.wait ?? defaultWait)(250);
    }
    throw new DocumentGenerationApplicationError(
      'generation_failed',
      'Assistant message did not complete in time'
    );
  }

  private closeCancellationWindow(
    key: string,
    abortController: AbortController
  ): void {
    const active = this.activeOperations.get(key);
    if (active?.abortController === abortController) active.cancellable = false;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    );
    return operation;
  }
}

function operationKey(
  projectId: ProjectId,
  input: GenerateDocumentFromMessageInput
): string {
  return JSON.stringify({
    projectId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    expectedRevision: input.expectedRevision,
    kind: input.kind,
    theme: input.kind === 'ppt' ? undefined : input.theme,
    presentationTemplate: input.presentationTemplate,
    parentWorkId: input.parentWorkId,
    images: input.images
  });
}

function messageQueueKey(
  projectId: ProjectId,
  input: GenerateDocumentFromMessageInput
): string {
  return `${projectId}:${input.conversationId}:${input.messageId}`;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function documentFailureCode(error: unknown): DocumentGenerationFailureCode {
  if (error instanceof DocumentDraftCompilationError) {
    return error.code === 'resource_limit' ? 'resource_limit' : 'invalid_outline';
  }
  if (error instanceof DocumentGenerationApplicationError) {
    if (error.code === 'resource_limit') return 'resource_limit';
    if (error.code === 'layout_overflow') return 'document_layout_overflow';
    if (error.code === 'storage_error') return 'storage_error';
    if (error.code === 'invalid_structure') return 'invalid_outline';
    if (error.code === 'response_failed') return 'response_failed';
    return 'generation_failed';
  }
  return 'generation_failed';
}

export function toDocumentGenerationApplicationInput(input: {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
  readonly kind: DocumentWorkspaceKind;
  readonly theme?: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly presentationTemplate?: PresentationTemplateId;
  readonly parentWorkId?: string;
  readonly images: GenerateDocumentFromMessageInput['images'];
}): GenerateDocumentFromMessageInput {
  const { parentWorkId, ...rest } = input;
  return {
    ...rest,
    conversationId: toConversationId(input.conversationId),
    messageId: toMessageId(input.messageId),
    ...(parentWorkId !== undefined
      ? { parentWorkId: toWorkId(parentWorkId) }
      : {})
  };
}
