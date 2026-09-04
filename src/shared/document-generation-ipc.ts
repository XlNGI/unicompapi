export const documentGenerationIpcChannels = {
  prepareGeneration: 'document-generation:prepare-generation',
  reconcileGeneration: 'document-generation:reconcile-generation',
  generateFromMessage: 'document-generation:generate-from-message',
  cancelGeneration: 'document-generation:cancel-generation',
  openDocument: 'document-generation:open-document'
} as const;

export const presentationTemplateIds = [
  'work_report',
  'natural_minimal',
  'business_minimal',
  'technology',
  'financing'
] as const;

export type PresentationTemplateId = (typeof presentationTemplateIds)[number];

export type DocumentGenerationIpcErrorCode =
  | 'invalid_request'
  | 'project_not_open'
  | 'conversation_not_found'
  | 'conversation_not_active'
  | 'revision_conflict'
  | 'invalid_outline'
  | 'page_count_mismatch'
  | 'document_layout_overflow'
  | 'generation_cancelled'
  | 'generation_failed'
  | 'ai_images_unavailable'
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

export interface DocumentGenerationCancelResultDto {
  readonly cancelled: boolean;
}

export interface DocumentGenerationFromMessageRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly theme?: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly presentationTemplate?: PresentationTemplateId;
  readonly images?: readonly {
    readonly fileId?: string;
    readonly workId?: string;
    readonly caption?: string;
  }[];
  readonly aiImages?: boolean;
}

export interface DocumentGenerationPrepareRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly parentWorkId?: string;
}

export interface DocumentGenerationPrepareResultDto {
  readonly prepared: true;
}

export interface DocumentGenerationReconcileRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
}

export interface DocumentGenerationReconcileResultDto {
  readonly interrupted: boolean;
}

export interface DocumentGenerationCancelRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly messageId: string;
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
  prepareGeneration(value: unknown): DocumentGenerationPrepareRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid document generation preparation request');
    }
    requireExactKeys(
      value,
      ['conversationId', 'expectedRevision', 'messageId', 'kind'],
      'prepareGeneration'
    );
    return {
      conversationId: requireString(value.conversationId, 'conversationId'),
      expectedRevision: requireNonNegativeInteger(
        value.expectedRevision,
        'expectedRevision'
      ),
      messageId: requireString(value.messageId, 'messageId'),
      kind: requireKind(value.kind)
    };
  },
  reconcileGeneration(value: unknown): DocumentGenerationReconcileRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid document generation reconciliation request');
    }
    requireExactKeys(
      value,
      ['conversationId', 'expectedRevision', 'messageId'],
      'reconcileGeneration'
    );
    return {
      conversationId: requireString(value.conversationId, 'conversationId'),
      expectedRevision: requireNonNegativeInteger(
        value.expectedRevision,
        'expectedRevision'
      ),
      messageId: requireString(value.messageId, 'messageId')
    };
  },
  generateFromMessage(value: unknown): DocumentGenerationFromMessageRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid document generation from message request');
    }
    requireExactKeys(
      value,
      [
        'conversationId',
        'expectedRevision',
        'messageId',
        'kind',
        'parentWorkId',
        'theme',
        'presentationTemplate',
        'images',
        'aiImages'
      ],
      'generateFromMessage'
    );
    const kind = requireKind(value.kind);
    const theme =
      value.theme === undefined ? undefined : requireTheme(value.theme);
    const presentationTemplate = resolvePresentationTemplate(
      kind,
      value.presentationTemplate,
      theme
    );
    if (value.aiImages !== undefined && typeof value.aiImages !== 'boolean') {
      throw new TypeError('aiImages must be a boolean');
    }
    return {
      conversationId: requireString(value.conversationId, 'conversationId'),
      expectedRevision: requireNonNegativeInteger(
        value.expectedRevision,
        'expectedRevision'
      ),
      messageId: requireString(value.messageId, 'messageId'),
      kind,
      ...(value.parentWorkId !== undefined
        ? { parentWorkId: requireString(value.parentWorkId, 'parentWorkId') }
        : {}),
      ...(theme !== undefined ? { theme } : {}),
      ...(presentationTemplate !== undefined
        ? { presentationTemplate }
        : {}),
      ...(value.images !== undefined
        ? { images: parseImages(value.images) }
        : {}),
      ...(value.aiImages !== undefined
        ? { aiImages: value.aiImages }
        : {})
    };
  },
  cancelGeneration(value: unknown): DocumentGenerationCancelRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid document generation cancellation request');
    }
    requireExactKeys(
      value,
      ['conversationId', 'expectedRevision', 'messageId'],
      'cancelGeneration'
    );
    return {
      conversationId: requireString(value.conversationId, 'conversationId'),
      expectedRevision: requireNonNegativeInteger(
        value.expectedRevision,
        'expectedRevision'
      ),
      messageId: requireString(value.messageId, 'messageId')
    };
  },
  openDocument(value: unknown): OpenDocumentRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid open document request');
    }
    requireExactKeys(value, ['workId'], 'openDocument');
    return { workId: requireString(value.workId, 'workId') };
  }
};

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) {
    throw new TypeError(`${label} contains unsupported field ${unsupported}`);
  }
}

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
): 'blueprint' | 'ink' | 'forest' | 'financing' {
  if (
    value !== 'blueprint' &&
    value !== 'ink' &&
    value !== 'forest' &&
    value !== 'financing'
  ) {
    throw new TypeError('theme must be blueprint, ink, forest or financing');
  }
  return value;
}

