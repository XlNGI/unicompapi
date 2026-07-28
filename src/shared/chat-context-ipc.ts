export const chatContextIpcChannels = {
  createConversation: 'chat-context:create-conversation',
  getConversation: 'chat-context:get-conversation',
  listConversations: 'chat-context:list-conversations',
  renameConversation: 'chat-context:rename-conversation',
  archiveConversation: 'chat-context:archive-conversation',
  restoreConversation: 'chat-context:restore-conversation',
  deleteConversation: 'chat-context:delete-conversation',
  addUserMessage: 'chat-context:add-user-message',
  requestAssistantResponse: 'chat-context:request-assistant-response',
  cancelAssistantResponse: 'chat-context:cancel-assistant-response',
  createContextDraft: 'chat-context:create-context-draft',
  getContextDraftPreview: 'chat-context:get-context-draft-preview',
  addContextMessageFragment: 'chat-context:add-context-message-fragment',
  removeContextMessageFragment: 'chat-context:remove-context-message-fragment',
  updateContextDraftLabels: 'chat-context:update-context-draft-labels',
  registerContextDraft: 'chat-context:register-context-draft',
  updateProjectContext: 'chat-context:update-project-context',
  deleteProjectContext: 'chat-context:delete-project-context',
  refreshContextSourceStatus: 'chat-context:refresh-context-source-status',
  listProjectContextCandidates: 'chat-context:list-project-context-candidates',
  getProjectContext: 'chat-context:get-project-context',
  getProjectContextRevision: 'chat-context:get-project-context-revision',
  getContextSourceStatus: 'chat-context:get-context-source-status'
} as const;

export type ChatContextIpcErrorCode =
  | 'invalid_request'
  | 'project_not_open'
  | 'project_scope_mismatch'
  | 'conversation_not_found'
  | 'conversation_not_saved'
  | 'conversation_deleted'
  | 'conversation_not_active'
  | 'draft_not_found'
  | 'context_not_found'
  | 'message_not_found'
  | 'message_not_completed'
  | 'message_revision_changed'
  | 'selection_out_of_range'
  | 'revision_conflict'
  | 'explicit_confirmation_required'
  | 'adapter_unavailable'
  | 'storage_error';

export type ChatContextIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ChatContextIpcErrorCode;
        readonly message: string;
        readonly currentRevision?: number;
      };
    };

export type ConversationAttachmentDto =
  | {
      readonly kind: 'asset';
      readonly projectId: string;
      readonly assetId: string;
    }
  | {
      readonly kind: 'file_reference';
      readonly projectId: string;
      readonly fileReferenceId: string;
    };

export interface MessageDto {
  readonly messageId: string;
  readonly conversationId: string;
  readonly revision: number;
  readonly role: 'user' | 'assistant';
  readonly state: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  readonly content: string;
  readonly attachments: readonly ConversationAttachmentDto[];
  readonly streamSequence?: number;
  readonly failureReason?: 'unavailable' | 'interrupted' | 'invalid_response' | 'unknown';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly cancelledAt?: string;
}

