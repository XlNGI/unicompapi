import { documentRevisionOperations, type DocumentRevisionOperation } from './document-intent-plan';

export interface RepairTarget {
  readonly sectionIndex?: number;
  readonly blockIndex?: number;
  readonly itemIndex?: number;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
  readonly pageNumber?: number;
}

export interface RepairOperation {
  readonly operation: DocumentRevisionOperation;
  readonly target: RepairTarget;
  readonly value?: string;
  readonly data?: {
    readonly chartKind: 'bar' | 'pie';
    readonly title?: string;
    readonly points: readonly { readonly label: string; readonly value: number }[];
  };
}

export interface RepairPlan {
  readonly kind: 'repair';
  readonly diagnosisCodes: readonly string[];
  readonly operations: readonly RepairOperation[];
  readonly preserve: readonly string[];
  readonly reason: string;
  readonly expectedRevision?: number;
  readonly targetPages?: readonly number[];
}

const maxOperations = 8;
const maxListItems = 32;

export function parseRepairPlan(value: unknown): RepairPlan {
  const record = requireRecord(value, 'RepairPlan');
  requireExactKeys(record, [
    'kind',
    'diagnosisCodes',
    'operations',
    'preserve',
    'reason',
    'expectedRevision',
    'targetPages'
  ]);
  if (record.kind !== 'repair') throw new TypeError('RepairPlan.kind must be repair');
  const operations = requireArray(record.operations, 'operations');
  if (operations.length === 0 || operations.length > maxOperations) {
    throw new TypeError('RepairPlan.operations has an invalid length');
  }
  const diagnosisCodes = requireTextList(record.diagnosisCodes, 'diagnosisCodes');
  if (diagnosisCodes.length === 0) throw new TypeError('RepairPlan requires diagnosisCodes');
  return {
    kind: 'repair',
    diagnosisCodes,
    operations: operations.map((operation, index) => parseOperation(operation, index)),
    preserve: requireTextList(record.preserve, 'preserve'),
    reason: requireSafeText(record.reason, 'reason'),
    ...(record.expectedRevision !== undefined
      ? { expectedRevision: requireNonNegativeInteger(record.expectedRevision, 'expectedRevision') }
      : {}),
    ...(record.targetPages !== undefined
      ? { targetPages: requirePositiveIntegerList(record.targetPages, 'targetPages') }
      : {})
  };
}

function parseOperation(value: unknown, index: number): RepairOperation {
  const label = `operations[${index}]`;
  const record = requireRecord(value, label);
  requireExactKeys(record, ['operation', 'target', 'value', 'data']);
  if (typeof record.operation !== 'string' || !documentRevisionOperations.includes(record.operation as DocumentRevisionOperation)) {
    throw new TypeError(`${label}.operation is invalid`);
  }
  const operation = record.operation as DocumentRevisionOperation;
  const parsed: RepairOperation = {
    operation,
    target: parseTarget(record.target, `${label}.target`),
    ...(record.value !== undefined ? { value: requireSafeText(record.value, `${label}.value`) } : {}),
    ...(record.data !== undefined ? { data: parseChartData(record.data, `${label}.data`) } : {})
  };
  if (['replace_text', 'insert_text', 'add_section', 'add_column', 'update_table', 'update_cells', 'replace_page_layout'].includes(operation) && parsed.value === undefined) {
    throw new TypeError(`${label}.value is required`);
  }
  if (operation === 'create_chart' && parsed.data === undefined) {
    throw new TypeError(`${label}.data is required`);
  }
  return parsed;
}

function parseTarget(value: unknown, label: string): RepairTarget {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['sectionIndex', 'blockIndex', 'itemIndex', 'rowIndex', 'columnIndex', 'pageNumber']);
  const target: Record<string, number> = {};
  for (const key of ['sectionIndex', 'blockIndex', 'itemIndex', 'rowIndex', 'columnIndex', 'pageNumber'] as const) {
    if (record[key] !== undefined) target[key] = requireNonNegativeInteger(record[key], `${label}.${key}`);
  }
  return target;
}

function parseChartData(value: unknown, label: string): NonNullable<RepairOperation['data']> {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['chartKind', 'title', 'points']);
  if ((record.chartKind !== 'bar' && record.chartKind !== 'pie') || !Array.isArray(record.points) || record.points.length > 50) {
    throw new TypeError(`${label} is invalid`);
  }
  return {
    chartKind: record.chartKind,
    ...(record.title !== undefined ? { title: requireSafeText(record.title, `${label}.title`) } : {}),
    points: record.points.map((point, index) => {
      const item = requireRecord(point, `${label}.points[${index}]`);
      requireExactKeys(item, ['label', 'value']);
      if (typeof item.value !== 'number' || !Number.isFinite(item.value)) throw new TypeError(`${label}.points[${index}].value is invalid`);
      return { label: requireSafeText(item.label, `${label}.points[${index}].label`), value: item.value };
    })
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`unsupported field: ${unsupported}`);
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireText(value: unknown, label: string): string {
  return requireSafeText(value, label);
}

function requireTextList(value: unknown, label: string): readonly string[] {
  const list = requireArray(value, label);
  if (list.length > maxListItems) throw new TypeError(`${label} exceeds the maximum item count`);
  return list.map((item, index) => requireText(item, `${label}[${index}]`));
}

function requireSafeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000) throw new TypeError(`${label} must be a bounded non-blank string`);
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/i.test(value)) throw new TypeError(`${label} must not contain a path or URL`);
  if (/(?:api[_-]?key|token|secret|password|credential)/i.test(value)) throw new TypeError(`${label} contains a protected value`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return Number(value);
}

function requirePositiveIntegerList(value: unknown, label: string): readonly number[] {
  const list = requireArray(value, label);
  if (list.length > maxListItems) throw new TypeError(`${label} exceeds the maximum item count`);
  const parsed = list.map((item, index) => {
    const number = requireNonNegativeInteger(item, `${label}[${index}]`);
    if (number < 1) throw new TypeError(`${label}[${index}] must be positive`);
    return number;
  });
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${label} must not contain duplicates`);
  return parsed;
}
