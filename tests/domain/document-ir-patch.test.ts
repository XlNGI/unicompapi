import { describe, expect, it } from 'vitest';
import { addTextPatch, deleteElementPatch, parseDocumentIRPatch, updateTextPatch } from '../../src/domain/entities/document-ir-patch';

describe('document mutation patch contract', () => {
  it('parses the three closed operations without accepting arbitrary fields', () => {
    expect(addTextPatch('page-1', 'element-host', '相同文本')).toMatchObject({ operations: [{ op: 'add_text', target: { pageId: 'page-1' }, elementId: 'element-host', placement: 'default' }] });
    expect(deleteElementPatch('element-1')).toMatchObject({ operations: [{ op: 'delete_element', target: { elementId: 'element-1' } }] });
    expect(updateTextPatch('element-1', '新文本')).toMatchObject({ operations: [{ op: 'update_text', target: { elementId: 'element-1' } }] });
    expect(() => parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'add_text', target: { pageId: 'page-1' }, elementId: 'model/path', text: 'x', placement: 'default' }] })).toThrow('invalid_ir_patch');
    expect(() => parseDocumentIRPatch({ schemaVersion: 1, operations: [{ op: 'delete_element', target: { elementId: 'element-1' }, text: 'extra' }] })).toThrow('invalid_ir_patch');
  });
});
