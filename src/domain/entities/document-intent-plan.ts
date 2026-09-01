import type { DocumentWorkspaceKind } from './document-generation';

export const documentIntentTasks = ['chat', 'create', 'revise'] as const;
export type DocumentIntentTask = (typeof documentIntentTasks)[number];

export const documentIntentSourcePolicies = [
  'internal_only',
  'web_only',
  'mixed'
] as const;
export type DocumentIntentSourcePolicy =
  (typeof documentIntentSourcePolicies)[number];

export const documentIntentConfidenceLevels = ['high', 'medium', 'low'] as const;
export type DocumentIntentConfidence =
  (typeof documentIntentConfidenceLevels)[number];

export interface DocumentIntentTargetHint {
  readonly documentName?: string;
  readonly ordinal?: number;
}

export interface DocumentIntentPlan {
  readonly task: DocumentIntentTask;
  readonly documentKind?: DocumentWorkspaceKind | 'auto';
  readonly topic?: string;
  readonly audience?: string;
  readonly purpose?: string;
  readonly pageCount?: number;
  readonly style?: string;
  readonly sourcePolicy: DocumentIntentSourcePolicy;
  readonly constraints: readonly string[];
  readonly missing: readonly string[];
  readonly ambiguities: readonly string[];
  readonly confidence: DocumentIntentConfidence;
  readonly target?: DocumentIntentTargetHint;
}

export const documentRevisionOperations = [
  'replace_text',
  'insert_text',
  'delete_text',
  'clear_section',
  'replace_page_layout',
  'add_section',
  'remove_section',
  'update_table',
  'add_column',
  'update_cells',
  'create_chart',
  'set_style'
] as const;
export type DocumentRevisionOperation =
  (typeof documentRevisionOperations)[number];

export interface DocumentRevisionScope {
  readonly pages?: readonly number[];
  readonly sections?: readonly string[];
  readonly tables?: readonly string[];
  readonly cells?: readonly string[];
}

export interface DocumentRevisionPlan {
  readonly task: 'revise';
  readonly documentKind: DocumentWorkspaceKind;
  readonly target?: DocumentIntentTargetHint;
  readonly scope: DocumentRevisionScope;
  readonly operations: readonly {
    readonly operation: DocumentRevisionOperation;
    readonly target: string;
    readonly value?: string;
  }[];
  readonly preserve: readonly string[];
  readonly confidence: DocumentIntentConfidence;
  readonly missing: readonly string[];
  readonly ambiguities: readonly string[];
}

export type DocumentIntentReadiness =
  | 'ready'
  | 'needs_confirmation'
  | 'needs_clarification';

export interface DocumentIntentAssessment {
  readonly readiness: DocumentIntentReadiness;
  readonly reasons: readonly string[];
}

const maxTextLength = 2_000;
const maxListItems = 32;
const maxPageCount = 500;

export function parseDocumentIntentPlan(value: unknown): DocumentIntentPlan {
  const record = requireRecord(value, 'DocumentIntentPlan');
  requireExactKeys(record, [
    'task',
    'documentKind',
    'topic',
    'audience',
    'purpose',
    'pageCount',
    'style',
    'sourcePolicy',
    'constraints',
    'missing',
    'ambiguities',
    'confidence',
    'target'
  ]);

  const task = requireEnum(record.task, documentIntentTasks, 'task');
  const documentKind = record.documentKind === undefined
    ? undefined
    : requireEnum(
        record.documentKind,
        ['auto', 'word', 'excel', 'ppt'] as const,
        'documentKind'
      );
  const plan: DocumentIntentPlan = {
    task,
    ...(documentKind !== undefined ? { documentKind } : {}),
    ...(record.topic !== undefined
      ? { topic: requireText(record.topic, 'topic') }
      : {}),
    ...(record.audience !== undefined
      ? { audience: requireText(record.audience, 'audience') }
      : {}),
    ...(record.purpose !== undefined
      ? { purpose: requireText(record.purpose, 'purpose') }
      : {}),
    ...(record.pageCount !== undefined
      ? { pageCount: requirePageCount(record.pageCount) }
      : {}),
    ...(record.style !== undefined
      ? { style: requireText(record.style, 'style') }
      : {}),
    sourcePolicy: requireEnum(
      record.sourcePolicy,
      documentIntentSourcePolicies,
      'sourcePolicy'
    ),
    constraints: requireTextList(record.constraints, 'constraints'),
    missing: requireTextList(record.missing, 'missing'),
    ambiguities: requireTextList(record.ambiguities, 'ambiguities'),
    confidence: requireEnum(
      record.confidence,
      documentIntentConfidenceLevels,
      'confidence'
    ),
    ...(record.target !== undefined
      ? { target: parseTargetHint(record.target) }
      : {})
  };

  if (task === 'chat' && plan.documentKind !== undefined) {
    throw new TypeError('chat intent must not choose a document kind');
  }
  if (task !== 'chat' && plan.documentKind === undefined) {
    throw new TypeError('document intent requires documentKind');
  }
  return plan;
}

