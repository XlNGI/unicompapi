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

    expect(result.agent.state).toBe('completed');
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
