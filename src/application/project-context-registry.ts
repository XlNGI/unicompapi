import {
  addProjectContextDraftFragment,
  createProjectContextContentSnapshot,
  createProjectContextDraft,
  deleteProjectContext,
  getCurrentProjectContextVersion,
  normalizeProjectContextSelection,
  registerProjectContextDraft,
  removeProjectContextDraftFragment,
  replaceProjectContextDraftLabels,
  toIsoTimestamp,
  updateProjectContextContent,
  updateProjectContextSourceStatus,
  type Conversation,
  type ConversationId,
  type ConversationRepository,
  type Message,
  type MessageId,
  type ProjectContextDraftId,
  type ProjectContextDraftV1,
  type ProjectContextFragmentId,
  type ProjectContextId,
  type ProjectContextMessageFragmentV1,
  type ProjectContextRepository,
  type ProjectContextSourceStatus,
  type ProjectContextV1,
  type ProjectContextVersionV1,
  type ProjectId
} from '../domain';

export type ProjectContextApplicationErrorCode =
  | 'project_scope_mismatch'
  | 'conversation_not_saved'
  | 'conversation_deleted'
  | 'draft_not_found'
  | 'context_not_found'
  | 'message_not_found'
  | 'message_not_completed'
  | 'message_revision_changed'
  | 'selection_out_of_range'
  | 'revision_conflict'
  | 'explicit_confirmation_required';

export class ProjectContextApplicationError extends Error {
  constructor(
    readonly code: ProjectContextApplicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProjectContextApplicationError';
  }
}

export interface ProjectContextIdFactory {
  nextDraftId(): ProjectContextDraftId;
  nextFragmentId(): ProjectContextFragmentId;
  nextContextId(): ProjectContextId;
}

export interface ProjectContextFragmentDto {
  readonly fragmentId: ProjectContextFragmentId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly messageRevision: number;
  readonly messageRole: 'user' | 'assistant';
  readonly selectionOrder: number;
  readonly selection: {
    readonly startUtf16: number;
    readonly endUtf16: number;
  };
  readonly contentSnapshot: string;
}

