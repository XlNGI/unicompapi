export const productionTraceIpcChannels = {
  list: 'conversation-production:list', subscribe: 'conversation-production:subscribe',
  unsubscribe: 'conversation-production:unsubscribe', event: 'conversation-production:event'
} as const;

export const productionEventCodes = [
  'request_received', 'source_context', 'model_request', 'model_response', 'plan_validation',
  'plan_decision', 'tool_authorization', 'tool_call', 'tool_result', 'document_compile',
  'document_render', 'document_structure_check', 'document_hash_check', 'document_check',
  'document_register', 'document_publish', 'task_complete'
] as const;
export type ProductionEventCode = (typeof productionEventCodes)[number];
export type ProductionEventStatus = 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
export interface ProductionEventFacts {
  readonly purpose?: 'planning' | 'content' | 'repair' | 'tool' | 'source_summary';
  readonly documentKind?: 'word' | 'excel' | 'ppt';
  readonly planKind?: 'chat' | 'document' | 'unknown';
  readonly action?: 'answer' | 'create' | 'revise' | 'analyze';
  readonly sourcePolicy?: 'none' | 'internal' | 'web' | 'mixed';
  readonly errorCode?: 'TOOL_PRECONDITION_FAILED' | 'OUTLINE_INVALID';
  readonly tool?: 'read_sources' | 'search' | 'analyze' | 'write_document' | 'render' | 'check' | 'publish' | 'patch';
  readonly count?: number;
  readonly pageNumber?: number;
  readonly totalPages?: number;
  readonly bytes?: number;
  readonly missingCount?: number;
  readonly sectionCount?: number;
  readonly contentCharacters?: number;
  readonly designPath?: 'design-aware' | 'legacy-fallback';
  readonly fallbackReason?: string;
  readonly artDirectionStatus?: 'validated' | 'invalid' | 'missing';
  readonly designIrStatus?: 'validated' | 'invalid' | 'missing';
  readonly layoutStatus?: 'success' | 'failed' | 'skipped';
  readonly renderPlanStatus?: 'valid' | 'invalid' | 'skipped';
  readonly diagnosticCode?: string;
  readonly repairAction?: 'reduce_gap' | 'rebalance_regions' | 'reduce_font_size' | 'compatible_composition';
  readonly pageRole?: 'hero' | 'statement' | 'comparison' | 'metric' | 'process' | 'evidence' | 'section' | 'content' | 'closing';
  readonly pageIntentDigest?: string;
  readonly pageIntent?: string;
  readonly composition?: 'single-focus' | 'comparison' | 'evidence-led' | 'sequence' | 'structured';
  readonly selectedLayout?: 'weighted-regions' | 'adaptive-grid' | 'flow-track';
  readonly density?: 'sparse' | 'balanced' | 'dense';
  readonly whitespace?: 'minimal' | 'balanced' | 'generous';
  readonly primaryRegion?: 'left' | 'center' | 'right' | 'top' | 'bottom' | 'leading' | 'trailing' | 'supporting';
  readonly geometrySignature?: string;
  readonly elementCount?: number;
  readonly repairCount?: number;
  readonly fallback?: boolean;
}
export interface ProductionTraceEventDto {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly traceId: string;
  readonly assistantMessageId?: string;
  readonly clientCommandId?: string;
  readonly sequence: number;
  readonly code: ProductionEventCode;
  readonly status: ProductionEventStatus;
  readonly operationId?: string;
  readonly facts?: ProductionEventFacts;
  readonly occurredAt: string;
}
export interface ProductionTraceIssueDto {
  readonly projectId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly traceId: string;
  readonly clientCommandId?: string;
  readonly code: 'recording_unavailable' | 'history_truncated';
}
export type ProductionTraceResult<T> = { readonly ok: true; readonly value: T } |
  { readonly ok: false; readonly error: { readonly code: 'project_not_open' | 'invalid_request' | 'storage_error'; readonly message: string } };
export interface ProductionTraceApi {
  list(conversationId: string): Promise<ProductionTraceResult<readonly ProductionTraceEventDto[]>>;
  subscribe(conversationId: string, afterSequence: number, onEvent: (event: ProductionTraceEventDto) => void,
    onIssue?: (issue: ProductionTraceIssueDto) => void): () => void;
  subscribeCommand(clientCommandId: string, onEvent: (event: ProductionTraceEventDto) => void,
    onIssue?: (issue: ProductionTraceIssueDto) => void): () => void;
}

export function productionTraceIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new TypeError('Invalid production trace identifier');
  }
  return value;
}

