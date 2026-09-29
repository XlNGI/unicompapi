import { describe, expect, it } from 'vitest';
import {
  canonicalToolIds,
  canonicalToolInputSchema,
  createCanonicalToolRegistry,
  deriveAvailableToolSet,
  validateCanonicalToolArguments,
  validateDocumentToolResult,
  type AvailableToolContext,
  type CanonicalToolContract,
  type CanonicalToolRegistry,
  type ToolExecutionContext
} from '../../src/domain/entities/canonical-tool-contract';

const registry = createCanonicalToolRegistry();
const read = registry.get('read_document_structure')!;
const update = registry.get('update_element')!;
const add = registry.get('add_element')!;
const remove = registry.get('delete_element')!;
const context: AvailableToolContext = {
  implementedToolIds: canonicalToolIds,
  capabilities: canonicalToolIds,
  operation: 'edit',
  currentDocumentId: 'document-1',
  currentDocumentIR: { operation: 'edit', attachmentRefs: [] },
  revision: 0,
  authorization: { canRead: true, canWrite: true, allowedToolIds: canonicalToolIds }
};

describe('canonical document tool contracts', () => {
  it('keeps the existing registry while exposing only the established business contract', () => {
    expect(registry.size).toBe(canonicalToolIds.length);
    expect([...registry.keys()]).toEqual(canonicalToolIds);
    expect(deriveAvailableToolSet(registry, context).map(contract => contract.toolId)).toEqual(expect.arrayContaining([
      'read_document_structure', 'update_element', 'add_element', 'delete_element'
    ]));
    for (const contract of registry.values()) {
      expect(contract.schemaVersion).toBe(1);
      expect(contract.input.additionalProperties).toBe(false);
      expect(contract.execution).toMatchObject({ cancellable: true, idempotency: { mode: 'required', scope: 'task_call' } });
      expect(contract.execution.timeoutMs).toBeGreaterThan(0);
      expect(contract.execution.budgetUnits).toBeGreaterThan(0);
      expect(contract.diagnostics.failureCodes).toContain('invalid_tool_arguments');
      if (!['read_document_structure', 'generate_pptx', 'update_element', 'add_element', 'delete_element', 'add_slide'].includes(contract.toolId)) {
        expect(contract.exposure).toBe('internal');
        expect(contract.input.fields).toEqual({});
      }
    }
    expect(read).toMatchObject({
      version: '1.0',
      preconditions: { requiresExistingDocument: true, requiresDocumentIR: true, requiresWrite: false, requiresRevision: true },
      execution: { timeoutMs: 60_000, budgetUnits: 1 },
      diagnostics: { traceType: 'read_sources' }
    });
  });

  it('projects only scope and ordinal with defaults and cross-field rules into Provider JSON Schema', () => {
    expect(canonicalToolInputSchema(read)).toEqual({
      type: 'object', additionalProperties: false,
      properties: {
        scope: { type: 'string', minLength: 1, maxLength: 8, enum: ['document', 'page', 'section'], default: 'document' },
        ordinal: { type: 'integer', minimum: 1, maximum: 500 }
      },
      required: [],
      allOf: [
        { if: { properties: { scope: { enum: ['page', 'section'] } }, required: ['scope'] }, then: { required: ['ordinal'] } },
        { if: { properties: { scope: { enum: ['document'] } } }, then: { not: { anyOf: [{ required: ['ordinal'] }] } } }
      ]
    });
    expect(validateCanonicalToolArguments(read, {})).toEqual({ scope: 'document' });
    expect(validateCanonicalToolArguments(read, { scope: 'document' })).toEqual({ scope: 'document' });
    expect(validateCanonicalToolArguments(read, { scope: 'page', ordinal: 3 })).toEqual({ scope: 'page', ordinal: 3 });
    expect(validateCanonicalToolArguments(read, { scope: 'section', ordinal: 1 })).toEqual({ scope: 'section', ordinal: 1 });
  });

  it('exposes only business update arguments and accepts a validated IR patch result', () => {
    expect(canonicalToolInputSchema(update)).toMatchObject({
      additionalProperties: false,
      required: ['elementId', 'text'],
      properties: { elementId: { type: 'string' }, text: { type: 'string' } }
    });
    expect(validateCanonicalToolArguments(update, { elementId: 'element-1', text: '新文本' })).toEqual({ elementId: 'element-1', text: '新文本' });
    expect(() => validateCanonicalToolArguments(update, { elementId: 'element-1', text: '新文本', revision: 1 })).toThrow('invalid_tool_arguments');
    expect(validateDocumentToolResult(update, {
      schemaVersion: 1, status: 'success',
      irPatch: { schemaVersion: 1, operations: [{ op: 'update_text', target: { elementId: 'element-1' }, text: '新文本' }] },
      observation: { changedElementId: 'element-1' }, artifactRefs: [{ kind: 'work', ref: 'work-candidate-1' }]
    })).toMatchObject({ status: 'success' });
  });

  it('exposes only business add/delete arguments and rejects host-owned fields', () => {
    expect(canonicalToolInputSchema(add)).toMatchObject({ required: ['pageId', 'type', 'text'], properties: { type: { enum: ['text'] }, placement: { enum: ['default'] } } });
    expect(validateCanonicalToolArguments(add, { pageId: 'page-1', type: 'text', text: '新增' })).toEqual({ pageId: 'page-1', type: 'text', text: '新增', placement: 'default' });
    expect(validateCanonicalToolArguments(remove, { elementId: 'element-1' })).toEqual({ elementId: 'element-1' });
    expect(() => validateCanonicalToolArguments(add, { pageId: 'page-1', type: 'text', text: '新增', elementId: 'model-id' })).toThrow('invalid_tool_arguments');
    expect(() => validateCanonicalToolArguments(remove, { elementId: 'element-1', revision: 2 })).toThrow('invalid_tool_arguments');
    expect(validateDocumentToolResult(add, { schemaVersion: 1, status: 'success', observation: { elementId: 'element-host', pageId: 'page-1', operation: 'added' }, irPatch: { schemaVersion: 1, operations: [{ op: 'add_text', target: { pageId: 'page-1' }, elementId: 'element-host', text: '新增', placement: 'default' }] } })).toMatchObject({ status: 'success' });
    expect(validateDocumentToolResult(remove, { schemaVersion: 1, status: 'success', observation: { elementId: 'element-1', operation: 'deleted' }, irPatch: { schemaVersion: 1, operations: [{ op: 'delete_element', target: { elementId: 'element-1' } }] } })).toMatchObject({ status: 'success' });
  });

  it.each([
    null, [], 'document', { scope: 'sheet' }, { scope: 'page' }, { scope: 'section' },
    { ordinal: 1 }, { scope: 'document', ordinal: 1 }, { scope: 'page', ordinal: '3' },
    { scope: 'page', ordinal: 0 }, { scope: 'page', ordinal: 501 }, { scope: 'page', ordinal: 1.5 },
    { scope: 'page', ordinal: Number.NaN }, { scope: null }, { scope: undefined },
    { scope: 'document', reason: 'read' }, { scope: 'document', extra: true }
  ])('rejects arguments inconsistent with the canonical fields and conditions: %j', value => {
    expect(() => validateCanonicalToolArguments(read, value)).toThrow('invalid_tool_arguments');
  });

  it.each(['documentRef', 'documentId', 'currentDocumentId', 'currentDocumentIR', 'revision', 'rootDirectory', 'relativePath',
    'filePath', 'path', 'authorization', 'abortSignal', 'taskContext', 'projectContext', 'checkpoint'])('never accepts Runtime-owned %s in LLM arguments', key => {
    expect(() => validateCanonicalToolArguments(read, { [key]: 'injected-by-model' })).toThrow('invalid_tool_arguments');
    expect(() => createCanonicalToolRegistry([{ ...read, input: { ...read.input, fields: { [key]: { type: 'string', maxLength: 64 } }, conditions: [] } }])).toThrow('tool_schema_invalid');
  });

  it('projects a changed field contract into both the schema and validator without another field definition', () => {
    const narrowed: CanonicalToolContract = {
      ...read,
      input: {
        ...read.input,
        fields: {
          ...read.input.fields,
          scope: { ...read.input.fields.scope, type: 'string', maxLength: 8, required: true, enum: ['page'], defaultValue: undefined },
          ordinal: { type: 'integer', minimum: 1, maximum: 2, required: true }
        }
      }
    };
    expect(canonicalToolInputSchema(narrowed)).toMatchObject({ required: ['scope', 'ordinal'], properties: { scope: { enum: ['page'] }, ordinal: { maximum: 2 } } });
    expect(() => validateCanonicalToolArguments(narrowed, {})).toThrow('invalid_tool_arguments');
    expect(() => validateCanonicalToolArguments(narrowed, { scope: 'page', ordinal: 3 })).toThrow('invalid_tool_arguments');
    expect(validateCanonicalToolArguments(narrowed, { scope: 'page', ordinal: 2 })).toEqual({ scope: 'page', ordinal: 2 });
  });

  it('keeps Registry membership separate from implementation, capabilities, document state and grants', () => {
    const unavailable: Partial<AvailableToolContext>[] = [
      { implementedToolIds: [] }, { capabilities: [] }, { currentDocumentId: undefined }, { currentDocumentIR: undefined },
      { revision: undefined }, { revision: -1 },
      { authorization: { ...context.authorization, canRead: false } },
      { authorization: { ...context.authorization, allowedToolIds: [] } }
    ];
    for (const missing of unavailable) expect(deriveAvailableToolSet(registry, { ...context, ...missing })).toEqual([]);
    expect(deriveAvailableToolSet(registry, { ...context, authorization: { ...context.authorization, canWrite: false } })).toEqual([read]);
  });

  it('permits querying a newly initialized and bound IR without forcing file parsing', () => {
    expect(deriveAvailableToolSet(registry, { ...context, operation: 'create', currentDocumentIR: { operation: 'create', attachmentRefs: [] } }).map(item => item.toolId)).toEqual(['read_document_structure', 'generate_pptx']);
  });

  it('checks write authorization and explicit operation restrictions from the contract', () => {
    const write: CanonicalToolContract = { ...registry.get('apply_document_patch')!, exposure: 'provider' };
    const writeRegistry = createCanonicalToolRegistry([write]);
    expect(deriveAvailableToolSet(writeRegistry, context).map(contract => contract.toolId)).toEqual(['apply_document_patch']);
    expect(deriveAvailableToolSet(writeRegistry, { ...context, authorization: { ...context.authorization, canWrite: false } })).toEqual([]);
    const restricted: CanonicalToolContract = { ...read, preconditions: { ...read.preconditions, allowedOperations: ['analyze'] } };
    expect(deriveAvailableToolSet(createCanonicalToolRegistry([restricted]), context)).toEqual([]);
  });

  it('copies and deeply freezes each catalog entry rather than retaining mutable caller contracts', () => {
    const mutable = structuredClone(read);
    const copied = createCanonicalToolRegistry([mutable]);
    const frozen = copied.get(read.toolId)!;
    expect(frozen).not.toBe(mutable);
    expect(Object.isFrozen(frozen.input.fields)).toBe(true);
    expect(Object.isFrozen(frozen.input.fields.scope)).toBe(true);
    expect(Object.isFrozen(frozen.diagnostics.failureCodes)).toBe(true);
    expect(Object.isFrozen(frozen.input.conditions)).toBe(true);
    (mutable.input.fields.scope as { defaultValue?: string }).defaultValue = 'page';
    expect(validateCanonicalToolArguments(frozen, {})).toEqual({ scope: 'document' });
    (copied as Map<string, CanonicalToolContract>).delete(read.toolId);
    expect(createCanonicalToolRegistry().has(read.toolId)).toBe(true);
    expect(() => createCanonicalToolRegistry([read, read])).toThrow('tool_registry_invalid');
  });

  it('keeps execution context independent of model schema and business arguments', () => {
    const host: ToolExecutionContext = {
      ...context,
      projectContext: { projectId: 'project-1', workId: 'work-1' },
      taskContext: { taskId: 'task-1', checkpoint: { revision: 0, step: 1 } },
      abortSignal: new AbortController().signal
    };
    expect(host.currentDocumentId).toBe('document-1');
    expect(Object.keys(canonicalToolInputSchema(read).properties as object)).toEqual(['scope', 'ordinal']);
    expect(validateCanonicalToolArguments(read, {})).not.toHaveProperty('currentDocumentId');
  });

  it('accepts a bounded structured observation and declared diagnostics', () => {
    const result = {
      schemaVersion: 1, status: 'success',
      observation: { pageCount: 5, pages: [{ ordinal: 1, heading: 'Overview' }] },
      diagnostics: [{ code: 'read_complete', severity: 'info', message: 'Structure read.' }],
      metadata: { revision: 0 }
    };
    expect(validateDocumentToolResult(read, result)).toEqual(result);
    for (const status of ['failed', 'cancelled', 'unknown']) expect(validateDocumentToolResult(read, { schemaVersion: 1, status })).toEqual({ schemaVersion: 1, status });
  });

  it.each([
    { schemaVersion: 1, status: 'success', irPatch: {} },
    { schemaVersion: 1, status: 'success', artifactRefs: [{ kind: 'file', ref: 'file-1' }] },
    { schemaVersion: 1, status: 'success', observation: [] },
    { schemaVersion: 1, status: 'success', observation: { number: Number.NaN } },
    { schemaVersion: 1, status: 'success', observation: { executor: () => undefined } },
    { schemaVersion: 1, status: 'success', observation: { constructor: 'bad' } },
    { schemaVersion: 1, status: 'success', diagnostics: [{ code: 'read_failed', severity: 'severe', message: 'failed' }] },
    { schemaVersion: 1, status: 'failed', diagnostics: [{ code: 'unregistered_failure', severity: 'error', message: 'failed' }] },
    { schemaVersion: 1, status: 'success', metadata: { object: {} } },
    { schemaVersion: 1, status: 'complete' }, { status: 'success' }, { schemaVersion: 1, status: 'success', extra: true }
  ] as unknown[])('rejects unsupported results and denies patches from the read tool: %j', value => {
    expect(() => validateDocumentToolResult(read, value)).toThrow('invalid_tool_result');
  });

  it('does not leak transient registry mutation into the authoritative catalog', () => {
    const empty: CanonicalToolRegistry = createCanonicalToolRegistry([]);
    expect(deriveAvailableToolSet(empty, context)).toEqual([]);
    expect(createCanonicalToolRegistry().size).toBe(canonicalToolIds.length);
  });
});