export interface ProjectContextDraftPreviewDto {
  readonly draftId: ProjectContextDraftId;
  readonly revision: number;
  readonly projectId: ProjectId;
  readonly sourceKind: 'conversation_selection';
  readonly conversationId: ConversationId;
  readonly labels: readonly string[];
  readonly fragments: readonly ProjectContextFragmentDto[];
  readonly contentPreview: string;
  readonly canRegister: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectContextCandidateDto {
  readonly contextId: ProjectContextId;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly status: 'active';
  readonly sourceKind: 'conversation_selection';
  readonly sourceStatus: ProjectContextSourceStatus;
  readonly labels: readonly string[];
  readonly contentPreview: string;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export interface ProjectContextDetailDto {
  readonly contextId: ProjectContextId;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly isCurrent: boolean;
  readonly status: 'active' | 'deleted';
  readonly sourceKind: 'conversation_selection';
  readonly sourceStatus: ProjectContextSourceStatus;
  readonly sourceConversationId: ConversationId;
  readonly sourceFragments: readonly ProjectContextFragmentDto[];
  readonly labels: readonly string[];
  readonly contentSnapshot: string;
  readonly registeredAt: string;
  readonly versionCreatedAt: string;
  readonly deletedAt?: string;
}

export class ProjectContextRegistryService {
  constructor(
    private readonly conversationRepository: ConversationRepository,
    private readonly contextRepository: ProjectContextRepository,
    private readonly ids: ProjectContextIdFactory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async createDraft(input: {
    readonly projectId: ProjectId;
    readonly conversationId: ConversationId;
  }): Promise<ProjectContextDraftPreviewDto> {
    this.assertProject(input.projectId);
    const conversation = await this.requireSavedConversation(input.conversationId);
    this.assertConversationAvailable(conversation);
    const createdAt = toIsoTimestamp(this.now());
    const draft = createProjectContextDraft({
      id: this.ids.nextDraftId(),
      projectId: input.projectId,
      conversationId: conversation.id,
      createdAt
    });
    await this.contextRepository.createDraft(draft);
    return toDraftPreviewDto(draft);
  }

  async getDraftPreview(input: {
    readonly projectId: ProjectId;
    readonly draftId: ProjectContextDraftId;
  }): Promise<ProjectContextDraftPreviewDto> {
    this.assertProject(input.projectId);
    return toDraftPreviewDto(await this.requireDraft(input.draftId));
  }

  async addMessageFragment(input: {
    readonly projectId: ProjectId;
    readonly draftId: ProjectContextDraftId;
    readonly expectedRevision: number;
    readonly messageId: MessageId;
    readonly startUtf16: number;
    readonly endUtf16: number;
  }): Promise<ProjectContextDraftPreviewDto> {
    this.assertProject(input.projectId);
    const draft = await this.requireDraft(input.draftId);
    const conversation = await this.requireSavedConversation(draft.conversationId);
    this.assertConversationAvailable(conversation);
    const message = requireMessage(conversation, input.messageId);
    assertCompletedMessage(message);
    if (
      !Number.isSafeInteger(input.startUtf16) ||
      !Number.isSafeInteger(input.endUtf16) ||
      input.startUtf16 < 0 ||
      input.endUtf16 <= input.startUtf16 ||
      input.endUtf16 > message.content.length
    ) {
      throw new ProjectContextApplicationError(
        'selection_out_of_range',
        'Message selection range is invalid'
      );
    }
    const contentSnapshot = normalizeProjectContextSelection(
      message.content.slice(input.startUtf16, input.endUtf16)
    );
    const updated = addProjectContextDraftFragment(draft, {
      id: this.ids.nextFragmentId(),
      conversationId: conversation.id,
      messageId: message.id,
      messageRevision: message.revision,
      messageRole: message.role,
      selection: {
        schemaVersion: 1,
        startUtf16: input.startUtf16,
        endUtf16: input.endUtf16
      },
      contentSnapshot
    }, toIsoTimestamp(this.now()));
    await this.contextRepository.saveDraft(updated, input.expectedRevision);
    return toDraftPreviewDto(updated);
  }

  async removeMessageFragment(input: {
    readonly projectId: ProjectId;
    readonly draftId: ProjectContextDraftId;
    readonly expectedRevision: number;
    readonly fragmentId: ProjectContextFragmentId;
  }): Promise<ProjectContextDraftPreviewDto> {
    this.assertProject(input.projectId);
    const draft = await this.requireDraft(input.draftId);
    const updated = removeProjectContextDraftFragment(
      draft,
      input.fragmentId,
      toIsoTimestamp(this.now())
    );
    await this.contextRepository.saveDraft(updated, input.expectedRevision);
    return toDraftPreviewDto(updated);
  }

  async updateDraftLabels(input: {
    readonly projectId: ProjectId;
    readonly draftId: ProjectContextDraftId;
    readonly expectedRevision: number;
    readonly labels: readonly string[];
  }): Promise<ProjectContextDraftPreviewDto> {
    this.assertProject(input.projectId);
    const draft = await this.requireDraft(input.draftId);
    const updated = replaceProjectContextDraftLabels(
      draft,
      input.labels,
      toIsoTimestamp(this.now())
    );
    await this.contextRepository.saveDraft(updated, input.expectedRevision);
    return toDraftPreviewDto(updated);
  }

  async registerDraft(input: {
    readonly projectId: ProjectId;
    readonly draftId: ProjectContextDraftId;
    readonly expectedRevision: number;
    readonly confirmed: true;
  }): Promise<ProjectContextDetailDto> {
    this.assertProject(input.projectId);
    if (input.confirmed !== true) {
      throw new ProjectContextApplicationError(
        'explicit_confirmation_required',
        'Project context registration requires explicit confirmation'
      );
    }
    const draft = await this.requireDraft(input.draftId);
    const conversation = await this.requireSavedConversation(draft.conversationId);
    this.assertConversationAvailable(conversation);
    verifyDraftSources(draft.fragments, conversation);
    const registeredAt = toIsoTimestamp(this.now());
    const context = registerProjectContextDraft(
      draft,
      this.ids.nextContextId(),
      registeredAt
    );
    await this.contextRepository.registerDraft(
      draft.id,
      input.expectedRevision,
      context
    );
    return toContextDetailDto(context, getCurrentProjectContextVersion(context));
  }

  async updateContext(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
    readonly expectedRevision: number;
    readonly contentSnapshot: string;
    readonly labels: readonly string[];
  }): Promise<ProjectContextDetailDto> {
    this.assertProject(input.projectId);
    const context = await this.requireContext(input.contextId);
    const updated = updateProjectContextContent(
      context,
      input.contentSnapshot,
      input.labels,
      toIsoTimestamp(this.now())
    );
    await this.contextRepository.save(updated, input.expectedRevision);
    return toContextDetailDto(updated, getCurrentProjectContextVersion(updated));
  }

  async deleteContext(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
    readonly expectedRevision: number;
  }): Promise<ProjectContextDetailDto> {
    this.assertProject(input.projectId);
    const context = await this.requireContext(input.contextId);
    const deleted = deleteProjectContext(context, toIsoTimestamp(this.now()));
    await this.contextRepository.save(deleted, input.expectedRevision);
    return toContextDetailDto(deleted, getCurrentProjectContextVersion(deleted));
  }

  async refreshSourceStatus(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
    readonly expectedRevision: number;
  }): Promise<ProjectContextDetailDto> {
    this.assertProject(input.projectId);
    const context = await this.requireContext(input.contextId);
    if (context.currentRevision !== input.expectedRevision) {
      throw new ProjectContextApplicationError(
        'revision_conflict',
        'Project context revision has changed'
      );
    }
    const current = getCurrentProjectContextVersion(context);
    const sourceStatus = await this.resolveSourceStatus(current);
    const updated = updateProjectContextSourceStatus(
      context,
      sourceStatus,
      toIsoTimestamp(this.now())
    );
    if (updated !== context) {
      await this.contextRepository.save(updated, input.expectedRevision);
    }
    return toContextDetailDto(updated, getCurrentProjectContextVersion(updated));
  }

