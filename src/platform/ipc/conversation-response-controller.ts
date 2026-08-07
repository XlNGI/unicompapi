import {
  createConversationResponseDraft,
  replaceConversationResponseContextSelections,
  replaceConversationResponseParameterValues,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
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
import type {
  ChatContextIpcResult,
  ConversationResponseCandidateDto,
  ConversationResponseDraftDto,
  ConversationResponseExecutionDto,
  ConversationResponsePreparationDto,
  ConversationResponseStreamEventDto
} from '../../shared/chat-context-ipc';
import {
  chatContextRequestParsers
} from '../../shared/chat-context-ipc';
import type {
  ConversationResponseExecutionLifecycle,
  ProviderFeatureCandidateService
} from '../providers';
import { pinProjectContextSelection } from '../repositories';
import type { StorageProjectSession } from './storage-ipc-controller';
import { chatContextFailure, failure } from './chat-context-errors';

export interface ConversationResponseControllerRuntime {
  readonly conversations: ProjectConversationRepository;
  readonly drafts: ConversationResponseDraftRepository;
  readonly contexts: ProjectContextRepository;
  readonly candidates: ProviderFeatureCandidateService;
  readonly executions: ConversationResponseExecutionLifecycle;
  submit?(input: {
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

  constructor(private readonly dependencies: ConversationResponseControllerDependencies) {}

  createDraft(request: unknown): Promise<ChatContextIpcResult<ConversationResponseDraftDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.createResponseDraft(request);
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
      const draft = await this.requireDraft(
        runtime,
        input.responseDraftId,
        input.expectedRevision
      );
      if (!draft.ok) return draft;
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

  getExecution(
    request: unknown
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.responseExecution(request);
      const runtime = this.requireRuntime();
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
      const runtime = this.requireRuntime();
      return {
        ok: true,
        value: await runtime.executions.replayControlledEvents(
          toConversationResponseExecutionId(input.responseExecutionId),
          input.afterSequence
        )
      };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private requireRuntime(): ConversationResponseControllerRuntime {
    const session = this.dependencies.getSession();
    if (!session) throw new ProjectNotOpenError();
    return this.dependencies.getRuntime(session);
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
    content: execution.content,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt
  };
}