export function parseDocumentRevisionPlan(
  value: unknown
): DocumentRevisionPlan {
  const record = requireRecord(value, 'RevisionPlan');
  requireExactKeys(record, [
    'task',
    'documentKind',
    'target',
    'scope',
    'operations',
    'preserve',
    'confidence',
    'missing',
    'ambiguities'
  ]);
  if (record.task !== 'revise') {
    throw new TypeError('RevisionPlan.task must be revise');
  }
  const operations = requireArray(record.operations, 'operations');
  if (operations.length === 0 || operations.length > maxListItems) {
    throw new TypeError('RevisionPlan.operations has an invalid length');
  }
  return {
    task: 'revise',
    documentKind: requireEnum(
      record.documentKind,
      ['word', 'excel', 'ppt'] as const,
      'documentKind'
    ),
    ...(record.target !== undefined
      ? { target: parseTargetHint(record.target) }
      : {}),
    scope: parseRevisionScope(record.scope),
    operations: operations.map((item, index) =>
      parseRevisionOperation(item, index)
    ),
    preserve: requireTextList(record.preserve, 'preserve'),
    confidence: requireEnum(
      record.confidence,
      documentIntentConfidenceLevels,
      'confidence'
    ),
    missing: requireTextList(record.missing, 'missing'),
    ambiguities: requireTextList(record.ambiguities, 'ambiguities')
  };
}

export function assessDocumentIntentPlan(
  plan: DocumentIntentPlan,
  options: { readonly externalSearchAuthorized?: boolean } = {}
): DocumentIntentAssessment {
  const reasons = [...plan.missing, ...plan.ambiguities];
  if (
    plan.sourcePolicy !== 'internal_only' &&
    !options.externalSearchAuthorized
  ) {
    reasons.push('external_search_authorization');
  }
  if (plan.confidence === 'low' || plan.ambiguities.length > 0) {
    return { readiness: 'needs_clarification', reasons };
  }
  if (reasons.length > 0) {
    return { readiness: 'needs_clarification', reasons };
  }
  if (plan.confidence === 'medium' || plan.sourcePolicy !== 'internal_only') {
    return {
      readiness: 'needs_confirmation',
      reasons: plan.sourcePolicy === 'internal_only'
        ? []
        : ['external_search_authorization']
    };
  }
  return { readiness: 'ready', reasons: [] };
}

function parseTargetHint(value: unknown): DocumentIntentTargetHint {
  const record = requireRecord(value, 'target');
  requireExactKeys(record, ['documentName', 'ordinal']);
  const target: DocumentIntentTargetHint = {
    ...(record.documentName !== undefined
      ? { documentName: requireText(record.documentName, 'target.documentName') }
      : {}),
    ...(record.ordinal !== undefined
      ? { ordinal: requirePositiveInteger(record.ordinal, 'target.ordinal') }
      : {})
  };
  if (target.documentName === undefined && target.ordinal === undefined) {
    throw new TypeError('target requires documentName or ordinal');
  }
  return target;
}

function parseRevisionScope(value: unknown): DocumentRevisionScope {
  const record = requireRecord(value, 'scope');
  requireExactKeys(record, ['pages', 'sections', 'tables', 'cells']);
  return {
    ...(record.pages !== undefined
      ? { pages: requirePositiveIntegerList(record.pages, 'scope.pages') }
      : {}),
    ...(record.sections !== undefined
      ? { sections: requireTextList(record.sections, 'scope.sections') }
      : {}),
    ...(record.tables !== undefined
      ? { tables: requireTextList(record.tables, 'scope.tables') }
      : {}),
    ...(record.cells !== undefined
      ? { cells: requireTextList(record.cells, 'scope.cells') }
      : {})
  };
}

function parseRevisionOperation(
  value: unknown,
  index: number
): DocumentRevisionPlan['operations'][number] {
  const record = requireRecord(value, `operations[${index}]`);
  requireExactKeys(record, ['operation', 'target', 'value']);
  return {
    operation: requireEnum(
      record.operation,
      documentRevisionOperations,
      `operations[${index}].operation`
    ),
    target: requireText(record.target, `operations[${index}].target`),
    ...(record.value !== undefined
      ? { value: requireText(record.value, `operations[${index}].value`) }
      : {})
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`unsupported field: ${unsupported}`);
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  if (value.length > maxTextLength) {
    throw new TypeError(`${label} exceeds the maximum length`);
  }
  return value;
}

function requireTextList(value: unknown, label: string): readonly string[] {
  const list = requireArray(value, label);
  if (list.length > maxListItems) {
    throw new TypeError(`${label} exceeds the maximum item count`);
  }
  return list.map((item, index) => requireText(item, `${label}[${index}]`));
}

function requirePositiveIntegerList(
  value: unknown,
  label: string
): readonly number[] {
  const list = requireArray(value, label);
  if (list.length > maxListItems) {
    throw new TypeError(`${label} exceeds the maximum item count`);
  }
  return list.map((item, index) =>
    requirePositiveInteger(item, `${label}[${index}]`)
  );
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requirePageCount(value: unknown): number {
  const pageCount = requirePositiveInteger(value, 'pageCount');
  if (pageCount > maxPageCount) {
    throw new TypeError('pageCount exceeds the maximum');
  }
  return pageCount;
}
