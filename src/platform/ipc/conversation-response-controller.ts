import { randomUUID } from 'node:crypto';
import { ExecutionBudgetError } from '../../application/execution-budget';
import { ConversationCompletionError, type ConversationCompletionCoordinator } from '../../application/conversation-completion-coordinator';
import { projectConversationParentRun } from './conversation-parent-run-projection';
import { NativeSearchAuthorizationError, type ConversationNativeSearch } from '../providers/conversation-native-search';
import { FeatureSubmissionError } from '../providers/provider-feature-candidates';
import { isConversationImageRequest, declinesConversationImageInput } from '../../application/conversation-image-request';
import {
  createConversationResponseDraft,
  attachConversationAgentRunExecution,
  createConversationAgentRun,
  transitionConversationAgentRun,
  replaceConversationResponseContextSelections,
  replaceConversationResponseParameterValues,
  toConversationId,
  toConversationAgentRunId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationWorkflowId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextId,
  type ConversationIntentPlan,
  type ConversationWorkflowV1,
  type Conversation,
  type ConversationAgentRunRepository,
  type ConversationResponseDraftRepository,
  type ConversationResponseDraftV1,
  type ConversationResponseExecutionReadModelV1,
  type FeatureCandidateSubjectV1,
  type ParameterValue,
  type ProjectContextRepository,
  type ProjectConversationRepository,
  type SubmissionUserConfirmationV1
} from '../../domain';
import {
  ConversationWorkflowApplicationError,
  type ConversationApplicationService,
  type ConversationWorkflowService
} from '../../application';
import type {
  ChatContextIpcResult,
  ConversationResponseCandidateDto,
  ConversationResponseDraftDto,
  ConversationResponseExecutionDto,
  ConversationResponsePreparationDto,
  ConversationResponseStartDto,
  ConversationResponseStreamEventDto, ConversationParentRunDto, ReconciliationInspectionDto,
  ConversationAgentResponseStartDto, ConversationAgentSessionDto
} from '../../shared/chat-context-ipc';
import {
  chatContextRequestParsers,
  type StartResponseRequest
} from '../../shared/chat-context-ipc';
import type {
  ConversationResponseExecutionLifecycle,
  ControlledConversationResponseStreamChannel,
  ConversationExecutionCoordinator,
  ProviderFeatureCandidateService
} from '../providers';
import { pinProjectContextSelection } from '../repositories';
import type { StorageProjectSession } from './storage-ipc-controller';
import { chatContextFailure, failure } from './chat-context-errors';
import { toConversationDto } from './conversation-controller';
import { ConversationAttachmentError, conversationAttachmentBatch, isImageAttachment, type ConversationAttachmentContextService } from '../documents/conversation-attachment-context';
import { conversationAttachmentQuery } from '../../application/conversation-attachment-query';
import { declinesWebResearch } from '../../application/conversation-intent-orchestrator';
import type { ConversationDocumentPageContextService } from '../documents/conversation-document-page-context';
import { emitProductionEvent, withProductionTrace } from '../conversation-production-trace';
import { buildDocumentOutlinePrompt } from '../../shared/document-outline-contract';
import type { ConversationDocumentToolSelection, ConversationDocumentToolSessionService } from '../documents/conversation-document-tool-session';

export interface ConversationResponseControllerRuntime {
  readonly nativeSearch?: ConversationNativeSearch;
  readonly conversationService: ConversationApplicationService;
  readonly conversations: ProjectConversationRepository;
  readonly drafts: ConversationResponseDraftRepository;
  readonly contexts: ProjectContextRepository;
  readonly candidates: ProviderFeatureCandidateService;
  readonly executions: ConversationResponseExecutionLifecycle;
  readonly executionCoordinator: ConversationExecutionCoordinator;
  readonly streamChannel: ControlledConversationResponseStreamChannel;
  readonly workflowService?: ConversationWorkflowService;
  readonly agentRuns?: ConversationAgentRunRepository;
  readonly completion?: Pick<ConversationCompletionCoordinator, 'settle' | 'canStartNewResponse' | 'inspect' | 'reconcile' | 'acknowledge' | 'waitForOperations'>;
  readonly continuations?: {
    /** Read-only replay and scope checks run before adding another user message. */
    validate?(input: { readonly conversation: Conversation; readonly input: StartResponseRequest;
      readonly signal: AbortSignal }): Promise<ConversationAgentResponseStartDto | undefined>;
    /** Host validates the token and reserves the original session before provider dispatch. */
    prepare(input: { readonly conversation: Conversation;
      readonly userMessageId: string; readonly input: StartResponseRequest; readonly signal: AbortSignal;
    }): Promise<{ readonly agentSession: ConversationAgentSessionDto;
      readonly workflow?: ConversationWorkflowV1; readonly waiting: boolean; readonly parentRunId?: string;
      readonly reservedRunId?: string }>;
    bindRun(input: { readonly sessionId: string; readonly runId: string }): Promise<void>;
    bindExecution(input: { readonly sessionId: string; readonly runId: string; readonly responseExecutionId: string }): Promise<void>;
    cancel(input: { readonly sessionId: string; readonly expectedRevision: number; readonly closeUnknown?: boolean }): Promise<ConversationAgentSessionDto>;
    /** Settles a reserved continuation that never reached an execution handle. */
    abandon?(input: { readonly sessionId: string; readonly cancelled: boolean }): Promise<void>;
  };
  readonly attachments?: Pick<ConversationAttachmentContextService, 'pin' | 'resolve'>;
  readonly documentPages?: Pick<ConversationDocumentPageContextService, 'resolve'>;
  readonly documentTools?: Pick<ConversationDocumentToolSessionService, 'select' | 'pinDraft'> &
    Partial<Pick<ConversationDocumentToolSessionService, 'prepare'>>;
  /** Completes startup recovery before accessing persisted response state or executing writes. */
  readonly ready: Promise<void>;
  refreshRecovery?(scope: { readonly conversationId?: string; readonly responseExecutionId?: string }): Promise<void>;
  submit?(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<ConversationResponseExecutionReadModelV1>;
  start?(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
    readonly signal?: AbortSignal;
  }): Promise<ConversationResponseExecutionReadModelV1>;
}

export interface ConversationResponseControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getRuntime(session: StorageProjectSession): ConversationResponseControllerRuntime;
  nextResponseDraftId(): string;
  nextAgentRunId?(): string;
  now?: () => string;
  onError?(error: unknown): void;
}

