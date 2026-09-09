const documentGenerationLogCodes = [
  'cancelled',
  'generation_failed',
  'invalid_plan',
  'storage_error',
  'verification_failed'
] as const;

type DocumentGenerationLogCode = (typeof documentGenerationLogCodes)[number];

export interface DocumentGenerationLogError {
  readonly category: 'document_generation';
  readonly code?: DocumentGenerationLogCode;
}

export function toDocumentGenerationLogError(
  error: unknown
): DocumentGenerationLogError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    category: 'document_generation',
    ...(typeof code === 'string' && documentGenerationLogCodes.includes(
      code as DocumentGenerationLogCode
    )
      ? { code: code as DocumentGenerationLogCode }
      : {})
  };
}
