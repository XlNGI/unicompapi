import type { ConversationNativeSearch } from './conversation-native-search';
import type { ConversationExecutionCoordinator } from './conversation-execution-coordinator';
import { randomUUID } from 'node:crypto';
import {
  beginAssistantMessage,
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toThreadId,
  type ConversationResponseDraftRepository,
  type ConversationResponseExecutionRepository,
  type MessageId,
  type ProjectContextRepository,
  type ProjectConversationRepository
} from '../../domain';
import { freezeProjectContextOutboundSnapshots } from '../repositories/project-context-snapshot';
import {
  ConversationContextBuilder,
  AgentContextAssembler,
  type ModelHistoryReader,
  type ConversationContextReference
} from '../../application';
import { DEEPSEEK_PROVIDER_PACKAGE_ID } from './deepseek/deepseek-contracts';
import {
  NEWAPI_PROVIDER_PACKAGE_ID
} from './newapi/newapi-contracts';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID, UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID } from './newapi/unicompapi-contracts';
import type { SubmissionArtifactFactoryPort } from './provider-submission-orchestrator';
import type { ItemStatus } from '../../domain';
import type { ConversationAttachmentContextService } from '../documents/conversation-attachment-context';
import { ConversationAttachmentError } from '../documents/conversation-attachment-context';
import { ConversationDocumentPageError } from '../documents/conversation-document-error';
import { buildAgentToolInstruction, buildDocumentReadToolInstruction, buildDocumentGenerationToolInstruction, buildDocumentMutationToolInstruction, type ConversationDocumentToolSessionService } from '../documents/conversation-document-tool-session';

