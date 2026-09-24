import {
  toConversationId,
  toConversationWorkflowId,
  toMessageId,
  toWorkId,
  type Conversation,
  type ConversationId,
  type ConversationResponseExecutionState,
  type ConversationWorkflowId,
  type ConversationWorkflowV1,
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
import { DocumentTaskRuntimeConflictError } from './document-task-runtime-service';
import type {
  DocumentRevisionAgentResult,
  DocumentRevisionPatch
} from './document-revision-agent';
import {
  isExplicitClearRevisionRequest,
  parseDeterministicClearRevisionTarget,
  parseRevisionTarget,
  parseRevisionTargets,
  revisionSectionIndex
} from './document-revision-agent';
import {
  isSupportedPresentationTotalPages,
  parseRequestedPresentationTotalPages,
  presentationBodySectionCount
} from './presentation-page-count';
import type { PresentationRevisionMap } from './presentation-revision-map';

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
  | 'verification_failed'
  | 'write_failed'
  | 'registration_failed'
  | 'result_sync_pending'
  | 'local_revision_not_supported'
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
  createCompletedLocalAssistantMessage?(input: {
    readonly conversationId: ConversationId;
    readonly expectedRevision: number;
    readonly content: string;
  }): Promise<{
    readonly conversation: Conversation;
    readonly messageId: MessageId;
  }>;
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

export interface DocumentGenerationWorkflowPort {
  bindDocumentMessage?(executionId: string, messageId: MessageId): Promise<void>;
  load(workflowId: ConversationWorkflowId): Promise<ConversationWorkflowV1 | undefined>;
  beginExecution(input: {
    readonly workflowId: ConversationWorkflowId;
    readonly expectedRevision: number;
    readonly executionId: string;
  }): Promise<void>;
  finishExecution(
    executionId: string,
    status: 'completed' | 'failed' | 'cancelled'
  ): Promise<void>;
  settleDocumentResult?(input: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly kind: DocumentWorkspaceKind;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly workId?: WorkId;
    /** Set only by the local revision service; never accepted from renderer or model input. */
    readonly localExecutionId?: string;
  }): Promise<void>;
}

/** Observable execution facts only; no model text, paths or private document data. */
export interface DocumentGenerationProgressEvent {
  readonly code: 'plan_validation' | 'tool_call' | 'tool_result' | 'document_compile' | 'document_render' |
    'document_check' | 'document_structure_check' | 'document_hash_check' | 'document_publish' | 'document_register';
  readonly status: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  readonly operationId?: string;
  readonly facts?: {
    readonly purpose?: 'planning' | 'content' | 'repair' | 'tool';
    readonly documentKind?: DocumentWorkspaceKind;
    readonly count?: number;
    readonly totalPages?: number;
    readonly bytes?: number;
    readonly tool?: 'read_sources' | 'search' | 'analyze' | 'write_document' | 'render' | 'check' | 'publish' | 'patch';
  };
}

export type DocumentGenerationProgressCallback = (event: DocumentGenerationProgressEvent) => void | Promise<void>;

/**
 * The Application layer only forwards bounded QA evidence to the model port.
 * Platform owns the concrete diagnostic implementation and all validation.
 */
export interface DocumentLlmRepairDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly scope: string;
  readonly message: string;
}

