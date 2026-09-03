import {
  parseFeatureCandidateSubject,
  type ConversationResponseDraftRepository,
  type FeatureCandidateSubjectV1,
  type ProjectContextRepository,
  type ProjectConversationRepository
} from '../../domain';
import {
  freezeProjectContextOutboundSnapshots
} from '../repositories/project-context-snapshot';
import type {
  FeatureSubjectResolverPort,
  ResolvedFeatureSubjectV1
} from './provider-feature-candidates';

export class ProjectConversationResponseSubjectResolver
  implements FeatureSubjectResolverPort {
  constructor(
    private readonly conversations: ProjectConversationRepository,
    private readonly drafts: ConversationResponseDraftRepository,
    private readonly contexts: ProjectContextRepository
  ) {
    if (
      conversations.projectId !== drafts.projectId ||
      conversations.projectId !== contexts.projectId
    ) {
      throw new TypeError('Conversation response repositories belong to different projects');
    }
  }

  async resolve(subject: FeatureCandidateSubjectV1): Promise<ResolvedFeatureSubjectV1> {
    const parsed = parseFeatureCandidateSubject(subject);
    if (parsed.kind !== 'conversation_response_draft') {
      throw new TypeError('Conversation response resolver requires a response draft subject');
    }
    const draft = await this.drafts.get(parsed.responseDraftId);
    if (
      !draft ||
      draft.revision !== parsed.responseDraftRevision ||
      draft.conversationId !== parsed.conversationId ||
      draft.conversationRevision !== parsed.conversationRevision ||
      draft.userMessageId !== parsed.userMessageId
    ) {
      throw new TypeError('Conversation response draft revision changed');
    }
    const conversation = await this.conversations.get(parsed.conversationId);
    if (
      !conversation ||
      conversation.projectId !== this.conversations.projectId ||
      conversation.revision !== parsed.conversationRevision ||
      conversation.status !== 'active'
    ) {
      throw new TypeError('Project conversation revision changed');
    }
    const userMessage = conversation.messages.find(
      (message) => message.id === parsed.userMessageId
    );
    if (
      !userMessage ||
      userMessage.role !== 'user' ||
      userMessage.state !== 'completed' ||
      userMessage.revision !== draft.userMessageRevision
    ) {
      throw new TypeError('Conversation response user message changed');
    }
    const selectedContexts = [];
    for (const selection of draft.contextSelections) {
      const context = await this.contexts.get(selection.contextId);
      if (context) selectedContexts.push(context);
    }
    const contextSnapshots = freezeProjectContextOutboundSnapshots({
      projectId: this.conversations.projectId,
      surface: 'conversation',
      contexts: selectedContexts,
      selections: draft.contextSelections
    });
    return {
      projectId: this.conversations.projectId,
      subject: parsed,
      productFeature: draft.productFeature,
      surface: 'conversation',
      imageCount: 0,
      videoCount: 0,
      contextCount: contextSnapshots.length,
      parameterValues: { ...draft.parameterValues },
      outboundTextSnapshot: draft.promptContent ?? userMessage.content,
      materialReferences: [],
      contextContentHashes: contextSnapshots.map((snapshot) => snapshot.contentHash)
    };
  }
}