  async listCandidates(input: {
    readonly projectId: ProjectId;
  }): Promise<readonly ProjectContextCandidateDto[]> {
    this.assertProject(input.projectId);
    const contexts = await this.contextRepository.list(false);
    return contexts.map(toContextCandidateDto);
  }

  async getContext(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
  }): Promise<ProjectContextDetailDto> {
    this.assertProject(input.projectId);
    const context = await this.requireContext(input.contextId);
    return toContextDetailDto(context, getCurrentProjectContextVersion(context));
  }

  async getContextRevision(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
    readonly revision: number;
  }): Promise<ProjectContextDetailDto> {
    this.assertProject(input.projectId);
    const context = await this.requireContext(input.contextId);
    const version = await this.contextRepository.getRevision(
      input.contextId,
      input.revision
    );
    if (!version) {
      throw new ProjectContextApplicationError(
        'context_not_found',
        'Project context revision does not exist'
      );
    }
    return toContextDetailDto(context, version);
  }

  async getSourceStatus(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
  }): Promise<{
    readonly contextId: ProjectContextId;
    readonly revision: number;
    readonly sourceStatus: ProjectContextSourceStatus;
  }> {
    const context = await this.requireContextForProject(input);
    const current = getCurrentProjectContextVersion(context);
    return {
      contextId: context.id,
      revision: current.revision,
      sourceStatus: current.sourceStatus
    };
  }

  private assertProject(projectId: ProjectId): void {
    if (projectId !== this.contextRepository.projectId) {
      throw new ProjectContextApplicationError(
        'project_scope_mismatch',
        'Requested project is outside project context repository scope'
      );
    }
  }

  private async requireSavedConversation(
    conversationId: ConversationId
  ): Promise<Conversation> {
    const conversation = await this.conversationRepository.get(conversationId);
    if (!conversation) {
      throw new ProjectContextApplicationError(
        'conversation_not_saved',
        'Conversation is not present in the saved conversation repository'
      );
    }
    return conversation;
  }

  private assertConversationAvailable(conversation: Conversation): void {
    if (conversation.status === 'deleted') {
      throw new ProjectContextApplicationError(
        'conversation_deleted',
        'Deleted conversation cannot be used for new project context registration'
      );
    }
  }

  private async requireDraft(
    draftId: ProjectContextDraftId
  ) {
    const draft = await this.contextRepository.getDraft(draftId);
    if (!draft) {
      throw new ProjectContextApplicationError(
        'draft_not_found',
        'Project context draft does not exist'
      );
    }
    return draft;
  }

  private async requireContext(
    contextId: ProjectContextId
  ): Promise<ProjectContextV1> {
    const context = await this.contextRepository.get(contextId);
    if (!context) {
      throw new ProjectContextApplicationError(
        'context_not_found',
        'Project context does not exist'
      );
    }
    return context;
  }

  private async requireContextForProject(input: {
    readonly projectId: ProjectId;
    readonly contextId: ProjectContextId;
  }): Promise<ProjectContextV1> {
    this.assertProject(input.projectId);
    return this.requireContext(input.contextId);
  }

  private async resolveSourceStatus(
    version: ProjectContextVersionV1
  ): Promise<ProjectContextSourceStatus> {
    const conversation = await this.conversationRepository.get(
      version.sourceConversationId
    );
    if (!conversation) return 'source_unavailable';
    if (conversation.status === 'deleted') return 'source_deleted';
    try {
      verifyDraftSources(version.sourceFragments, conversation);
      return 'available';
    } catch {
      return 'source_unavailable';
    }
  }
}