export function parseProductionEventFacts(input: unknown): ProductionEventFacts {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Invalid production facts');
  const enums: Record<string, readonly string[]> = {
    purpose: ['planning', 'content', 'repair', 'tool', 'source_summary'], documentKind: ['word', 'excel', 'ppt'],
    planKind: ['chat', 'document', 'unknown'], action: ['answer', 'create', 'revise', 'analyze'],
    sourcePolicy: ['none', 'internal', 'web', 'mixed'],
    errorCode: ['TOOL_PRECONDITION_FAILED', 'OUTLINE_INVALID'],
    tool: ['read_sources', 'search', 'analyze', 'write_document', 'render', 'check', 'publish', 'patch'],
    designPath: ['design-aware', 'legacy-fallback'],
    artDirectionStatus: ['validated', 'invalid', 'missing'],
    designIrStatus: ['validated', 'invalid', 'missing'],
    layoutStatus: ['success', 'failed', 'skipped'],
    renderPlanStatus: ['valid', 'invalid', 'skipped'],
    repairAction: ['reduce_gap', 'rebalance_regions', 'reduce_font_size', 'compatible_composition'],
    pageRole: ['hero', 'statement', 'comparison', 'metric', 'process', 'evidence', 'section', 'content', 'closing'],
    composition: ['single-focus', 'comparison', 'evidence-led', 'sequence', 'structured'],
    selectedLayout: ['weighted-regions', 'adaptive-grid', 'flow-track'],
    density: ['sparse', 'balanced', 'dense'],
    whitespace: ['minimal', 'balanced', 'generous'],
    primaryRegion: ['left', 'center', 'right', 'top', 'bottom', 'leading', 'trailing', 'supporting']
  };
  const counts = ['count', 'pageNumber', 'totalPages', 'bytes', 'missingCount', 'sectionCount', 'contentCharacters', 'elementCount', 'repairCount'];
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (enums[key]?.includes(value as string)) result[key] = value as string;
    else if (counts.includes(key) && Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000) result[key] = value as number;
    else if (key === 'fallback' && typeof value === 'boolean') result[key] = value;
    else if (key === 'diagnosticCode' && typeof value === 'string' && /^[a-z0-9_-]{1,80}$/u.test(value)) result[key] = value;
    else if (key === 'pageIntentDigest' && typeof value === 'string' && /^sha256:[a-f0-9]{20}$/u.test(value)) result[key] = value;
    else if (key === 'pageIntent' && typeof value === 'string' && value.trim().length > 0 && value.length <= 600 && !/[\u0000-\u001f]/u.test(value)) { /* Read legacy traces without replaying their raw intent. */ }
    else if (key === 'fallbackReason' && typeof value === 'string' && /^[a-z0-9_-]{1,80}$/u.test(value)) result[key] = value;
    else if (key === 'geometrySignature' && typeof value === 'string' && /^sha256:[a-f0-9]{20}$/u.test(value)) result[key] = value;
    else throw new TypeError('Unsupported production fact');
  }
  return result as ProductionEventFacts;
}

export function parseProductionTraceEvent(input: unknown): ProductionTraceEventDto {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Invalid production event');
  const item = input as Record<string, unknown>;
  const allowed = ['schemaVersion', 'projectId', 'conversationId', 'sourceMessageId', 'traceId', 'assistantMessageId',
    'clientCommandId', 'sequence', 'code', 'status', 'operationId', 'facts', 'occurredAt'];
  if (Object.keys(item).some((key) => !allowed.includes(key)) || item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 ||
    !productionEventCodes.includes(item.code as ProductionEventCode) ||
    !['started', 'progress', 'completed', 'failed', 'cancelled'].includes(item.status as string) ||
    typeof item.occurredAt !== 'string' || !Number.isFinite(Date.parse(item.occurredAt))) throw new TypeError('Invalid production event');
  return {
    schemaVersion: 1, projectId: productionTraceIdentifier(item.projectId), conversationId: productionTraceIdentifier(item.conversationId),
    sourceMessageId: productionTraceIdentifier(item.sourceMessageId), traceId: productionTraceIdentifier(item.traceId),
    ...(item.assistantMessageId !== undefined ? { assistantMessageId: productionTraceIdentifier(item.assistantMessageId) } : {}),
    ...(item.clientCommandId !== undefined ? { clientCommandId: productionTraceIdentifier(item.clientCommandId) } : {}),
    sequence: item.sequence as number, code: item.code as ProductionEventCode, status: item.status as ProductionEventStatus,
    ...(item.operationId !== undefined ? { operationId: productionTraceIdentifier(item.operationId) } : {}),
    ...(item.facts !== undefined ? { facts: parseProductionEventFacts(item.facts) } : {}), occurredAt: item.occurredAt
  };
}
