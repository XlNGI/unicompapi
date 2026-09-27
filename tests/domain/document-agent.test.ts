import { describe, expect, it } from 'vitest';
import {
  createDocumentToolRegistry,
  filterDocumentTools,
  parseDocumentToolRequest,
  parseDocumentIR,
  validateDocumentPlan,
  validateDocumentIR
} from '../../src/domain';

describe('document agent tool contract', () => {
  it('exposes only the bounded tool registry', () => {
    const registry = createDocumentToolRegistry();
    expect(registry.has('apply_document_patch')).toBe(true);
    expect(registry.has('run_code' as never)).toBe(false);
  });

  it('rejects paths, URLs and protected input values', () => {
    expect(() => parseDocumentToolRequest({
      toolId: 'read_document_structure',
      input: { path: 'C:\\secret\\a.docx' },
      reason: 'read'
    })).toThrow(/path or URL/);
    expect(() => parseDocumentToolRequest({
      toolId: 'read_document_structure',
      input: { query: 'https://example.com' },
      reason: 'read'
    })).toThrow(/path or URL/);
    expect(() => parseDocumentToolRequest({
      toolId: 'read_document_structure',
      input: { note: 'token=abc' },
      reason: 'read'
    })).toThrow(/protected/);
  });

  it('requires an explicit operation and keeps create attachment sources separate from existing documents', () => {
    expect(parseDocumentIR({ operation: 'create', attachmentRefs: [] }).operation).toBe('create');
    expect(parseDocumentIR({ operation: 'create', attachmentRefs: ['attachment-1'] }).attachmentRefs).toEqual(['attachment-1']);
    expect(parseDocumentIR({ operation: 'edit', attachmentRefs: ['doc-1'] }).operation).toBe('edit');
  });

  it('marks existing-document prerequisites in the registry', () => {
    expect(createDocumentToolRegistry().get('read_document_structure')?.requiresExistingDocument).toBe(true);
    expect(createDocumentToolRegistry().get('render_preview')?.requiresExistingDocument).toBe(false);
  });

  it('keeps create and edit IR operations explicit', () => {
    const create = parseDocumentIR({ operation: 'create', attachmentRefs: [] });
    const edit = parseDocumentIR({ operation: 'edit', attachmentRefs: ['ppt-1'], documentRef: 'ppt-1' });
    expect(create).toMatchObject({ operation: 'create', attachmentRefs: [] });
    expect(edit).toMatchObject({ operation: 'edit', attachmentRefs: ['ppt-1'], documentRef: 'ppt-1' });
    expect(() => parseDocumentIR({ operation: 'create', attachmentRefs: [], documentRef: 'ppt-1' })).toThrow(/must not reference/);
    expect(() => parseDocumentIR({ operation: 'create', attachmentRefs: [], toolCalls: [] })).toThrow(/must not reference/);
  });

  it('parses bounded content, source and revision fields into a stable IR', () => {
    const ir = parseDocumentIR({
      operation: 'edit',
      attachmentRefs: ['attachment-1'],
      documentRef: 'document-1',
      content: {
        title: '季度经营汇报',
        sections: [{
          sectionId: 'section-1',
          heading: '结论',
          purpose: '给管理层的行动建议',
          blocks: [{ blockId: 'block-1', kind: 'text', content: '收入增长', sourceRefs: ['retrieval-1'] }],
          preserve: ['标题层级']
        }],
        sourceRefs: ['retrieval-1'],
        styleConstraints: ['简洁商务'],
        pageCount: 5
      },
      preserve: ['非目标页面'],
      revision: { baseWorkId: 'work-1', expectedRevision: 2, targetPages: [2] }
    });
    expect(ir.content?.sections[0]?.blocks[0]?.sourceRefs).toEqual(['retrieval-1']);
    expect(ir.revision).toEqual({ baseWorkId: 'work-1', expectedRevision: 2, targetPages: [2] });
  });

  it('rejects unsafe content IR fields and create revision dependencies', () => {
    expect(() => parseDocumentIR({
      operation: 'create',
      attachmentRefs: [],
      revision: { baseWorkId: 'work-1', expectedRevision: 1 }
    })).toThrow(/must not reference/);
    expect(() => parseDocumentIR({
      operation: 'create', attachmentRefs: [], content: {
        title: 'PPT', sections: [{ sectionId: 'section-1', heading: '结论', blocks: [{
          blockId: 'block-1', kind: 'text', content: 'api_key: sk-test', sourceRefs: []
        }], preserve: [] }], sourceRefs: [], styleConstraints: []
      }
    })).toThrow(/protected/);
  });

  it('validates and filters tool prerequisites from the explicit IR', () => {
    const registry = createDocumentToolRegistry();
    const ir = parseDocumentIR({ operation: 'create', attachmentRefs: [] });
    expect(filterDocumentTools(ir, ['read_document_structure', 'render_preview'], registry)).toEqual(['render_preview']);
    expect(validateDocumentPlan({
      ir: { ...ir, toolCalls: [{ toolId: 'read_document_structure', input: {}, reason: 'inspect' }] },
      toolIds: ['read_document_structure'], registry
    })).toMatchObject({ ok: false, code: 'TOOL_PRECONDITION_FAILED', recoverable: true });
  });

  it('classifies missing or invalid operation as an outline error', () => {
    expect(validateDocumentIR({ attachmentRefs: [] })).toEqual({
      ok: false, code: 'OUTLINE_INVALID', recoverable: false, reason: 'outline_invalid'
    });
    expect(validateDocumentIR({ operation: 'replace', attachmentRefs: [] })).toMatchObject({
      ok: false, code: 'OUTLINE_INVALID'
    });
  });
});
