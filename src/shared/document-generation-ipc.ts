export const documentGenerationIpcChannels = {
  generateFromConversation: 'document-generation:generate-from-conversation',
  generateFromMessage: 'document-generation:generate-from-message',
  openDocument: 'document-generation:open-document'
} as const;

export type DocumentGenerationIpcErrorCode =
  | 'invalid_request'
  | 'project_not_open'
  | 'conversation_not_found'
  | 'conversation_not_active'
  | 'revision_conflict'
  | 'invalid_outline'
  | 'generation_failed'
  | 'work_not_found'
  | 'file_unavailable'
  | 'storage_error';

export type DocumentGenerationIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: DocumentGenerationIpcErrorCode;
        readonly message: string;
      };
    };

export interface DocumentGenerationFromConversationDto {
  readonly conversationId: string;
  readonly messageId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

export interface DocumentOpenResultDto {
  readonly opened: boolean;
}

export interface DocumentGenerationRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly title: string;
  readonly outlineJson: string;
  readonly contentFingerprint: string;
  readonly draftRevision: number;
  readonly sourceDraftId: string;
  readonly theme?: 'blueprint' | 'ink' | 'forest';
}

export interface DocumentGenerationFromMessageRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly theme?: 'blueprint' | 'ink' | 'forest';
}

export interface OpenDocumentRequest {
  readonly workId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

export const documentGenerationRequestParsers = {
  generateFromConversation(value: unknown): DocumentGenerationRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid document generation request');
    }
    return {
      conversationId: requireString(value.conversationId, 'conversationId'),
      expectedRevision: requireNonNegativeInteger(
        value.expectedRevision,
        'expectedRevision'
      ),
      kind: requireKind(value.kind),
      title: requireString(value.title, 'title'),
      outlineJson: requireString(value.outlineJson, 'outlineJson'),
      contentFingerprint: requireString(
        value.contentFingerprint,
        'contentFingerprint'
      ),
      draftRevision: requireNonNegativeInteger(
        value.draftRevision,
        'draftRevision'
      ),
      sourceDraftId: requireString(value.sourceDraftId, 'sourceDraftId'),
      ...(value.theme !== undefined
        ? { theme: requireTheme(value.theme) }
        : {})
    };
  },
  generateFromMessage(value: unknown): DocumentGenerationFromMessageRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid document generation from message request');
    }
    return {
      conversationId: requireString(value.conversationId, 'conversationId'),
      expectedRevision: requireNonNegativeInteger(
        value.expectedRevision,
        'expectedRevision'
      ),
      messageId: requireString(value.messageId, 'messageId'),
      kind: requireKind(value.kind),
      ...(value.theme !== undefined
        ? { theme: requireTheme(value.theme) }
        : {})
    };
  },
  openDocument(value: unknown): OpenDocumentRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid open document request');
    }
    return { workId: requireString(value.workId, 'workId') };
  }
};

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function requireKind(value: unknown): 'word' | 'excel' | 'ppt' {
  if (value !== 'word' && value !== 'excel' && value !== 'ppt') {
    throw new TypeError('kind must be word, excel or ppt');
  }
  return value;
}

function requireTheme(
  value: unknown
): 'blueprint' | 'ink' | 'forest' {
  if (value !== 'blueprint' && value !== 'ink' && value !== 'forest') {
    throw new TypeError('theme must be blueprint, ink or forest');
  }
  return value;
}

export interface DocumentGenerationApi {
  generateFromConversation(
    request: DocumentGenerationRequest
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationFromConversationDto>>;
  generateFromMessage(
    request: DocumentGenerationFromMessageRequest
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationFromConversationDto>>;
  openDocument(
    workId: string
  ): Promise<DocumentGenerationIpcResult<DocumentOpenResultDto>>;
}