export class ConversationResponseController {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly startCommands = new Map<
    string,
    Promise<ChatContextIpcResult<ConversationAgentResponseStartDto>>
  >();
  private readonly startAbortControllers = new Map<string, AbortController>();
  private readonly reconciliationInspections = new Map<string, {
    projectId: string; responseExecutionId: string; runId: string; runRevision: number; intentRevision: number | null; expiresAt: number;
    taskRevisions: readonly { readonly id: string; readonly revision: number }[]
  }>();

  constructor(private readonly dependencies: ConversationResponseControllerDependencies) {}

  createDraft(request: unknown): Promise<ChatContextIpcResult<ConversationResponseDraftDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.createResponseDraft(request);
      const runtime = await this.requireRuntime();
      const conversation = await runtime.conversations.get(
        toConversationId(input.conversationId)
      );
      if (!conversation || conversation.projectId !== runtime.conversations.projectId) {
        return failure('conversation_not_found', 'The project conversation does not exist');
      }
      if (conversation.revision !== input.expectedRevision) {
        return failure(
          'revision_conflict',
          'Conversation revision has changed',
          conversation.revision
        );
      }
      if (conversation.status !== 'active') {
        return failure('conversation_not_active', 'The conversation is not active');
      }
      const message = conversation.messages.find(
        (item) => item.id === toMessageId(input.userMessageId)
      );
      if (!message || message.role !== 'user') {
        return failure('message_not_found', 'The selected user message does not exist');
      }
      if (message.state !== 'completed') {
        return failure('message_not_completed', 'The selected user message is not complete');
      }
      const attachmentQuery = conversationAttachmentQuery(undefined, message);
      const isPlainUserMessage = message.displayContent === undefined || message.displayContent === message.content;
      const toolSelection = isPlainUserMessage ? await runtime.documentTools?.select({
        conversation, currentUserMessageId: message.id, query: attachmentQuery
      }) : undefined;
      const pageReferences = isPlainUserMessage && !toolSelection ? await runtime.documentPages?.resolve({
        conversation, currentUserMessageId: message.id, query: attachmentQuery
      }) ?? [] : [];
      if (!pageReferences.length && !toolSelection) await runtime.attachments?.resolve({
        conversation, currentUserMessageId: message.id, query: attachmentQuery
      });
      const imageQuery = isPlainUserMessage && !toolSelection && !pageReferences.length && !declinesConversationImageInput(attachmentQuery) && (isConversationImageRequest(attachmentQuery) || conversationAttachmentBatch(conversation).some(item => isImageAttachment(item.fileName ?? ''))) ? attachmentQuery : undefined;
      const draft = createConversationResponseDraft({
        id: toConversationResponseDraftId(this.dependencies.nextResponseDraftId()),
        projectId: runtime.conversations.projectId,
        conversationId: conversation.id,
        conversationRevision: conversation.revision,
        userMessageId: message.id,
        userMessageRevision: message.revision,
        attachmentQuery,
      ...(imageQuery ? { imageQuery } : {}),
        ...(pageReferences.length ? { documentPageQuery: attachmentQuery } : {}),
        productFeature: input.productFeature,
        createdAt: toIsoTimestamp(this.now())
      });
      await runtime.drafts.create(draft);
      return { ok: true, value: toResponseDraftDto(draft) };
    });
  }

  replaceContexts(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseDraftDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.replaceResponseContexts(request);
      const runtime = await this.requireRuntime();
      const draft = await this.requireDraft(
        runtime,
        input.responseDraftId,
        input.expectedRevision
      );
      if (!draft.ok) return draft;
      const selections = [];
      for (const item of input.selections) {
        const context = await runtime.contexts.get(toProjectContextId(item.contextId));
        if (!context || context.projectId !== runtime.contexts.projectId) {
          return failure('context_not_found', 'The selected project context does not exist');
        }
        selections.push(pinProjectContextSelection(
          context,
          item.contextRevision,
          item.includeInPrompt
        ));
      }
      const updated = replaceConversationResponseContextSelections(
        draft.value,
        selections,
        toIsoTimestamp(this.now())
      );
      await runtime.drafts.save(updated, draft.value.revision);
      return { ok: true, value: toResponseDraftDto(updated) };
    });
  }

  replaceParameters(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseDraftDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.replaceResponseParameters(request);
      const runtime = await this.requireRuntime();
      const draft = await this.requireDraft(
        runtime,
        input.responseDraftId,
        input.expectedRevision
      );
      if (!draft.ok) return draft;
      const updated = replaceConversationResponseParameterValues(
        draft.value,
        input.parameterValues as Readonly<Record<string, ParameterValue>>,
        toIsoTimestamp(this.now())
      );
      await runtime.drafts.save(updated, draft.value.revision);
      return { ok: true, value: toResponseDraftDto(updated) };
    });
  }

  listCandidates(
    request: unknown
  ): Promise<ChatContextIpcResult<readonly ConversationResponseCandidateDto[]>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseDraftRevision(request);
      const runtime = await this.requireRuntime();
      const draft = await this.requireDraft(
        runtime,
        input.responseDraftId,
        input.expectedRevision
      );
      if (!draft.ok) return draft;
      return {
        ok: true,
        value: await runtime.candidates.listFeatureCandidates(subject(draft.value))
      };
    });
  }

  listTextCandidates(
    request: unknown
  ): Promise<ChatContextIpcResult<readonly ConversationResponseCandidateDto[]>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.listTextCandidates(request);
      // Candidate discovery only reads the provider registry and authorization
      // policy. It must remain available while project recovery repairs legacy
      // workflow/execution records; mutating and execution operations still
      // use requireRuntime() and wait for the recovery barrier.
      const runtime = await this.requireRuntime({ waitForReady: false });
      return {
        ok: true,
        value: await runtime.candidates.listCatalogForFeature({
          projectId: runtime.conversations.projectId,
          productFeature: input.productFeature
        })
      };
    });
  }

  prepareSubmission(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponsePreparationDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.prepareResponseSubmission(request);
      const runtime = await this.requireRuntime();
      const draft = await this.requireDraft(
        runtime,
        input.responseDraftId,
        input.expectedRevision
      );
      if (!draft.ok) return draft;
      return {
        ok: true,
        value: await runtime.candidates.prepareSubmission({
          subject: subject(draft.value),
          candidateId: input.candidateId
        })
      };
    });
  }

  submit(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.submitResponse(request);
      if (!input.confirmed) {
        return failure('explicit_confirmation_required', 'Explicit confirmation is required');
      }
      const runtime = await this.requireRuntime();
      const draft = await this.requireDraft(
        runtime,
        input.responseDraftId,
        input.expectedRevision
      );
      if (!draft.ok) return draft;
      const active = await runtime.executions.listActive(draft.value.conversationId);
      if (active.length > 0) {
        return failure(
          'response_execution_in_progress',
          'The conversation already has an active response execution'
        );
      }
      const blocked = await this.responseStartBlock(runtime, draft.value.conversationId, draft.value.userMessageId);
      if (blocked && !blocked.ok) return blocked;
      const confirmation = {
        schemaVersion: 1 as const,
        confirmationId: input.confirmationId,
        confirmed: true as const
      };
      await runtime.candidates.validatePreparedSubmission({
        subject: subject(draft.value),
        routeSelectionToken: input.routeSelectionToken,
        confirmation
      });
      if (!runtime.submit) {
        return failure(
          'runtime_not_allowed',
          'Conversation provider runtime access is not approved'
        );
      }
      return {
        ok: true,
        value: toResponseExecutionDto(await runtime.submit({
          subject: subject(draft.value),
          routeSelectionToken: input.routeSelectionToken,
          confirmation
        }))
      };
    });
  }

  start(request: unknown): Promise<ChatContextIpcResult<ConversationResponseStartDto>> {
    return this.execute(async () => {
      const result = await this.startCommand(request);
      if (result.ok && !('execution' in result.value)) return failure('invalid_request', 'Waiting responses must use the Agent entry');
      return result as ChatContextIpcResult<ConversationResponseStartDto>;
    });
  }

  private startCommand(request: unknown): Promise<ChatContextIpcResult<ConversationAgentResponseStartDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.startResponse(request);
      const runtime = await this.requireRuntime({ waitForReady: false });
      const commandKey = `${runtime.conversations.projectId}:${input.clientCommandId}`;
      const existing = this.startCommands.get(commandKey);
      if (existing) return existing;
      if (this.startAbortControllers.size >= 256) return failure('invalid_request', 'Too many response starts are pending');
      if (this.startCommands.size >= 256) {
        const oldest = [...this.startCommands.keys()].find(key => !this.startAbortControllers.has(key));
        if (oldest) this.startCommands.delete(oldest);
      }
      const controller = new AbortController();
      this.startAbortControllers.set(commandKey, controller);
      const operation = (async () => {
        await waitForResponseStart(() => runtime.ready, controller.signal, () => this.assertStartScope(runtime, controller.signal));
        return waitForResponseStart(() => this.startValidated(runtime, input, controller.signal), controller.signal,
          () => this.assertStartScope(runtime, controller.signal));
      })().finally(() => {
        if (this.startAbortControllers.get(commandKey) === controller) this.startAbortControllers.delete(commandKey);
      });
      this.startCommands.set(commandKey, operation);
      return operation;
    });
  }

  cancelResponseStart(request: unknown): Promise<ChatContextIpcResult<{ readonly cancelled: boolean }>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.cancelResponseStart(request);
      const session = this.dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      if (input.projectId !== session.projectId) return failure('project_scope_mismatch', 'The response start belongs to another project');
      const controller = this.startAbortControllers.get(`${input.projectId}:${input.clientCommandId}`);
      if (!controller) return { ok: true, value: { cancelled: false } };
      controller.abort(new ResponseStartCancelledError());
      return { ok: true, value: { cancelled: true } };
    });
  }

  /** Shutdown also owns starts that have not created an execution handle yet. */
  cancelActiveStarts(): number {
    const active = [...this.startAbortControllers.values()].filter(controller => !controller.signal.aborted);
    for (const controller of active) controller.abort(new ResponseStartCancelledError());
    return active.length;
  }

  /** Agent-native entry: semantic routing and confirmation stay with the model. */
  startAgent(request: unknown): Promise<ChatContextIpcResult<ConversationAgentResponseStartDto>> {
    return this.execute(async () => {
      const parsed = chatContextRequestParsers.startAgentResponse(request);
      return this.startCommand({ ...parsed, confirmed: true, agentNative: true });
    });
  }

  cancelAgentSession(request: unknown): Promise<ChatContextIpcResult<ConversationAgentSessionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.cancelAgentSession(request);
      const runtime = await this.requireRuntime();
      if (input.projectId !== runtime.conversations.projectId) return failure('project_scope_mismatch', 'The task belongs to another project');
      if (!runtime.continuations) return failure('continuation_not_available', 'The task cannot be continued in this runtime');
      return { ok: true, value: await runtime.continuations.cancel(input) };
    });
  }

  getExecution(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseExecution(request);
      const runtime = await this.requireRuntime();
      await runtime.refreshRecovery?.({ responseExecutionId: input.responseExecutionId });
      return {
        ok: true,
        value: await this.executionDto(runtime, await runtime.executions.readModel(
          toConversationResponseExecutionId(input.responseExecutionId)
        ))
      };
    });
  }

  replayEvents(
    request: unknown
  ): Promise<ChatContextIpcResult<readonly ConversationResponseStreamEventDto[]>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.replayResponseEvents(request);
      const runtime = await this.requireRuntime();
      return {
        ok: true,
        value: await runtime.executions.replayControlledEvents(
          toConversationResponseExecutionId(input.responseExecutionId),
          input.afterSequence
        )
      };
    });
  }

  cancelExecution(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseExecution(request);
      const runtime = await this.requireRuntime();
      await runtime.refreshRecovery?.({ responseExecutionId: input.responseExecutionId });
      const executionId = toConversationResponseExecutionId(input.responseExecutionId);
      const interruptOnTimeout = () => runtime.executions
        .interrupt(executionId, 'transport_interrupted')
        .then(() => undefined);
      if (runtime.executionCoordinator.has(executionId)) {
        const accepted = await runtime.executionCoordinator.cancel(
          executionId,
          interruptOnTimeout
        );
        const updated = await runtime.executions.readModel(executionId);
        if (!accepted && isActiveExecutionState(updated.state)) {
          return failure(
            'response_execution_not_active',
            'The response execution has no active provider operation'
          );
        }
        return { ok: true, value: toResponseExecutionDto(updated) };
      }
      const current = await runtime.executions.readModel(executionId);
      if (current.projectId !== runtime.conversations.projectId) {
        return failure('response_execution_not_found', 'The response execution does not exist');
      }
      if (!isActiveExecutionState(current.state)) {
        return { ok: true, value: toResponseExecutionDto(current) };
      }
      const accepted = await runtime.executionCoordinator.cancel(
        executionId,
        interruptOnTimeout
      );
      const updated = await runtime.executions.readModel(executionId);
      if (!accepted && isActiveExecutionState(updated.state)) {
        return failure(
          'response_execution_not_active',
          'The response execution has no active provider operation'
        );
      }
      return { ok: true, value: toResponseExecutionDto(updated) };
    });
  }

  subscribeEvents(
    request: unknown,
    subscriberId: string,
    onEvent: (event: ConversationResponseStreamEventDto) => void,
    onDisconnect: () => void
  ): Promise<ChatContextIpcResult<true>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseExecution(request);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(subscriberId)) {
        return failure('invalid_request', 'Response event subscription is invalid');
      }
      const runtime = await this.requireRuntime();
      const execution = await runtime.executions.readModel(
        toConversationResponseExecutionId(input.responseExecutionId)
      );
      const conversation = await runtime.conversations.get(toConversationId(execution.conversationId));
      if (!conversation || conversation.projectId !== runtime.conversations.projectId) {
        return failure('response_execution_not_found', 'The response execution does not exist');
      }
      runtime.streamChannel.subscribe({
        subscriberId,
        executionId: toConversationResponseExecutionId(input.responseExecutionId),
        onEvent,
        onDisconnect: () => onDisconnect()
      });
      return { ok: true, value: true };
    });
  }

  acknowledgeEvents(subscriberId: string, sequence: number): void {
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(subscriberId)) {
      void this.requireRuntime().then((runtime) => {
        runtime.streamChannel.acknowledge(subscriberId, sequence);
      }).catch((error) => this.dependencies.onError?.(error));
    }
  }

  unsubscribeEvents(subscriberId: string): void {
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(subscriberId)) {
      void this.requireRuntime().then((runtime) => {
        runtime.streamChannel.disconnect(subscriberId);
      }).catch((error) => this.dependencies.onError?.(error));
    }
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private async startValidated(
    runtime: ConversationResponseControllerRuntime,
    input: StartResponseRequest,
    signal: AbortSignal
  ): Promise<ChatContextIpcResult<ConversationAgentResponseStartDto>> {
    const step = <T>(operation: () => Promise<T>) => waitForResponseStart(operation, signal,
      () => this.assertStartScope(runtime, signal));
    if (!input.confirmed) {
      return failure('explicit_confirmation_required', 'Explicit confirmation is required');
    }
    if (!runtime.start) {
      return failure(
        'runtime_not_allowed',
        'Conversation provider runtime access is not approved'
      );
    }
    const startResponse = runtime.start.bind(runtime);
    let workflow = input.workflow
      ? await step(() => this.requireReadyWorkflow(runtime, input))
      : undefined;
    const attachmentFileIds = input.attachmentFileIds ?? [];
    if (attachmentFileIds.length && !runtime.attachments) {
      throw new ConversationAttachmentError('attachment_unavailable', '附件读取服务尚未配置。');
    }
    const attachments = input.attachmentFileIds !== undefined
      ? attachmentFileIds.length ? await step(() => runtime.attachments!.pin(attachmentFileIds)) : []
      : undefined;
    let conversation = input.conversation
      ? await step(() => runtime.conversationService.get(
          toConversationId(input.conversation!.conversationId)
        ))
      : await step(() => runtime.conversationService.create({
          title: input.title,
          projectId: runtime.conversations.projectId
        }));
    if (input.agentNative && runtime.continuations?.validate) {
      const replay = await step(() => runtime.continuations!.validate!({ conversation, input, signal }));
      if (replay) return { ok: true, value: replay };
    }
    if (input.conversation) {
      const active = await step(() => runtime.executions.listActive(input.conversation!.conversationId));
      if (active.length > 0) return failure('response_execution_in_progress', 'The conversation already has an active response execution');
    }
    const blocked = await step(() => this.responseStartBlock(runtime, conversation.id, input.conversation?.editedMessageId));
    if (blocked) return blocked;
    if (workflow) {
      if (
        !input.conversation ||
        conversation.revision !== input.conversation.expectedRevision
      ) {
        return failure(
          'revision_conflict',
          'Conversation revision has changed',
          conversation.revision
        );
      }
      if (attachments && attachments.some((attachment) =>
        !conversationAttachmentBatch(conversation).some((pinned) =>
          pinned.fileReferenceId === attachment.fileReferenceId && pinned.checksumSha256 === attachment.checksumSha256))) {
        throw new ConversationAttachmentError('attachment_changed', '新增附件须先绑定到当前需求，请补充资料后再执行。');
      }
    } else if (input.conversation) {
      conversation = input.conversation.editedMessageId
        ? await step(() => runtime.conversationService.editCancelledUserMessage({
            conversationId: conversation.id,
            expectedRevision: input.conversation!.expectedRevision,
            messageId: toMessageId(input.conversation!.editedMessageId!),
            content: input.content,
            ...(attachments ? { attachments } : {}),
            ...(input.displayContent !== undefined
              ? { displayContent: input.displayContent }
              : {})
          }))
        : await step(() => runtime.conversationService.addUserMessage({
            conversationId: conversation.id,
            expectedRevision: input.conversation!.expectedRevision,
            content: input.content,
            ...(attachments ? { attachments } : {}),
            ...(input.displayContent !== undefined
              ? { displayContent: input.displayContent }
              : {})
          }));
    } else {
      conversation = await step(() => runtime.conversationService.addUserMessage({
        conversationId: conversation.id,
        expectedRevision: conversation.revision,
        content: input.content,
        ...(attachments ? { attachments } : {}),
        ...(input.displayContent !== undefined
          ? { displayContent: input.displayContent }
          : {})
      }));
    }
    const userMessage = workflow
      ? conversation.messages.find((message) => message.id === workflow!.sourceMessageId)
      : input.conversation?.editedMessageId
      ? conversation.messages.find(
          (message) => message.id === toMessageId(input.conversation!.editedMessageId!)
        )
      : [...conversation.messages].reverse().find((message) => message.role === 'user');
    if (!userMessage || userMessage.role !== 'user' || userMessage.state !== 'completed') {
      return failure('message_not_completed', 'The selected user message is not complete');
    }
    const session = this.dependencies.getSession();
    if (!session || session.projectId !== runtime.conversations.projectId) {
      return failure('project_not_open', 'The source project is no longer active');
    }
    let agentRun: ReturnType<typeof createConversationAgentRun> | undefined;
    let agentSession: ConversationAgentSessionDto | undefined;
    let parentRunId: string | undefined;
    let reservedRunId: string | undefined;
    let removeStartedCancellation: (() => void) | undefined;
    return withProductionTrace({ rootDirectory: session.rootDirectory, projectId: session.projectId,
      conversationId: conversation.id, sourceMessageId: userMessage.id, traceId: userMessage.id,
      clientCommandId: input.clientCommandId }, async () => {
    try {
    if (input.agentNative && runtime.continuations) {
      const preparedSession = await step(() => runtime.continuations!.prepare({
        conversation, userMessageId: userMessage.id, input, signal
      }));
      agentSession = preparedSession.agentSession;
      parentRunId = preparedSession.parentRunId;
      reservedRunId = preparedSession.reservedRunId;
      workflow = preparedSession.workflow;
      if (preparedSession.waiting) {
        return { ok: true, value: {
          conversation: { ...toConversationDto(await runtime.conversationService.get(conversation.id)), agentSessions: [agentSession] },
          agentSession, waiting: true
        } };
      }
    } else if (input.continuation) {
      return failure('continuation_not_available', 'The task continuation service is unavailable');
    }
    // Fail locally before candidate authorization or provider dispatch. Factory
    // revalidates the pinned hashes immediately before forming provider messages.
    const attachmentQuery = conversationAttachmentQuery(workflow?.plan, userMessage);
    // Agent-native requests must reach the model before any query-shaped
    // document selection. The Agent chooses whether to read or mutate after
    // seeing the available tools and conversation context.
    const isPageQuestion = input.agentNative ? false : workflow ? workflow.plan.kind === 'chat'
      : userMessage.displayContent === undefined || userMessage.displayContent === userMessage.content;
    const documentPageQuery = isPageQuestion ? attachmentQuery : undefined;
    let toolSelection: ConversationDocumentToolSelection | undefined = documentPageQuery && runtime.documentTools ? await step(() => runtime.documentTools!.select({
      conversation, currentUserMessageId: userMessage.id, query: documentPageQuery
    })) : undefined;
    const pageReferences = documentPageQuery && !toolSelection && runtime.documentPages ? await step(() => runtime.documentPages!.resolve({
      conversation, currentUserMessageId: userMessage.id, query: documentPageQuery
    })) ?? [] : [];
    if (!input.agentNative && !pageReferences.length && !toolSelection && runtime.attachments) await step(() => runtime.attachments!.resolve({
      conversation,
      currentUserMessageId: userMessage.id,
      query: attachmentQuery
    }));
    const imageQuery = isPageQuestion && !toolSelection && !pageReferences.length && !declinesConversationImageInput(attachmentQuery) && (isConversationImageRequest(attachmentQuery) || conversationAttachmentBatch(conversation).some(item => isImageAttachment(item.fileName ?? ''))) ? attachmentQuery : undefined;
    const lastUserText = [...conversation.messages].reverse().find(m => m.role === 'user')?.content ?? '';
    const declinedSearch = declinesWebResearch(lastUserText);
    if (workflow && (declinedSearch || workflow.plan.sourcePolicy === 'internal')) {
      if (runtime.nativeSearch) await step(() => runtime.nativeSearch!.revoke(conversation.id));
    }
    const localSources = Boolean(workflow?.plan.sourcePolicy === 'mixed' && runtime.nativeSearch &&
      await step(() => runtime.nativeSearch!.preferLocal(conversation, workflow!)));
    const prepareNativeSearch = Boolean(workflow && !toolSelection && runtime.nativeSearch && !declinedSearch && !localSources &&
      (['web', 'mixed'].includes(workflow.plan.sourcePolicy) || await step(() => runtime.nativeSearch!.allowsConversation(conversation.id))));
    if (workflow?.plan.kind === 'document' && !prepareNativeSearch) {
      // Persist source disclosure before pinning the conversation revision for
      // execution. This local reply is excluded from the model's history.
      conversation = await step(() => runtime.conversationService.ensureLocalReply(conversation.id,
        `sources-${workflow!.id}-${workflow!.revision}`,
        localSources
          ? '已检索到本地资料，本次优先使用本地资料制作，不联网搜索；最新公开信息未联网核实。'
          : '本次制作不联网搜索，将依据当前需求、可用资料和模型已有知识生成内容；最新数据、政策等信息未联网核实。'));
    }
    let draft = createConversationResponseDraft({
      id: toConversationResponseDraftId(this.dependencies.nextResponseDraftId()),
      projectId: runtime.conversations.projectId,
      conversationId: conversation.id,
      conversationRevision: conversation.revision,
      userMessageId: userMessage.id,
      userMessageRevision: userMessage.revision,
      ...(input.agentNative ? { agentNative: true } : {}),
      ...(workflow
        ? {
            promptContent: workflow.plan.kind === 'document'
              ? buildDocumentGenerationPrompt(input.content, workflow.plan)
              : input.content
          }
        : {}),
      attachmentQuery,
      ...(imageQuery ? { imageQuery } : {}),
      ...(pageReferences.length ? { documentPageQuery } : {}),
      productFeature: input.productFeature,
      createdAt: toIsoTimestamp(this.now())
    });
    await step(() => runtime.drafts.create(draft));
    if (Object.keys(input.parameterValues).length > 0) {
      const parameterized = replaceConversationResponseParameterValues(
        draft,
        input.parameterValues as Readonly<Record<string, ParameterValue>>,
        toIsoTimestamp(this.now())
      );
      await step(() => runtime.drafts.save(parameterized, draft.revision));
      draft = parameterized;
    }
    if (input.contextSelections.length > 0) {
      const selections = [];
      for (const item of input.contextSelections) {
        const context = await step(() => runtime.contexts.get(toProjectContextId(item.contextId)));
        if (!context || context.projectId !== runtime.contexts.projectId) {
          return failure('context_not_found', 'The selected project context does not exist');
        }
        selections.push(pinProjectContextSelection(
          context,
          item.contextRevision,
          item.includeInPrompt
        ));
      }
      const contextualized = replaceConversationResponseContextSelections(
        draft,
        selections,
        toIsoTimestamp(this.now())
      );
      await step(() => runtime.drafts.save(contextualized, draft.revision));
      draft = contextualized;
    }
    if (runtime.documentTools?.prepare) {
      toolSelection = await step(() => runtime.documentTools!.prepare!({ conversation, draft, signal })) ?? toolSelection;
    }
    if (toolSelection) await step(() => runtime.documentTools!.pinDraft({ draft, selection: toolSelection!, signal }));
    if (workflow && runtime.nativeSearch && prepareNativeSearch) {
      const binding = await step(() => runtime.candidates.resolveBinding(subject(draft), input.candidateId));
      try {
        await step(() => runtime.nativeSearch!.prepare({ conversation, workflow: workflow!, draft, candidate: binding.candidate }));
      } catch (error) {
        if (error instanceof NativeSearchAuthorizationError) return failure('native_search_authorization_required', '请在对话中回应联网提示。');
        throw error;
      }
    }
    const prepared = await step(() => runtime.candidates.prepareSubmission({
      subject: subject(draft),
      candidateId: input.candidateId
    })).catch(error => {
      if (imageQuery && error instanceof FeatureSubmissionError && error.code === 'candidate_unavailable') {
        throw new ConversationAttachmentError('attachment_unsupported', '当前所选模型或通道不能接收图片，请选择支持图片输入的模型后重新发送。');
      }
      throw error;
    });
    if (input.agentNative && (!workflow || agentSession) && runtime.agentRuns) {
      agentRun = createConversationAgentRun({
        id: toConversationAgentRunId(reservedRunId ?? this.dependencies.nextAgentRunId?.() ?? `agent-run-${randomUUID()}`),
        projectId: runtime.conversations.projectId,
        conversationId: conversation.id,
        sourceMessageId: userMessage.id,
        parentRunId: parentRunId ? toConversationAgentRunId(parentRunId)
          : (await step(() => runtime.agentRuns!.list(conversation.id)))[0]?.id,
        createdAt: toIsoTimestamp(this.now())
      });
      await step(() => runtime.agentRuns!.create(agentRun!));
      if (agentSession) await step(() => runtime.continuations!.bindRun({ sessionId: agentSession!.sessionId, runId: agentRun!.id }));
    }
    await step(() => emitProductionEvent({ code: 'tool_authorization', status: 'completed',
      facts: { purpose: 'content', count: input.contextSelections.length } }));
    const pendingExecutionId = workflow
      ? `pending:${input.clientCommandId}`
      : undefined;
    const executingWorkflow = workflow && pendingExecutionId
      ? await step(() => runtime.workflowService!.beginExecution({
          workflowId: workflow!.id,
          expectedRevision: workflow!.revision,
          executionId: pendingExecutionId
        }))
      : undefined;
    let execution: ConversationResponseExecutionReadModelV1;
    try {
      execution = await step(() => {
        const pending = startResponse({
        subject: subject(draft),
        routeSelectionToken: prepared.routeSelectionToken,
        confirmation: {
          schemaVersion: 1,
          confirmationId: prepared.confirmation.confirmationId,
          confirmed: true
        },
        signal
        });
        void pending.then(late => {
          if (isActiveExecutionState(late.state)) {
            const cancelStarted = () => { void runtime.executionCoordinator.cancel(late.responseExecutionId).catch(() => undefined); };
            if (signal.aborted) cancelStarted();
            else {
              signal.addEventListener('abort', cancelStarted, { once: true });
              removeStartedCancellation = () => signal.removeEventListener('abort', cancelStarted);
            }
          }
        }, () => undefined);
        return pending;
      });
    } catch (error) {
      if (pendingExecutionId) {
        await runtime.workflowService?.finishExecution(pendingExecutionId, signal.aborted ? 'cancelled' : 'failed');
      }
      throw error;
    }
    if (agentRun && runtime.agentRuns) {
      try {
        if (agentSession) await runtime.continuations!.bindExecution({ sessionId: agentSession.sessionId, runId: agentRun.id,
          responseExecutionId: execution.responseExecutionId });
        const latestRun = await runtime.agentRuns.get(agentRun.id) ?? agentRun;
        const attached = attachConversationAgentRunExecution(
          latestRun,
          execution.responseExecutionId,
          toIsoTimestamp(this.now())
        );
        if (attached !== latestRun) await runtime.agentRuns.save(attached, latestRun.revision);
        agentRun = attached;
        execution = await runtime.executions.readModel(execution.responseExecutionId);
        if (runtime.completion && !runtime.executionCoordinator.has(toConversationResponseExecutionId(execution.responseExecutionId))) {
          const settled = await runtime.completion.settle(toConversationResponseExecutionId(execution.responseExecutionId));
          if (settled) agentRun = settled.run;
        } else if (!runtime.completion && ['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.state)) {
          const settled = transitionConversationAgentRun(
            agentRun,
            execution.state === 'completed' ? 'completed' : execution.state === 'cancelled' ? 'cancelled' : 'failed',
            toIsoTimestamp(this.now())
          );
          await runtime.agentRuns.save(settled, agentRun.revision);
          agentRun = settled;
        }
      } catch (error) {
        this.dependencies.onError?.(error);
      }
    }
    if (executingWorkflow) {
      try {
        await runtime.workflowService!.bindExecution({
          workflowId: executingWorkflow.id,
          expectedRevision: executingWorkflow.revision,
          executionId: execution.responseExecutionId
        });
        // A fast provider can finish while the workflow still has its temporary
        // execution ID. Reconcile the persisted terminal state after binding so
        // that an early observer event cannot leave the workflow executing.
        const persisted = await runtime.executions.readModel(execution.responseExecutionId);
        execution = persisted;
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(persisted.state)) {
          await runtime.workflowService!.finishExecution(
            persisted.responseExecutionId,
            persisted.state === 'completed' ? 'completed' : persisted.state === 'cancelled' ? 'cancelled' : 'failed'
          );
        }
      } catch (error) {
        // Dispatch has already happened. Return the real execution for recovery;
        // throwing a start failure here would invite a duplicate paid request.
        this.dependencies.onError?.(error);
      }
    }
    const latest = await runtime.conversationService.get(conversation.id);
    return {
      ok: true,
      value: {
        conversation: toConversationDto(latest),
        execution: await this.executionDto(runtime, execution),
        ...(agentSession ? { agentSession } : {})
      }
    };
    } catch (error) {
      if (agentSession) await runtime.continuations?.abandon?.({ sessionId: agentSession.sessionId, cancelled: signal.aborted }).catch(this.dependencies.onError);
      if (agentRun && runtime.agentRuns) {
        try {
          const latest = await runtime.agentRuns.get(agentRun.id);
          if (latest && !['completed', 'failed', 'cancelled'].includes(latest.status)) {
            const failed = transitionConversationAgentRun(latest, signal.aborted ? 'cancelled' : 'failed', toIsoTimestamp(this.now()));
            await runtime.agentRuns.save(failed, latest.revision);
          }
        } catch (runError) {
          this.dependencies.onError?.(runError);
        }
      }
      await emitProductionEvent({ code: 'task_complete', status: signal.aborted ? 'cancelled' : 'failed', facts: { purpose: 'content' } });
      throw error;
    } finally { removeStartedCancellation?.(); }
    });
  }

  private async requireReadyWorkflow(
    runtime: ConversationResponseControllerRuntime,
    input: StartResponseRequest
  ) {
    if (!input.workflow || !runtime.workflowService || !input.conversation) {
      throw new TypeError('Conversation workflow response binding is invalid');
    }
    if (input.conversation.editedMessageId !== null) {
      throw new TypeError('Conversation workflow cannot edit a cancelled message');
    }
    const workflow = await runtime.workflowService.get(
      toConversationWorkflowId(input.workflow.workflowId)
    );
    if (!workflow) {
      throw new ConversationWorkflowApplicationError(
        'workflow_not_found',
        'Conversation workflow does not exist'
      );
    }
    if (workflow.revision !== input.workflow.expectedRevision) {
      throw new ConversationWorkflowApplicationError(
        'workflow_revision_conflict',
        'Conversation workflow revision changed',
        workflow.revision
      );
    }
    if (workflow.projectId !== runtime.conversations.projectId || workflow.conversationId !== input.conversation.conversationId) {
      throw new TypeError('Conversation workflow does not belong to this response');
    }
    if (workflow.status !== 'ready') {
      throw new ConversationWorkflowApplicationError(
        workflow.status === 'needs_clarification'
          ? 'clarification_required'
          : workflow.status === 'needs_confirmation'
            ? 'confirmation_required'
            : 'workflow_not_ready',
        'Conversation workflow is not ready for this response',
        workflow.revision
      );
    }
    return workflow;
  }

  private async requireRuntime(
    options: { readonly waitForReady?: boolean } = {}
  ): Promise<ConversationResponseControllerRuntime> {
    const session = this.dependencies.getSession();
    if (!session) throw new ProjectNotOpenError();
    const runtime = this.dependencies.getRuntime(session);
    if (options.waitForReady !== false) await runtime.ready;
    return runtime;
  }

  inspectReconciliation(request: unknown): Promise<ChatContextIpcResult<ReconciliationInspectionDto>> {
    return this.inspectReconciliationCommand(request, false);
  }

  reconcileReconciliation(request: unknown): Promise<ChatContextIpcResult<ReconciliationInspectionDto>> {
    return this.inspectReconciliationCommand(request, true);
  }

  acknowledgeReconciliation(request: unknown): Promise<ChatContextIpcResult<ConversationParentRunDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.acknowledgeReconciliation(request);
      const runtime = await this.requireRuntime();
      await runtime.refreshRecovery?.({ responseExecutionId: input.responseExecutionId });
      if (input.projectId !== runtime.conversations.projectId) return failure('project_scope_mismatch', 'The reconciliation belongs to another project');
      if (!input.confirmed) return failure('explicit_confirmation_required', 'Explicit confirmation is required');
      if (!runtime.completion) return failure('runtime_not_allowed', 'Reconciliation is unavailable');
      const pin = this.reconciliationInspections.get(input.inspectToken);
      if (!pin || pin.expiresAt <= Date.now() || pin.projectId !== input.projectId || pin.responseExecutionId !== input.responseExecutionId ||
          pin.runRevision !== input.expectedRunRevision) return failure('reconciliation_snapshot_changed', 'Inspect the latest task state before closing it');
      const executionId = toConversationResponseExecutionId(input.responseExecutionId);
      const snapshot = await runtime.completion.inspect(executionId);
      if (!snapshot || snapshot.run.id !== pin.runId || snapshot.run.revision !== pin.runRevision ||
          (snapshot.intent?.revision ?? null) !== pin.intentRevision || projectConversationParentRun(snapshot).state !== 'needs_reconciliation') {
        return failure('reconciliation_snapshot_changed', 'The task changed after inspection');
      }
      this.reconciliationInspections.delete(input.inspectToken);
      try {
        const acknowledged = await runtime.completion.acknowledge(executionId, pin.runRevision, pin.intentRevision, pin.taskRevisions);
        if (!acknowledged) return failure('response_execution_not_found', 'The task does not exist');
        return { ok: true, value: projectConversationParentRun({ run: acknowledged.run, intent: acknowledged.intent, taskRevisions: pin.taskRevisions }) };
      } catch (error) {
        if (error instanceof ConversationCompletionError) return failure(error.code === 'entity_conflict' ? 'reconciliation_snapshot_changed' : 'response_reconciliation_required',
          error.code === 'entity_conflict' ? 'The task changed after inspection' : 'Local settlement still needs reconciliation');
        throw error;
      }
    });
  }

  private inspectReconciliationCommand(request: unknown, reconcile: boolean): Promise<ChatContextIpcResult<ReconciliationInspectionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseReconciliation(request);
      const runtime = await this.requireRuntime();
      await runtime.refreshRecovery?.({ responseExecutionId: input.responseExecutionId });
      if (input.projectId !== runtime.conversations.projectId) return failure('project_scope_mismatch', 'The reconciliation belongs to another project');
      if (!runtime.completion) return failure('runtime_not_allowed', 'Reconciliation is unavailable');
      const id = toConversationResponseExecutionId(input.responseExecutionId);
      if (reconcile) await runtime.completion.reconcile(id);
      const snapshot = await runtime.completion.inspect(id);
      if (!snapshot) return failure('response_execution_not_found', 'The task does not exist');
      const parentRun = projectConversationParentRun(snapshot);
      if (parentRun.state !== 'needs_reconciliation') return { ok: true, value: { parentRun } };
      for (const [token, pin] of this.reconciliationInspections) if (pin.expiresAt <= Date.now()) this.reconciliationInspections.delete(token);
      if (this.reconciliationInspections.size >= 256) this.reconciliationInspections.delete(this.reconciliationInspections.keys().next().value!);
      const inspectToken = `inspect-${randomUUID()}`;
      const expiresAt = Date.now() + 120_000;
      this.reconciliationInspections.set(inspectToken, { projectId: input.projectId, responseExecutionId: input.responseExecutionId,
        runId: snapshot.run.id, runRevision: snapshot.run.revision, intentRevision: snapshot.intent?.revision ?? null, expiresAt,
        taskRevisions: snapshot.taskRevisions });
      return { ok: true, value: { parentRun, inspectToken, expiresAt: new Date(expiresAt).toISOString() } };
    });
  }

  private assertStartScope(runtime: ConversationResponseControllerRuntime, signal: AbortSignal): void {
    if (signal.aborted) throw new ResponseStartCancelledError();
    const session = this.dependencies.getSession();
    if (!session || session.projectId !== runtime.conversations.projectId) throw new ProjectNotOpenError();
  }

  private async executionDto(runtime: ConversationResponseControllerRuntime, execution: ConversationResponseExecutionReadModelV1): Promise<ConversationResponseExecutionDto> {
    const snapshot = await runtime.completion?.inspect(toConversationResponseExecutionId(execution.responseExecutionId));
    return { ...toResponseExecutionDto(execution), ...(snapshot ? { parentRun: projectConversationParentRun(snapshot) } : {}) };
  }

  private async responseStartBlock(runtime: ConversationResponseControllerRuntime, conversationId: string, editedMessageId?: string | null): Promise<ChatContextIpcResult<ConversationResponseStartDto> | undefined> {
    if (runtime.completion) await runtime.executionCoordinator.waitForCompletedOperations(async id => {
      const execution = await runtime.executions.readModel(id);
      return execution.conversationId === conversationId && ['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.state);
    });
    if (runtime.completion && !await runtime.completion.canStartNewResponse(toConversationId(conversationId))) {
      return failure('response_reconciliation_required', 'The previous task must finish local settlement or be inspected before starting a new response');
    }
    if (editedMessageId && runtime.agentRuns && (await runtime.agentRuns.list(toConversationId(conversationId)))
      .some(run => run.sourceMessageId === editedMessageId && run.reconciliationReason !== undefined)) {
      return failure('response_reconciliation_required', 'An unknown original request must not be edited and replayed');
    }
    return undefined;
  }

  private async requireDraft(
    runtime: ConversationResponseControllerRuntime,
    responseDraftId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationResponseDraftV1>> {
    const draft = await runtime.drafts.get(toConversationResponseDraftId(responseDraftId));
    if (!draft || draft.projectId !== runtime.drafts.projectId) {
      return failure('response_draft_not_found', 'The response draft does not exist');
    }
    if (draft.revision !== expectedRevision) {
      return failure('revision_conflict', 'Response draft revision has changed', draft.revision);
    }
    return { ok: true, value: draft };
  }

  private async execute<T>(
    operation: () => Promise<ChatContextIpcResult<T>>
  ): Promise<ChatContextIpcResult<T>> {
    const current = (async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ConversationCompletionError) return failure<T>(error.code === 'entity_conflict'
          ? 'reconciliation_snapshot_changed' : 'response_reconciliation_required', 'Execution settlement requires local reconciliation');
        if (error instanceof ResponseStartCancelledError) return failure<T>('response_start_cancelled', 'Response preparation was stopped; existing execution facts are retained');
        if (error instanceof ExecutionBudgetError) return failure<T>(error.code === 'cancelled' ? 'response_start_cancelled'
          : error.code === 'timeout' ? 'response_execution_timeout' : 'response_execution_stopped',
          '执行已停止，请查看执行记录；输入和已有作品保留。');
        if (error instanceof ProjectNotOpenError) {
          return failure<T>('project_not_open', 'A project must be open');
        }
        return chatContextFailure<T>(error, this.dependencies.onError);
      }
    })();
    this.operations.add(current);
    void current.finally(() => this.operations.delete(current));
    return current;
  }

  private now(): string {
    return (this.dependencies.now ?? (() => new Date().toISOString()))();
  }
}

