import {
  createConversationResponseDraft,
  replaceConversationResponseContextSelections,
  replaceConversationResponseParameterValues,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationWorkflowId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextId,
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
  ConversationResponseStreamEventDto
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

export interface ConversationResponseControllerRuntime {
  readonly conversationService: ConversationApplicationService;
  readonly conversations: ProjectConversationRepository;
  readonly drafts: ConversationResponseDraftRepository;
  readonly contexts: ProjectContextRepository;
  readonly candidates: ProviderFeatureCandidateService;
  readonly executions: ConversationResponseExecutionLifecycle;
  readonly executionCoordinator: ConversationExecutionCoordinator;
  readonly streamChannel: ControlledConversationResponseStreamChannel;
  readonly workflowService?: ConversationWorkflowService;
  /** Completes startup recovery before this project accepts response operations. */
  readonly ready: Promise<void>;
  submit?(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<ConversationResponseExecutionReadModelV1>;
  start?(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<ConversationResponseExecutionReadModelV1>;
}

export interface ConversationResponseControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getRuntime(session: StorageProjectSession): ConversationResponseControllerRuntime;
  nextResponseDraftId(): string;
  now?: () => string;
  onError?(error: unknown): void;
}

export class ConversationResponseController {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly startCommands = new Map<
    string,
    Promise<ChatContextIpcResult<ConversationResponseStartDto>>
  >();

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
      const draft = createConversationResponseDraft({
        id: toConversationResponseDraftId(this.dependencies.nextResponseDraftId()),
        projectId: runtime.conversations.projectId,
        conversationId: conversation.id,
        conversationRevision: conversation.revision,
        userMessageId: message.id,
        userMessageRevision: message.revision,
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
      const runtime = await this.requireRuntime();
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
      const input = chatContextRequestParsers.startResponse(request);
      const runtime = await this.requireRuntime();
      const commandKey = `${runtime.conversations.projectId}:${input.clientCommandId}`;
      const existing = this.startCommands.get(commandKey);
      if (existing) return existing;
      if (this.startCommands.size >= 256) {
        const oldest = this.startCommands.keys().next().value as string | undefined;
        if (oldest) this.startCommands.delete(oldest);
      }
      const operation = this.startValidated(runtime, input);
      this.startCommands.set(commandKey, operation);
      return operation;
    });
  }

  getExecution(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseExecution(request);
      const runtime = await this.requireRuntime();
      return {
        ok: true,
        value: toResponseExecutionDto(await runtime.executions.readModel(
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
    input: StartResponseRequest
  ): Promise<ChatContextIpcResult<ConversationResponseStartDto>> {
    if (!input.confirmed) {
      return failure('explicit_confirmation_required', 'Explicit confirmation is required');
    }
    if (!runtime.start) {
      return failure(
        'runtime_not_allowed',
        'Conversation provider runtime access is not approved'
      );
    }
    const workflow = input.workflow
      ? await this.requireReadyWorkflow(runtime, input)
      : undefined;
    if (input.conversation) {
      const active = await runtime.executions.listActive(input.conversation.conversationId);
      if (active.length > 0) {
        return failure(
          'response_execution_in_progress',
          'The conversation already has an active response execution'
        );
      }
    }
    let conversation = input.conversation
      ? await runtime.conversationService.get(
          toConversationId(input.conversation.conversationId)
        )
      : await runtime.conversationService.create({
          title: input.title,
          projectId: runtime.conversations.projectId
        });
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
    } else if (input.conversation) {
      conversation = input.conversation.editedMessageId
        ? await runtime.conversationService.editCancelledUserMessage({
            conversationId: conversation.id,
            expectedRevision: input.conversation.expectedRevision,
            messageId: toMessageId(input.conversation.editedMessageId),
            content: input.content,
            ...(input.displayContent !== undefined
              ? { displayContent: input.displayContent }
              : {})
          })
        : await runtime.conversationService.addUserMessage({
            conversationId: conversation.id,
            expectedRevision: input.conversation.expectedRevision,
            content: input.content,
            ...(input.displayContent !== undefined
              ? { displayContent: input.displayContent }
              : {})
          });
    } else {
      conversation = await runtime.conversationService.addUserMessage({
        conversationId: conversation.id,
        expectedRevision: conversation.revision,
        content: input.content,
        ...(input.displayContent !== undefined
          ? { displayContent: input.displayContent }
          : {})
      });
    }
    const userMessage = workflow
      ? conversation.messages.find((message) => message.id === workflow.sourceMessageId)
      : input.conversation?.editedMessageId
      ? conversation.messages.find(
          (message) => message.id === toMessageId(input.conversation!.editedMessageId!)
        )
      : [...conversation.messages].reverse().find((message) => message.role === 'user');
    if (!userMessage || userMessage.role !== 'user' || userMessage.state !== 'completed') {
      return failure('message_not_completed', 'The selected user message is not complete');
    }
    let draft = createConversationResponseDraft({
      id: toConversationResponseDraftId(this.dependencies.nextResponseDraftId()),
      projectId: runtime.conversations.projectId,
      conversationId: conversation.id,
      conversationRevision: conversation.revision,
      userMessageId: userMessage.id,
      userMessageRevision: userMessage.revision,
      ...(workflow ? { promptContent: input.content } : {}),
      productFeature: input.productFeature,
      createdAt: toIsoTimestamp(this.now())
    });
    await runtime.drafts.create(draft);
    if (Object.keys(input.parameterValues).length > 0) {
      const parameterized = replaceConversationResponseParameterValues(
        draft,
        input.parameterValues as Readonly<Record<string, ParameterValue>>,
        toIsoTimestamp(this.now())
      );
      await runtime.drafts.save(parameterized, draft.revision);
      draft = parameterized;
    }
    if (input.contextSelections.length > 0) {
      const selections = [];
      for (const item of input.contextSelections) {
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
      const contextualized = replaceConversationResponseContextSelections(
        draft,
        selections,
        toIsoTimestamp(this.now())
      );
      await runtime.drafts.save(contextualized, draft.revision);
      draft = contextualized;
    }
    const prepared = await runtime.candidates.prepareSubmission({
      subject: subject(draft),
      candidateId: input.candidateId
    });
    const pendingExecutionId = workflow
      ? `pending:${input.clientCommandId}`
      : undefined;
    const executingWorkflow = workflow && pendingExecutionId
      ? await runtime.workflowService!.beginExecution({
          workflowId: workflow.id,
          expectedRevision: workflow.revision,
          executionId: pendingExecutionId
        })
      : undefined;
    let execution: ConversationResponseExecutionReadModelV1;
    try {
      execution = await runtime.start({
        subject: subject(draft),
        routeSelectionToken: prepared.routeSelectionToken,
        confirmation: {
          schemaVersion: 1,
          confirmationId: prepared.confirmation.confirmationId,
          confirmed: true
        }
      });
    } catch (error) {
      if (pendingExecutionId) {
        await runtime.workflowService?.finishExecution(pendingExecutionId, 'failed');
      }
      throw error;
    }
    if (executingWorkflow) {
      try {
        await runtime.workflowService!.bindExecution({
          workflowId: executingWorkflow.id,
          expectedRevision: executingWorkflow.revision,
          executionId: execution.responseExecutionId
        });
      } catch (error) {
        this.dependencies.onError?.(error);
      }
    }
    const latest = await runtime.conversationService.get(conversation.id);
    return {
      ok: true,
      value: {
        conversation: toConversationDto(latest),
        execution: toResponseExecutionDto(execution)
      }
    };
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

  private async requireRuntime(): Promise<ConversationResponseControllerRuntime> {
    const session = this.dependencies.getSession();
    if (!session) throw new ProjectNotOpenError();
    const runtime = this.dependencies.getRuntime(session);
    await runtime.ready;
    return runtime;
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
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt
  };
}

function isActiveExecutionState(state: ConversationResponseExecutionReadModelV1['state']): boolean {
  return state === 'pending' || state === 'streaming';
}
