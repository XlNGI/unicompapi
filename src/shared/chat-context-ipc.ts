export const chatContextIpcChannels = {
  createConversation: 'chat-context:create-conversation',
  getConversation: 'chat-context:get-conversation',
  listConversations: 'chat-context:list-conversations',
  listConversationCandidates: 'chat-context:list-conversation-candidates',
  renameConversation: 'chat-context:rename-conversation',
  archiveConversation: 'chat-context:archive-conversation',
  restoreConversation: 'chat-context:restore-conversation',
  deleteConversation: 'chat-context:delete-conversation',
  addUserMessage: 'chat-context:add-user-message',
  editCancelledUserMessage: 'chat-context:edit-cancelled-user-message',
  copyLegacyConversation: 'chat-context:copy-legacy-conversation',
  createResponseDraft: 'chat-context:create-response-draft',
  replaceResponseContexts: 'chat-context:replace-response-contexts',
  replaceResponseParameters: 'chat-context:replace-response-parameters',
  listResponseCandidates: 'chat-context:list-response-candidates',
  listTextCandidates: 'chat-context:list-text-candidates',
  prepareResponseSubmission: 'chat-context:prepare-response-submission',
  submitResponse: 'chat-context:submit-response',
  startResponse: 'chat-context:start-response',
  startWorkflow: 'chat-context:start-workflow',
  answerWorkflow: 'chat-context:answer-workflow',
  confirmWorkflow: 'chat-context:confirm-workflow',
  cancelWorkflow: 'chat-context:cancel-workflow',
  getWorkflow: 'chat-context:get-workflow',
  getPendingWorkflow: 'chat-context:get-pending-workflow',
  getResponseExecution: 'chat-context:get-response-execution',
  replayResponseEvents: 'chat-context:replay-response-events',
  cancelResponseExecution: 'chat-context:cancel-response-execution',
  subscribeResponseEvents: 'chat-context:subscribe-response-events',
  acknowledgeResponseEvents: 'chat-context:acknowledge-response-events',
  unsubscribeResponseEvents: 'chat-context:unsubscribe-response-events',
  responseEvent: 'chat-context:response-event',
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
  | 'legacy_conversation_read_only'
  | 'response_draft_not_found'
  | 'response_execution_not_found'
  | 'response_execution_not_active'
  | 'response_execution_in_progress'
  | 'candidate_not_found'
  | 'candidate_unavailable'
  | 'route_selection_invalid'
  | 'route_selection_expired'
  | 'route_selection_consumed'
  | 'stale_route_selection'
  | 'confirmation_required'
  | 'runtime_not_allowed'
  | 'draft_not_found'
  | 'context_not_found'
  | 'message_not_found'
  | 'message_not_completed'
  | 'message_not_editable'
  | 'message_revision_changed'
  | 'selection_out_of_range'
  | 'revision_conflict'
  | 'explicit_confirmation_required'
  | 'workflow_not_found'
  | 'workflow_revision_conflict'
  | 'workflow_not_ready'
  | 'clarification_required'
  | 'confirmation_expired'
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
  readonly reasoningContent?: string;
  readonly documentGenerationStatus?: {
    readonly state:
      | 'generating_content'
      | 'validating_outline'
      | 'generating_file'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'interrupted';
    readonly kind: 'word' | 'excel' | 'ppt';
    readonly errorCode?:
      | 'response_failed'
      | 'invalid_outline'
      | 'resource_limit'
      | 'document_layout_overflow'
      | 'revision_scope_violation'
      | 'revision_patch_failed'
      | 'revision_conflict'
      | 'unvalidated_output'
      | 'page_count_mismatch'
      | 'generation_failed'
      | 'storage_error';
  };
  readonly documentResult?: {
    readonly workId: string;
    readonly fileName: string;
    readonly kind: 'word' | 'excel' | 'ppt';
    readonly sizeBytes: number;
  };
  readonly attachments: readonly ConversationAttachmentDto[];
  readonly streamSequence?: number;
  readonly failureReason?: 'unavailable' | 'interrupted' | 'invalid_response' | 'truncated' | 'unknown';
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
  readonly storageScope: 'current_project' | 'legacy_project' | 'legacy_unbound';
  readonly readOnly: boolean;
  readonly messages: readonly MessageDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

export interface ConversationCandidateDto {
  readonly conversationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: 'active' | 'archived';
  readonly messageCount: number;
  readonly completedMessageCount: number;
  readonly updatedAt: string;
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

export interface EditCancelledUserMessageRequest extends AddUserMessageRequest {
  readonly messageId: string;
}

export interface ConversationResponseDraftDto {
  readonly responseDraftId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly conversationId: string;
  readonly conversationRevision: number;
  readonly userMessageId: string;
  readonly userMessageRevision: number;
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly contextSelections: readonly {
    readonly contextId: string;
    readonly contextRevision: number;
    readonly includeInPrompt: boolean;
  }[];
  readonly parameterValues: Readonly<Record<string, string | number | boolean | readonly unknown[] | {
    readonly [key: string]: unknown;
  }>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationResponseCandidateDto {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly providerName: string;
  readonly connectionName: string;
  readonly modelName: string;
  readonly parameterSchema: {
    readonly schemaVersion: 2;
    readonly schemaId: string;
    readonly revision: number;
    readonly productFeature: string;
    readonly fields: readonly {
      readonly fieldId: string;
      readonly labelId: string;
      readonly groupId?: string;
      readonly order: number;
      readonly valueType: string;
      readonly exposure: string;
      readonly defaultPolicy: string;
      readonly required: boolean;
      readonly options?: readonly (string | number | boolean)[];
      readonly minimum?: number;
      readonly maximum?: number;
      readonly step?: number;
      readonly unitId?: string;
    }[];
  };
  readonly usageSchema: {
    readonly schemaVersion: 1;
    readonly schemaId: string;
    readonly revision: number;
  };
  readonly cost: {
    readonly state: 'known' | 'unknown' | 'not_applicable';
    readonly summary?: string;
  };
  readonly available: boolean;
  readonly unavailableReasons: readonly string[];
}

export interface ConversationResponsePreparationDto {
  readonly schemaVersion: 1;
  readonly routeSelectionToken: string;
  readonly expiresAt: string;
  readonly confirmation: {
    readonly schemaVersion: 1;
    readonly confirmationId: string;
    readonly productFeature: string;
    readonly providerName: string;
    readonly connectionName: string;
    readonly modelName: string;
    readonly recipientName: string;
    readonly outboundScope: 'external_service' | 'local_network' | 'local_device' | 'unknown';
    readonly contentCategories: readonly string[];
    readonly parameterFieldCount: number;
    readonly materialCount: number;
    readonly contextCount: number;
    readonly cost: {
      readonly state: 'known' | 'unknown' | 'not_applicable';
      readonly summary?: string;
    };
  };
}

export interface ConversationResponseExecutionDto {
  readonly responseExecutionId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly state: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly streamSequence: number;
  readonly reasoningContent: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationResponseStartDto {
  readonly conversation: ConversationDto;
  readonly execution: ConversationResponseExecutionDto;
}

export interface ConversationIntentPlanDto {
  readonly schemaVersion: 1;
  readonly kind: 'chat' | 'document' | 'unknown';
  readonly action?: 'answer' | 'create' | 'revise' | 'analyze';
  readonly documentKind?: 'word' | 'excel' | 'ppt' | 'auto';
  readonly targetHint?: {
    readonly unit: 'document' | 'version' | 'page' | 'section' | 'table' | 'cell' | 'block';
    readonly ordinal?: number;
    readonly name?: string;
  };
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly sourcePolicy: 'none' | 'internal' | 'web' | 'mixed';
  readonly missing: readonly string[];
  readonly ambiguities: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly needsConfirmation: boolean;
}

export interface ConversationWorkflowDto {
  readonly workflowId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly revision: number;
  readonly status:
    | 'draft'
    | 'needs_clarification'
    | 'needs_confirmation'
    | 'ready'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'cancelled';
  readonly plan: ConversationIntentPlanDto;
  readonly pendingQuestions: readonly {
    readonly field: string;
    readonly question: string;
    readonly required: boolean;
  }[];
  readonly resolvedTarget?: {
    readonly artifactRef: string;
    readonly version: number;
  };
  readonly confirmationId?: string;
  readonly planHash?: string;
  readonly confirmationExpiresAt?: string;
  readonly executionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationWorkflowStartDto {
  readonly conversation: ConversationDto;
  readonly workflow: ConversationWorkflowDto;
}

export interface ConversationResponseStreamEventDto {
  readonly schemaVersion: 1;
  readonly responseExecutionId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly sequence: number;
  readonly type: 'execution_created' | 'stream_started' | 'reasoning_delta' | 'content_delta' |
    'cancel_requested' | 'stream_completed' | 'stream_failed' |
    'stream_cancelled' | 'stream_interrupted' | 'stream_resumed';
  readonly reasoningDelta?: string;
  readonly contentDelta?: string;
  readonly safeCode?: string;
  readonly interruptionReason?: 'provider_disconnected' | 'transport_interrupted' | 'application_shutdown';
  readonly occurredAt: string;
}

export interface CreateResponseDraftRequest extends ConversationRevisionRequest {
  readonly userMessageId: string;
  readonly productFeature: 'text_chat' | 'text_reasoning';
}

export interface ResponseDraftRevisionRequest {
  readonly responseDraftId: string;
  readonly expectedRevision: number;
}

export interface ReplaceResponseContextsRequest extends ResponseDraftRevisionRequest {
  readonly selections: readonly {
    readonly contextId: string;
    readonly contextRevision: number;
    readonly includeInPrompt: boolean;
  }[];
}

export interface ReplaceResponseParametersRequest extends ResponseDraftRevisionRequest {
  readonly parameterValues: Readonly<Record<string, string | number | boolean | readonly unknown[] | {
    readonly [key: string]: unknown;
  }>>;
}

export interface ListTextCandidatesRequest {
  readonly productFeature: 'text_chat' | 'text_reasoning';
}

export interface PrepareResponseSubmissionRequest extends ResponseDraftRevisionRequest {
  readonly candidateId: string;
}

export interface SubmitResponseRequest extends ResponseDraftRevisionRequest {
  readonly routeSelectionToken: string;
  readonly confirmationId: string;
  readonly confirmed: boolean;
}

export interface StartResponseRequest {
  readonly clientCommandId: string;
  readonly conversation: {
    readonly conversationId: string;
    readonly expectedRevision: number;
    readonly editedMessageId: string | null;
  } | null;
  readonly title: string;
  readonly content: string;
  readonly displayContent?: string;
  readonly workflow?: {
    readonly workflowId: string;
    readonly expectedRevision: number;
  };
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly candidateId: string;
  readonly contextSelections: readonly {
    readonly contextId: string;
    readonly contextRevision: number;
    readonly includeInPrompt: boolean;
  }[];
  readonly parameterValues: Readonly<Record<string, string | number | boolean | readonly unknown[] | {
    readonly [key: string]: unknown;
  }>>;
  readonly confirmed: boolean;
}

export interface StartWorkflowRequest {
  readonly clientCommandId: string;
  readonly conversation: {
    readonly conversationId: string;
    readonly expectedRevision: number;
  } | null;
  readonly title: string;
  readonly content: string;
  readonly intentHint?: {
    readonly kind: 'document';
    readonly documentKind: 'auto' | 'word' | 'excel' | 'ppt';
  };
}

export interface AnswerWorkflowRequest {
  readonly workflowId: string;
  readonly expectedWorkflowRevision: number;
  readonly expectedConversationRevision: number;
  readonly content: string;
}

export interface WorkflowRevisionRequest {
  readonly workflowId: string;
  readonly expectedRevision: number;
}

export interface WorkflowIdRequest {
  readonly workflowId: string;
}

export interface ResponseExecutionRequest {
  readonly responseExecutionId: string;
}

export interface ReplayResponseEventsRequest extends ResponseExecutionRequest {
  readonly afterSequence: number;
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
  editCancelledUserMessage(value: unknown): EditCancelledUserMessageRequest {
    const record = exactRecord(value, [
      'conversationId',
      'expectedRevision',
      'messageId',
      'content'
    ]);
    return {
      conversationId: controlledId(record.conversationId, 'conversationId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      messageId: controlledId(record.messageId, 'messageId'),
      content: boundedText(record.content, 'content', 1_000_000, false)
    };
  },
  createResponseDraft(value: unknown): CreateResponseDraftRequest {
    const record = exactRecord(value, [
      'conversationId',
      'expectedRevision',
      'userMessageId',
      'productFeature'
    ]);
    if (record.productFeature !== 'text_chat' && record.productFeature !== 'text_reasoning') {
      throw new TypeError('productFeature is invalid');
    }
    return {
      conversationId: controlledId(record.conversationId, 'conversationId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      userMessageId: controlledId(record.userMessageId, 'userMessageId'),
      productFeature: record.productFeature
    };
  },
  responseDraftRevision(value: unknown): ResponseDraftRevisionRequest {
    const record = exactRecord(value, ['responseDraftId', 'expectedRevision']);
    return {
      responseDraftId: controlledId(record.responseDraftId, 'responseDraftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision')
    };
  },
  replaceResponseContexts(value: unknown): ReplaceResponseContextsRequest {
    const record = exactRecord(value, [
      'responseDraftId',
      'expectedRevision',
      'selections'
    ]);
    if (!Array.isArray(record.selections) || record.selections.length > 100) {
      throw new TypeError('selections are invalid');
    }
    const selections = record.selections.map((selection) => {
      const item = exactRecord(selection, [
        'contextId',
        'contextRevision',
        'includeInPrompt'
      ]);
      return {
        contextId: controlledId(item.contextId, 'contextId'),
        contextRevision: positiveRevision(item.contextRevision, 'contextRevision'),
        includeInPrompt: booleanValue(item.includeInPrompt, 'includeInPrompt')
      };
    });
    if (new Set(selections.map((selection) => selection.contextId)).size !== selections.length) {
      throw new TypeError('selections contain duplicate contexts');
    }
    return {
      responseDraftId: controlledId(record.responseDraftId, 'responseDraftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      selections
    };
  },
  replaceResponseParameters(value: unknown): ReplaceResponseParametersRequest {
    const record = exactRecord(value, [
      'responseDraftId',
      'expectedRevision',
      'parameterValues'
    ]);
    return {
      responseDraftId: controlledId(record.responseDraftId, 'responseDraftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      parameterValues: parameterValuesRecord(record.parameterValues)
    };
  },
  listTextCandidates(value: unknown): ListTextCandidatesRequest {
    const record = exactRecord(value, ['productFeature']);
    if (record.productFeature !== 'text_chat' && record.productFeature !== 'text_reasoning') {
      throw new TypeError('productFeature is invalid');
    }
    return { productFeature: record.productFeature };
  },
  prepareResponseSubmission(value: unknown): PrepareResponseSubmissionRequest {
    const record = exactRecord(value, [
      'responseDraftId',
      'expectedRevision',
      'candidateId'
    ]);
    return {
      responseDraftId: controlledId(record.responseDraftId, 'responseDraftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      candidateId: controlledId(record.candidateId, 'candidateId')
    };
  },
  submitResponse(value: unknown): SubmitResponseRequest {
    const record = exactRecord(value, [
      'responseDraftId',
      'expectedRevision',
      'routeSelectionToken',
      'confirmationId',
      'confirmed'
    ]);
    return {
      responseDraftId: controlledId(record.responseDraftId, 'responseDraftId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision'),
      routeSelectionToken: boundedText(
        record.routeSelectionToken,
        'routeSelectionToken',
        512,
        false
      ),
      confirmationId: controlledId(record.confirmationId, 'confirmationId'),
      confirmed: booleanValue(record.confirmed, 'confirmed')
    };
  },
  startResponse(value: unknown): StartResponseRequest {
    const hasDisplayContent =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'displayContent');
    const hasWorkflow =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'workflow');
    const record = exactRecord(value, [
      'clientCommandId',
      'conversation',
      'title',
      'content',
      ...(hasDisplayContent ? ['displayContent'] : []),
      ...(hasWorkflow ? ['workflow'] : []),
      'productFeature',
      'candidateId',
      'contextSelections',
      'parameterValues',
      'confirmed'
    ]);
    if (record.productFeature !== 'text_chat' && record.productFeature !== 'text_reasoning') {
      throw new TypeError('productFeature is invalid');
    }
    const conversation = record.conversation === null
      ? null
      : exactRecord(record.conversation, [
          'conversationId',
          'expectedRevision',
          'editedMessageId'
        ]);
    const editedMessageId = !conversation || conversation.editedMessageId === null
      ? null
      : controlledId(conversation.editedMessageId, 'editedMessageId');
    const workflow = !hasWorkflow
      ? undefined
      : exactRecord(record.workflow, ['workflowId', 'expectedRevision']);
    if (!Array.isArray(record.contextSelections) || record.contextSelections.length > 100) {
      throw new TypeError('contextSelections are invalid');
    }
    const contextSelections = record.contextSelections.map((selection) => {
      const item = exactRecord(selection, [
        'contextId',
        'contextRevision',
        'includeInPrompt'
      ]);
      return {
        contextId: controlledId(item.contextId, 'contextId'),
        contextRevision: positiveRevision(item.contextRevision, 'contextRevision'),
        includeInPrompt: booleanValue(item.includeInPrompt, 'includeInPrompt')
      };
    });
    if (new Set(contextSelections.map((selection) => selection.contextId)).size !== contextSelections.length) {
      throw new TypeError('contextSelections contain duplicate contexts');
    }
    return {
      clientCommandId: controlledId(record.clientCommandId, 'clientCommandId'),
      conversation: conversation
        ? {
            conversationId: controlledId(conversation.conversationId, 'conversationId'),
            expectedRevision: revision(conversation.expectedRevision, 'expectedRevision'),
            editedMessageId
          }
        : null,
      title: boundedText(record.title, 'title', 200, false),
      content: boundedText(record.content, 'content', 1_000_000, false),
      ...(record.displayContent !== undefined
        ? {
            displayContent: boundedText(
              record.displayContent,
              'displayContent',
              8_000,
              false
            )
          }
        : {}),
      ...(workflow !== undefined
        ? {
            workflow: {
              workflowId: controlledId(workflow.workflowId, 'workflowId'),
              expectedRevision: revision(
                workflow.expectedRevision,
                'workflow.expectedRevision'
              )
            }
          }
        : {}),
      productFeature: record.productFeature,
      candidateId: controlledId(record.candidateId, 'candidateId'),
      contextSelections,
      parameterValues: parameterValuesRecord(record.parameterValues),
      confirmed: booleanValue(record.confirmed, 'confirmed')
    };
  },
  startWorkflow(value: unknown): StartWorkflowRequest {
    const hasIntentHint =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'intentHint');
    const record = exactRecord(value, [
      'clientCommandId',
      'conversation',
      'title',
      'content',
      ...(hasIntentHint ? ['intentHint'] : [])
    ]);
    const conversation = record.conversation === null
      ? null
      : exactRecord(record.conversation, ['conversationId', 'expectedRevision']);
    const intentHint = !hasIntentHint
      ? undefined
      : exactRecord(record.intentHint, ['kind', 'documentKind']);
    if (
      intentHint &&
      (intentHint.kind !== 'document' ||
        !['auto', 'word', 'excel', 'ppt'].includes(String(intentHint.documentKind)))
    ) {
      throw new TypeError('intentHint is invalid');
    }
    return {
      clientCommandId: controlledId(record.clientCommandId, 'clientCommandId'),
      conversation: conversation
        ? {
            conversationId: controlledId(conversation.conversationId, 'conversationId'),
            expectedRevision: revision(conversation.expectedRevision, 'expectedRevision')
          }
        : null,
      title: boundedText(record.title, 'title', 200, false),
      content: boundedText(record.content, 'content', 8_000, false),
      ...(intentHint
        ? {
            intentHint: {
              kind: 'document' as const,
              documentKind: intentHint.documentKind as 'auto' | 'word' | 'excel' | 'ppt'
            }
          }
        : {})
    };
  },
  answerWorkflow(value: unknown): AnswerWorkflowRequest {
    const record = exactRecord(value, [
      'workflowId',
      'expectedWorkflowRevision',
      'expectedConversationRevision',
      'content'
    ]);
    return {
      workflowId: controlledId(record.workflowId, 'workflowId'),
      expectedWorkflowRevision: revision(
        record.expectedWorkflowRevision,
        'expectedWorkflowRevision'
      ),
      expectedConversationRevision: revision(
        record.expectedConversationRevision,
        'expectedConversationRevision'
      ),
      content: boundedText(record.content, 'content', 8_000, false)
    };
  },
  workflowRevision(value: unknown): WorkflowRevisionRequest {
    const record = exactRecord(value, ['workflowId', 'expectedRevision']);
    return {
      workflowId: controlledId(record.workflowId, 'workflowId'),
      expectedRevision: revision(record.expectedRevision, 'expectedRevision')
    };
  },
  workflowId(value: unknown): WorkflowIdRequest {
    const record = exactRecord(value, ['workflowId']);
    return { workflowId: controlledId(record.workflowId, 'workflowId') };
  },
  responseExecution(value: unknown): ResponseExecutionRequest {
    const record = exactRecord(value, ['responseExecutionId']);
    return {
      responseExecutionId: controlledId(
        record.responseExecutionId,
        'responseExecutionId'
      )
    };
  },
  replayResponseEvents(value: unknown): ReplayResponseEventsRequest {
    const record = exactRecord(value, ['responseExecutionId', 'afterSequence']);
    return {
      responseExecutionId: controlledId(
        record.responseExecutionId,
        'responseExecutionId'
      ),
      afterSequence: revision(record.afterSequence, 'afterSequence')
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
  listConversationCandidates(): Promise<
    ChatContextIpcResult<readonly ConversationCandidateDto[]>
  >;
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
  editCancelledUserMessage(
    conversationId: string,
    expectedRevision: number,
    messageId: string,
    content: string
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  copyLegacyConversation(
    conversationId: string
  ): Promise<ChatContextIpcResult<ConversationDto>>;
  createResponseDraft(
    conversationId: string,
    expectedRevision: number,
    userMessageId: string,
    productFeature: 'text_chat' | 'text_reasoning'
  ): Promise<ChatContextIpcResult<ConversationResponseDraftDto>>;
  replaceResponseContexts(
    responseDraftId: string,
    expectedRevision: number,
    selections: readonly {
      readonly contextId: string;
      readonly contextRevision: number;
      readonly includeInPrompt: boolean;
    }[]
  ): Promise<ChatContextIpcResult<ConversationResponseDraftDto>>;
  replaceResponseParameters(
    responseDraftId: string,
    expectedRevision: number,
    parameterValues: Readonly<Record<string, string | number | boolean | readonly unknown[] | {
      readonly [key: string]: unknown;
    }>>
  ): Promise<ChatContextIpcResult<ConversationResponseDraftDto>>;
  listResponseCandidates(
    responseDraftId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<readonly ConversationResponseCandidateDto[]>>;
  listTextCandidates(
    productFeature: 'text_chat' | 'text_reasoning'
  ): Promise<ChatContextIpcResult<readonly ConversationResponseCandidateDto[]>>;
  prepareResponseSubmission(
    responseDraftId: string,
    expectedRevision: number,
    candidateId: string
  ): Promise<ChatContextIpcResult<ConversationResponsePreparationDto>>;
  submitResponse(
    responseDraftId: string,
    expectedRevision: number,
    routeSelectionToken: string,
    confirmationId: string,
    confirmed: true
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>>;
  startResponse(
    request: StartResponseRequest
  ): Promise<ChatContextIpcResult<ConversationResponseStartDto>>;
  startWorkflow(
    request: StartWorkflowRequest
  ): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>>;
  answerWorkflow(
    request: AnswerWorkflowRequest
  ): Promise<ChatContextIpcResult<ConversationWorkflowStartDto>>;
  confirmWorkflow(
    workflowId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationWorkflowDto>>;
  cancelWorkflow(
    workflowId: string,
    expectedRevision: number
  ): Promise<ChatContextIpcResult<ConversationWorkflowDto>>;
  getWorkflow(
    workflowId: string
  ): Promise<ChatContextIpcResult<ConversationWorkflowDto>>;
  getPendingWorkflow(
    conversationId: string
  ): Promise<ChatContextIpcResult<ConversationWorkflowDto | null>>;
  getResponseExecution(
    responseExecutionId: string
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>>;
  replayResponseEvents(
    responseExecutionId: string,
    afterSequence: number
  ): Promise<ChatContextIpcResult<readonly ConversationResponseStreamEventDto[]>>;
  cancelResponseExecution(
    responseExecutionId: string
  ): Promise<ChatContextIpcResult<ConversationResponseExecutionDto>>;
  subscribeResponseEvents(
    responseExecutionId: string,
    afterSequence: number,
    onEvent: (event: ConversationResponseStreamEventDto) => void
  ): () => void;
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

function parameterValuesRecord(
  value: unknown
): Readonly<Record<string, string | number | boolean | readonly unknown[] | {
  readonly [key: string]: unknown;
}>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('parameterValues is invalid');
  }
  const entries = Object.entries(value);
  if (entries.length > 100) {
    throw new TypeError('parameterValues is invalid');
  }
  const result: Record<string, string | number | boolean | readonly unknown[] | {
    readonly [key: string]: unknown;
  }> = {};
  for (const [key, entry] of entries) {
    if (
      typeof key !== 'string' ||
      key.trim().length === 0 ||
      key.length > 200 ||
      !isJsonParameterValue(entry)
    ) {
      throw new TypeError('parameterValues is invalid');
    }
    result[key] = entry as string | number | boolean | readonly unknown[] | {
      readonly [key: string]: unknown;
    };
  }
  return result;
}

function isJsonParameterValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return value.length <= 1_000_000;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((entry) => isJsonParameterValue(entry, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    return (
      entries.length <= 100 &&
      entries.every(
        ([key, entry]) =>
          typeof key === 'string' &&
          key.trim().length > 0 &&
          key.length <= 200 &&
          isJsonParameterValue(entry, depth + 1)
      )
    );
  }
  return false;
}
