import { describe, expect, it } from 'vitest';
import {
  createDocumentToolRegistry,
  parseDocumentToolRequest
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
});