function resolvePresentationTemplate(
  kind: 'word' | 'excel' | 'ppt',
  value: unknown,
  legacyTheme: 'blueprint' | 'ink' | 'forest' | 'financing' | undefined
): PresentationTemplateId | undefined {
  if (kind !== 'ppt') {
    if (value !== undefined) {
      throw new TypeError('presentationTemplate is only valid for ppt');
    }
    return undefined;
  }
  if (value === undefined) {
    return legacyTheme === 'financing' ? 'financing' : 'work_report';
  }
  if (
    typeof value !== 'string' ||
    !presentationTemplateIds.includes(value as PresentationTemplateId)
  ) {
    throw new TypeError(
      'presentationTemplate must be work_report, natural_minimal, business_minimal, technology or financing'
    );
  }
  return value as PresentationTemplateId;
}

function parseImages(
  value: unknown
): readonly {
  readonly fileId?: string;
  readonly workId?: string;
  readonly caption?: string;
}[] {
  if (!Array.isArray(value)) {
    throw new TypeError('images must be an array');
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new TypeError(`images[${index}] must be an object`);
    }
    requireExactKeys(item, ['fileId', 'workId', 'caption'], `images[${index}]`);
    const fileId = item.fileId === undefined ? undefined : requireString(item.fileId, `images[${index}].fileId`);
    const workId = item.workId === undefined ? undefined : requireString(item.workId, `images[${index}].workId`);
    if (!fileId && !workId) {
      throw new TypeError(`images[${index}] requires fileId or workId`);
    }
    return {
      ...(fileId !== undefined ? { fileId } : {}),
      ...(workId !== undefined ? { workId } : {}),
      ...(item.caption !== undefined
        ? { caption: requireString(item.caption, `images[${index}].caption`) }
        : {})
    };
  });
}

export interface DocumentGenerationApi {
  prepareGeneration(
    request: DocumentGenerationPrepareRequest
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationPrepareResultDto>>;
  reconcileGeneration(
    request: DocumentGenerationReconcileRequest
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationReconcileResultDto>>;
  generateFromMessage(
    request: DocumentGenerationFromMessageRequest
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationFromConversationDto>>;
  cancelGeneration(
    request: DocumentGenerationCancelRequest
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationCancelResultDto>>;
  openDocument(
    workId: string
  ): Promise<DocumentGenerationIpcResult<DocumentOpenResultDto>>;
}
