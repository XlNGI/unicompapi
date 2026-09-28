const documentGenerationLogCodes = [
  'cancelled',
  'generation_failed',
  'revision_scope_violation',
  'write_failed',
  'registration_failed',
  'result_sync_pending',
  'invalid_plan',
  'invalid_outline',
  'storage_error',
  'verification_failed'
] as const;

type DocumentGenerationLogCode = (typeof documentGenerationLogCodes)[number];
type DocumentGenerationDiagnosticCode = 'TOOL_PRECONDITION_FAILED' | 'OUTLINE_INVALID';

export interface DocumentGenerationLogError {
  readonly category: 'document_generation';
  readonly code?: DocumentGenerationLogCode;
  readonly reason?: 'renderer_unavailable' | 'visual_diagnostics';
  readonly diagnosticCode?: DocumentGenerationDiagnosticCode;
}

export function toDocumentGenerationLogError(
  error: unknown
): DocumentGenerationLogError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : '';
  const inferredCode = typeof code === 'string' ? code :
    /tool[_ ]precondition[_ ]failed/i.test(message) ? 'TOOL_PRECONDITION_FAILED' :
      /invalid[_ ]outline|document_plan_validation_failed/i.test(message) ? 'invalid_outline' : undefined;
  const diagnosticCode = inferredCode === 'invalid_outline' || code === 'OUTLINE_INVALID' ? 'OUTLINE_INVALID' :
    inferredCode === 'TOOL_PRECONDITION_FAILED' ? 'TOOL_PRECONDITION_FAILED' : undefined;
  return {
    category: 'document_generation',
    ...(typeof inferredCode === 'string' && documentGenerationLogCodes.includes(
      inferredCode as DocumentGenerationLogCode
    )
      ? { code: inferredCode as DocumentGenerationLogCode }
      : {}),
    ...(code === 'verification_failed' && /renderer is unavailable/i.test(message)
      ? { reason: 'renderer_unavailable' as const }
      : code === 'verification_failed' && /visual diagnostics/i.test(message)
        ? { reason: 'visual_diagnostics' as const }
        : {}),
    ...(diagnosticCode ? { diagnosticCode } : {})
  };
}
