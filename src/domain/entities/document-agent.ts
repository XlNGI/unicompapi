export const documentToolIds = [
  'extract_source',
  'aggregate_data',
  'generate_chart',
  'select_material',
  'read_document_structure',
  'apply_document_patch',
  'render_preview',
  'inspect_layout'
] as const;
export type DocumentToolId = (typeof documentToolIds)[number];

export type DocumentToolValue = string | number | boolean;
export type DocumentToolInput = Readonly<Record<string, DocumentToolValue>>;

export interface DocumentToolDefinition {
  readonly id: DocumentToolId;
  readonly version: string;
  readonly description: string;
  readonly requiresWrite: boolean;
  readonly supportsCancellation: boolean;
  readonly maxCostUnits: number;
}

export interface DocumentToolRequest {
  readonly toolId: DocumentToolId;
  readonly input: DocumentToolInput;
  readonly reason: string;
}

export const documentAgentStates = [
  'completed',
  'failed',
  'cancelled',
  'max_steps_exceeded',
  'budget_exceeded',
  'timeout',
  'repeated_diagnosis'
] as const;
export type DocumentAgentState = (typeof documentAgentStates)[number];

export interface DocumentToolObservation {
  readonly step: number;
  readonly toolId: DocumentToolId;
  readonly ok: boolean;
  readonly data: Readonly<Record<string, unknown>>;
  readonly diagnostic?: string;
}

export interface DocumentAgentResult {
  readonly state: DocumentAgentState;
  readonly steps: number;
  readonly costUnits: number;
  readonly observations: readonly DocumentToolObservation[];
  readonly summary?: string;
}

export function parseDocumentToolRequest(value: unknown): DocumentToolRequest {
  const record = requireRecord(value, 'DocumentToolRequest');
  requireExactKeys(record, ['toolId', 'input', 'reason']);
  const toolId = requireEnum(record.toolId, documentToolIds, 'toolId');
  const inputRecord = requireRecord(record.input, 'input');
  const input: Record<string, DocumentToolValue> = {};
  for (const [key, raw] of Object.entries(inputRecord)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) {
      throw new TypeError(`input key ${key} is invalid`);
    }
    if (
      typeof raw !== 'string' &&
      typeof raw !== 'number' &&
      typeof raw !== 'boolean'
    ) {
      throw new TypeError(`input.${key} must be scalar`);
    }
    if (typeof raw === 'string') {
      requireSafeText(raw, `input.${key}`);
    }
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      throw new TypeError(`input.${key} must be finite`);
    }
    input[key] = raw;
  }
  return {
    toolId,
    input,
    reason: requireSafeText(record.reason, 'reason')
  };
}

export function createDocumentToolRegistry(): ReadonlyMap<
  DocumentToolId,
  DocumentToolDefinition
> {
  const definitions: readonly DocumentToolDefinition[] = [
    ['extract_source', false, 1],
    ['aggregate_data', false, 2],
    ['generate_chart', true, 3],
    ['select_material', false, 1],
    ['read_document_structure', false, 1],
    ['apply_document_patch', true, 4],
    ['render_preview', false, 2],
    ['inspect_layout', false, 1]
  ].map(([id, requiresWrite, maxCostUnits]) => ({
    id: id as DocumentToolId,
    version: '1.0',
    description: `Controlled ${id} operation`,
    requiresWrite: Boolean(requiresWrite),
    supportsCancellation: true,
    maxCostUnits: Number(maxCostUnits)
  }));
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`unsupported field: ${unsupported}`);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function requireSafeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000) {
    throw new TypeError(`${label} must be a bounded non-blank string`);
  }
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/i.test(value)) {
    throw new TypeError(`${label} must not contain a path or URL`);
  }
  if (/(?:api[_-]?key|token|secret|password|credential)/i.test(value)) {
    throw new TypeError(`${label} contains a protected value`);
  }
  return value;
}
