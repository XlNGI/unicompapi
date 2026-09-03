import type {
  ConversationApplicationService,
  ConversationWorkflowService
} from '../../application';
import {
  toConversationId,
  toConversationWorkflowId,
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

export interface ConversationWorkflowControllerRuntime {
  readonly conversationService: ConversationApplicationService;
  readonly workflowService: ConversationWorkflowService;
}

export class ConversationWorkflowController {
  private readonly operations = new Set<Promise<unknown>>();
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
      const operation = this.startValidated(session, input);
      this.startCommands.set(key, operation);
      return operation;
    });
  }

  answer(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.answerWorkflow(request);
      const session = this.dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      const runtime = this.dependencies.getRuntime(session);
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
      if (workflow.status !== 'needs_clarification') {
        return failure('clarification_required', 'Conversation workflow is not awaiting clarification');
      }
      const conversation = await runtime.conversationService.addUserMessage({
        conversationId: workflow.conversationId,
        expectedRevision: input.expectedConversationRevision,
        content: input.content
      });
      const updated = await runtime.workflowService.answer({
        workflowId,
        expectedRevision: input.expectedWorkflowRevision,
        rawText: input.content,
        context: semanticContext(conversation)
      });
      return {
        ok: true,
        value: {
          conversation: toConversationDto(conversation),
          workflow: toWorkflowDto(updated)
        }
      };
    });
  }

  confirm(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.workflowRevision(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
      return {
        ok: true,
        value: toWorkflowDto(await runtime.value.workflowService.confirm({
          workflowId: toConversationWorkflowId(input.workflowId),
          expectedRevision: input.expectedRevision
        }))
      };
    });
  }

  cancel(request: unknown): Promise<ChatContextIpcResult<ConversationWorkflowDto>> {
    return this.execute(async () => {
      const input = chatContextRequestParsers.workflowRevision(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return runtime;
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
    input: ReturnType<typeof chatContextRequestParsers.startWorkflow>
  ): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>> {
    const runtime = this.dependencies.getRuntime(session);
    let conversation = input.conversation
      ? await runtime.conversationService.get(
          toConversationId(input.conversation.conversationId)
        )
      : await runtime.conversationService.create({
          title: input.title,
          projectId: session.projectId
        });
    conversation = await runtime.conversationService.addUserMessage({
      conversationId: conversation.id,
      expectedRevision: input.conversation?.expectedRevision ?? conversation.revision,
      content: input.content
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
      context: {
        ...semanticContext(conversation),
        ...(input.intentHint
          ? {
              requestedIntentKind: input.intentHint.kind,
              requestedDocumentKind: input.intentHint.documentKind
            }
          : {})
      }
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

function semanticContext(conversation: Awaited<ReturnType<ConversationApplicationService['get']>>) {
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
    recentUserMessages: conversation.messages
      .filter((message) => message.role === 'user' && message.state === 'completed')
      .slice(-8)
      .map((message) => message.displayContent ?? message.content)
  };
}
