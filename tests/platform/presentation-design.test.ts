import { describe, expect, it } from 'vitest';
import {
  applyPresentationLayoutToOutline,
  buildPresentationDesignIR,
  buildPresentationLayoutIR,
  parsePresentationPlan
} from '../../src/domain';
import { buildPresentationPlanFromOutline, parseDocumentOutline } from '../../src/platform/documents';

function planWithScene() {
  return parsePresentationPlan({
    kind: 'ppt', title: '测试', templateId: 'business_minimal', sourceRefs: [], preserve: [],
    pages: [{
      pageNumber: 1, sourceSection: '结论', pageKind: 'insight', layout: 'insight', composition: 'editorial',
      elements: [], capacity: { contentGroups: 1, bodyCharacters: 10, maxContentGroups: 4, maxBodyCharacters: 500, maxTableColumns: 5, minBodyFontSize: 18, withinLimit: true }, sourceRefs: [], preserve: [],
      scene: { schemaVersion: 1, elements: [
        { elementId: 'title', type: 'text', geometry: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, zIndex: 1, content: '标题', style: { fontSize: 28, textColor: '20372B' } },
        { elementId: 'body', type: 'shape', geometry: { x: 0.65, y: 0.4, width: 0.25, height: 0.3 }, zIndex: 2, style: { fill: 'F5EBE6' } }
      ] }
    }]
  });
}

describe('presentation design and layout IR', () => {
  it('derives design and geometry IR from a validated presentation plan', () => {
    const plan = planWithScene();
    const design = buildPresentationDesignIR(plan);
    const layout = buildPresentationLayoutIR(plan);
    expect(design.pages[0]?.elements).toHaveLength(2);
    expect(layout.pages[0]?.boxes[0]).toMatchObject({ elementId: 'title', x: 0.1 });
    expect(layout.diagnostics).toEqual([]);
  });

  it('records deterministic overlap diagnostics without invoking a model', () => {
    const plan = planWithScene();
    const next = parsePresentationPlan({
      ...plan,
      pages: [{ ...plan.pages[0], scene: { ...plan.pages[0].scene!, elements: [
        plan.pages[0].scene!.elements[0],
        { ...plan.pages[0].scene!.elements[1], geometry: { x: 0.2, y: 0.15, width: 0.5, height: 0.3 } }
      ] } }]
    });
    expect(buildPresentationLayoutIR(next, { autoAdjust: false }).diagnostics).toEqual([
      expect.objectContaining({ code: 'overlap', severity: 'warning', pageNumber: 1 })
    ]);
    expect(buildPresentationLayoutIR(next).adjustments.length).toBeGreaterThan(0);
  });

  it('writes bounded section geometry adjustments back to the source outline', () => {
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '布局回写',
      sections: [{
        heading: '章节一',
        level: 1,
        blocks: [{ type: 'paragraph', text: '正文' }],
        scene: {
          schemaVersion: 1,
          elements: [
            { elementId: 'a', type: 'text', content: '标题', geometry: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, zIndex: 1 },
            { elementId: 'b', type: 'shape', geometry: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, zIndex: 2 }
          ]
        }
      }]
    }));
    const plan = buildPresentationPlanFromOutline(outline);
    const layout = buildPresentationLayoutIR(plan);
    const adjusted = applyPresentationLayoutToOutline(outline, plan, layout);
    expect(adjusted.sections[0]?.scene?.elements[1]?.geometry).not.toEqual(
      outline.sections[0]?.scene?.elements[1]?.geometry
    );
  });

  it('includes top-level cover scenes in design/layout IR and applies their adjustments', () => {
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '封面布局',
      coverScene: {
        schemaVersion: 1,
        elements: [
          { elementId: 'cover-title', type: 'text', content: '封面', geometry: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, zIndex: 1 },
          { elementId: 'cover-panel', type: 'shape', geometry: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, zIndex: 2 }
        ]
      },
      sections: [{ heading: '章节一', level: 1, blocks: [{ type: 'paragraph', text: '正文' }] }]
    }));
    const plan = buildPresentationPlanFromOutline(outline);
    const design = buildPresentationDesignIR(plan);
    expect(design.pages[0]?.elements.map((element) => element.elementId)).toEqual(['cover-title', 'cover-panel']);
    const layout = buildPresentationLayoutIR(plan);
    const adjusted = applyPresentationLayoutToOutline(outline, plan, layout);
    expect(adjusted.coverScene?.elements[1]?.geometry).not.toEqual(outline.coverScene?.elements[1]?.geometry);
  });
});
