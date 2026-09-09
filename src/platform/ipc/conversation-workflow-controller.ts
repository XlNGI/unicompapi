import type {
  ConversationApplicationService,
  ConversationWorkflowService
} from '../../application';
import {
  toConversationId,
  toConversationWorkflowId,
  type ConversationAttachmentReference,
  type ConversationWorkflowV1
} from '../../domain';
import {
  chatContextRequestParsers,
  type ChatContextIpcResult,
  type ConversationWorkflowDto,
  type ConversationWorkflowStartDto
} from '../../shared/chat-context-ipc';
import { toConversationDto } from './conversation-controller';
import { chatContextFailure, failure } from './chat-context-errors';
import type { StorageProjectSession } from './storage-ipc-controller';
import type { ConversationAttachmentContextService } from '../documents/conversation-attachment-context';

export interface ConversationWorkflowControllerRuntime {
  readonly ready?: Promise<void>;
  readonly conversationService: ConversationApplicationService;
  readonly workflowService: ConversationWorkflowService;
  readonly attachments?: {
    pin(fileIds: readonly string[]): Promise<readonly ConversationAttachmentReference[]>;
    prepareSummary?(input: Parameters<ConversationAttachmentContextService['prepareSummary']>[0]): Promise<void>;
  };
}

export class ConversationWorkflowController {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly planning = new Map<string, AbortController>();
  private readonly preparedPlanningWorkflows = new Map<AbortSignal, ConversationWorkflowV1>();
  private readonly startCommands = new Map<
    string,
    Promise<ChatContextIpcResult<ConversationWorkflowStartDto>>
  >();

  constructor(private readonly dependencies: {
    getSession(): StorageProjectSession | undefined;
    getRuntime(session: StorageProjectSession): ConversationWorkflowControllerRuntime;
    onError?(error: unknown): void;
  }) {}

