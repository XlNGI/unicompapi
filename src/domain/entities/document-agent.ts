import type { DocumentOutline } from './document-generation';
import { createCanonicalToolRegistry, type CanonicalToolId } from './canonical-tool-contract';

/** Compatibility identity view. Registration is owned by the canonical catalog. */
export const documentToolIds: readonly CanonicalToolId[] = Object.freeze([...createCanonicalToolRegistry().keys()]);
export type DocumentToolId = CanonicalToolId;
export const documentOperations = ['create', 'edit', 'analyze'] as const;
export type DocumentOperation = (typeof documentOperations)[number];
export const documentPlanErrorCodes = ['TOOL_PRECONDITION_FAILED', 'OUTLINE_INVALID'] as const;
export type DocumentPlanErrorCode = (typeof documentPlanErrorCodes)[number];

export type DocumentToolValue = string | number | boolean;
export type DocumentToolInput = Readonly<Record<string, DocumentToolValue>>;

export interface DocumentToolDefinition {
  readonly id: DocumentToolId;
  readonly version: string;
  readonly description: string;
  readonly requiresWrite: boolean;
  readonly requiresExistingDocument: boolean;
  readonly supportsCancellation: boolean;
  readonly maxCostUnits: number;
}

export interface DocumentToolRequest {
  readonly toolId: DocumentToolId;
  readonly input: DocumentToolInput;
  readonly reason: string;
}

export const documentIRBlockKinds = ['text', 'bullets', 'table', 'chart', 'image'] as const;
export type DocumentIRBlockKind = (typeof documentIRBlockKinds)[number];

export interface DocumentIRBlock {
  readonly blockId: string;
  readonly kind: DocumentIRBlockKind;
  readonly content?: string;
  readonly sourceRefs: readonly string[];
}

export interface DocumentIRSection {
  readonly sectionId: string;
  readonly heading: string;
  readonly purpose?: string;
  readonly blocks: readonly DocumentIRBlock[];
  readonly preserve: readonly string[];
}

export interface DocumentIRContent {
  readonly title: string;
  readonly sections: readonly DocumentIRSection[];
  readonly sourceRefs: readonly string[];
  readonly styleConstraints: readonly string[];
  readonly pageCount?: number;
}

export interface DocumentIRRevision {
  readonly baseWorkId: string;
  readonly expectedRevision: number;
  readonly targetPages?: readonly number[];
}

export interface DocumentIR {
  readonly operation: DocumentOperation;
  readonly attachmentRefs: readonly string[];
  readonly documentRef?: string;
  readonly pageRefs?: readonly string[];
  readonly workRef?: string;
  readonly toolCalls?: readonly DocumentToolRequest[];
  readonly content?: DocumentIRContent;
  readonly preserve?: readonly string[];
  readonly revision?: DocumentIRRevision;
}

export function buildDocumentIRFromOutline(input: {
  readonly outline: DocumentOutline;
  readonly operation: DocumentOperation;
  readonly attachmentRefs?: readonly string[];
  readonly revision?: DocumentIRRevision;
}): DocumentIR {
  const sourceRefs = input.attachmentRefs ?? [];
  const content: DocumentIRContent = {
    title: input.outline.title,
    sections: input.outline.sections.map((section, sectionIndex) => ({
      sectionId: `section-${sectionIndex + 1}`,
      heading: section.heading,
      ...(section.takeaway !== undefined ? { purpose: section.takeaway } : {}),
      blocks: section.blocks.map((block, blockIndex) => ({
        blockId: `section-${sectionIndex + 1}-block-${blockIndex + 1}`,
        kind: block.type === 'table' ? 'table' : block.type === 'chart' ? 'chart' : block.type === 'bullets' || block.type === 'numbered' ? 'bullets' : 'text',
        content: block.type === 'paragraph' || block.type === 'quote' ? block.text : block.type === 'bullets' || block.type === 'numbered' ? block.items.join('\n') : JSON.stringify(block),
        sourceRefs
      })),
      preserve: []
    })),
    sourceRefs,
    styleConstraints: []
  };
  return parseDocumentIR({ operation: input.operation, attachmentRefs: sourceRefs, content, ...(input.revision !== undefined ? { revision: input.revision } : {}) });
}

