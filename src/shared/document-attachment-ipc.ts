export const documentAttachmentIpcChannels = {
  importAttachment: 'document-attachment:import',
  extractFile: 'document-attachment:extract',
  extractTheme: 'document-attachment:extract-theme',
  retrieveContext: 'document-attachment:retrieve-context'
} as const;

export type DocumentAttachmentIpcErrorCode =
  | 'invalid_request'
  | 'project_not_open'
  | 'source_unavailable'
  | 'unsupported_format'
  | 'too_large'
  | 'extraction_failed'
  | 'storage_error';

export type DocumentAttachmentFormat =
  | 'txt'
  | 'md'
  | 'csv'
  | 'docx'
  | 'pdf'
  | 'xlsx'
  | 'pptx'
  | 'epub';

export type DocumentExtractionStatus =
  | 'extracted'
  | 'unsupported'
  | 'too_large'
  | 'encrypted'
  | 'scanned_pdf'
  | 'failed';

export interface DocumentExtractionStats {
  readonly characters: number;
  readonly paragraphs?: number;
  readonly pages?: number;
  readonly tables?: number;
}

export interface DocumentExtractionDto {
  readonly fileId: string;
  readonly format: DocumentAttachmentFormat;
  readonly status: DocumentExtractionStatus;
  readonly stats: DocumentExtractionStats;
  readonly preview: string;
  readonly warnings: readonly string[];
}

export interface DocumentAttachmentImportDto {
  readonly fileId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly extraction: DocumentExtractionDto;
}

export type DocumentAttachmentIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: DocumentAttachmentIpcErrorCode;
        readonly message: string;
      };
    };

export interface AttachmentImportRequest {
  readonly sourcePath: string;
}

export interface FileExtractionRequest {
  readonly fileId: string;
}

export interface DocumentThemeColorsDto {
  readonly accent: string;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
}

export interface RagContextRequest {
  readonly query: string;
  readonly k?: number;
}

export type RagSourceKind =
  | 'project_attachment'
  | 'product_information'
  | 'brand_guideline'
  | 'template_metadata'
  | 'confirmed_history';

export interface RagContextChunkDto {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceKind: RagSourceKind;
  readonly source: string;
  readonly text: string;
  readonly contentHash: string;
  readonly indexVersion: string;
  readonly score: number;
  readonly rank: number;
  readonly fileId?: string;
  readonly page?: number;
  readonly sheet?: string;
  readonly section?: string;
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

export const documentAttachmentRequestParsers = {
  importAttachment(value: unknown): AttachmentImportRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid attachment import request');
    }
    return { sourcePath: requireString(value.sourcePath, 'sourcePath') };
  },
  extractFile(value: unknown): FileExtractionRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid file extraction request');
    }
    return { fileId: requireString(value.fileId, 'fileId') };
  },
  extractTheme(value: unknown): FileExtractionRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid theme extraction request');
    }
    return { fileId: requireString(value.fileId, 'fileId') };
  },
  retrieveContext(value: unknown): RagContextRequest {
    if (!isRecord(value)) {
      throw new TypeError('Invalid context retrieval request');
    }
    const k = value.k === undefined ? undefined : value.k;
    if (
      k !== undefined &&
      (!Number.isSafeInteger(k) || Number(k) < 1 || Number(k) > 10)
    ) {
      throw new TypeError('k must be an integer between 1 and 10');
    }
    return {
      query: requireString(value.query, 'query'),
      ...(k !== undefined ? { k: Number(k) } : {})
    };
  }
};

export interface DocumentAttachmentApi {
  importAttachment(
    request: AttachmentImportRequest
  ): Promise<DocumentAttachmentIpcResult<DocumentAttachmentImportDto>>;
  extractFile(
    request: FileExtractionRequest
  ): Promise<DocumentAttachmentIpcResult<DocumentExtractionDto>>;
  extractTheme(
    request: FileExtractionRequest
  ): Promise<DocumentAttachmentIpcResult<DocumentThemeColorsDto>>;
  retrieveContext(
    request: RagContextRequest
  ): Promise<DocumentAttachmentIpcResult<readonly RagContextChunkDto[]>>;
}
