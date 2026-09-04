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
import type {
  DocumentRevisionAgentResult,
  DocumentRevisionPatch
} from './document-revision-agent';
import {
  isSupportedPresentationTotalPages,
  parseRequestedPresentationTotalPages,
  presentationBodySectionCount
} from './presentation-page-count';

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
  | 'revision_scope_violation'
  | 'revision_patch_failed'
  | 'revision_conflict'
  | 'unvalidated_output'
  | 'page_count_mismatch'
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
  /** Stable identity and validated patch for a scoped parent revision. */
  readonly revisionTargetSectionHeading?: string;
  readonly revisionPatch?: DocumentRevisionPatch;
  readonly revisionPatches?: readonly DocumentRevisionPatch[];
  readonly requestedTotalPages?: number;
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
  readonly revisionTargetSectionHeading?: string;
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
  let consecutiveReadFailures = 0;
  for (;;) {
    let response: T;
    try {
      response = await input.read();
      consecutiveReadFailures = 0;
    } catch (error) {
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures >= 5) throw error;
      await input.wait(1_000);
      continue;
    }
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
      /** Optional bounded local/provider-backed revision workflow. */
      readonly revisionAgent?: (
        input: {
          readonly baseWorkId: WorkId;
          readonly expectedRevision: number;
          readonly kind: DocumentWorkspaceKind;
          readonly requestText: string;
          readonly outline: DocumentOutline;
          readonly proposedOutline: DocumentOutline;
          readonly signal: AbortSignal;
        }
      ) => Promise<DocumentRevisionAgentResult>;
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
      let outline = this.compileDraft(content, input.kind);
      let revisionTargetSectionHeading: string | undefined;
      let revisionPatch: DocumentRevisionPatch | undefined;
      let revisionPatches: readonly DocumentRevisionPatch[] | undefined;
      const requestText = collectRevisionRequestText(
        conversation,
        input.messageId
      );
      const requestedTotalPages =
        input.kind === 'ppt' && requestText !== undefined
          ? parseRequestedPresentationTotalPages(requestText)
          : undefined;
      if (
        requestedTotalPages !== undefined &&
        !isSupportedPresentationTotalPages(requestedTotalPages)
      ) {
        throw new DocumentGenerationApplicationError(
          'page_count_mismatch',
          'PPT 总页数必须在 3 至 40 页之间。'
        );
      }
      if (input.parentWorkId !== undefined) {
        const previousMessage = [...conversation.messages]
          .reverse()
          .find((item) => {
            const result = item.documentResult;
            return (
              item.role === 'assistant' &&
              result?.workId === input.parentWorkId &&
              result?.kind === input.kind
            );
          });
        if (previousMessage && requestText) {
          const previousOutline = this.compileLegacyDraft(
            previousMessage.content,
            input.kind
          );
          let revisionApplied = false;
          if (requestedTotalPages !== undefined) {
            outline = validateFullPresentationPageCountRevision(
              previousOutline,
              outline,
              requestedTotalPages
            );
            revisionApplied = true;
          } else if (this.dependencies.revisionAgent !== undefined) {
            if (abortController.signal.aborted) {
              throw new DocumentGenerationApplicationError(
                'cancelled',
                'Document revision was cancelled'
              );
            }
            let revision;
            try {
              revision = await this.dependencies.revisionAgent({
                baseWorkId: input.parentWorkId,
                expectedRevision: input.expectedRevision,
                kind: input.kind,
                requestText,
                outline: previousOutline,
                proposedOutline: outline,
                signal: abortController.signal
              });
            } catch (error) {
              if (error instanceof DocumentGenerationApplicationError) throw error;
              if (
                error instanceof ConversationApplicationError &&
                error.code === 'revision_conflict'
              ) {
                throw error;
              }
              if (error instanceof Error && error.name === 'AbortError') {
                throw new DocumentGenerationApplicationError(
                  'cancelled',
                  'Document revision agent timed out or was cancelled'
                );
              }
              throw new DocumentGenerationApplicationError(
                'revision_patch_failed',
                'Document revision patch workflow failed'
              );
            }
            if (
              revision.agent.state !== 'completed' &&
              revision.agent.state !== 'completed_unvalidated'
            ) {
              throw new DocumentGenerationApplicationError(
                revision.agent.state === 'cancelled' ? 'cancelled' : 'unvalidated_output',
                'Document revision workflow did not complete structural validation'
              );
            }
            if (!revision.changed) {
              throw new DocumentGenerationApplicationError(
                'unvalidated_output',
                'Document revision workflow did not produce a scoped change'
              );
            }
            validateRevisionScope(previousOutline, revision);
            outline = revision.outline;
            revisionPatch = revision.patch;
            revisionPatches = revision.patches;
            revisionApplied = true;
          }
          const ordinal = parseRevisionOrdinal(requestText);
          if (ordinal !== undefined) {
            const heading = previousOutline.sections[ordinal - 1]?.heading;
            if (heading === undefined) {
              throw new DocumentGenerationApplicationError(
                'revision_scope_violation',
                'Revision target does not exist in the previous document'
              );
            }
            revisionTargetSectionHeading = heading;
          }
          if (!revisionApplied) {
            outline = preserveUntargetedDocumentSections(
              previousOutline,
              outline,
              requestText
            );
          }
        } else if (this.dependencies.revisionAgent !== undefined) {
          throw new DocumentGenerationApplicationError(
            'invalid_structure',
            'Revision request or parent document was not found'
          );
        }
      }
      if (abortController.signal.aborted) {
        throw new DocumentGenerationApplicationError(
          'cancelled',
          'Document generation was cancelled before file creation'
        );
      }
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
      ...(revisionTargetSectionHeading !== undefined
        ? { revisionTargetSectionHeading }
        : {}),
      ...(revisionPatch !== undefined ? { revisionPatch } : {}),
      ...(revisionPatches !== undefined ? { revisionPatches } : {}),
      ...(requestedTotalPages !== undefined ? { requestedTotalPages } : {}),
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

  private compileLegacyDraft(
    content: string,
    kind: DocumentWorkspaceKind
  ): DocumentOutline {
    try {
      return this.dependencies.compiler.compile({ content, kind });
    } catch (error) {
      if (error instanceof DocumentDraftCompilationError && error.code === 'invalid_structure') {
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
    if (error.code === 'revision_scope_violation') return 'revision_scope_violation';
    if (error.code === 'revision_patch_failed') return 'revision_patch_failed';
    if (error.code === 'revision_conflict') return 'revision_conflict';
    if (error.code === 'unvalidated_output') return 'unvalidated_output';
    if (error.code === 'page_count_mismatch') return 'page_count_mismatch';
    return 'generation_failed';
  }
  if (
    error instanceof ConversationApplicationError &&
    error.code === 'revision_conflict'
  ) {
    return 'revision_conflict';
  }
  return 'generation_failed';
}

export function collectRevisionRequestText(
  conversation: Conversation,
  currentAssistantMessageId: MessageId
): string | undefined {
  const currentIndex = conversation.messages.findIndex(
    (message) => message.id === currentAssistantMessageId
  );
  if (currentIndex < 1) return undefined;
  const parts: string[] = [];
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role !== 'user') break;
    const content = (message.displayContent ?? message.content).trim();
    if (content.length > 0) parts.unshift(content);
  }
  if (parts.length > 0) return parts.join('\n');
  const legacyRequest = [...conversation.messages]
    .slice(0, currentIndex)
    .reverse()
    .find((message) => message.role === 'user');
  const legacyContent = (
    legacyRequest?.displayContent ?? legacyRequest?.content ?? ''
  ).trim();
  return legacyContent.length > 0 ? legacyContent : undefined;
}