export interface ConversationResponseArtifactFactoryDependencies {
  readonly nativeSearch?: ConversationNativeSearch;
  readonly conversations: Pick<ProjectConversationRepository, 'projectId' | 'get' | 'save'>;
  readonly drafts: ConversationResponseDraftRepository;
  readonly contexts: ProjectContextRepository;
  readonly executions: ConversationResponseExecutionRepository;
  readonly threadFirst?: boolean;
  readonly contextBuilder?: ConversationContextBuilder;
  readonly agentContextAssembler?: AgentContextAssembler;
  readonly modelHistory?: Pick<ModelHistoryReader, 'readConversation'>;
  readonly attachments?: Pick<ConversationAttachmentContextService, 'resolve'> & Partial<Pick<ConversationAttachmentContextService, 'resolveImage'>>;
  readonly documentTools?: Pick<ConversationDocumentToolSessionService, 'prepare' | 'registerExecution'>;
  readonly executionCoordinator?: ConversationExecutionCoordinator;
  getStartupSignal?(draftId: string): AbortSignal | undefined;
  onPreparationFailed?(executionId: string, error: unknown): Promise<void>;
  projectAssistantMessage?(input: {
    readonly threadId: string;
    readonly sourceMessageId: string;
    readonly assistantMessageId: string;
    readonly messageRevision: number;
    readonly status: ItemStatus;
    readonly content: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly legacyMessageSnapshot?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  bindExecutionOwnership?(executionId: string): Promise<void>;
  bindDocumentOwnership?(executionId: string): Promise<void>;
  nextMessageId?: () => MessageId;
  nextExecutionId?: () => string;
  nextStreamEventId?: () => string;
  now?: () => string;
}

export class ConversationResponseArtifactFactory
  implements SubmissionArtifactFactoryPort {
  private readonly nextMessageId: () => MessageId;
  private readonly nextExecutionId: () => string;
  private readonly nextStreamEventId: () => string;
  private readonly contextBuilder: ConversationContextBuilder;
  private readonly agentContextAssembler: AgentContextAssembler;

  constructor(
    private readonly dependencies: ConversationResponseArtifactFactoryDependencies
  ) {
    this.nextMessageId = dependencies.nextMessageId ??
      (() => toMessageId(`message-${randomUUID()}`));
    this.nextExecutionId = dependencies.nextExecutionId ??
      (() => `response-execution-${randomUUID()}`);
    this.nextStreamEventId = dependencies.nextStreamEventId ??
      (() => `response-stream-${randomUUID()}`);
    this.contextBuilder = dependencies.contextBuilder ?? new ConversationContextBuilder();
    this.agentContextAssembler = dependencies.agentContextAssembler ?? new AgentContextAssembler();
  }

  async create(input: Parameters<SubmissionArtifactFactoryPort['create']>[0]) {
    const subject = input.subject.subject;
    if (subject.kind !== 'conversation_response_draft') {
      throw new TypeError('Conversation response artifacts require a response draft subject');
    }
    const draft = await this.dependencies.drafts.get(subject.responseDraftId);
    if (!draft || draft.revision !== subject.responseDraftRevision || draft.conversationId !== subject.conversationId ||
        draft.conversationRevision !== subject.conversationRevision || draft.userMessageId !== subject.userMessageId) {
      throw new TypeError('Conversation response draft is unavailable for artifact creation');
    }
    const startupSignal = this.dependencies.getStartupSignal?.(draft.id);
    assertStartupSignal(startupSignal);
    const conversation = await this.dependencies.conversations.get(subject.conversationId);
    if (!conversation || conversation.id !== subject.conversationId || conversation.projectId !== this.dependencies.conversations.projectId ||
        conversation.status !== 'active' || conversation.revision !== subject.conversationRevision) {
      throw new TypeError('Conversation revision changed before artifact creation');
    }
    const userMessage = conversation.messages.find((message) => message.id === draft.userMessageId);
    if (!userMessage || userMessage.role !== 'user' || userMessage.state !== 'completed' || userMessage.revision !== draft.userMessageRevision) {
      throw new TypeError('Conversation response user message is unavailable for artifact creation');
    }
    const nativeSearch = await this.dependencies.nativeSearch?.dispatch(draft, input.candidate);
    assertStartupSignal(startupSignal);
    const toolSelection = await awaitStartup(this.dependencies.documentTools?.prepare({ conversation, draft, signal: startupSignal }), startupSignal);
    const bindsExistingDocument = toolSelection !== undefined &&
      (!('kind' in toolSelection) || toolSelection.kind === 'mutation' || toolSelection.kind === 'revision');
    if (toolSelection && (nativeSearch || !input.subject.contextContentHashes.includes(toolSelection.bindingHash))) {
      throw new ConversationDocumentPageError('document_page_unavailable', '文档读取授权范围或版本已变化，请重新提交。');
    }
    const selectedContexts = [];
    for (const selection of bindsExistingDocument ? [] : draft.contextSelections) {
      const context = await this.dependencies.contexts.get(selection.contextId);
      if (context) selectedContexts.push(context);
    }
    const contextSnapshots = freezeProjectContextOutboundSnapshots({
      projectId: this.dependencies.conversations.projectId,
      surface: 'conversation',
      contexts: selectedContexts,
      selections: bindsExistingDocument ? [] : draft.contextSelections
    });
    const imageInput = draft.imageQuery ? await this.dependencies.attachments?.resolveImage?.({ conversation, currentUserMessageId: draft.userMessageId }) : undefined;
    if (draft.imageQuery && (!imageInput || input.subject.imageCount !== 1 || !input.subject.materialReferences.some(item => item.referenceId === imageInput.fileId) || !input.subject.contextContentHashes.includes(imageInput.image.checksumSha256))) {
      throw new ConversationAttachmentError('attachment_changed', '图片与已确认的发送范围不一致，请重新确认。');
    }
    const attachmentReferences = bindsExistingDocument ? [] : await this.dependencies.attachments?.resolve({
      conversation,
      currentUserMessageId: draft.userMessageId,
      query: draft.attachmentQuery ?? userMessage.displayContent ?? userMessage.content,
      ...(imageInput ? { imageFileId: imageInput.fileId } : {})
    }) ?? [];
    const references: readonly ConversationContextReference[] = [...attachmentReferences, ...contextSnapshots.map(
      (snapshot) => ({
        sourceId: snapshot.contextId,
        sourceType: 'project' as const,
        revision: snapshot.contextRevision,
        contentHash: snapshot.contentHash,
        excerpt: snapshot.contentSnapshot
      })
    )];
    if (nativeSearch && references.length) throw new TypeError('Native search context exceeds the authorized scope');
    const modelConversation = this.dependencies.modelHistory
      ? await this.dependencies.modelHistory.readConversation({ threadId: toThreadId(conversation.id) })
      : conversation;
    const modelUser = modelConversation.messages.find(message => message.id === draft.userMessageId);
    if (!modelUser || modelUser.role !== 'user' || modelUser.state !== 'completed' || modelUser.revision !== draft.userMessageRevision) {
      throw new TypeError('Authoritative model history user message changed');
    }
    assertStartupSignal(startupSignal);
    const contextEnvelope = draft.agentNative
      ? this.agentContextAssembler.assemble({
          conversation: modelConversation,
          currentUserMessageId: draft.userMessageId,
          currentUserContent: input.subject.outboundTextSnapshot,
          references
        })
      : this.contextBuilder.build({
          conversation: modelConversation,
          currentUserMessageId: draft.userMessageId,
          currentUserContent: input.subject.outboundTextSnapshot,
          omitHistory: !!nativeSearch || !!toolSelection,
          references
        });
    const messages = toolSelection ? [
      { role: 'system' as const, content: 'kind' in toolSelection
        ? toolSelection.kind === 'generation'
          ? buildDocumentGenerationToolInstruction(toolSelection)
          : toolSelection.kind === 'mutation'
            ? buildDocumentMutationToolInstruction(toolSelection)
            : buildAgentToolInstruction()
        : buildDocumentReadToolInstruction(toolSelection) },
      ...contextEnvelope.messages
    ] : contextEnvelope.messages;
    const createdAt = toIsoTimestamp(input.createdAt);
    assertStartupSignal(startupSignal);
    const assistantMessageId = this.nextMessageId();
    const pendingConversation = beginAssistantMessage(conversation, {
      id: assistantMessageId,
      createdAt
    });
    if (this.dependencies.threadFirst && !this.dependencies.projectAssistantMessage) {
      throw new Error('thread_pending_projection_unavailable');
    }
    await this.dependencies.projectAssistantMessage?.({
      threadId: String(conversation.id),
      sourceMessageId: String(draft.userMessageId),
      assistantMessageId: String(assistantMessageId),
      messageRevision: 0,
      status: 'pending',
      content: '',
      createdAt,
      updatedAt: createdAt,
      legacyMessageSnapshot: pendingConversation.messages.at(-1)! as unknown as Readonly<Record<string, unknown>>
    });
    if (!this.dependencies.threadFirst) await this.dependencies.conversations.save(
      pendingConversation,
      conversation.revision
    );

    const responseExecution = createConversationResponseExecution({
      id: toConversationResponseExecutionId(this.nextExecutionId()),
      projectId: this.dependencies.conversations.projectId,
      providerInvocationAttemptId: input.invocationAttemptId,
      snapshot: {
        schemaVersion: 1,
        responseDraftId: draft.id,
        responseDraftRevision: draft.revision,
        conversationId: conversation.id,
        conversationRevision: conversation.revision,
        userMessageId: draft.userMessageId,
        userMessageRevision: draft.userMessageRevision,
        assistantMessageId,
        productFeature: draft.productFeature,
        routeSnapshotId: input.routeSnapshotId,
        candidate: {
          schemaVersion: 1,
          providerId: input.candidate.routeTemplate.providerId,
          connectionId: input.candidate.routeTemplate.connectionId,
          connectionRevision: input.candidate.routeTemplate.connectionRevision,
          modelId: input.candidate.routeTemplate.modelId,
          modelRevision: input.candidate.routeTemplate.modelRevision,
          profileId: input.candidate.routeTemplate.profileId,
          profileRevision: input.candidate.routeTemplate.profileRevision,
          protocolBindingId: input.candidate.routeTemplate.protocolBindingId,
          protocolBindingRevision: input.candidate.routeTemplate.protocolBindingRevision,
          runtimeSource: runtimeSourceForPackage(input.candidate.routeTemplate.packageId)
        },
        outboundUserTextSnapshot: input.subject.outboundTextSnapshot,
        contextSnapshots
      },
      createdAt
    });
    const createdEvent = createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId(this.nextStreamEventId()),
      responseExecutionId: responseExecution.id,
      sequence: 1,
      type: 'execution_created',
      occurredAt: createdAt
    });
    await this.dependencies.executions.create(responseExecution, createdEvent);
    if (startupSignal) this.dependencies.executionCoordinator?.bindStartupSignal(responseExecution.id, startupSignal);
    try {
      assertStartupSignal(startupSignal);
      await this.dependencies.bindExecutionOwnership?.(responseExecution.id);
      if (toolSelection) {
        await this.dependencies.documentTools!.registerExecution({ selection: toolSelection, responseExecutionId: responseExecution.id, signal: startupSignal });
      }
      await this.dependencies.bindDocumentOwnership?.(responseExecution.id);
      assertStartupSignal(startupSignal);
    } catch (error) {
      this.dependencies.executionCoordinator?.releaseStartupSignal(responseExecution.id);
      await this.dependencies.onPreparationFailed?.(responseExecution.id, error);
      throw error;
    }

    return {
      subjectArtifacts: {
        kind: 'conversation' as const,
        responseExecution,
        responseStreamEvents: [createdEvent]
      },
      dispatchRequest: {
        responseExecutionId: responseExecution.id,
        invocationAttemptId: input.invocationAttemptId,
        messages,
        ...(nativeSearch ? { nativeSearch } : {}),
        ...(imageInput ? { image: imageInput.image } : {}),
        parameterValues: input.subject.parameterValues
      }
    };
  }
}

function assertStartupSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' });
}

async function awaitStartup<T>(pending: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  if (!signal) return await pending;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, stopped]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

function runtimeSourceForPackage(
  packageId: string
): 'official_direct' | 'newapi_gateway' {
  if (
    packageId === NEWAPI_PROVIDER_PACKAGE_ID ||
    packageId === UNICOMPAPI_PROVIDER_PACKAGE_ID || packageId === UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID
  ) {
    return 'newapi_gateway';
  }
  if (packageId === DEEPSEEK_PROVIDER_PACKAGE_ID) {
    return 'official_direct';
  }
  return 'official_direct';
}
