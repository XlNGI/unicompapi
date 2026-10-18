import { toConversationId, toMessageId, toWorkId, type Conversation, type ConversationId, type ConversationWorkflowId, type ConversationWorkflowV1, type DocumentMessageResult, type DocumentGenerationFailureCode, type DocumentGenerationStatus, type DocumentIR, type DocumentOutline, type DocumentWorkspaceKind, type ExecutionId, type MessageId, type PresentationTemplateId, type PresentationPageRequirement, type assessPresentationPageCount, type ProjectId, type TaskId, type WorkId } from '../domain';
import type { DocumentRevisionPatch } from './document-revision-agent';
import type { DocumentOperation } from '../domain/entities/document-agent';
import type { PresentationRevisionMap } from './presentation-revision-map';
import { ConversationApplicationError } from './conversation-service';
import { DocumentTaskRuntimeConflictError } from './document-task-runtime-service';
import { type PresentationArtDirectionPlanner, type PresentationArtDirectionRequest } from './presentation-art-direction';
import { collectConversationDocumentBrief } from './conversation-document-brief';
import type { ProductionPresentationDesignIR } from '../domain/entities/presentation-design-contract';
import { ExecutionBudgetError, type HostExecutionBudget } from './execution-budget';

export type DocumentDraftCompilationErrorCode =
  | 'invalid_structure'
  | 'ir_conflict'
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
  compileIR?(input: {
    readonly outline: DocumentOutline;
    readonly operation: DocumentOperation;
    readonly attachmentRefs?: readonly string[];
    readonly revision?: DocumentIR['revision'];
    /** Host-owned stable compilation identity; never supplied by model tool arguments. */
    readonly identitySeed?: string;
  }): DocumentIR;
  compile(input: {
    readonly content: string;
    readonly kind: DocumentWorkspaceKind;
    readonly operation?: DocumentOperation;
    readonly attachmentRefs?: readonly string[];
  }): DocumentOutline;
  recover(input: {
    readonly content: string;
    readonly kind: DocumentWorkspaceKind;
    readonly operation?: DocumentOperation;
    readonly attachmentRefs?: readonly string[];
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
  readonly code: 'request_received' | 'plan_validation' | 'tool_call' | 'tool_result' | 'document_compile' | 'document_render' |
    'document_check' | 'document_structure_check' | 'document_hash_check' | 'document_publish' | 'document_register';
  readonly status: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  readonly operationId?: string;
  readonly facts?: {
    readonly purpose?: 'planning' | 'content' | 'repair' | 'tool' | 'source_summary';
    readonly documentKind?: DocumentWorkspaceKind;
    readonly count?: number;
    readonly totalPages?: number;
    readonly requestedPages?: number;
    readonly pageCountMode?: 'target' | 'exact' | 'max' | 'range';
    readonly pageCountBasis?: 'total' | 'content';
    readonly bytes?: number;
    readonly tool?: 'read_sources' | 'search' | 'analyze' | 'write_document' | 'render' | 'check' | 'publish' | 'patch';
    readonly designPath?: 'design-aware' | 'legacy-fallback';
    readonly fallbackReason?: string;
    readonly artDirectionStatus?: 'validated' | 'invalid' | 'missing';
    readonly designIrStatus?: 'validated' | 'invalid' | 'missing';
    readonly layoutStatus?: 'success' | 'failed' | 'skipped';
    readonly renderPlanStatus?: 'valid' | 'invalid' | 'skipped';
    readonly repairCount?: number;
    readonly diagnosticCode?: string;
    readonly repairAction?: 'reduce_gap' | 'rebalance_regions' | 'reduce_font_size' | 'compatible_composition';
    readonly pageNumber?: number;
    readonly pageRole?: 'hero' | 'statement' | 'comparison' | 'metric' | 'process' | 'evidence' | 'section' | 'content' | 'closing';
    readonly pageIntentDigest?: string;
    readonly composition?: 'single-focus' | 'comparison' | 'evidence-led' | 'sequence' | 'structured' | 'authored';
    readonly selectedLayout?: 'weighted-regions' | 'adaptive-grid' | 'flow-track' | 'design-tree';
    readonly elementCount?: number;
    readonly density?: 'sparse' | 'balanced' | 'dense';
    readonly whitespace?: 'minimal' | 'balanced' | 'generous';
    readonly primaryRegion?: 'left' | 'center' | 'right' | 'top' | 'bottom' | 'leading' | 'trailing' | 'supporting';
    readonly geometrySignature?: string;
    readonly fallback?: boolean;
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
  readonly executionBudget?: HostExecutionBudget;
  start(): Promise<void>;
  progress(event: DocumentGenerationProgressEvent): Promise<void>;
  complete(workId: WorkId): Promise<void>;
  fail(status: 'failed' | 'cancelled'): Promise<void>;
}

export interface DocumentGenerationRuntimePort {
  create(input: GenerateDocumentFromMessageInput, signal?: AbortSignal): Promise<DocumentGenerationRuntimeSession>;
}

export interface DocumentGenerationExecutionInput {
  /** Live Host guard, rechecked before publication and formal registration. */
  readonly validateSource?: () => Promise<void>;
  readonly designCorrectionCount?: number;
  readonly designRevisionTargetPages?: readonly number[];
  readonly executionBudget?: HostExecutionBudget;
  /** Optional durable Task Runtime execution identity supplied by the host. */
  readonly executionId?: string;
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly contentFingerprint: string;
  readonly draftRevision: number;
  readonly sourceDraftId: string;
  readonly outline: DocumentOutline;
  readonly documentIR?: DocumentIR;
  readonly designIR?: ProductionPresentationDesignIR;
  /** User semantic requirements only; never contains Runtime execution metadata. */
  readonly userRequirement?: string;
  readonly requestArtDirection?: PresentationArtDirectionPlanner;
  readonly artDirectionTimeoutMs?: number;
  readonly parentWorkId?: WorkId;
  readonly sourceChecksumSha256?: string;
  /** Stable identity and validated patch for a scoped parent revision. */
  readonly revisionTargetSectionHeading?: string;
  readonly revisionPatch?: DocumentRevisionPatch;
  readonly revisionPatches?: readonly DocumentRevisionPatch[];
  readonly requestedTotalPages?: number;
  readonly pageRequirement?: PresentationPageRequirement;
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
  readonly presentationDesign?: { readonly path: 'design-aware' | 'legacy-fallback'; readonly fallbackReason?: string };
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly workId: WorkId;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly validatedOutline?: DocumentOutline;
  readonly pageCountAssessment?: ReturnType<typeof assessPresentationPageCount>;
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
  /** Resolved upstream by the workflow/generation plan. */
  readonly operation?: DocumentOperation;
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
      readonly workflows?: DocumentGenerationWorkflowPort;
      readonly generationInputs?: {
        resolve(input: GenerateDocumentFromMessageInput, reuse: boolean): Promise<GenerateDocumentFromMessageInput>;
      };
      readonly compiler: DocumentDraftCompilerPort;
      readonly generator: DocumentGenerationExecutorPort;
      readonly runtime?: DocumentGenerationRuntimePort;
      readonly onProgress?: DocumentGenerationProgressCallback;
      readonly resolvePresentationMap?: (workId: WorkId, outline: DocumentOutline) => Promise<PresentationRevisionMap>;
      readonly canRetryMessage?: (conversationId: ConversationId, messageId: MessageId) => Promise<boolean>;
      /** LLM is the only source of QA repair decisions. */
      readonly llmRepairPlanner?: (
        input: DocumentLlmRepairPlannerRequest
      ) => Promise<unknown>;
      readonly artDirectionPlanner?: (input: PresentationArtDirectionRequest & {
        readonly conversationId: ConversationId; readonly messageId: MessageId;
      }) => Promise<unknown>;
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
    const operation = this.track(this.settleDocumentWorkflow(input, previous
        .catch(() => undefined)
        .then(() => this.runGeneration(key, input, abortController))));
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
    let result: GenerateDocumentFromMessageResult;
    try {
      result = await operation;
    } catch (error) {
      await settle({ conversationId: input.conversationId, messageId: input.messageId, kind: input.kind,
        status: isDocumentCancellation(error) ? 'cancelled' : 'failed' }).catch(() => undefined);
      throw error;
    }
    // runGeneration has persisted the validated document result and Work before advancing the queue.
    try {
      await settle({ conversationId: input.conversationId, messageId: input.messageId, kind: input.kind,
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

  private async runGeneration(
    key: string,
    input: GenerateDocumentFromMessageInput,
    abortController: AbortController
  ): Promise<GenerateDocumentFromMessageResult> {
    let validatingOutline = false;
    let runtimeSession: DocumentGenerationRuntimeSession | undefined;
    let removeRuntimeAbort: (() => void) | undefined;
    try {
    await this.reportProgress({ code: 'request_received', status: 'started', operationId: 'local-document-generation',
      facts: { documentKind: input.kind, purpose: 'content' } });
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
      runtimeSession = await this.dependencies.runtime?.create(input, abortController.signal);
      if (runtimeSession?.executionBudget) {
        const budget = runtimeSession.executionBudget;
        const interrupt = () => abortController.abort(budget.signal.reason);
        budget.signal.addEventListener('abort', interrupt, { once: true });
        removeRuntimeAbort = () => budget.signal.removeEventListener('abort', interrupt);
        budget.assertCanProceed('prepare');
      }
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
      const operation = input.operation ?? (input.parentWorkId === undefined ? 'create' : 'edit');
      const attachmentRefs = input.parentWorkId === undefined ? [] : [String(input.parentWorkId)];
      if (input.parentWorkId !== undefined || operation !== 'create') {
        throw new DocumentGenerationApplicationError('invalid_structure',
          'Document edits require an application-validated semantic plan and a bound document tool session');
      }
      const outline = this.compileDraft(content, input.kind, operation, attachmentRefs);
      runtimeSession?.executionBudget?.assertCanProceed('tool');
      if (abortController.signal.aborted) {
        throw new DocumentGenerationApplicationError(
          'cancelled',
          'Document generation was cancelled before file creation'
        );
      }
      const documentIR = this.dependencies.compiler.compileIR?.({
        outline,
        operation,
        identitySeed: JSON.stringify([input.conversationId, input.messageId, outline,
          input.parentWorkId === undefined ? attachmentRefs : []]),
        attachmentRefs: input.parentWorkId === undefined ? attachmentRefs : [],
        ...(input.parentWorkId !== undefined
          ? { revision: { baseWorkId: String(input.parentWorkId), expectedRevision: input.expectedRevision } }
          : {})
      });
      validatingOutline = false;
      await reportGenerationProgress({ code: 'plan_validation', status: 'completed', operationId: 'document-outline',
        facts: { purpose: 'content', documentKind: input.kind, count: outline.sections.length } });
      await this.persistStatus(input, {
        state: 'generating_file',
        kind: input.kind
      });
       const generated = await this.dependencies.generator.run({
       ...(runtimeSession ? { executionId: runtimeSession.executionId } : {}),
       ...(runtimeSession?.executionBudget ? { executionBudget: runtimeSession.executionBudget } : {}),
      kind: input.kind,
      title: outline.title,
      contentFingerprint: this.dependencies.fingerprint(JSON.stringify({
        content,
        kind: input.kind,
        theme: input.theme ?? null,
        presentationTemplate: input.presentationTemplate ?? null,
        parentWorkId: input.parentWorkId ?? null,
          images: input.images,
        outline,
        ...(documentIR !== undefined ? { documentIR } : {})
      })),
      draftRevision: 1,
      sourceDraftId: `message-${input.messageId}`,
      outline,
      ...(documentIR !== undefined ? { documentIR } : {}),
      ...(input.kind === 'ppt' && input.parentWorkId === undefined && operation === 'create'
        ? { userRequirement: collectArtDirectionRequestText(conversation, input.messageId) ?? requestText ?? '',
            ...(this.dependencies.artDirectionPlanner ? { requestArtDirection: (request: PresentationArtDirectionRequest) =>
              this.dependencies.artDirectionPlanner!({ ...request, conversationId: input.conversationId, messageId: input.messageId }) } : {}) }
        : {}),
      ...(input.parentWorkId !== undefined
        ? { parentWorkId: input.parentWorkId }
        : {}),
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
      const status = (!runtimeSession?.executionBudget?.stopReason || runtimeSession.executionBudget.stopReason === 'cancelled') &&
        (abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof DocumentGenerationApplicationError && error.code === 'cancelled')) ? 'cancelled' : 'failed';
      if (runtimeSession) {
        try {
          if (validatingOutline) await runtimeSession.progress({ code: 'plan_validation', status, operationId: 'document-outline',
            facts: { purpose: 'content', documentKind: input.kind } });
          await runtimeSession.fail(status);
        } catch {
          // The generation error remains authoritative. A failed runtime
          // projection is left for explicit reconciliation and never turns a
          // local file failure into a false success.
        }
      }
      if (validatingOutline) await this.reportProgress({ code: 'plan_validation', status, operationId: 'document-outline',
        facts: { purpose: 'content', documentKind: input.kind } });
      await this.persistTerminalFailure(input, error);
      throw error;
    } finally {
      removeRuntimeAbort?.();
      runtimeSession?.executionBudget?.dispose();
    }
  }

  private async reportProgress(event: DocumentGenerationProgressEvent): Promise<void> {
    // A progress projection must never undo a completed file or Work write.
    try { await this.dependencies.onProgress?.(event); } catch { /* best effort */ }
  }

  private compileDraft(
    content: string,
    kind: DocumentWorkspaceKind,
    operation?: DocumentOperation,
    attachmentRefs: readonly string[] = []
  ): DocumentOutline {
    try {
      return this.dependencies.compiler.compile({ content, kind, operation, attachmentRefs });
    } catch (error) {
      if (
        error instanceof DocumentDraftCompilationError &&
        error.code === 'invalid_structure' &&
        /not valid JSON/i.test(error.message)
      ) {
        return this.dependencies.compiler.recover({ content, kind, operation, attachmentRefs });
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
    const cancelled = isDocumentCancellation(error);
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

function isDocumentCancellation(error: unknown): boolean {
  return (error instanceof DocumentGenerationApplicationError || error instanceof ExecutionBudgetError) && error.code === 'cancelled';
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

/**
 * Art Direction needs the complete creation brief. A confirmation turn may be
 * separated from the assistant outline by earlier assistant messages, so the
 * revision helper's adjacent-user semantics would lose the original visual
 * requirements. Stop at the last delivered document to keep the boundary
 * deterministic and bounded.
 */
export function collectArtDirectionRequestText(
  conversation: Conversation,
  currentAssistantMessageId: MessageId
): string | undefined {
  return collectConversationDocumentBrief(conversation, currentAssistantMessageId).text || undefined;
}

export function toDocumentGenerationApplicationInput(input: {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
  readonly kind: DocumentWorkspaceKind;
  readonly operation?: DocumentOperation;
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
      : {}),
    ...(input.operation !== undefined ? { operation: input.operation } : {})
  };
}