class ResponseStartCancelledError extends Error {
  constructor() {
    super('response_start_cancelled');
    this.name = 'AbortError';
  }
}

async function waitForResponseStart<T>(operation: () => Promise<T>, signal: AbortSignal, assertActive: () => void): Promise<T> {
  assertActive();
  let stop!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new ResponseStartCancelledError());
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    if (signal.aborted) throw new ResponseStartCancelledError();
    const pending = Promise.resolve().then(() => { assertActive(); return operation(); });
    void pending.catch(() => undefined);
    const result = await Promise.race([pending, stopped]);
    assertActive();
    return result;
  } finally { signal.removeEventListener('abort', stop); }
}

/**
 * The semantic plan is authoritative for document generation. Keep it in the
 * provider-bound prompt as a bounded JSON contract so the content model gets
 * the extracted requirements without gaining control over execution fields.
 */
function buildDocumentGenerationPrompt(
  rawText: string,
  plan: ConversationIntentPlan
): string {
  const operation = plan.action === 'revise'
    ? 'edit'
    : plan.action === 'analyze'
      ? 'analyze'
      : 'create';
  const contract = {
    schemaVersion: 1,
    operation,
    documentKind: plan.documentKind,
    ...(plan.deliverables ? { deliverables: plan.deliverables } : {}),
    ...(plan.steps ? { steps: plan.steps } : {}),
    parameters: plan.parameters,
    sourcePolicy: plan.sourcePolicy,
    missing: plan.missing,
    ambiguities: plan.ambiguities,
    ...(plan.targetHint ? { targetHint: plan.targetHint } : {}),
    needsConfirmation: plan.needsConfirmation
  };
  const outlineKind = plan.documentKind && plan.documentKind !== 'auto'
    ? plan.documentKind
    : 'word';
  return [
    '【UniComp 受控文档生成合同】',
    '以下 JSON 由应用层生成，是本次文档生成的结构化需求；不得自行改变 operation、documentKind、目标范围、资料策略或缺失项。',
    JSON.stringify(contract),
    '【当前用户需求】',
    rawText,
    buildDocumentOutlinePrompt(outlineKind),
    '【输出要求】不要输出路径、凭证、Provider、模型选择、工具调用、权限或 JSON 之外的解释。正文内容必须服从上述合同；合同未提供的事实不得臆造。'
  ].join('\n');
}

