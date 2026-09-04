import {
  ConversationWebResearchError,
  type ConversationApplicationService,
  type ConversationWebResearchService,
  type ConversationWebLocalRetrievalPort
} from '../../application';
import {
  toConversationId,
  toConversationWorkflowId,
  type ConversationWorkflowV1
} from '../../domain';
import {
  webResearchRequestParsers,
  type WebResearchApi,
  type WebResearchIpcErrorCode,
  type WebResearchIpcResult,
  type WebResearchSessionDto
} from '../../shared/web-research-ipc';
import type { RagRetrievalService } from '../search';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ConversationWebResearchControllerRuntime {
  readonly conversationService: ConversationApplicationService;
  readonly workflowService: {
    get(id: ReturnType<typeof toConversationWorkflowId>): Promise<ConversationWorkflowV1 | undefined>;
  };
  readonly research: ConversationWebResearchService;
  readonly local: RagRetrievalService;
}

export class ConversationWebResearchController implements WebResearchApi {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly dependencies: {
    getSession(): StorageProjectSession | undefined;
    getRuntime(session: StorageProjectSession): ConversationWebResearchControllerRuntime;
    onError?(error: unknown): void;
  }) {}

  preview(request: unknown): Promise<WebResearchIpcResult<WebResearchSessionDto>> {
    return this.execute(async () => {
      const input = webResearchRequestParsers.preview(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return failure('project_not_open', runtime.error.message);
      const workflow = await this.requireWorkflow(runtime.value, input.workflowId);
      if (!workflow) return failure('workflow_not_found', 'Conversation workflow does not exist');
      if (workflow.revision !== input.expectedWorkflowRevision) {
        return failure('workflow_revision_conflict', 'Conversation workflow revision has changed', workflow.revision);
      }
      const conversation = await runtime.value.conversationService.get(
        toConversationId(workflow.conversationId)
      );
      if (!conversation) return failure('conversation_not_found', 'Conversation does not exist');
      if (conversation.revision !== input.expectedConversationRevision) {
        return failure('revision_conflict', 'Conversation revision has changed', conversation.revision);
      }
      const source = conversation.messages.find((message) => message.id === workflow.sourceMessageId);
      if (!source || source.role !== 'user' || source.state !== 'completed') {
        return failure('workflow_not_ready', 'Conversation workflow source message is unavailable');
      }
      const session = await runtime.value.research.preview({
        workflow,
        conversationRevision: conversation.revision,
        query: source.displayContent ?? source.content,
        local: runtime.value.local as ConversationWebLocalRetrievalPort
      });
      return { ok: true, value: toSessionDto(session) };
    });
  }

  authorize(request: unknown): Promise<WebResearchIpcResult<WebResearchSessionDto>> {
    return this.execute(async () => {
      const input = webResearchRequestParsers.authorize(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return failure('project_not_open', runtime.error.message);
      const workflow = await this.requireWorkflow(runtime.value, input.workflowId);
      if (!workflow) return failure('workflow_not_found', 'Conversation workflow does not exist');
      if (workflow.revision !== input.expectedWorkflowRevision) {
        return failure('workflow_revision_conflict', 'Conversation workflow revision has changed', workflow.revision);
      }
      const conversation = await runtime.value.conversationService.get(
        toConversationId(workflow.conversationId)
      );
      if (!conversation) return failure('conversation_not_found', 'Conversation does not exist');
      if (conversation.revision !== input.expectedConversationRevision) {
        return failure('revision_conflict', 'Conversation revision has changed', conversation.revision);
      }
      const session = await runtime.value.research.authorize({
        workflow,
        conversationRevision: conversation.revision,
        planHash: input.planHash,
        confirmed: true
      });
      return { ok: true, value: toSessionDto(session) };
    });
  }

  cancel(request: unknown): Promise<WebResearchIpcResult<WebResearchSessionDto>> {
    return this.execute(async () => {
      const input = webResearchRequestParsers.cancel(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return failure('project_not_open', runtime.error.message);
      const workflow = await this.requireWorkflow(runtime.value, input.workflowId);
      if (!workflow) return failure('workflow_not_found', 'Conversation workflow does not exist');
      if (workflow.revision !== input.expectedWorkflowRevision) {
        return failure('workflow_revision_conflict', 'Conversation workflow revision has changed', workflow.revision);
      }
      return {
        ok: true,
        value: toSessionDto(runtime.value.research.cancel({
          projectId: workflow.projectId,
          workflowId: workflow.id,
          workflowRevision: workflow.revision
        }))
      };
    });
  }

  getStatus(request: unknown): Promise<WebResearchIpcResult<WebResearchSessionDto | null>> {
    return this.execute(async () => {
      const input = webResearchRequestParsers.status(request);
      const runtime = this.requireRuntime();
      if (!runtime.ok) return failure('project_not_open', runtime.error.message);
      const workflow = await requireWorkflow(runtime.value, input.workflowId);
      if (!workflow) return { ok: true, value: null };
      const session = runtime.value.research.getStatus(workflow.projectId, workflow.id);
      return { ok: true, value: session ? toSessionDto(session) : null };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private requireRuntime():
    | { readonly ok: true; readonly value: ConversationWebResearchControllerRuntime }
    | { readonly ok: false; readonly error: { readonly code: 'project_not_open'; readonly message: string } } {
    const session = this.dependencies.getSession();
    return session
      ? { ok: true, value: this.dependencies.getRuntime(session) }
      : { ok: false, error: { code: 'project_not_open', message: 'A project must be open' } };
  }

  private async requireWorkflow(
    runtime: ConversationWebResearchControllerRuntime,
    workflowId: string
  ): Promise<ConversationWorkflowV1 | undefined> {
    return runtime.workflowService.get(toConversationWorkflowId(workflowId));
  }

  private async execute<T>(operation: () => Promise<WebResearchIpcResult<T>>): Promise<WebResearchIpcResult<T>> {
    const current: Promise<WebResearchIpcResult<T>> = (async () => {
      try {
        return await operation();
      } catch (error) {
        this.dependencies.onError?.(error);
        if (error instanceof ConversationWebResearchError) {
          return failure<T>(mapResearchError(error.code), '联网检索未完成');
        }
        if (error instanceof TypeError) return failure<T>('invalid_request', 'The request is invalid');
        return failure<T>('storage_error', 'The operation could not be completed');
      }
    })();
    this.operations.add(current);
    void current.finally(() => this.operations.delete(current));
    return current;
  }
}

function toSessionDto(session: Awaited<ReturnType<ConversationWebResearchService['preview']>>): WebResearchSessionDto {
  return {
    workflowId: session.workflowId,
    workflowRevision: session.workflowRevision,
    conversationRevision: session.conversationRevision,
    planHash: session.planHash,
    status: session.status,
    references: session.references,
    ...(session.authorization ? { authorization: session.authorization } : {}),
    ...(session.failureCode ? { failureCode: mapResearchError(session.failureCode) } : {}),
    updatedAt: session.updatedAt
  };
}

function mapResearchError(
  code: string
): NonNullable<WebResearchSessionDto['failureCode']> {
  const known: readonly NonNullable<WebResearchSessionDto['failureCode']>[] = [
    'web_authorization_required',
    'web_authorization_expired',
    'web_authorization_mismatch',
    'web_domain_not_allowed',
    'web_query_not_allowed',
    'web_provider_unconfigured',
    'web_credential_unavailable',
    'web_authentication_failed',
    'web_rate_limited',
    'web_timeout',
    'web_cancelled',
    'web_network_error',
    'web_response_invalid',
    'web_response_too_large',
    'web_no_results',
    'source_required_unavailable'
  ];
  return known.includes(code as NonNullable<WebResearchSessionDto['failureCode']>)
    ? code as NonNullable<WebResearchSessionDto['failureCode']>
    : 'web_network_error';
}

function failure<T>(
  code: WebResearchIpcErrorCode,
  message: string,
  currentRevision?: number
): WebResearchIpcResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(currentRevision === undefined ? {} : { currentRevision })
    }
  };
}

async function requireWorkflow(
  runtime: ConversationWebResearchControllerRuntime,
  workflowId: string
): Promise<ConversationWorkflowV1 | undefined> {
  return runtime.workflowService.get(toConversationWorkflowId(workflowId));
}
