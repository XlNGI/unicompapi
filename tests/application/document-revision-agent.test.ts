import { describe, expect, it } from 'vitest';
import { runLocalDocumentRevisionAgent } from '../../src/application';
import {
  applyStructuredDocumentPatch,
  readStructuredDocument
} from '../../src/platform/documents/structured-document-tools';
import type { DocumentOutline } from '../../src/domain';
import type { DocumentRevisionPatch } from '../../src/application';

const outline = {
  kind: 'ppt' as const,
  title: '运营方案',
  sections: [
    {
      heading: '第一章',
      level: 1 as const,
      pageKind: 'insight' as const,
      blocks: [{ type: 'paragraph' as const, text: '保留内容' }]
    },
    {
      heading: '第二章',
      level: 1 as const,
      pageKind: 'insight' as const,
      blocks: [{ type: 'paragraph' as const, text: '需要清空' }]
    },
    {
      heading: '第三章',
      level: 1 as const,
      pageKind: 'closing' as const,
      blocks: [{ type: 'paragraph' as const, text: '仍然保留' }]
    }
  ]
};

const ports = {
  readStructure: (document: DocumentOutline) =>
    readStructuredDocument(document),
  applyPatch: (document: DocumentOutline, patch: DocumentRevisionPatch) => {
    const result = applyStructuredDocumentPatch(document, patch);
    return {
      document: result.document,
      changed: result.change.changed,
      affectedSections: result.change.affectedSections
    };
  }
};