export interface ConversationDto {
  readonly conversationId: string;
  readonly revision: number;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: 'active' | 'archived' | 'deleted';
  readonly messages: readonly MessageDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

export interface ProjectContextFragmentDto {
  readonly fragmentId: string;
  readonly conversationId: string;
  readonly messageId: string;
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
  readonly draftId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly sourceKind: 'conversation_selection';
  readonly conversationId: string;
  readonly labels: readonly string[];
  readonly fragments: readonly ProjectContextFragmentDto[];
  readonly contentPreview: string;
  readonly canRegister: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectContextCandidateDto {
  readonly contextId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly status: 'active';
  readonly sourceKind: 'conversation_selection';
  readonly sourceStatus: 'available' | 'source_deleted' | 'source_unavailable';
  readonly labels: readonly string[];
  readonly contentPreview: string;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export interface ProjectContextDetailDto {
  readonly contextId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly isCurrent: boolean;
  readonly status: 'active' | 'deleted';
  readonly sourceKind: 'conversation_selection';
  readonly sourceStatus: 'available' | 'source_deleted' | 'source_unavailable';
  readonly sourceConversationId: string;
  readonly sourceFragments: readonly ProjectContextFragmentDto[];
  readonly labels: readonly string[];
  readonly contentSnapshot: string;
  readonly registeredAt: string;
  readonly versionCreatedAt: string;
  readonly deletedAt?: string;
}

export interface ContextSourceStatusDto {
  readonly contextId: string;
  readonly revision: number;
  readonly sourceStatus: 'available' | 'source_deleted' | 'source_unavailable';
}

export interface CreateConversationRequest {
  readonly title: string;
  readonly bindToCurrentProject: boolean;
}

export interface ConversationIdRequest {
  readonly conversationId: string;
}

export interface ConversationRevisionRequest extends ConversationIdRequest {
  readonly expectedRevision: number;
}

export interface ListConversationsRequest {
  readonly includeArchived: boolean;
  readonly includeDeleted: boolean;
}

export interface RenameConversationRequest extends ConversationRevisionRequest {
  readonly title: string;
}

export interface AddUserMessageRequest extends ConversationRevisionRequest {
  readonly content: string;
}

export interface CancelAssistantResponseRequest
  extends ConversationRevisionRequest {
  readonly messageId: string;
}

export interface DraftIdRequest {
  readonly draftId: string;
}

export interface DraftRevisionRequest extends DraftIdRequest {
  readonly expectedRevision: number;
}

export interface AddContextMessageFragmentRequest extends DraftRevisionRequest {
  readonly messageId: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface RemoveContextMessageFragmentRequest extends DraftRevisionRequest {
  readonly fragmentId: string;
}

export interface UpdateContextDraftLabelsRequest extends DraftRevisionRequest {
  readonly labels: readonly string[];
}

export interface RegisterContextDraftRequest extends DraftRevisionRequest {
  readonly confirmed: boolean;
}

export interface ContextIdRequest {
  readonly contextId: string;
}

export interface ContextRevisionRequest extends ContextIdRequest {
  readonly expectedRevision: number;
}

export interface UpdateProjectContextRequest extends ContextRevisionRequest {
  readonly contentSnapshot: string;
  readonly labels: readonly string[];
}

export interface GetProjectContextRevisionRequest extends ContextIdRequest {
  readonly revision: number;
}

export const chatContextRequestParsers = {
  createConversation(value: unknown): CreateConversationRequest {
    const record = exactRecord(value, ['title', 'bindToCurrentProject']);
    return {
      title: boundedText(record.title, 'title', 200, false),
      bindToCurrentProject: booleanValue(
        record.bindToCurrentProject,
        'bindToCurrentProject'
      )
    };
  },
  conversationId(value: unknown): ConversationIdRequest {
    const record = exactRecord(value, ['conversationId']);
    return { conversationId: controlledId(record.conversationId, 'conversationId') };
  },
  conversationRevision(value: unknown): ConversationRevisionRequest {
    const record = exactRecord(value, ['conversationId', 'expectedRevision']);
    return {
      conversationId: controlledId(record.conversationId, 'conversationId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision')
    };
  },
  listConversations(value: unknown): ListConversationsRequest {
    const record = exactRecord(value, ['includeArchived', 'includeDeleted']);
    return {
      includeArchived: booleanValue(record.includeArchived, 'includeArchived'),
      includeDeleted: booleanValue(record.includeDeleted, 'includeDeleted')
    };
  },
  renameConversation(value: unknown): RenameConversationRequest {
    const record = exactRecord(value, [
      'conversationId',
      'expectedRevision',
      'title'
    ]);
    return {
      conversationId: controlledId(record.conversationId, 'conversationId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      title: boundedText(record.title, 'title', 200, false)
    };
  },
  addUserMessage(value: unknown): AddUserMessageRequest {
    const record = exactRecord(value, [
      'conversationId',
      'expectedRevision',
      'content'
    ]);
    return {
      conversationId: controlledId(record.conversationId, 'conversationId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      content: boundedText(record.content, 'content', 1_000_000, false)
    };
  },
  cancelAssistantResponse(value: unknown): CancelAssistantResponseRequest {
    const record = exactRecord(value, [
      'conversationId',
      'messageId',
      'expectedRevision'
    ]);
    return {
      conversationId: controlledId(record.conversationId, 'conversationId'),
      messageId: controlledId(record.messageId, 'messageId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision')
    };
  },
  createContextDraft(value: unknown): ConversationIdRequest {
    return this.conversationId(value);
  },
  draftId(value: unknown): DraftIdRequest {
    const record = exactRecord(value, ['draftId']);
    return { draftId: controlledId(record.draftId, 'draftId') };
  },
  addContextMessageFragment(value: unknown): AddContextMessageFragmentRequest {
    const record = exactRecord(value, [
      'draftId',
      'expectedRevision',
      'messageId',
      'startUtf16',
      'endUtf16'
    ]);
    return {
      draftId: controlledId(record.draftId, 'draftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      messageId: controlledId(record.messageId, 'messageId'),
      startUtf16: revision(record.startUtf16, 'startUtf16'),
      endUtf16: revision(record.endUtf16, 'endUtf16')
    };
  },
  removeContextMessageFragment(
    value: unknown
  ): RemoveContextMessageFragmentRequest {
    const record = exactRecord(value, [
      'draftId',
      'expectedRevision',
      'fragmentId'
    ]);
    return {
      draftId: controlledId(record.draftId, 'draftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      fragmentId: controlledId(record.fragmentId, 'fragmentId')
    };
  },
  updateContextDraftLabels(value: unknown): UpdateContextDraftLabelsRequest {
    const record = exactRecord(value, [
      'draftId',
      'expectedRevision',
      'labels'
    ]);
    return {
      draftId: controlledId(record.draftId, 'draftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      labels: labelList(record.labels)
    };
  },
  registerContextDraft(value: unknown): RegisterContextDraftRequest {
    const record = exactRecord(value, [
      'draftId',
      'expectedRevision',
      'confirmed'
    ]);
    return {
      draftId: controlledId(record.draftId, 'draftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      confirmed: booleanValue(record.confirmed, 'confirmed')
    };
  },
  contextId(value: unknown): ContextIdRequest {
    const record = exactRecord(value, ['contextId']);
    return { contextId: controlledId(record.contextId, 'contextId') };
  },
  contextRevision(value: unknown): ContextRevisionRequest {
    const record = exactRecord(value, ['contextId', 'expectedRevision']);
    return {
      contextId: controlledId(record.contextId, 'contextId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision')
    };
  },
  updateProjectContext(value: unknown): UpdateProjectContextRequest {
    const record = exactRecord(value, [
      'contextId',
      'expectedRevision',
      'contentSnapshot',
      'labels'
    ]);
    return {
      contextId: controlledId(record.contextId, 'contextId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      contentSnapshot: boundedText(
        record.contentSnapshot,
        'contentSnapshot',
        1_000_000,
        false
      ),
      labels: labelList(record.labels)
    };
  },
  getProjectContextRevision(value: unknown): GetProjectContextRevisionRequest {
    const record = exactRecord(value, ['contextId', 'revision']);
    return {
      contextId: controlledId(record.contextId, 'contextId'),
      revision: positiveRevision(record.revision, 'revision')
    };
  }
} as const;

export interface ChatContextApi {
  createConversation(
    title: string,
    bindToCurrentProject: boolean
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  getConversation(
    conversationId: string
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  listConversations(
    includeArchived: boolean,
    includeDeleted: boolean
  ): Promise<ChatContextIpcResult<readonly ConversationDto[]>>;
  renameConversation(
    conversationId: string,
    expectedRevision: number,
    title: string
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  archiveConversation(
    conversationId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  restoreConversation(
    conversationId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  deleteConversation(
    conversationId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  addUserMessage(
    conversationId: string,
    expectedRevision: number,
    content: string
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  requestAssistantResponse(
    conversationId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  cancelAssistantResponse(
    conversationId: string,
    messageId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  createContextDraft(
    conversationId: string
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>>;
  getContextDraftPreview(
    draftId: string
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>>;
  addContextMessageFragment(
    draftId: string,
    expectedRevision: number,
    messageId: string,
    startUtf16: number,
    endUtf16: number
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>>;
  removeContextMessageFragment(
    draftId: string,
    expectedRevision: number,
    fragmentId: string
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>>;
  updateContextDraftLabels(
    draftId: string,
    expectedRevision: number,
    labels: readonly string[]
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>>;
  registerContextDraft(
    draftId: string,
    expectedRevision: number,
    confirmed: true
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>>;
  updateProjectContext(
    contextId: string,
    expectedRevision: number,
    contentSnapshot: string,
    labels: readonly string[]
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>>;
  deleteProjectContext(
    contextId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>>;
  refreshContextSourceStatus(
    contextId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>>;
  listProjectContextCandidates(): Promise<
    ChatContextIpcResult<readonly ProjectContextCandidateDto[]>
  >;
  getProjectContext(
    contextId: string
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>>;
  getProjectContextRevision(
    contextId: string,
    revision: number
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>>;
  getContextSourceStatus(
    contextId: string
  ): Promise<ChatContextIpcResult<ContextSourceStatusDto>>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Request must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw new TypeError('Request contains unexpected or missing fields');
  }
  return record;
}

function controlledId(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return Number(value);
}

function positiveRevision(value: unknown, field: string): number {
  const parsed = revision(value, field);
  if (parsed < 1) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} is invalid`);
  return value;
}

function boundedText(
  value: unknown,
  field: string,
  maximumLength: number,
  allowBlank: boolean
): string {
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new TypeError(`${field} is invalid`);
  }
  if (!allowBlank && value.trim().length === 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function labelList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new TypeError('labels are invalid');
  }
  return value.map((label) => boundedText(label, 'label', 100, false));
}