export function parseDocumentIR(value: unknown): DocumentIR {
  const record = requireRecord(value, 'DocumentIR');
  requireExactKeys(record, [
    'operation', 'attachmentRefs', 'documentRef', 'pageRefs', 'workRef', 'toolCalls',
    'content', 'preserve', 'revision'
  ]);
  const operation = requireEnum(record.operation, documentOperations, 'DocumentIR.operation');
  const attachmentRefs = parseReferenceList(record.attachmentRefs, 'DocumentIR.attachmentRefs');
  const documentRef = optionalReference(record.documentRef, 'DocumentIR.documentRef');
  const pageRefs = record.pageRefs === undefined ? undefined : parseReferenceList(record.pageRefs, 'DocumentIR.pageRefs');
  const workRef = optionalReference(record.workRef, 'DocumentIR.workRef');
  const toolCalls = record.toolCalls === undefined ? undefined : requireArray(record.toolCalls, 'DocumentIR.toolCalls').map((item) => parseDocumentToolRequest(item));
  if (operation === 'create' && (documentRef !== undefined || pageRefs !== undefined ||
      workRef !== undefined || toolCalls !== undefined || record.revision !== undefined)) {
    throw new TypeError('DocumentIR.create must not reference an existing document or invoke document tools');
  }
  return {
    operation,
    attachmentRefs,
    ...(documentRef !== undefined ? { documentRef } : {}),
    ...(pageRefs !== undefined ? { pageRefs } : {}),
    ...(workRef !== undefined ? { workRef } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(record.content !== undefined ? { content: parseDocumentIRContent(record.content) } : {}),
    ...(record.preserve !== undefined ? { preserve: parseTextList(record.preserve, 'DocumentIR.preserve', 64, 500) } : {}),
    ...(record.revision !== undefined ? { revision: parseDocumentIRRevision(record.revision) } : {})
  };
}

function parseDocumentIRContent(value: unknown): DocumentIRContent {
  const record = requireRecord(value, 'DocumentIR.content');
  requireExactKeys(record, ['title', 'sections', 'sourceRefs', 'styleConstraints', 'pageCount']);
  const sections = requireArray(record.sections, 'DocumentIR.content.sections');
  if (sections.length === 0 || sections.length > 80) throw new TypeError('DocumentIR.content.sections has an invalid length');
  return {
    title: requireSafeText(record.title, 'DocumentIR.content.title', 240),
    sections: sections.map((section, index) => parseDocumentIRSection(section, index)),
    sourceRefs: parseTextList(record.sourceRefs, 'DocumentIR.content.sourceRefs', 128, 240),
    styleConstraints: parseTextList(record.styleConstraints, 'DocumentIR.content.styleConstraints', 32, 500),
    ...(record.pageCount === undefined ? {} : { pageCount: positiveInteger(record.pageCount, 'DocumentIR.content.pageCount', 500) })
  };
}

function parseDocumentIRSection(value: unknown, index: number): DocumentIRSection {
  const label = `DocumentIR.content.sections[${index}]`;
  const record = requireRecord(value, label);
  requireExactKeys(record, ['sectionId', 'heading', 'purpose', 'blocks', 'preserve']);
  const blocks = requireArray(record.blocks, `${label}.blocks`);
  if (blocks.length > 100) throw new TypeError(`${label}.blocks has an invalid length`);
  return {
    sectionId: requireSafeReference(record.sectionId, `${label}.sectionId`),
    heading: requireSafeText(record.heading, `${label}.heading`, 240),
    ...(record.purpose === undefined ? {} : { purpose: requireSafeText(record.purpose, `${label}.purpose`, 500) }),
    blocks: blocks.map((block, blockIndex) => parseDocumentIRBlock(block, `${label}.blocks[${blockIndex}]`)),
    preserve: parseTextList(record.preserve, `${label}.preserve`, 32, 500)
  };
}

function parseDocumentIRBlock(value: unknown, label: string): DocumentIRBlock {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['blockId', 'kind', 'content', 'sourceRefs']);
  if (!documentIRBlockKinds.includes(record.kind as DocumentIRBlockKind)) throw new TypeError(`${label}.kind is invalid`);
  const content = record.content === undefined ? undefined : requireSafeText(record.content, `${label}.content`, 4_000);
  if (content === undefined && record.kind !== 'image') throw new TypeError(`${label}.content is required`);
  return {
    blockId: requireSafeReference(record.blockId, `${label}.blockId`),
    kind: record.kind as DocumentIRBlockKind,
    ...(content === undefined ? {} : { content }),
    sourceRefs: parseTextList(record.sourceRefs, `${label}.sourceRefs`, 32, 240)
  };
}

function parseDocumentIRRevision(value: unknown): DocumentIRRevision {
  const record = requireRecord(value, 'DocumentIR.revision');
  requireExactKeys(record, ['baseWorkId', 'expectedRevision', 'targetPages']);
  return {
    baseWorkId: requireSafeReference(record.baseWorkId, 'DocumentIR.revision.baseWorkId'),
    expectedRevision: nonNegativeInteger(record.expectedRevision, 'DocumentIR.revision.expectedRevision'),
    ...(record.targetPages === undefined ? {} : { targetPages: positiveIntegerList(record.targetPages, 'DocumentIR.revision.targetPages') })
  };
}

function parseTextList(value: unknown, label: string, maxItems: number, maxLength: number): readonly string[] {
  const items = requireArray(value, label);
  if (items.length > maxItems) throw new TypeError(`${label} exceeds the maximum item count`);
  return items.map((item, index) => requireSafeText(item, `${label}[${index}]`, maxLength));
}

function positiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function positiveIntegerList(value: unknown, label: string): readonly number[] {
  const items = requireArray(value, label);
  if (items.length > 40) throw new TypeError(`${label} exceeds the maximum item count`);
  const parsed = items.map((item, index) => positiveInteger(item, `${label}[${index}]`, 500));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${label} must not contain duplicates`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

export interface DocumentPlanValidationSuccess {
  readonly ok: true;
  readonly operation: DocumentOperation;
  readonly allowedToolIds: readonly DocumentToolId[];
}

export interface DocumentPlanValidationFailure {
  readonly ok: false;
  readonly code: DocumentPlanErrorCode;
  readonly operation?: DocumentOperation;
  readonly toolId?: DocumentToolId;
  readonly recoverable: boolean;
  readonly reason: 'tool_precondition' | 'outline_invalid';
}

export type DocumentPlanValidationResult = DocumentPlanValidationSuccess | DocumentPlanValidationFailure;

export function validateDocumentIR(value: unknown):
  | { readonly ok: true; readonly ir: DocumentIR }
  | { readonly ok: false; readonly code: 'OUTLINE_INVALID'; readonly recoverable: false; readonly reason: 'outline_invalid' } {
  try {
    return { ok: true, ir: parseDocumentIR(value) };
  } catch {
    return { ok: false, code: 'OUTLINE_INVALID', recoverable: false, reason: 'outline_invalid' };
  }
}

/** Filters and validates the bounded plan before it is exposed to an LLM or executed. */
export function validateDocumentPlan(input: {
  readonly ir: DocumentIR;
  readonly toolIds: readonly DocumentToolId[];
  readonly registry?: ReadonlyMap<DocumentToolId, DocumentToolDefinition>;
}): DocumentPlanValidationResult {
  const registry = input.registry ?? createDocumentToolRegistry();
  const rawOperation = (input.ir as unknown as { readonly operation?: unknown }).operation;
  if (typeof rawOperation !== 'string' || !documentOperations.includes(rawOperation as DocumentOperation)) {
    return { ok: false, code: 'OUTLINE_INVALID', recoverable: false, reason: 'outline_invalid' };
  }
  const operation = rawOperation as DocumentOperation;
  const allowedToolIds = input.toolIds.filter((toolId) => {
    const definition = registry.get(toolId);
    return definition !== undefined && !(operation === 'create' && definition.requiresExistingDocument);
  });
  const plannedToolIds = [...new Set([
    ...(input.ir.toolCalls?.map((call) => call.toolId) ?? []),
    ...input.toolIds
  ])];
  const invalidToolId = plannedToolIds.find((toolId) => {
    const definition = registry.get(toolId);
    return definition === undefined || (operation === 'create' && definition.requiresExistingDocument);
  });
  if (invalidToolId !== undefined) {
    const definition = registry.get(invalidToolId);
    if (operation === 'create' && definition?.requiresExistingDocument) {
      return {
        ok: false,
        code: 'TOOL_PRECONDITION_FAILED',
        operation,
        toolId: invalidToolId,
        recoverable: true,
        reason: 'tool_precondition'
      };
    }
    return { ok: false, code: 'OUTLINE_INVALID', operation, recoverable: false, reason: 'outline_invalid' };
  }
  return { ok: true, operation, allowedToolIds };
}

export function filterDocumentTools(
  ir: DocumentIR,
  bindings: readonly DocumentToolId[],
  registry: ReadonlyMap<DocumentToolId, DocumentToolDefinition> = createDocumentToolRegistry()
): readonly DocumentToolId[] {
  return bindings.filter((toolId) => {
    const definition = registry.get(toolId);
    return definition !== undefined && !(ir.operation === 'create' && definition.requiresExistingDocument);
  });
}

export const documentAgentStates = [
  'completed',
  'completed_unvalidated',
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

export const documentAgentProgressStages = ['planning', 'tool', 'completed'] as const;
export type DocumentAgentProgressStage = (typeof documentAgentProgressStages)[number];
export type DocumentAgentProgressStatus = 'started' | 'completed' | 'failed' | 'cancelled';

/** Safe progress projection for the assistant message and IPC stream. */
export interface DocumentAgentProgressEvent {
  readonly sequence: number;
  readonly step: number;
  readonly stage: DocumentAgentProgressStage;
  readonly status: DocumentAgentProgressStatus;
  readonly toolId?: DocumentToolId;
  readonly safeCode?: string;
  readonly occurredAt: string;
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
  const definitions: readonly DocumentToolDefinition[] = [...createCanonicalToolRegistry().values()].map(contract => ({
    id: contract.toolId,
    version: contract.version,
    description: contract.description,
    requiresWrite: contract.preconditions.requiresWrite,
    requiresExistingDocument: contract.preconditions.requiresExistingDocument,
    supportsCancellation: contract.execution.cancellable,
    maxCostUnits: contract.execution.budgetUnits
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

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function parseReferenceList(value: unknown, label: string): readonly string[] {
  const refs = requireArray(value, label).map((item, index) => {
    if (typeof item !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(item)) {
      throw new TypeError(`${label}[${index}] is invalid`);
    }
    return item;
  });
  if (new Set(refs).size !== refs.length) throw new TypeError(`${label} contains duplicates`);
  return refs;
}

function optionalReference(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireSafeReference(value: unknown, label: string): string {
  const reference = optionalReference(value, label);
  if (reference === undefined) throw new TypeError(`${label} is required`);
  return reference;
}

function requireSafeText(value: unknown, label: string, maxLength = 2_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
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