describe('local document revision agent', () => {
  it('runs read → patch → render → inspect and clears only the requested section', async () => {
    const result = await runLocalDocumentRevisionAgent(
      {
        baseWorkId: 'work-parent' as never,
        expectedRevision: 3,
        kind: 'ppt',
        requestText: '清空第二章',
        outline
      },
      ports
    );

    expect(result.agent.state).toBe('completed_unvalidated');
    expect(result.agent.observations.map((item) => item.toolId)).toEqual([
      'read_document_structure',
      'apply_document_patch',
      'render_preview',
      'inspect_layout'
    ]);
    expect(result.changed).toBe(true);
    expect(result.targetSectionIndex).toBe(1);
    expect(result.outline.sections[0]).toEqual(outline.sections[0]);
    expect(result.outline.sections[1].heading).toBe('第二章');
    expect(result.outline.sections[1].blocks).toEqual([]);
    expect(result.outline.sections[2]).toEqual(outline.sections[2]);
  });

  it('clears content when the delete verb follows the targeted chapter', async () => {
    const result = await runLocalDocumentRevisionAgent(
      {
        baseWorkId: 'work-parent' as never,
        expectedRevision: 3,
        kind: 'ppt',
        requestText: '将第二章的内容删掉',
        outline
      },
      ports
    );

    expect(result.agent.state).toBe('completed_unvalidated');
    expect(result.changed).toBe(true);
    expect(result.targetSectionIndex).toBe(1);
    expect(result.patch && 'pageNumber' in result.patch.target ? result.patch.target.pageNumber : undefined).toBe(3);
    expect(result.outline.sections[1].blocks).toEqual([]);
    expect(result.outline.sections[0]).toEqual(outline.sections[0]);
    expect(result.outline.sections[2]).toEqual(outline.sections[2]);
  });

  it('applies a bounded batch when two addressed chapters are requested', async () => {
    const result = await runLocalDocumentRevisionAgent({
      baseWorkId: 'work-parent' as never,
      expectedRevision: 3,
      kind: 'ppt',
      requestText: '清空第二章和第三章',
      outline
    }, ports);
    expect(result.agent.state).toBe('completed_unvalidated');
    expect(result.patches).toHaveLength(2);
    expect(result.patch).toBeUndefined();
    expect(result.outline.sections[0]).toEqual(outline.sections[0]);
    expect(result.outline.sections[1].blocks).toEqual([]);
    expect(result.outline.sections[2].blocks).toEqual([]);
  });

  it('applies a provider content proposal only to the addressed section', async () => {
    const proposed = {
      ...outline,
      sections: [
        outline.sections[0],
        {
          ...outline.sections[1],
          blocks: [{ type: 'paragraph' as const, text: '新的管理结论' }]
        },
        outline.sections[2]
      ]
    };
    const result = await runLocalDocumentRevisionAgent(
      {
        baseWorkId: 'work-parent' as never,
        expectedRevision: 3,
        kind: 'ppt',
        requestText: '把第二章改写得更适合管理层',
        outline,
        proposedOutline: proposed
      },
      ports
    );

    expect(result.patch?.operation).toBe('replace_section');
    expect(result.outline.sections[1].blocks).toEqual([
      { type: 'paragraph', text: '新的管理结论' }
    ]);
    expect(result.outline.sections[0]).toEqual(outline.sections[0]);
    expect(result.outline.sections[2]).toEqual(outline.sections[2]);
  });

  it('uses a text patch when exactly one Word paragraph changes', async () => {
    const word = {
      kind: 'word' as const,
      title: '报告',
      sections: [
        { heading: '第一章', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '旧内容' }] }
      ]
    };
    const result = await runLocalDocumentRevisionAgent({
      baseWorkId: 'work-parent' as never,
      expectedRevision: 3,
      kind: 'word',
      requestText: '把第一章改写得更清楚',
      outline: word,
      proposedOutline: {
        ...word,
        sections: [{ ...word.sections[0], blocks: [{ type: 'paragraph', text: '新内容' }] }]
      }
    }, ports);

    expect(result.patch).toMatchObject({
      operation: 'replace_text',
      target: { sectionIndex: 0, blockIndex: 0 },
      value: '新内容'
    });
  });


  it('falls back to a section patch when preceding Word blocks expand physically', async () => {
    const word = {
      kind: 'word' as const,
      title: '报告',
      sections: [{
        heading: '第一章',
        level: 1 as const,
        blocks: [
          { type: 'bullets' as const, items: ['甲', '乙'] },
          { type: 'paragraph' as const, text: '旧内容' }
        ]
      }]
    };
    const result = await runLocalDocumentRevisionAgent({
      baseWorkId: 'work-parent' as never,
      expectedRevision: 3,
      kind: 'word',
      requestText: '把第一章改写得更清楚',
      outline: word,
      proposedOutline: {
        ...word,
        sections: [{ ...word.sections[0], blocks: [
          { type: 'bullets', items: ['甲', '乙'] },
          { type: 'paragraph', text: '新内容' }
        ] }]
      }
    }, ports);

    expect(result.patch?.operation).toBe('replace_section');
  });

  it('uses a cell patch when exactly one Excel data cell changes', async () => {
    const excel = {
      kind: 'excel' as const,
      title: '工资表',
      sections: [
        { heading: '明细', level: 1 as const, blocks: [{ type: 'table' as const, header: ['姓名', '金额'], rows: [['甲', '10']] }] }
      ]
    };
    const result = await runLocalDocumentRevisionAgent({
      baseWorkId: 'work-parent' as never,
      expectedRevision: 3,
      kind: 'excel',
      requestText: '把第一章的数据更新一下',
      outline: excel,
      proposedOutline: {
        ...excel,
        sections: [{ ...excel.sections[0], blocks: [{ type: 'table', header: ['姓名', '金额'], rows: [['甲', '12']] }] }]
      }
    }, ports);

    expect(result.patch).toMatchObject({
      operation: 'update_cells',
      target: { sectionIndex: 0, blockIndex: 0, rowIndex: 0, columnIndex: 1 },
      value: '12'
    });
  });

  it('does not mutate when the request is outside the deterministic rule set', async () => {
    const result = await runLocalDocumentRevisionAgent(
      {
        baseWorkId: 'work-parent' as never,
        expectedRevision: 3,
        kind: 'ppt',
        requestText: '把第二章改得更简洁',
        outline
      },
      ports
    );

    expect(result.changed).toBe(false);
    expect(result.agent.steps).toBe(0);
    expect(result.outline).toEqual(outline);
  });

  it('honours cancellation before executing a tool', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runLocalDocumentRevisionAgent(
      {
        baseWorkId: 'work-parent' as never,
        expectedRevision: 3,
        kind: 'ppt',
        requestText: '清空第二章',
        outline,
        signal: controller.signal
      },
      ports
    );

    expect(result.agent.state).toBe('cancelled');
    expect(result.changed).toBe(false);
    expect(result.outline).toEqual(outline);
  });
});
