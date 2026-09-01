import { describe, expect, it } from 'vitest';
import {
  StructuredDocumentToolError,
  applyStructuredDocumentPatch,
  parseDocumentPatch,
  readStructuredDocument
} from '../../src/platform/documents';

const outline = {
  kind: 'ppt' as const,
  title: '经营分析',
  sections: [
    {
      heading: '指标',
      level: 1 as const,
      blocks: [
        { type: 'paragraph' as const, text: '收入增长' },
        { type: 'table' as const, header: ['季度', '收入'], rows: [['Q1', '10']] }
      ]
    },
    {
      heading: '结论',
      level: 1 as const,
      blocks: [{ type: 'bullets' as const, items: ['保持投入'] }]
    }
  ]
};

describe('structured document tools', () => {
  it('reads bounded structure summaries without exposing file details', () => {
    const snapshot = readStructuredDocument(outline);
    expect(snapshot).toMatchObject({ kind: 'ppt', sectionCount: 2 });
    expect(snapshot.sections[0].blocks[1]).toMatchObject({ type: 'table', itemCount: 1 });
    expect(JSON.stringify(snapshot)).not.toMatch(/path|url|token/i);
  });

  it('applies scoped table and page-layout patches immutably', () => {
    const tableResult = applyStructuredDocumentPatch(outline, {
      operation: 'update_cells',
      target: { sectionIndex: 0, blockIndex: 1, rowIndex: 0, columnIndex: 1 },
      value: '12'
    });
    expect(tableResult.document.sections[0].blocks[1]).toMatchObject({
      type: 'table',
      rows: [['Q1', '12']]
    });
    expect(outline.sections[0].blocks[1]).toMatchObject({ rows: [['Q1', '10']] });

    const layoutResult = applyStructuredDocumentPatch(outline, {
      operation: 'replace_page_layout',
      target: { pageNumber: 2 },
      value: 'data'
    });
    expect(layoutResult.document.sections[1].pageKind).toBe('data');
  });

  it('rejects out-of-scope targets and unsupported style mutation', () => {
    expect(() => applyStructuredDocumentPatch(outline, {
      operation: 'update_cells',
      target: { sectionIndex: 0, blockIndex: 0, rowIndex: 0, columnIndex: 0 },
      value: 'x'
    })).toThrow(StructuredDocumentToolError);
    expect(() => applyStructuredDocumentPatch(outline, {
      operation: 'set_style',
      target: { sectionIndex: 0 },
      value: 'C:\\font'
    })).toThrow(/path or URL/);
  });

  it('parses chart creation as a bounded structured operation', () => {
    const patch = parseDocumentPatch({
      operation: 'create_chart',
      target: { sectionIndex: 0 },
      data: { chartKind: 'bar', points: [{ label: 'Q1', value: 10 }] }
    });
    const result = applyStructuredDocumentPatch(outline, patch);
    expect(result.document.sections[0].blocks.at(-1)).toMatchObject({ type: 'chart', chartKind: 'bar' });
  });

  it('clears one section while retaining its identity and all other sections', () => {
    const result = applyStructuredDocumentPatch(outline, {
      operation: 'clear_section',
      target: { sectionIndex: 1, pageNumber: 2 }
    });

    expect(result.document.sections[0]).toEqual(outline.sections[0]);
    expect(result.document.sections[1]).toEqual({
      heading: '结论',
      level: 1,
      blocks: []
    });
    expect(result.change).toEqual({
      operation: 'clear_section',
      affectedSections: [1],
      affectedBlocks: [],
      changed: true
    });
  });
});
