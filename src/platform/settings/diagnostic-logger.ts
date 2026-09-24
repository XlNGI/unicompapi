export const diagnosticEventCodes = [
  'process.uncaught_exception',
  'process.unhandled_rejection',
  'provider.request_started',
  'provider.request_completed',
  'provider.request_failed',
  'provider.runtime_disposed',
  'chat.request_blocked'
] as const;

export type DiagnosticEventCode = (typeof diagnosticEventCodes)[number];
export type DiagnosticFactValue = string | number | boolean;

export interface DiagnosticLogInput {
  readonly code: DiagnosticEventCode;
  readonly facts?: Readonly<Record<string, unknown>>;
}

export interface NormalizedDiagnosticEvent {
  readonly code: DiagnosticEventCode;
  readonly category:
    | 'application'
    | 'tasks'
    | 'media'
    | 'networkErrors'
    | 'connectionValidation'
    | 'crashDiagnostics';
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly facts: Readonly<Record<string, DiagnosticFactValue>>;
}

interface DiagnosticEventSpec {
  readonly category: NormalizedDiagnosticEvent['category'];
  readonly level: NormalizedDiagnosticEvent['level'];
  readonly factKeys: readonly string[];
}

const eventCatalog: Readonly<Record<DiagnosticEventCode, DiagnosticEventSpec>> = {
  'process.uncaught_exception': {
    category: 'crashDiagnostics',
    level: 'error',
    factKeys: ['name']
  },
  'process.unhandled_rejection': {
    category: 'crashDiagnostics',
    level: 'error',
    factKeys: ['name']
  },
  'provider.request_started': {
    category: 'application',
    level: 'debug',
    factKeys: ['operation', 'method']
  },
  'provider.request_completed': {
    category: 'application',
    level: 'info',
    factKeys: ['operation', 'method', 'status', 'elapsedMs', 'requestBytes', 'requestId']
  },
  'provider.request_failed': {
    category: 'networkErrors',
    level: 'error',
    factKeys: [
      'operation',
      'method',
      'status',
      'errorCode',
      'elapsedMs',
      'requestBytes',
      'requestId',
      'upstreamCode',
      'upstreamType'
    ]
  },
  'provider.runtime_disposed': {
    category: 'application',
    level: 'info',
    factKeys: []
  },
  'chat.request_blocked': {
    category: 'application',
    level: 'warn',
    factKeys: ['reason']
  }
};

const tokenPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const namePattern = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const chatBlockedReasons = new Set([
  'subject_invalid',
  'candidate_not_found',
  'candidate_unavailable',
  'route_selection_invalid',
  'route_selection_expired',
  'route_selection_consumed',
  'stale_route_selection',
  'confirmation_required',
  'runtime_not_allowed',
  'adapter_unavailable',
  'attachment_unavailable',
  'attachment_unsupported',
  'attachment_changed',
  'attachment_scope_exceeded',
  'native_search_authorization_required'
]);

export function normalizeDiagnosticEvent(
  input: DiagnosticLogInput
): NormalizedDiagnosticEvent | undefined {
  const spec = eventCatalog[input?.code];
  if (!spec) return undefined;
  const facts: Record<string, DiagnosticFactValue> = {};
  const source = input.facts ?? {};
  for (const key of spec.factKeys) {
    const value = sanitizeFact(key, source[key]);
    if (value !== undefined) facts[key] = value;
  }
  return {
    code: input.code,
    category: spec.category,
    level: spec.level,
    facts
  };
}

export function diagnosticErrorName(reason: unknown): string {
  if (reason instanceof Error && namePattern.test(reason.name)) return reason.name;
  const constructorName = reason instanceof Error ? reason.constructor.name : undefined;
  if (typeof constructorName === 'string' && namePattern.test(constructorName)) {
    return constructorName;
  }
  return 'Error';
}

export interface ProviderDiagnosticSourceEvent {
  readonly event: 'request_started' | 'request_completed' | 'request_failed' | 'runtime_disposed';
  readonly operation?: string;
  readonly method?: string;
  readonly status?: number;
  readonly errorCode?: string;
  readonly upstreamCode?: string;
  readonly upstreamType?: string;
  readonly requestId?: string;
  readonly requestBytes?: number;
  readonly elapsedMs?: number;
}

export function toProviderDiagnostic(
  event: ProviderDiagnosticSourceEvent
): DiagnosticLogInput | undefined {
  const code = `provider.${event.event}` as DiagnosticEventCode;
  if (!(code in eventCatalog)) return undefined;
  return {
    code,
    facts: {
      operation: event.operation,
      method: event.method,
      status: event.status,
      errorCode: event.errorCode,
      upstreamCode: event.upstreamCode,
      upstreamType: event.upstreamType,
      requestId: event.requestId,
      requestBytes: event.requestBytes,
      elapsedMs: event.elapsedMs
    }
  };
}

export function toChatBlockedDiagnostic(error: unknown): DiagnosticLogInput | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (error.name === 'FeatureSubmissionError' && code && chatBlockedReasons.has(code)) {
    return { code: 'chat.request_blocked', facts: { reason: code } };
  }
  if (error.name === 'RuntimeAuthorizationDeniedError' || code === 'runtime_not_allowed') {
    return { code: 'chat.request_blocked', facts: { reason: 'runtime_not_allowed' } };
  }
  if (error.name === 'SubmissionOrchestrationError' && code === 'authorization_not_claimed') {
    return { code: 'chat.request_blocked', facts: { reason: 'runtime_not_allowed' } };
  }
  if (error.name === 'SubmissionOrchestrationError' && code === 'adapter_contract_invalid') {
    return { code: 'chat.request_blocked', facts: { reason: 'adapter_unavailable' } };
  }
  if (error.name === 'ConversationAttachmentError' && code && chatBlockedReasons.has(code)) {
    return { code: 'chat.request_blocked', facts: { reason: code } };
  }
  if (
    error.name === 'NativeSearchAuthorizationError' ||
    code === 'native_search_authorization_required'
  ) {
    return { code: 'chat.request_blocked', facts: { reason: 'native_search_authorization_required' } };
  }
  return undefined;
}

function sanitizeFact(key: string, value: unknown): DiagnosticFactValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (key === 'status' || key === 'elapsedMs' || key === 'requestBytes') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const maximum = key === 'status' ? 999 : key === 'elapsedMs' ? 86_400_000 : 1_000_000_000_000;
    if (value < 0 || value > maximum) return undefined;
    return Math.round(value);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.slice(0, 128);
  if (key === 'method') return trimmed === 'GET' || trimmed === 'POST' ? trimmed : undefined;
  if (key === 'name') return namePattern.test(trimmed) ? trimmed : undefined;
  if (key === 'requestId') return requestIdPattern.test(trimmed) ? trimmed : undefined;
  if (
    key === 'operation' ||
    key === 'errorCode' ||
    key === 'reason' ||
    key === 'upstreamCode' ||
    key === 'upstreamType'
  ) {
    return tokenPattern.test(trimmed) ? trimmed : undefined;
  }
  return undefined;
}