export interface DocumentLlmRepairPlannerRequest {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly outline: DocumentOutline;
  readonly diagnostics: readonly DocumentLlmRepairDiagnostic[];
  readonly expectedRevision: number;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

/** Durable lifecycle hooks for a local document generation execution. */
export interface DocumentGenerationRuntimeSession {
  readonly executionId: string;
  start(): Promise<void>;
  progress(event: DocumentGenerationProgressEvent): Promise<void>;
  complete(workId: WorkId): Promise<void>;
  fail(status: 'failed' | 'cancelled'): Promise<void>;
}

export interface DocumentGenerationRuntimePort {
  create(input: GenerateDocumentFromMessageInput): Promise<DocumentGenerationRuntimeSession>;
}

export interface DocumentGenerationExecutionInput {
  /** Optional durable Task Runtime execution identity supplied by the host. */
  readonly executionId?: string;
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly contentFingerprint: string;
  readonly draftRevision: number;
  readonly sourceDraftId: string;
  readonly outline: DocumentOutline;
  readonly parentWorkId?: WorkId;
  readonly sourceChecksumSha256?: string;
  /** Stable identity and validated patch for a scoped parent revision. */
  readonly revisionTargetSectionHeading?: string;
  readonly revisionPatch?: DocumentRevisionPatch;
  readonly revisionPatches?: readonly DocumentRevisionPatch[];
  readonly requestedTotalPages?: number;
  readonly theme?: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly presentationTemplate?: PresentationTemplateId;
  /**
   * Optional LLM/Designer repair planner. A missing planner deliberately
   * disables automatic repair; no local fallback is permitted.
   */
  readonly requestLlmRepair?: (request: {
    readonly outline: DocumentOutline;
    readonly diagnostics: readonly DocumentLlmRepairDiagnostic[];
    readonly expectedRevision: number;
    readonly attempt: number;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
  readonly repairTimeoutMs?: number;
  readonly signal: AbortSignal;
  readonly onCancellationClosed: () => void | Promise<void>;
  readonly onProgress?: DocumentGenerationProgressCallback;
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
  readonly validatedOutline?: DocumentOutline;
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

export interface PrepareDeterministicDocumentRevisionInput {
  readonly conversationId: ConversationId;
  readonly expectedRevision: number;
  readonly workflowId: ConversationWorkflowId;
  readonly expectedWorkflowRevision: number;
  readonly kind: DocumentWorkspaceKind;
  readonly parentWorkId: WorkId;
}

export interface PrepareDeterministicDocumentRevisionResult {
  readonly conversationId: ConversationId;
  readonly expectedRevision: number;
  readonly messageId: MessageId;
}

export async function waitForDocumentResponseCompletion<
  T extends { readonly state: ConversationResponseExecutionState }
>(input: {
  readonly read: () => Promise<T>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly maxWaitMs?: number;
}): Promise<T | undefined> {
  const maxWaitMs = input.maxWaitMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 10 * 60_000) throw new TypeError('Document response wait budget is invalid');
  const deadline = Date.now() + maxWaitMs;
  let consecutiveReadFailures = 0;
  for (let attempt = 0; attempt < Math.ceil(maxWaitMs / 1_000); attempt += 1) {
    if (input.signal?.aborted || Date.now() >= deadline) return undefined;
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
  return undefined;
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
  private readonly localRevisionWorkflows = new Map<string, string>();
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
      readonly workflows?: DocumentGenerationWorkflowPort;
      readonly generationInputs?: {
        resolve(input: GenerateDocumentFromMessageInput, reuse: boolean): Promise<GenerateDocumentFromMessageInput>;
      };
      readonly compiler: DocumentDraftCompilerPort;
      readonly generator: DocumentGenerationExecutorPort;
      readonly runtime?: DocumentGenerationRuntimePort;
      readonly onProgress?: DocumentGenerationProgressCallback;
      readonly resolvePresentationMap?: (workId: WorkId, outline: DocumentOutline) => Promise<PresentationRevisionMap>;
      readonly validatePresentationSelection?: (input: GenerateDocumentFromMessageInput, map: PresentationRevisionMap, target: { unit: 'page' | 'section'; ordinal: number }) => Promise<void>;
      readonly canRetryMessage?: (conversationId: ConversationId, messageId: MessageId) => Promise<boolean>;
      /** Optional bounded local/provider-backed revision workflow. */
      readonly revisionAgent?: (
        input: {
          readonly baseWorkId: WorkId;
          readonly expectedRevision: number;
          readonly kind: DocumentWorkspaceKind;
          readonly requestText: string;
          readonly outline: DocumentOutline;
          readonly proposedOutline?: DocumentOutline;
          readonly presentationMap?: PresentationRevisionMap;
          readonly signal: AbortSignal;
        }
      ) => Promise<DocumentRevisionAgentResult>;
      /** LLM is the only source of QA repair decisions. */
      readonly llmRepairPlanner?: (
        input: DocumentLlmRepairPlannerRequest
      ) => Promise<unknown>;
      readonly fingerprint: (content: string) => string;
      readonly nextLocalExecutionId?: () => string;
      readonly wait?: (milliseconds: number) => Promise<void>;
    }
  ) {}

  async prepareDeterministicRevision(
    input: PrepareDeterministicDocumentRevisionInput
  ): Promise<PrepareDeterministicDocumentRevisionResult> {
    const workflows = this.dependencies.workflows;
    const createLocalMessage =
      this.dependencies.conversations.createCompletedLocalAssistantMessage;
    if (!workflows || !createLocalMessage) {
      throw new DocumentGenerationApplicationError(
        'local_revision_not_supported',
        'Local document revision workflow is unavailable'
      );
    }
    const conversation = await this.dependencies.conversations.load(
      input.conversationId
    );
    if (!conversation || conversation.projectId !== this.dependencies.projectId) {
      throw new ConversationApplicationError(
        'conversation_not_found',
        'Conversation does not exist'
      );
    }
    if (conversation.revision !== input.expectedRevision) {
      throw new ConversationApplicationError(
        'revision_conflict',
        'Conversation revision has changed',
        conversation.revision
      );
    }
    const workflow = await workflows.load(input.workflowId);
    if (
      !workflow ||
      workflow.projectId !== this.dependencies.projectId ||
      workflow.conversationId !== input.conversationId ||
      workflow.revision !== input.expectedWorkflowRevision ||
      workflow.status !== 'ready' ||
      workflow.plan.kind !== 'document' ||
      workflow.plan.action !== 'revise' ||
      (workflow.plan.documentKind !== 'auto' &&
        workflow.plan.documentKind !== input.kind) ||
      workflow.plan.sourcePolicy !== 'none'
    ) {
      throw new DocumentGenerationApplicationError(
        'local_revision_not_supported',
        'The confirmed workflow is not eligible for local document revision'
      );
    }
    const sourceIndex = conversation.messages.findIndex(
      (message) => message.id === workflow.sourceMessageId
    );
    const source = conversation.messages[sourceIndex];
    const parentIndex = conversation.messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        message.state === 'completed' &&
        message.documentResult?.workId === input.parentWorkId &&
        message.documentResult.kind === input.kind
    );
    const parent = conversation.messages[parentIndex];
    if (
      !source ||
      source.role !== 'user' ||
      source.state !== 'completed' ||
      sourceIndex !== conversation.messages.length - 1 ||
      !parent ||
      parent.role !== 'assistant' ||
      parent.state !== 'completed' ||
      !parent.documentResult?.validatedContent ||
      parentIndex >= sourceIndex ||
      workflow.resolvedTarget?.artifactRef !== parent.id
    ) {
      throw new DocumentGenerationApplicationError(
        'local_revision_not_supported',
        'The local revision source or parent document is unavailable'
      );
    }
    const requestText = (source.displayContent ?? source.content).trim();
    const target = parseDeterministicClearRevisionTarget(requestText);
    if (!target || !workflowTargetMatches(workflow, target)) {
      throw new DocumentGenerationApplicationError(
        'local_revision_not_supported',
        'The request is not a single explicit clear operation'
      );
    }
    const previousOutline = this.compileLegacyDraft(
      parent.documentResult.validatedContent,
      input.kind
    );
    const presentationMap = input.kind === 'ppt' && this.dependencies.resolvePresentationMap
      ? await this.dependencies.resolvePresentationMap(input.parentWorkId, previousOutline) : undefined;
    const targetIndex = revisionSectionIndex(input.kind, target, presentationMap);
    if (targetIndex < 0 || targetIndex >= previousOutline.sections.length) {
      throw new DocumentGenerationApplicationError(
        'revision_scope_violation',
        'Revision target does not exist in the previous document'
      );
    }

    const executionId = this.dependencies.nextLocalExecutionId?.() ??
      `local-document-revision-${workflow.id}-${workflow.revision}`;
    await workflows.beginExecution({
      workflowId: workflow.id,
      expectedRevision: workflow.revision,
      executionId
    });
    try {
      const created = await createLocalMessage({
          conversationId: conversation.id,
          expectedRevision: conversation.revision,
          content: '已按确认范围执行本地文档修改。'
        });
      const key = messageQueueKey(this.dependencies.projectId, {
        conversationId: conversation.id,
        messageId: created.messageId
      });
      this.localRevisionWorkflows.set(key, executionId);
      await workflows.bindDocumentMessage?.(executionId, created.messageId);
      await this.persistStatus(
        {
          conversationId: conversation.id,
          expectedRevision: created.conversation.revision,
          messageId: created.messageId,
          kind: input.kind,
          parentWorkId: input.parentWorkId,
          images: []
        },
        { state: 'validating_outline', kind: input.kind }
      );
      const preparedConversation = await this.dependencies.conversations.load(
        conversation.id
      );
      if (!preparedConversation) {
        throw new ConversationApplicationError(
          'conversation_not_found',
          'Conversation disappeared during local revision preparation'
        );
      }
      return {
        conversationId: conversation.id,
        expectedRevision: preparedConversation.revision,
        messageId: created.messageId
      };
    } catch (error) {
      for (const [key, value] of this.localRevisionWorkflows) {
        if (value === executionId) this.localRevisionWorkflows.delete(key);
      }
      await workflows.finishExecution(executionId, 'failed');
      throw error;
    }
  }

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
    const localWorkflowExecutionId = this.localRevisionWorkflows.get(key);
    if (localWorkflowExecutionId && this.dependencies.workflows) {
      await this.dependencies.workflows.finishExecution(
        localWorkflowExecutionId,
        'failed'
      );
      this.localRevisionWorkflows.delete(key);
    }
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
    const operation = this.track(this.settleDocumentWorkflow(input, this.settleLocalRevisionWorkflow(
      queueKey,
      previous
        .catch(() => undefined)
        .then(() => this.runGeneration(key, input, abortController))
    )));
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