  start(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.startWorkflow(request);
      const session = this.dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      const key = `${session.projectId}:${input.clientCommandId}`;
      const existing = this.startCommands.get(key);
      if (existing) return existing;
      if (this.startCommands.size >= 256) {
        const oldest = this.startCommands.keys().next().value as string | undefined;
        if (oldest) this.startCommands.delete(oldest);
      }
      const operation = this.withPlanning(session, input.clientCommandId,
        (signal) => this.startValidated(session, input, signal));
      this.startCommands.set(key, operation);
      return operation;
    });
  }

  answer(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.answerWorkflow(request);
      const session = this.dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      return this.withPlanning(session, input.clientCommandId ?? `answer:${input.workflowId}:${input.expectedWorkflowRevision}`, async (signal) => {
      const runtime = this.dependencies.getRuntime(session);
      await runtime.ready;
      signal.throwIfAborted();
      const workflowId = toConversationWorkflowId(input.workflowId);
      const workflow = await runtime.workflowService.get(workflowId);
      if (!workflow) return failure('invalid_request', 'Conversation workflow does not exist');
      if (workflow.revision !== input.expectedWorkflowRevision) {
        return failure(
          'workflow_revision_conflict',
          'Conversation workflow revision has changed',
          workflow.revision
        );
      }
      if (!['needs_clarification', 'needs_confirmation', 'ready'].includes(workflow.status)) {
        return failure('workflow_not_ready', 'Conversation workflow cannot accept an answer in its current state');
      }
      const attachments = input.attachmentFileIds !== undefined
        ? input.attachmentFileIds.length ? await runtime.attachments?.pin(input.attachmentFileIds) : []
        : undefined;
      if (input.attachmentFileIds?.length && !attachments) {
        return failure('invalid_request', 'Conversation attachments are unavailable');
      }
      signal.throwIfAborted();
      const conversation = await runtime.conversationService.addUserMessage({
        conversationId: workflow.conversationId,
        expectedRevision: input.expectedConversationRevision,
        content: input.content,
        ...(attachments ? { attachments } : {})
      });
      const updated = await runtime.workflowService.answer({
        workflowId,
        expectedRevision: input.expectedWorkflowRevision,
        rawText: input.content,
        signal,
        sourceMessageId: conversation.messages.at(-1)?.id,
        context: {
          ...semanticContext(conversation, workflow.sourceMessageId),
          ...(input.semanticCandidate ? { semanticCandidate: input.semanticCandidate } : {})
        }
      });
      this.preparedPlanningWorkflows.set(signal, updated);
      if (updated.status === 'ready') await runtime.attachments?.prepareSummary?.({
        conversation,
        query: conversation.messages.find((message) => message.id === updated.sourceMessageId)?.content ?? input.content,
        selection: input.semanticCandidate,
        signal
      });
      return {
        ok: true,
        value: {
          conversation: toConversationDto(conversation),
          workflow: toWorkflowDto(updated)
        }
      };
      });
    });
  }

  confirm(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.workflowRevision(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
      await runtime.value.ready;
      return {
        ok: true,
        value: toWorkflowDto(await runtime.value.workflowService.confirm({
          workflowId: toConversationWorkflowId(input.workflowId),
          expectedRevision: input.expectedRevision
        }))
      };
    });
  }

  resumeFailed(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.workflowRevision(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
      await runtime.value.ready;
      return {
        ok: true,
        value: toWorkflowDto(await runtime.value.workflowService.resumeFailedDelivery({
          workflowId: toConversationWorkflowId(input.workflowId),
          expectedRevision: input.expectedRevision
        }))
      };
    });
  }

  cancelPlanning(request: unknown): Promise<ChatContextIpcResult<{ readonly cancelled: boolean }>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.planningCommand(request);
      const session = this.dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      const controller = this.planning.get(`${session.projectId}:${input.clientCommandId}`);
      controller?.abort();
      return { ok: true, value: { cancelled: Boolean(controller) } };
    });
  }

  cancelActivePlanning(): number {
    const active = [...this.planning.values()];
    for (const controller of active) controller.abort();
    return active.length;
  }

  private async withPlanning(
    session: StorageProjectSession,
    commandId: string,
    operation: (signal: AbortSignal) => Promise<ChatContextIpcResult<ConversationWorkflowStartDto>>
  ): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>> {
    const key = `${session.projectId}:${commandId}`;
    if (this.planning.has(key) || this.planning.size >= 256) {
      return failure('workflow_not_ready', '需求正在处理中，请勿重复发送。');
    }
    const controller = new AbortController();
    this.planning.set(key, controller);
    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted) {
        // A cancellation racing the final save must not leave an executable plan.
        if (result.ok && !['cancelled', 'completed', 'failed'].includes(result.value.workflow.status)) {
          await this.dependencies.getRuntime(session).workflowService.cancel({
            workflowId: toConversationWorkflowId(result.value.workflow.workflowId),
            expectedRevision: result.value.workflow.revision
          });
        }
        return failure('planning_cancelled', '需求理解已停止，未开始后续执行。');
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        const prepared = this.preparedPlanningWorkflows.get(controller.signal);
        if (prepared && ['needs_clarification', 'needs_confirmation', 'ready'].includes(prepared.status)) {
          await this.dependencies.getRuntime(session).workflowService.cancel({ workflowId: prepared.id, expectedRevision: prepared.revision });
        }
        return failure('planning_cancelled', '需求理解已停止，未开始后续执行。');
      }
      throw error;
    } finally {
      this.planning.delete(key);
      this.preparedPlanningWorkflows.delete(controller.signal);
    }
  }

  cancel(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.workflowRevision(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
      await runtime.value.ready;
      return {
        ok: true,
        value: toWorkflowDto(await runtime.value.workflowService.cancel({
          workflowId: toConversationWorkflowId(input.workflowId),
          expectedRevision: input.expectedRevision
        }))
      };
    });
  }

  get(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.workflowId(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
      await runtime.value.ready;
      const workflow = await runtime.value.workflowService.get(
        toConversationWorkflowId(input.workflowId)
      );
      return workflow
        ? { ok: true, value: toWorkflowDto(workflow) }
        : failure('workflow_not_found', 'Conversation workflow does not exist');
    });
  }

  getPending(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto | null>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.conversationId(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
      await runtime.value.ready;
      const workflow = await runtime.value.workflowService.getPending(
        toConversationId(input.conversationId)
      );
      return { ok: true, value: workflow ? toWorkflowDto(workflow) : null };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private async startValidated(
    session: StorageProjectSession,
    input: ReturnType<typeof chatContextRequestParsers.startWorkflow>,
    signal: AbortSignal
  ): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>> {
    const runtime = this.dependencies.getRuntime(session);
    await runtime.ready;
    signal.throwIfAborted();
    let conversation = input.conversation
      ? await runtime.conversationService.get(
          toConversationId(input.conversation.conversationId)
        )
      : await runtime.conversationService.create({
          title: input.title,
          projectId: session.projectId
        });
    const attachments = input.attachmentFileIds !== undefined
      ? input.attachmentFileIds.length ? await runtime.attachments?.pin(input.attachmentFileIds) : []
      : undefined;
    if (input.attachmentFileIds?.length && !attachments) {
      return failure('invalid_request', 'Conversation attachments are unavailable');
    }
    signal.throwIfAborted();
    conversation = await runtime.conversationService.addUserMessage({
      conversationId: conversation.id,
      expectedRevision: input.conversation?.expectedRevision ?? conversation.revision,
      content: input.content,
      ...(attachments ? { attachments } : {})
    });
    const source = conversation.messages.at(-1);
    if (!source || source.role !== 'user') {
      return failure('message_not_completed', 'The workflow source message is unavailable');
    }
    const workflow = await runtime.workflowService.create({
      projectId: session.projectId,
      conversationId: conversation.id,
      sourceMessageId: source.id,
      rawText: input.content,
      signal,
      context: {
        ...semanticContext(conversation),
        ...(input.semanticCandidate ? { semanticCandidate: input.semanticCandidate } : {}),
        ...(input.intentHint
          ? {
              requestedIntentKind: input.intentHint.kind,
              requestedDocumentKind: input.intentHint.documentKind
            }
          : {})
      }
    });
    this.preparedPlanningWorkflows.set(signal, workflow);
    if (workflow.status === 'ready') await runtime.attachments?.prepareSummary?.({
      conversation, query: input.content, selection: input.semanticCandidate, signal
    });
    return {
      ok: true,
      value: {
        conversation: toConversationDto(conversation),
        workflow: toWorkflowDto(workflow)
      }
    };
  }

  private requireRuntime():
    | { readonly ok: true; readonly value: ConversationWorkflowControllerRuntime }
    | { readonly ok: false; readonly error: { readonly code: 'project_not_open'; readonly message: string } } {
    const session = this.dependencies.getSession();
    return session
      ? { ok: true, value: this.dependencies.getRuntime(session) }
      : { ok: false, error: { code: 'project_not_open', message: 'A project must be open' } };
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
    void current.finally(() => this.operations.delete(current));
    return current;
  }
}

export function toWorkflowDto(workflow: ConversationWorkflowV1): ConversationWorkflowDto {
  return {
    workflowId: workflow.id,
    projectId: workflow.projectId,
    conversationId: workflow.conversationId,
    sourceMessageId: workflow.sourceMessageId,
    revision: workflow.revision,
    status: workflow.status,
    plan: workflow.plan,
    ...(workflow.deliveries ? { deliveries: workflow.deliveries } : {}),
    pendingQuestions: workflow.pendingQuestions,
    ...(workflow.resolvedTarget ? { resolvedTarget: workflow.resolvedTarget } : {}),
    ...(workflow.confirmationId ? { confirmationId: workflow.confirmationId } : {}),
    ...(workflow.planHash ? { planHash: workflow.planHash } : {}),
    ...(workflow.confirmationExpiresAt
      ? { confirmationExpiresAt: workflow.confirmationExpiresAt }
      : {}),
    ...(workflow.executionId ? { executionId: workflow.executionId } : {}),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  };
}

function semanticContext(
  conversation: Awaited<ReturnType<ConversationApplicationService['get']>>,
  workflowSourceMessageId?: string
) {
  const sourceIndex = workflowSourceMessageId === undefined
    ? 0
    : conversation.messages.findIndex((message) => message.id === workflowSourceMessageId);
  const workflowMessages = sourceIndex >= 0
    ? conversation.messages.slice(sourceIndex)
    : conversation.messages;
  return {
    documents: conversation.messages.flatMap((message) =>
      message.role === 'assistant' && message.state === 'completed' && message.documentResult
        ? [{
            messageId: message.id,
            kind: message.documentResult.kind,
            fileName: message.documentResult.fileName
          }]
        : []
    ),
    recentUserMessages: workflowMessages
      .filter((message) => message.role === 'user' && message.state === 'completed')
      .slice(-8)
      .map((message) => message.displayContent ?? message.content)
  };
}