function requireMessage(conversation: Conversation, messageId: MessageId): Message {
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) {
    throw new ProjectContextApplicationError(
      'message_not_found',
      'Message does not exist in the selected conversation'
    );
  }
  return message;
}

function assertCompletedMessage(
  message: Message
): asserts message is Extract<Message, { state: 'completed' }> {
  if (message.state !== 'completed') {
    throw new ProjectContextApplicationError(
      'message_not_completed',
      'Only completed messages can be registered as project context'
    );
  }
}

function verifyDraftSources(
  fragments: readonly ProjectContextMessageFragmentV1[],
  conversation: Conversation
): void {
  for (const fragment of fragments) {
    if (fragment.conversationId !== conversation.id) {
      throw new ProjectContextApplicationError(
        'message_not_found',
        'Project context fragment belongs to another conversation'
      );
    }
    const message = requireMessage(conversation, fragment.messageId);
    assertCompletedMessage(message);
    if (
      message.revision !== fragment.messageRevision ||
      message.role !== fragment.messageRole
    ) {
      throw new ProjectContextApplicationError(
        'message_revision_changed',
        'Project context source message revision has changed'
      );
    }
    const { startUtf16, endUtf16 } = fragment.selection;
    if (endUtf16 > message.content.length) {
      throw new ProjectContextApplicationError(
        'message_revision_changed',
        'Project context source selection is no longer available'
      );
    }
    const currentSnapshot = normalizeProjectContextSelection(
      message.content.slice(startUtf16, endUtf16)
    );
    if (currentSnapshot !== fragment.contentSnapshot) {
      throw new ProjectContextApplicationError(
        'message_revision_changed',
        'Project context source content has changed'
      );
    }
  }
}

function toDraftPreviewDto(
  draft: ProjectContextDraftV1
): ProjectContextDraftPreviewDto {
  return {
    draftId: draft.id,
    revision: draft.revision,
    projectId: draft.projectId,
    sourceKind: draft.sourceKind,
    conversationId: draft.conversationId,
    labels: draft.labels,
    fragments: draft.fragments.map(toFragmentDto),
    contentPreview: draft.fragments.length === 0
      ? ''
      : createProjectContextContentSnapshot(draft.fragments),
    canRegister: draft.fragments.length > 0,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

function toFragmentDto(
  fragment: ProjectContextMessageFragmentV1
): ProjectContextFragmentDto {
  return {
    fragmentId: fragment.id,
    conversationId: fragment.conversationId,
    messageId: fragment.messageId,
    messageRevision: fragment.messageRevision,
    messageRole: fragment.messageRole,
    selectionOrder: fragment.selectionOrder,
    selection: {
      startUtf16: fragment.selection.startUtf16,
      endUtf16: fragment.selection.endUtf16
    },
    contentSnapshot: fragment.contentSnapshot
  };
}

function toContextCandidateDto(
  context: ProjectContextV1
): ProjectContextCandidateDto {
  const current = getCurrentProjectContextVersion(context);
  if (current.status !== 'active') {
    throw new ProjectContextApplicationError(
      'context_not_found',
      'Deleted project context cannot be returned as a candidate'
    );
  }
  return {
    contextId: context.id,
    projectId: context.projectId,
    revision: current.revision,
    status: 'active',
    sourceKind: current.sourceKind,
    sourceStatus: current.sourceStatus,
    labels: current.labels,
    contentPreview: current.contentSnapshot.slice(0, 240),
    registeredAt: current.registeredAt,
    updatedAt: context.updatedAt
  };
}

function toContextDetailDto(
  context: ProjectContextV1,
  version: ProjectContextVersionV1
): ProjectContextDetailDto {
  return {
    contextId: context.id,
    projectId: context.projectId,
    revision: version.revision,
    isCurrent: version.revision === context.currentRevision,
    status: version.status,
    sourceKind: version.sourceKind,
    sourceStatus: version.sourceStatus,
    sourceConversationId: version.sourceConversationId,
    sourceFragments: version.sourceFragments.map(toFragmentDto),
    labels: version.labels,
    contentSnapshot: version.contentSnapshot,
    registeredAt: version.registeredAt,
    versionCreatedAt: version.createdAt,
    ...(version.status === 'deleted' ? { deletedAt: version.deletedAt } : {})
  };
}
