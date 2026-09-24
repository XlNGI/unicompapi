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
import { conversationAttachmentQuery } from '../../application/conversation-attachment-query';
import { ConversationRevisionConflictError } from '../repositories/json-conversation-repository';
import { emitProductionEvent, withProductionTrace } from '../conversation-production-trace';

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
      if (!input.semanticCandidate) return failure('model_selection_required', '本次请求尚未发出，请先选择一个可用模型。');
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
      if (!input.semanticCandidate) return failure('model_selection_required', '本次请求尚未发出，请先选择一个可用模型。');
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
      if (workflow.status === 'needs_confirmation' && /^(?:确认执行|确认并继续|同意执行|继续)[。！!\s]*$/u.test(input.content.trim())) {
        if (input.attachmentFileIds?.length) {
          return failure('confirmation_required', '本次新增了附件，请先说明它们的使用范围，再确认更新后的任务。');
        }
        const snapshot = await runtime.conversationService.get(workflow.conversationId);
        const question = snapshot.messages.at(-1)?.workflowReply;
        if (question?.workflowId !== workflow.id || question.revision !== workflow.revision) {
          return failure('confirmation_required', '请先查看当前任务的确认回复，再确认执行。');
        }
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
      const sourceMessageId = conversation.messages.at(-1)!.id;
      return withProductionTrace({ rootDirectory: session.rootDirectory, projectId: session.projectId,
        conversationId: conversation.id, sourceMessageId, traceId: sourceMessageId,
        ...(input.clientCommandId ? { clientCommandId: input.clientCommandId } : {}) }, async () => {
      await emitProductionEvent({ code: 'request_received', status: 'completed' });
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
      await reportWorkflowDecision(updated);
      if (updated.status === 'ready') await runtime.attachments?.prepareSummary?.({
        conversation,
        query: conversationAttachmentQuery(updated.plan,
          conversation.messages.find((message) => message.id === updated.sourceMessageId) ?? { content: input.content }),
        selection: input.semanticCandidate,
        signal
      });
      return {
        ok: true,
        value: {
          conversation: toConversationDto(await this.ensureReply(runtime, updated)),
          workflow: toWorkflowDto(updated)
        }
      };
      });
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
      if (workflow) await this.ensureReply(runtime.value, workflow);
      return { ok: true, value: workflow ? toWorkflowDto(workflow) : null };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private async ensureReply(runtime: ConversationWorkflowControllerRuntime, workflow: ConversationWorkflowV1) {
    // The durable workflow is the replay source after a crash between its save
    // and the conversation projection. Only retry this idempotent projection.
    for (let attempt = 0; ; attempt += 1) {
      const current = await runtime.workflowService.get(workflow.id);
      if (!current || current.revision !== workflow.revision || current.status !== workflow.status) {
        return runtime.conversationService.get(workflow.conversationId);
      }
      try {
        return await runtime.conversationService.ensureWorkflowReply(current);
      } catch (error) {
        if (!(error instanceof ConversationRevisionConflictError) || attempt >= 2) throw error;
      }
    }
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
    return withProductionTrace({ rootDirectory: session.rootDirectory, projectId: session.projectId,
      conversationId: conversation.id, sourceMessageId: source.id, traceId: source.id,
      clientCommandId: input.clientCommandId }, async () => {
    await emitProductionEvent({ code: 'request_received', status: 'completed' });
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
    await reportWorkflowDecision(workflow);
    if (workflow.status === 'ready') await runtime.attachments?.prepareSummary?.({
      conversation, query: conversationAttachmentQuery(workflow.plan, source), selection: input.semanticCandidate, signal
    });
    return {
      ok: true,
      value: {
        conversation: toConversationDto(await this.ensureReply(runtime, workflow)),
        workflow: toWorkflowDto(workflow)
      }
    };
    });
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

async function reportWorkflowDecision(workflow: ConversationWorkflowV1): Promise<void> {
  if (workflow.status === 'failed' || workflow.status === 'cancelled') {
    await emitProductionEvent({ code: 'plan_validation', status: workflow.status,
      facts: { purpose: 'planning' } });
    return;
  }
  await emitProductionEvent({ code: 'plan_decision', status: 'completed', facts: {
    purpose: 'planning', planKind: workflow.plan.kind,
    ...(workflow.plan.action ? { action: workflow.plan.action } : {}),
    ...(workflow.plan.documentKind && workflow.plan.documentKind !== 'auto'
      ? { documentKind: workflow.plan.documentKind } : {}),
    sourcePolicy: workflow.plan.sourcePolicy, missingCount: workflow.pendingQuestions.length,
    count: workflow.plan.steps?.length ?? 0
  } });
}

export function toWorkflowDto(workflow: ConversationWorkflowV1): ConversationWorkflowDto {
  return {
    ...(workflow.planningFailureCode ? { planningFailureCode: workflow.planningFailureCode } : {}),
    workflowId: workflow.id,
    projectId: workflow.projectId,
    conversationId: workflow.conversationId,
    sourceMessageId: workflow.sourceMessageId,
    revision: workflow.revision,
    status: workflow.status,
    plan: workflow.plan,
    ...(workflow.deliveries ? { deliveries: workflow.deliveries } : {}),
    pendingQuestions: workflow.pendingQuestions,
    ...(workflow.resolvedTarget ? { resolvedTarget: {
      artifactRef: workflow.resolvedTarget.artifactRef, version: workflow.resolvedTarget.version,
      ...(workflow.resolvedTarget.presentation ? { presentation: {
        workId: workflow.resolvedTarget.presentation.workId,
        unit: workflow.resolvedTarget.presentation.unit,
        ordinal: workflow.resolvedTarget.presentation.ordinal,
        heading: workflow.resolvedTarget.presentation.heading,
        pages: workflow.resolvedTarget.presentation.pages
      } } : {})
    } } : {}),
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