function validateFullPresentationPageCountRevision(
  previous: DocumentOutline,
  proposed: DocumentOutline,
  requestedTotalPages: number
): DocumentOutline {
  const requiredSections = presentationBodySectionCount(requestedTotalPages);
  if (
    previous.kind !== 'ppt' ||
    proposed.kind !== 'ppt' ||
    proposed.sections.length !== requiredSections ||
    proposed.sections.some(
      (section) => section.pageKind === 'cover' || section.pageKind === 'closing'
    )
  ) {
    throw new DocumentGenerationApplicationError(
      'page_count_mismatch',
      `PPT 总页数要求为 ${requestedTotalPages} 页，模型必须返回 ${requiredSections} 个正文分节。`
    );
  }
  return { ...proposed, title: previous.title };
}

function validateRevisionScope(
  previous: DocumentOutline,
  revision: DocumentRevisionAgentResult
): void {
  const patches = revision.patch
    ? [revision.patch]
    : revision.patches && revision.patches.length > 0
      ? [...revision.patches]
      : undefined;
  if (!patches) {
    throw new DocumentGenerationApplicationError(
      'revision_patch_failed',
      'Document revision did not return a validated patch'
    );
  }
  const targetIndexes = new Set<number>();
  for (const patch of patches) {
    const target = patch.target;
    const sectionIndex = target.sectionIndex;
    const expectedSection = previous.sections[sectionIndex];
    if (
      !Number.isSafeInteger(sectionIndex) ||
      sectionIndex < 0 ||
      expectedSection === undefined ||
      target.sectionHeading !== expectedSection.heading ||
      (previous.kind === 'ppt' &&
        'pageNumber' in target &&
        target.pageNumber !== undefined &&
        target.pageNumber !== sectionIndex + 2)
    ) {
      throw new DocumentGenerationApplicationError(
        'revision_scope_violation',
        'Revision patch targets an invalid or cross-document range'
      );
    }
    targetIndexes.add(sectionIndex);
  }
  if (revision.outline.title !== previous.title) {
    throw new DocumentGenerationApplicationError(
      'revision_scope_violation',
      'Revision changed the document title outside the requested range'
    );
  }
  if (revision.outline.sections.length !== previous.sections.length) {
    throw new DocumentGenerationApplicationError(
      'revision_scope_violation',
      'Revision changed the document section count outside the requested range'
    );
  }
  for (const [sectionIndex, previousSection] of previous.sections.entries()) {
    if (targetIndexes.has(sectionIndex)) continue;
    if (JSON.stringify(revision.outline.sections[sectionIndex]) !== JSON.stringify(previousSection)) {
      throw new DocumentGenerationApplicationError(
        'revision_scope_violation',
        'Revision changed a section outside the requested range'
      );
    }
  }
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

/**
 * Keeps a revision scoped to the chapter/page the user named. The model still
 * returns a complete outline for validation, but sections outside the ordinal
 * target are restored from the previous outline. This prevents a local edit
 * from silently becoming a rewrite of the whole deck.
 */
export function preserveUntargetedDocumentSections(
  previous: DocumentOutline,
  next: DocumentOutline,
  requestText: string
): DocumentOutline {
  if (previous.kind !== next.kind) return next;
  const ordinal = parseRevisionOrdinal(requestText);
  if (ordinal === undefined || ordinal > previous.sections.length) return next;
  const targetIndex = ordinal - 1;
  const target = next.sections[targetIndex];
  const base = previous.sections[targetIndex];
  if (!target || !base) return next;
  const managementAudience = /非技术管理者|管理者|管理层|高管/u.test(requestText);
  const targetWithStableIdentity = {
    ...target,
    heading: base.heading,
    level: base.level
  };
  const effectiveTarget =
    managementAudience && sectionContentFingerprint(target) === sectionContentFingerprint(base)
      ? rewriteSectionForNonTechnicalManagers(targetWithStableIdentity)
      : targetWithStableIdentity;
  const sections = previous.sections.map((section, index) =>
    index === targetIndex
      ? effectiveTarget
      : section
  );
  return { ...next, title: previous.title, sections };
}

function sectionContentFingerprint(section: DocumentOutline['sections'][number]): string {
  return JSON.stringify({ ...section, heading: '', level: 0 });
}

function rewriteSectionForNonTechnicalManagers(
  section: DocumentOutline['sections'][number]
): DocumentOutline['sections'][number] {
  const rewrite = (value: string): string => {
    let text = value
      .replace(/参考生视频 API|参考生视频API/gu, '视频生成能力')
      .replace(/API 接口|API接口|API/gu, '系统能力')
      .replace(/请求体/gu, '提交内容')
      .replace(/响应体/gu, '处理结果')
      .replace(/callback_url|callbackurl/giu, '回调地址')
      .replace(/off[_-]?peak/giu, '错峰处理')
      .replace(/算力/gu, '资源消耗')
      .replace(/模型/gu, '生成方案')
      .replace(/参数/gu, '配置项')
      .replace(/Token/gu, '访问凭证');
    if (text === value) text = `对管理决策的意义：${text}`;
    return text;
  };
  const blocks = section.blocks.map((block) => {
    if (block.type === 'paragraph' || block.type === 'quote') {
      return { ...block, text: rewrite(block.text) };
    }
    if (block.type === 'bullets' || block.type === 'numbered') {
      return { ...block, items: block.items.map(rewrite) };
    }
    return block;
  });
  return {
    ...section,
    blocks,
    ...(section.takeaway !== undefined
      ? { takeaway: rewrite(section.takeaway) }
      : { takeaway: '管理层可据此评估业务价值、投入成本和试点优先级。' }),
    ...(section.action !== undefined
      ? { action: rewrite(section.action) }
      : { action: '建议先选一个高频业务场景小范围试点，以成本、周期和效果作为验收指标。' })
  };
}

export function parseRevisionOrdinal(value: string): number | undefined {
  const match = /第\s*([一二三四五六七八九十百千万\d]+)\s*(?:章|节|页|部分)/u.exec(
    value
  );
  if (!match) return undefined;
  if (/^\d+$/u.test(match[1])) return Number(match[1]);
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    百: 100,
    千: 1000,
    万: 10_000
  };
  let total = 0;
  let section = 0;
  for (const character of match[1]) {
    const digit = digits[character];
    if (digit >= 10) {
      section = (section || 1) * digit;
      total += section;
      section = 0;
    } else {
      section = digit;
    }
  }
  return total + section || undefined;
}
