import { randomUUID } from 'node:crypto';
import {
  beginAssistantMessage,
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  type ConversationResponseDraftRepository,
  type ConversationResponseExecutionRepository,
  type MessageId,
  type ProjectContextRepository,
  type ProjectConversationRepository
} from '../../domain';
import { freezeProjectContextOutboundSnapshots } from '../repositories/project-context-snapshot';
import {
  ConversationContextBuilder,
  type ConversationContextReference
} from '../../application';
import { DEEPSEEK_PROVIDER_PACKAGE_ID } from './deepseek/deepseek-contracts';
import {
  NEWAPI_PROVIDER_PACKAGE_ID
} from './newapi/newapi-contracts';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID } from './newapi/unicompapi-contracts';
import type { SubmissionArtifactFactoryPort } from './provider-submission-orchestrator';
import type { ConversationAttachmentContextService } from '../documents/conversation-attachment-context';
import { ConversationAttachmentError } from '../documents/conversation-attachment-context';
import { ConversationDocumentPageError, resolveConversationResponseDocumentPages, type ConversationDocumentPageContextService } from '../documents/conversation-document-page-context';

export interface ConversationResponseArtifactFactoryDependencies {
  readonly conversations: ProjectConversationRepository;
  readonly drafts: ConversationResponseDraftRepository;
  readonly contexts: ProjectContextRepository;
  readonly executions: ConversationResponseExecutionRepository;
  readonly contextBuilder?: ConversationContextBuilder;
  readonly attachments?: Pick<ConversationAttachmentContextService, 'resolve'> & Partial<Pick<ConversationAttachmentContextService, 'resolveImage'>>;
  readonly documentPages?: Pick<ConversationDocumentPageContextService, 'resolve'>;
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
  private readonly now: () => string;
  private readonly contextBuilder: ConversationContextBuilder;

  constructor(
    private readonly dependencies: ConversationResponseArtifactFactoryDependencies
  ) {
    this.nextMessageId = dependencies.nextMessageId ??
      (() => toMessageId(`message-${randomUUID()}`));
    this.nextExecutionId = dependencies.nextExecutionId ??
      (() => `response-execution-${randomUUID()}`);
    this.nextStreamEventId = dependencies.nextStreamEventId ??
      (() => `response-stream-${randomUUID()}`);
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.contextBuilder = dependencies.contextBuilder ?? new ConversationContextBuilder();
  }

  async create(input: Parameters<SubmissionArtifactFactoryPort['create']>[0]) {
    const subject = input.subject.subject;
    if (subject.kind !== 'conversation_response_draft') {
      throw new TypeError('Conversation response artifacts require a response draft subject');
    }
    const draft = await this.dependencies.drafts.get(subject.responseDraftId);
    if (!draft || draft.revision !== subject.responseDraftRevision) {
      throw new TypeError('Conversation response draft is unavailable for artifact creation');
    }
    const conversation = await this.dependencies.conversations.get(subject.conversationId);
    if (!conversation || conversation.revision !== subject.conversationRevision) {
      throw new TypeError('Conversation revision changed before artifact creation');
    }
    const userMessage = conversation.messages.find((message) => message.id === draft.userMessageId);
    if (!userMessage || userMessage.role !== 'user' || userMessage.state !== 'completed') {
      throw new TypeError('Conversation response user message is unavailable for artifact creation');
    }
    const pageReferences = await resolveConversationResponseDocumentPages({
      conversation, draft, service: this.dependencies.documentPages
    });
    const selectedContexts = [];
    for (const selection of pageReferences.length ? [] : draft.contextSelections) {
      const context = await this.dependencies.contexts.get(selection.contextId);
      if (context) selectedContexts.push(context);
    }
    const contextSnapshots = freezeProjectContextOutboundSnapshots({
      projectId: this.dependencies.conversations.projectId,
      surface: 'conversation',
      contexts: selectedContexts,
      selections: pageReferences.length ? [] : draft.contextSelections
    });
    if (pageReferences.some((reference) => !input.subject.contextContentHashes?.includes(reference.contentHash))) {
      throw new ConversationDocumentPageError('document_page_unavailable', '作品页面在请求准备后发生变化，请重新核对后再提问。');
    }
    const imageInput = draft.imageQuery ? await this.dependencies.attachments?.resolveImage?.({ conversation, currentUserMessageId: draft.userMessageId }) : undefined;
    if (draft.imageQuery && (!imageInput || input.subject.imageCount !== 1 || !input.subject.materialReferences.some(item => item.referenceId === imageInput.fileId) || !input.subject.contextContentHashes.includes(imageInput.image.checksumSha256))) {
      throw new ConversationAttachmentError('attachment_changed', '图片与已确认的发送范围不一致，请重新确认。');
    }
    const attachmentReferences = pageReferences.length ? [] : await this.dependencies.attachments?.resolve({
      conversation,
      currentUserMessageId: draft.userMessageId,
      query: draft.attachmentQuery ?? userMessage.displayContent ?? userMessage.content,
      ...(imageInput ? { imageFileId: imageInput.fileId } : {})
    }) ?? [];
    const references: readonly ConversationContextReference[] = [...pageReferences, ...attachmentReferences, ...contextSnapshots.map(
      (snapshot) => ({
        sourceId: snapshot.contextId,
        sourceType: 'project' as const,
        revision: snapshot.contextRevision,
        contentHash: snapshot.contentHash,
        excerpt: snapshot.contentSnapshot
      })
    )];
    const contextEnvelope = this.contextBuilder.build({
      conversation,
      currentUserMessageId: draft.userMessageId,
      currentUserContent: input.subject.outboundTextSnapshot,
      omitHistory: pageReferences.length > 0,
      references
    });
    if (pageReferences.some((page) => !contextEnvelope.references.some((reference) =>
      reference.sourceId === page.sourceId && reference.contentHash === page.contentHash && reference.excerpt === page.excerpt))) {
      throw new ConversationDocumentPageError('document_page_scope_exceeded', '目标页面超过本次完整读取预算，请缩小问题范围后继续。');
    }
    const messages = contextEnvelope.messages;
    const createdAt = toIsoTimestamp(input.createdAt);
    const assistantMessageId = this.nextMessageId();
    const pendingConversation = beginAssistantMessage(conversation, {
      id: assistantMessageId,
      createdAt
    });
    await this.dependencies.conversations.save(
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
        ...(imageInput ? { image: imageInput.image } : {}),
        parameterValues: input.subject.parameterValues
      }
    };
  }
}

function runtimeSourceForPackage(
  packageId: string
): 'official_direct' | 'newapi_gateway' {
  if (
    packageId === NEWAPI_PROVIDER_PACKAGE_ID ||
    packageId === UNICOMPAPI_PROVIDER_PACKAGE_ID
  ) {
    return 'newapi_gateway';
  }
  if (packageId === DEEPSEEK_PROVIDER_PACKAGE_ID) {
    return 'official_direct';
  }
  return 'official_direct';
}