class ProjectNotOpenError extends Error {}

export function toResponseDraftDto(
  draft: ConversationResponseDraftV1
): ConversationResponseDraftDto {
  return {
    responseDraftId: draft.id,
    revision: draft.revision,
    projectId: draft.projectId,
    conversationId: draft.conversationId,
    conversationRevision: draft.conversationRevision,
    userMessageId: draft.userMessageId,
    userMessageRevision: draft.userMessageRevision,
    productFeature: draft.productFeature,
    contextSelections: draft.contextSelections.map((selection) => ({
      contextId: selection.contextId,
      contextRevision: selection.contextRevision,
      includeInPrompt: selection.includeInPrompt
    })),
    parameterValues: { ...draft.parameterValues },
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

function subject(draft: ConversationResponseDraftV1): FeatureCandidateSubjectV1 {
  return {
    kind: 'conversation_response_draft',
    conversationId: draft.conversationId,
    conversationRevision: draft.conversationRevision,
    responseDraftId: draft.id,
    responseDraftRevision: draft.revision,
    userMessageId: draft.userMessageId
  };
}

function toResponseExecutionDto(
  execution: ConversationResponseExecutionReadModelV1
): ConversationResponseExecutionDto {
  return {
    responseExecutionId: execution.responseExecutionId,
    conversationId: execution.conversationId,
    userMessageId: execution.userMessageId,
    assistantMessageId: execution.assistantMessageId,
    productFeature: execution.productFeature,
    state: execution.state,
    streamSequence: execution.streamSequence,
    reasoningContent: execution.reasoningContent,
    content: execution.content,
    ...(execution.taskProgress?.length ? { taskProgress: execution.taskProgress } : {}),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt
  };
}

function isActiveExecutionState(state: ConversationResponseExecutionReadModelV1['state']): boolean {
  return state === 'pending' || state === 'streaming';
}
