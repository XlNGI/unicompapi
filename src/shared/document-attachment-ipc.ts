export const documentAttachmentIpcChannels = {
  importAttachment: 'document-attachment:import',
  extractFile: 'document-attachment:extract'
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
  | 'pptx';

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
