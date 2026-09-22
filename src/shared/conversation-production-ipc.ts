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
  readonly tool?: 'read_sources' | 'search' | 'analyze' | 'write_document' | 'render' | 'check' | 'publish' | 'patch';
  readonly count?: number;
  readonly pageNumber?: number;
  readonly totalPages?: number;
  readonly bytes?: number;
  readonly missingCount?: number;
  readonly sectionCount?: number;
  readonly contentCharacters?: number;
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
    tool: ['read_sources', 'search', 'analyze', 'write_document', 'render', 'check', 'publish', 'patch']
  };
  const counts = ['count', 'pageNumber', 'totalPages', 'bytes', 'missingCount', 'sectionCount', 'contentCharacters'];
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (enums[key]?.includes(value as string)) result[key] = value as string;
    else if (counts.includes(key) && Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000) result[key] = value as number;
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