  private async settleDocumentWorkflow(
    input: GenerateDocumentFromMessageInput,
    operation: Promise<GenerateDocumentFromMessageResult>
  ): Promise<GenerateDocumentFromMessageResult> {
    const settle = this.dependencies.workflows?.settleDocumentResult;
    if (!settle) return operation;
    const localExecutionId = this.localRevisionWorkflows.get(messageQueueKey(this.dependencies.projectId, input));
    let result: GenerateDocumentFromMessageResult;
    try {
      result = await operation;
    } catch (error) {
      await settle({ conversationId: input.conversationId, messageId: input.messageId, kind: input.kind,
        ...(localExecutionId ? { localExecutionId } : {}),
        status: error instanceof DocumentGenerationApplicationError && error.code === 'cancelled' ? 'cancelled' : 'failed' }).catch(() => undefined);
      throw error;
    }
    // runGeneration has persisted the validated document result and Work before advancing the queue.
    try {
      await settle({ conversationId: input.conversationId, messageId: input.messageId, kind: input.kind,
        ...(localExecutionId ? { localExecutionId } : {}),
        status: 'completed', workId: result.workId });
    } catch {
      const error = new DocumentGenerationApplicationError('result_sync_pending', '新版文档已保存，任务完成状态同步未完成。');
      await this.persistTerminalFailure(input, error);
      if (error instanceof DocumentTaskRuntimeConflictError) {
        throw new DocumentGenerationApplicationError(
          'generation_failed',
          'Document execution state could not be recorded safely'
        );
      }
      throw error;
    }
    return result;
  }

  private async settleLocalRevisionWorkflow<T>(
    queueKey: string,
    operation: Promise<T>
  ): Promise<T> {
    const executionId = this.localRevisionWorkflows.get(queueKey);
    if (!executionId || !this.dependencies.workflows) return operation;
    if (this.dependencies.workflows.settleDocumentResult) {
      try {
        return await operation;
      } finally {
        this.localRevisionWorkflows.delete(queueKey);
      }
    }
    try {
      const result = await operation;
      await this.dependencies.workflows.finishExecution(executionId, 'completed');
      return result;
    } catch (error) {
      await this.dependencies.workflows.finishExecution(
        executionId,
        error instanceof DocumentGenerationApplicationError &&
          error.code === 'cancelled'
          ? 'cancelled'
          : 'failed'
      );
      throw error;
    } finally {
      this.localRevisionWorkflows.delete(queueKey);
    }
  }

  private async runGeneration(
    key: string,
    input: GenerateDocumentFromMessageInput,
    abortController: AbortController
  ): Promise<GenerateDocumentFromMessageResult> {
    let validatingOutline = false;
    let revisingDocument = false;
    let runtimeSession: DocumentGenerationRuntimeSession | undefined;
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
    if (message.documentGenerationStatus?.state === 'failed') {
      const code = message.documentGenerationStatus.errorCode;
      if (['revision_scope_violation', 'revision_patch_failed', 'revision_conflict', 'unvalidated_output', 'verification_failed', 'invalid_outline', 'resource_limit', 'document_layout_overflow', 'page_count_mismatch'].includes(code) ||
        (this.dependencies.canRetryMessage && !await this.dependencies.canRetryMessage(input.conversationId, input.messageId))) {
        throw new DocumentGenerationApplicationError('revision_scope_violation', '请核对修改范围或内容后重新发起任务，当前失败不可原样重试。');
      }
    }
    if (this.dependencies.generationInputs) {
      input = await this.dependencies.generationInputs.resolve(input,
        message.documentGenerationStatus?.state === 'failed' || message.documentGenerationStatus?.state === 'interrupted');
    }
    const content = message.content.trim();
      if (!content) {
      throw new DocumentGenerationApplicationError(
        'invalid_structure',
        'The assistant response is empty'
      );
      }
      runtimeSession = await this.dependencies.runtime?.create(input);
      await runtimeSession?.start();
      const reportGenerationProgress = async (event: DocumentGenerationProgressEvent): Promise<void> => {
        // Runtime persistence is a safety boundary. If it cannot claim or
        // settle an operation, the bridge leaves the runtime blocked for
        // reconciliation; the existing UI trace remains best effort.
        await runtimeSession?.progress(event);
        await this.reportProgress(event);
      };
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

      validatingOutline = true;
      await reportGenerationProgress({ code: 'plan_validation', status: 'started', operationId: 'document-outline',
        facts: { purpose: 'content', documentKind: input.kind } });
      await this.persistStatus(input, {
        state: 'validating_outline',
        kind: input.kind
      });
      const requestText = collectRevisionRequestText(
        conversation,
        input.messageId
      );
      const previousMessage = input.parentWorkId === undefined
        ? undefined
        : [...conversation.messages]
            .reverse()
            .find((item) => {
              const result = item.documentResult;
              return (
                item.role === 'assistant' &&
                result?.workId === input.parentWorkId &&
                result?.kind === input.kind
              );
            });
      const previousOutline = previousMessage
        ? this.compileLegacyDraft(
            previousMessage.documentResult?.validatedContent ?? previousMessage.content,
            input.kind
          )
        : undefined;
      const revisionTarget = requestText === undefined
        ? undefined
        : parseRevisionTarget(requestText);
      if (input.kind === 'ppt' && input.parentWorkId && revisionTarget && this.dependencies.validatePresentationSelection &&
        parseRevisionTargets(requestText ?? '').length !== 1) {
        throw new DocumentGenerationApplicationError('revision_scope_violation', '请指定一个明确的 PPT 页面或章节并确认实际范围。');
      }
      const presentationMap = input.kind === 'ppt' && input.parentWorkId && previousOutline && this.dependencies.resolvePresentationMap
        ? await this.dependencies.resolvePresentationMap(input.parentWorkId, previousOutline) : undefined;
      if (input.kind === 'ppt' && input.parentWorkId && revisionTarget && !presentationMap) {
        throw new DocumentGenerationApplicationError('revision_scope_violation', '无法取得原 PPT 的实际页面映射，请核对作品后重新发起修改。');
      }
      if (presentationMap && revisionTarget && this.dependencies.validatePresentationSelection) {
        await this.dependencies.validatePresentationSelection(input, presentationMap, revisionTarget);
      }
      const useDeterministicClearRevision =
        input.parentWorkId !== undefined &&
        requestText !== undefined &&
        revisionTarget !== undefined &&
        previousOutline !== undefined &&
        this.dependencies.revisionAgent !== undefined &&
        isExplicitClearRevisionRequest(requestText);
      let outline = useDeterministicClearRevision
        ? previousOutline
        : this.compileDraft(content, input.kind);
      let revisionTargetSectionHeading: string | undefined;
      let revisionPatch: DocumentRevisionPatch | undefined;
      let revisionPatches: readonly DocumentRevisionPatch[] | undefined;
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
        if (previousOutline && requestText) {
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
            revisingDocument = true;
            await reportGenerationProgress({ code: 'tool_call', status: 'started', operationId: 'document-revision',
              facts: { purpose: 'repair', tool: 'patch', documentKind: input.kind } });
            try {
              revision = await this.dependencies.revisionAgent({
                baseWorkId: input.parentWorkId,
                expectedRevision: input.expectedRevision,
                kind: input.kind,
                requestText,
                outline: previousOutline,
                ...(presentationMap ? { presentationMap } : {}),
                ...(useDeterministicClearRevision
                  ? {}
                  : { proposedOutline: outline }),
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
            validateRevisionScope(previousOutline, revision, presentationMap);
            revisingDocument = false;
            await reportGenerationProgress({ code: 'tool_result', status: 'completed', operationId: 'document-revision',
              facts: { purpose: 'repair', tool: 'patch', documentKind: input.kind } });
            outline = revision.outline;
            revisionPatch = revision.patch;
            revisionPatches = revision.patches;
            revisionApplied = true;
          }
          if (revisionTarget !== undefined) {
            const heading = previousOutline.sections[
              revisionSectionIndex(previousOutline.kind, revisionTarget, presentationMap)
            ]?.heading;
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
              requestText,
              presentationMap
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
      validatingOutline = false;
      await reportGenerationProgress({ code: 'plan_validation', status: 'completed', operationId: 'document-outline',
        facts: { purpose: 'content', documentKind: input.kind, count: outline.sections.length } });
      await this.persistStatus(input, {
        state: 'generating_file',
        kind: input.kind
      });
       const generated = await this.dependencies.generator.run({
       ...(runtimeSession ? { executionId: runtimeSession.executionId } : {}),
      ...(presentationMap ? { sourceChecksumSha256: presentationMap.checksumSha256 } : {}),
      kind: input.kind,
      title: outline.title,
      contentFingerprint: this.dependencies.fingerprint(JSON.stringify({
        content: useDeterministicClearRevision ? requestText : content,
        kind: input.kind,
        theme: input.theme ?? null,
        presentationTemplate: input.presentationTemplate ?? null,
        parentWorkId: input.parentWorkId ?? null,
        ...(presentationMap ? { sourceChecksumSha256: presentationMap.checksumSha256 } : {}),
        images: input.images,
        outline
      })),
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
      ...(this.dependencies.llmRepairPlanner !== undefined
        ? {
            requestLlmRepair: (request: {
              readonly outline: DocumentOutline;
              readonly diagnostics: readonly DocumentLlmRepairDiagnostic[];
              readonly expectedRevision: number;
              readonly attempt: number;
              readonly signal: AbortSignal;
            }) => this.dependencies.llmRepairPlanner!({
              conversationId: input.conversationId,
              messageId: input.messageId,
              ...request
            })
          }
        : {}),
      ...(this.dependencies.llmRepairPlanner !== undefined
        ? { repairTimeoutMs: 30_000 }
        : {}),
      signal: abortController.signal,
      ...(runtimeSession ? { strictProgress: true } : {}),
      onCancellationClosed: () =>
        this.closeCancellationWindow(key, abortController),
       ...(runtimeSession
         ? { onProgress: reportGenerationProgress }
         : this.dependencies.onProgress
           ? { onProgress: this.dependencies.onProgress }
           : {}),
       images: input.images
       });

       // DocumentGenerationRunner registers the Work before resolving. Only
       // now can the Task Runtime enter its formal completed state.
       await runtimeSession?.complete(generated.workId);

      try {
        await this.attachResult(input, generated, generated.validatedOutline ?? outline);
      } catch {
        throw new DocumentGenerationApplicationError('result_sync_pending', '新版文档已保存，结果状态同步未完成，请重试同步；不会重新生成作品。');
      }
      if (input.kind === 'ppt' && this.dependencies.resolvePresentationMap) {
        // The index is derived and rebuildable. Index failure cannot undo a saved Work.
        await this.dependencies.resolvePresentationMap(generated.workId, generated.validatedOutline ?? outline).catch(() => undefined);
      }
      return {
        conversationId: input.conversationId,
        messageId: input.messageId,
        ...generated
      };
    } catch (error) {
      const status = abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof DocumentGenerationApplicationError && error.code === 'cancelled') ? 'cancelled' : 'failed';
      if (runtimeSession) {
        try {
          if (revisingDocument) await runtimeSession.progress({ code: 'tool_result', status, operationId: 'document-revision',
            facts: { purpose: 'repair', tool: 'patch', documentKind: input.kind } });
          if (validatingOutline) await runtimeSession.progress({ code: 'plan_validation', status, operationId: 'document-outline',
            facts: { purpose: 'content', documentKind: input.kind } });
          await runtimeSession.fail(status);
        } catch {
          // The generation error remains authoritative. A failed runtime
          // projection is left for explicit reconciliation and never turns a
          // local file failure into a false success.
        }
      }
      if (revisingDocument) await this.reportProgress({ code: 'tool_result', status, operationId: 'document-revision',
        facts: { purpose: 'repair', tool: 'patch', documentKind: input.kind } });
      if (validatingOutline) await this.reportProgress({ code: 'plan_validation', status, operationId: 'document-outline',
        facts: { purpose: 'content', documentKind: input.kind } });
      await this.persistTerminalFailure(input, error);
      throw error;
    }
  }

  private async reportProgress(event: DocumentGenerationProgressEvent): Promise<void> {
    // A progress projection must never undo a completed file or Work write.
    try { await this.dependencies.onProgress?.(event); } catch { /* best effort */ }
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
    generated: DocumentGenerationExecutionResult,
    validatedOutline: DocumentOutline
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
            sizeBytes: generated.sizeBytes,
            validatedContent: JSON.stringify(validatedOutline)
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
  input: Pick<GenerateDocumentFromMessageInput, 'conversationId' | 'messageId'>
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
    if (error.code === 'verification_failed' || error.code === 'write_failed' || error.code === 'registration_failed' || error.code === 'result_sync_pending') return error.code;
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

function workflowTargetMatches(
  workflow: ConversationWorkflowV1,
  target: { readonly unit: 'page' | 'section'; readonly ordinal: number }
): boolean {
  const hint = workflow.plan.targetHint;
  return (
    hint?.unit === target.unit &&
    hint.ordinal === target.ordinal &&
    hint.name === undefined
  );
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
  revision: DocumentRevisionAgentResult,
  presentationMap?: PresentationRevisionMap
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
        !presentationMap?.sections[sectionIndex]?.pages.includes(target.pageNumber))
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

export function toPrepareDeterministicDocumentRevisionInput(input: {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly workflowId: string;
  readonly expectedWorkflowRevision: number;
  readonly kind: DocumentWorkspaceKind;
  readonly parentWorkId: string;
}): PrepareDeterministicDocumentRevisionInput {
  return {
    ...input,
    conversationId: toConversationId(input.conversationId),
    workflowId: toConversationWorkflowId(input.workflowId),
    parentWorkId: toWorkId(input.parentWorkId)
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
  requestText: string,
  presentationMap?: PresentationRevisionMap
): DocumentOutline {
  if (previous.kind !== next.kind) return next;
  const revisionTarget = parseRevisionTarget(requestText);
  if (revisionTarget === undefined) return next;
  const targetIndex = revisionSectionIndex(previous.kind, revisionTarget, presentationMap);
  if (targetIndex < 0 || targetIndex >= previous.sections.length) return next;
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
