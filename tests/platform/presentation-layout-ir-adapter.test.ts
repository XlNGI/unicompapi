import { describe, expect, it } from 'vitest';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildDocumentContentSnapshot } from '../../src/domain/entities/document-content-snapshot';
import { buildFallbackPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { parseProductionPresentationLayoutIR, validateProductionPresentationLayoutIR, type ProductionPresentationLayoutIR } from '../../src/domain/entities/presentation-layout-ir';
import { parsePresentationRenderPlan, type PresentationRenderPlan, type PresentationRenderPlanContent, type PresentationRenderPlanElement } from '../../src/domain/entities/presentation-render-plan';
import { parsePresentationPlan, type PresentationPageScene } from '../../src/domain/entities/presentation-plan';
import { buildPresentationLayoutIR } from '../../src/domain/entities/presentation-design';
import {
  adaptLegacyPresentationLayout, adaptLegacyPresentationRenderPlan, buildProductionPresentationLayoutIR, computePresentationLayoutDigest,
  derivePresentationRenderPlanFromLayoutIR, parseVerifiedProductionPresentationLayoutIR
} from '../../src/platform/documents/presentation-layout-ir-adapter';

const outline: DocumentOutline = { kind: 'ppt', title: 'Canonical title', sections: [
  { heading: 'First section', level: 1, blocks: [{ type: 'quote', text: 'Precise fact' }, { type: 'numbered', items: ['Step A', 'Step B'] }] },
  { heading: 'Second section', level: 1, blocks: [
    { type: 'table', header: ['Name', 'Value'], rows: [['Revenue', '42']] },
    { type: 'chart', chartKind: 'bar', title: 'Results', data: [{ label: 'Revenue', value: 42 }] }
  ] }
] };

function writerPlan(source: DocumentOutline): PresentationRenderPlan {
  const pageCount = source.sections.length ? source.sections.length + 2 : 1;
  return {
    schemaVersion: 1, canvas: { width: 13.333, height: 7.5 }, minimumFontSize: 14,
    pages: Array.from({ length: pageCount }, (_, index) => {
      const section = source.sections[index - 1];
      const values: Array<{ ref: string; content: PresentationRenderPlanContent }> = [];
      if (section) {
        values.push({ ref: `outline.sections[${index - 1}].heading`, content: { type: 'text', text: section.heading } });
        if (section.takeaway) values.push({ ref: `outline.sections[${index - 1}].takeaway`, content: { type: 'text', text: section.takeaway } });
      } else if (index === pageCount - 1 && index > 0) {
        const last = source.sections.length - 1;
        if (source.sections[last]?.action) values.push({ ref: `outline.sections[${last}].action`, content: { type: 'text', text: source.sections[last].action! } });
        let takeaway = last;
        while (takeaway >= 0 && !source.sections[takeaway].takeaway) takeaway -= 1;
        if (takeaway >= 0) values.push({ ref: `outline.sections[${takeaway}].takeaway`, content: { type: 'text', text: source.sections[takeaway].takeaway! } });
        values.push({ ref: 'outline.title', content: { type: 'text', text: source.title } });
      } else values.push({ ref: 'outline.title', content: { type: 'text', text: source.title } });
      section?.blocks.forEach((block, blockIndex) => {
        const ref = `outline.sections[${index - 1}].blocks[${blockIndex}]`;
        if (block.type === 'paragraph' || block.type === 'quote') values.push({ ref, content: { type: 'text', text: block.text } });
        else if (block.type === 'bullets' || block.type === 'numbered') block.items.forEach((text, item) => values.push({ ref: `${ref}.items[${item}]`, content: { type: 'text', text } }));
        else if (block.type === 'table') values.push({ ref, content: { type: 'table', header: block.header, rows: block.rows } });
        else if (block.type === 'chart') values.push({ ref, content: { type: 'chart', chartKind: block.chartKind, ...(block.title ? { title: block.title } : {}), data: block.data } });
      });
      if (section?.action) values.push({ ref: `outline.sections[${index - 1}].action`, content: { type: 'text', text: section.action } });
      const elements: PresentationRenderPlanElement[] = values.map((value, element) => ({
        renderId: `p${index + 1}-e${element}`, source: { kind: 'outline', ref: value.ref }, type: value.content.type,
        geometry: { x: 0.8, y: 0.4 + element * 1.25, width: 11.5, height: 1 },
        style: { fontFamily: 'Arial', fontSize: 18, bold: false, color: '222222', alignment: 'left', verticalAlignment: 'top',
          ...(value.content.type === 'chart' ? { showLegend: false, showValues: true } : {}) },
        content: value.content, zIndex: element
      }));
      elements.push({ renderId: `p${index + 1}-number`, source: { kind: 'generated', key: 'page-number' }, type: 'text',
        geometry: { x: 12, y: 7, width: 0.5, height: 0.25 }, style: { fontFamily: 'Arial', fontSize: 10, bold: false, color: '222222', alignment: 'right', verticalAlignment: 'middle' },
        content: { type: 'text', text: String(index + 1) }, zIndex: values.length });
      return { pageNumber: index + 1, pageRole: index === 0 ? 'hero' as const : index === pageCount - 1 ? 'closing' as const : 'content' as const, backgroundColor: 'FFFFFF', elements };
    })
  };
}
function fixture(source = outline) {
  const content = buildDocumentContentSnapshot({ outline: source, identityScope: 'layout-fixture' });
  const design = buildFallbackPresentationDesignIR(source);
  const plan = writerPlan(source);
  return { content, design, plan, layout: buildProductionPresentationLayoutIR({ renderPlan: plan, content, design }) };
}
function rehashedLayout(layout: ProductionPresentationLayoutIR): ProductionPresentationLayoutIR {
  return { ...layout, identity: { ...layout.identity, layoutDigest: computePresentationLayoutDigest(layout) } };
}

describe('sole production Layout IR contract', () => {
  it('keeps solved geometry, font and z-order while resolving every writer value from canonical content', () => {
    const { content, plan, layout } = fixture();
    const rendered = derivePresentationRenderPlanFromLayoutIR(layout, content);
    for (const [index, page] of rendered.pages.entries()) {
      expect(page.elements.map(element => [element.geometry, element.style, element.content, element.zIndex]))
        .toEqual(plan.pages[index].elements.map(element => [element.geometry, element.style, element.content, element.zIndex]));
    }
    expect(rendered.inputIdentity).toEqual(layout.identity);
    expect(rendered.pages[2].elements.find(element => element.type === 'chart')?.content).toEqual({ type: 'chart', chartKind: 'bar', title: 'Results', data: [{ label: 'Revenue', value: 42 }] });
    expect(JSON.stringify(layout)).not.toContain('Precise fact');
    expect(JSON.stringify(layout)).not.toContain('Canonical title');
    expect(layout.pages.every(page => page.elements.every(element => !('content' in element)))).toBe(true);
  });

  it('rejects a valid-looking render payload that disagrees with the content source', () => {
    const { content, design, plan } = fixture();
    const tampered = structuredClone(plan);
    Object.assign(tampered.pages[1].elements[1].content, { text: 'Invented fact' });
    expect(() => buildProductionPresentationLayoutIR({ renderPlan: tampered, content, design })).toThrow('layout_candidate_content_mismatch');
  });

  it.each([
    { name: 'paragraph', source: { kind: 'ppt', title: 'Paragraph deck', sections: [{ heading: 'Evidence', level: 1, blocks: [{ type: 'paragraph', text: 'Required paragraph' }] }] } as DocumentOutline, pageIndex: 1, elementIndex: 1 },
    { name: 'table', source: outline, pageIndex: 2, elementIndex: 1 },
    { name: 'numbered item', source: outline, pageIndex: 1, elementIndex: 2 }
  ])('refuses an omitted $name after the attacker recomputes the layout hash', ({ source, pageIndex, elementIndex }) => {
    const { content, layout, design, plan } = fixture(source);
    const omitted = rehashedLayout({ ...layout, pages: layout.pages.map((page, index) => index === pageIndex
      ? { ...page, elements: page.elements.filter((_, element) => element !== elementIndex) } : page) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(omitted, { content, design })).toThrow('layout_source_coverage_mismatch');
    expect(() => derivePresentationRenderPlanFromLayoutIR(omitted, content)).toThrow('layout_source_coverage_mismatch');
    const incompleteWriter: PresentationRenderPlan = { ...plan, pages: plan.pages.map((page, index) => index === pageIndex
      ? { ...page, elements: page.elements.filter((_, element) => element !== elementIndex) } : page) };
    expect(() => buildProductionPresentationLayoutIR({ renderPlan: incompleteWriter, content, design })).toThrow('layout_source_coverage_mismatch');
  });

  it('rejects a repeated canonical source with a different valid element identity and geometry', () => {
    const { content, layout, design } = fixture();
    const body = layout.pages[1].elements[1];
    const repeated = rehashedLayout({ ...layout, pages: layout.pages.map((page, index) => index === 1
      ? { ...page, elements: [...page.elements, { ...body, elementId: 'element-extra-copy',
        geometry: { ...body.geometry, y: 5.6, height: 0.8 }, zIndex: 99 }] } : page) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(repeated, { content, design })).toThrow();
    expect(() => derivePresentationRenderPlanFromLayoutIR(repeated, content)).toThrow();
  });

  it.each(['missing', 'duplicate', 'unexpected'] as const)('rejects %s Host generated page-number inventory after recomputing the hash', mode => {
    const { content, layout, design } = fixture();
    const page = layout.pages[1];
    const number = page.elements.find(element => element.source.kind === 'generated')!;
    const elements = mode === 'missing' ? page.elements.filter(element => element !== number)
      : mode === 'duplicate' ? [...page.elements, { ...number, elementId: 'element-extra-number',
        geometry: { ...number.geometry, x: 11 }, zIndex: 99 }]
        : page.elements.map(element => element === number ? { ...number,
          source: { kind: 'generated' as const, key: 'closing-label' as const }, style: { ...number.style, fontSize: 18 } } : element);
    const changed = rehashedLayout({ ...layout, pages: layout.pages.map((original, index) => index === 1 ? { ...page, elements } : original) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(changed, { content, design })).toThrow('layout_generated_source_coverage_mismatch');
    expect(() => derivePresentationRenderPlanFromLayoutIR(changed, content)).toThrow('layout_generated_source_coverage_mismatch');
  });

  it('uses stable body, cover, closing and element identities after insertion and reordering', () => {
    const initial = fixture();
    const changed: DocumentOutline = { ...outline, sections: [
      { heading: 'Inserted', level: 1, blocks: [{ type: 'paragraph', text: 'New fact' }] }, outline.sections[1], outline.sections[0]
    ] };
    const content = buildDocumentContentSnapshot({ outline: changed, previousSnapshot: initial.content });
    const layout = buildProductionPresentationLayoutIR({ renderPlan: writerPlan(changed), content, design: buildFallbackPresentationDesignIR(changed) });
    for (const oldPage of initial.layout.pages) {
      const newPage = layout.pages.find(page => page.pageId === oldPage.pageId)!;
      expect(newPage).toBeDefined();
      expect(newPage.elements.map(element => element.elementId)).toEqual(oldPage.elements.map(element => element.elementId));
    }
    expect(layout.identity.layoutId).toBe(initial.layout.identity.layoutId);
    expect(layout.identity.contentRevision).toBe(2);
    expect(layout.identity.layoutDigest).not.toBe(initial.layout.identity.layoutDigest);
  });

  it('refuses stale snapshot revisions, altered hashes and changed layout geometry', () => {
    const { content, layout } = fixture();
    const next = buildDocumentContentSnapshot({ outline, previousSnapshot: content });
    expect(() => derivePresentationRenderPlanFromLayoutIR(layout, next)).toThrow('layout_content_identity_mismatch');
    const altered = structuredClone(layout);
    Object.assign(altered.pages[1].elements[0].geometry, { x: 0.9 });
    expect(() => parseVerifiedProductionPresentationLayoutIR(altered, { content })).toThrow('layout_digest_mismatch');
    expect(() => derivePresentationRenderPlanFromLayoutIR({ ...layout, identity: { ...layout.identity, contentDigest: 'a'.repeat(64) } }, content)).toThrow('layout_digest_mismatch');
  });

  it('rejects cross-page source reassignment even when an attacker recalculates the layout digest', () => {
    const { content, layout } = fixture();
    const altered = structuredClone(layout);
    Object.assign(altered.pages[1].elements[0], { source: { kind: 'content', ref: content.sections[1].headingId } });
    Object.assign(altered.identity, { layoutDigest: computePresentationLayoutDigest(altered) });
    expect(() => derivePresentationRenderPlanFromLayoutIR(altered, content)).toThrow('layout_content_source_wrong_page');
  });

  it('validates source coverage, uniqueness and explicitly forbids content copies in Layout IR', () => {
    const { layout } = fixture();
    expect(validateProductionPresentationLayoutIR(layout, { expectedSourceIdsByPage: [] }).some(issue => issue.code === 'source_coverage_mismatch')).toBe(true);
    const copied = structuredClone(layout);
    Object.assign(copied.pages[1].elements[1], { content: { type: 'text', text: 'A second fact source' } });
    expect(() => parseProductionPresentationLayoutIR(copied)).toThrow();
    const duplicated = structuredClone(layout);
    Object.assign(duplicated.pages[1], { pageId: layout.pages[0].pageId });
    expect(validateProductionPresentationLayoutIR(duplicated).some(issue => issue.code === 'duplicate_identity')).toBe(true);
  });

  it('rejects out-of-canvas geometry and minimum-font bypasses at the contract boundary', () => {
    const { layout } = fixture();
    const overflow = structuredClone(layout);
    Object.assign(overflow.pages[1].elements[0].geometry, { x: 13 });
    expect(() => parseProductionPresentationLayoutIR(overflow)).toThrow();
    const font = structuredClone(layout);
    Object.assign(font.pages[1].elements[0].style, { fontSize: 8 });
    expect(() => parseProductionPresentationLayoutIR(font)).toThrow();
  });

  it('records bounded repairs using stable page identities and sanitized diagnostic codes', () => {
    const { plan, content, design } = fixture();
    const layout = buildProductionPresentationLayoutIR({ renderPlan: plan, content, design,
      diagnostics: [{ code: 'layout_overflow', pageNumber: 2 }], repairs: [{ attempt: 1, action: 'reduce_gap', pages: [2] }] });
    expect(layout.repairs[0].pageIds).toEqual([layout.pages[1].pageId]);
    expect(layout.diagnostics[0]).toEqual({ code: 'layout_overflow', pageId: layout.pages[1].pageId });
    expect(() => buildProductionPresentationLayoutIR({ renderPlan: plan, content, design, diagnostics: [{ code: 'C:/private/project/fact' }] })).toThrow();
    expect(() => buildProductionPresentationLayoutIR({ renderPlan: plan, content, design, repairs: [{ attempt: 1, action: 'reduce_gap', pages: [40] }] })).toThrow('layout_repair_page_unresolved');
    expect(() => parseProductionPresentationLayoutIR({ ...layout, repairs: Array.from({ length: 5 }, (_, index) => ({ ...layout.repairs[0], attempt: index + 1 })) })).toThrow();
  });

  it('provides auditable legacy adaptation without calculating replacement coordinates', () => {
    const { content, plan } = fixture();
    const layout = adaptLegacyPresentationRenderPlan({ renderPlan: plan, content, fallbackReason: 'legacy_workflow' });
    expect(layout.compatibility).toEqual({ origin: 'legacy-render-plan', fallbackReason: 'legacy_workflow' });
    expect(layout.identity.designDigest).toBeUndefined();
    expect(derivePresentationRenderPlanFromLayoutIR(layout, content).pages.map(page => page.elements.map(element => element.geometry)))
      .toEqual(plan.pages.map(page => page.elements.map(element => element.geometry)));
    expect(() => parseProductionPresentationLayoutIR({ ...layout, compatibility: { origin: 'legacy-render-plan' } })).toThrow();
  });

  it('replays normalized JSON deterministically and returns independent writer objects', () => {
    const { content, design, plan, layout } = fixture();
    const second = buildProductionPresentationLayoutIR({ renderPlan: JSON.parse(JSON.stringify(plan)), content, design });
    expect(second).toEqual(layout);
    expect(parseVerifiedProductionPresentationLayoutIR(JSON.parse(JSON.stringify(layout)), { content, design })).toEqual(layout);
    const derived = derivePresentationRenderPlanFromLayoutIR(layout, content);
    Object.assign(derived.pages[1].elements[0].geometry, { x: 7 });
    Object.assign(derived.pages[2].elements[1].content, { rows: [['Changed', '99']] });
    expect(layout.pages[1].elements[0].geometry.x).toBe(0.8);
    expect(content.sections[1].blocks[0].payload).toEqual(outline.sections[1].blocks[0]);
  });

  it('retains legacy Render Plan parsing while validating canonical source inventories and input identity', () => {
    const { plan, layout, content } = fixture();
    expect(parsePresentationRenderPlan(plan)).toEqual(plan);
    const derived = derivePresentationRenderPlanFromLayoutIR(layout, content);
    expect(parsePresentationRenderPlan(derived, { validSourceRefsByPage: derived.pages.map(page => ({ pageNumber: page.pageNumber,
      sourceRefs: page.elements.flatMap(element => element.source.kind === 'content' ? [element.source.ref] : []) })) })).toEqual(derived);
    expect(() => parsePresentationRenderPlan({ ...derived, inputIdentity: { ...derived.inputIdentity, arbitraryPath: 'C:/private' } })).toThrow();
  });

  it('allows the currently validated closing action without allowing unrelated body sources', () => {
    const withAction: DocumentOutline = { kind: 'ppt', title: 'Action deck', sections: [{ heading: 'Result', level: 1, action: 'Start next week', blocks: [{ type: 'paragraph', text: 'Evidence' }] }] };
    const content = buildDocumentContentSnapshot({ outline: withAction, identityScope: 'action-deck' });
    const plan = writerPlan(withAction);
    Object.assign(plan.pages[2].elements[0], { source: { kind: 'outline', ref: 'outline.sections[0].action' }, content: { type: 'text', text: 'Start next week' } });
    const layout = buildProductionPresentationLayoutIR({ content, renderPlan: plan, design: buildFallbackPresentationDesignIR(withAction) });
    expect(derivePresentationRenderPlanFromLayoutIR(layout, content).pages[2].elements[0].content).toEqual({ type: 'text', text: 'Start next week' });
    Object.assign(plan.pages[2].elements[0], { source: { kind: 'outline', ref: 'outline.sections[0].heading' }, content: { type: 'text', text: 'Result' } });
    expect(() => buildProductionPresentationLayoutIR({ content, renderPlan: plan, design: buildFallbackPresentationDesignIR(withAction) })).toThrow('layout_content_source_wrong_page');
  });

  it('adapts old pure-text scene boxes without resolving or adjusting their geometry again', () => {
    const scene: PresentationPageScene = { schemaVersion: 1, elements: [{ elementId: 'cover-title', type: 'text', content: 'Cover statement', geometry: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, style: { fontSize: 28, textColor: '222222' }, zIndex: 0 }] };
    const content = buildDocumentContentSnapshot({ outline: { kind: 'ppt', title: 'Scene deck', sections: [], coverScene: scene }, identityScope: 'scene-deck' });
    const plan = parsePresentationPlan({ kind: 'ppt', title: 'Scene deck', templateId: 'business_minimal', sourceRefs: [], preserve: [], coverScene: scene,
      pages: [{ pageNumber: 1, sourceSection: 'cover', pageKind: 'cover', layout: 'cover', composition: 'cover', elements: [],
        capacity: { contentGroups: 1, bodyCharacters: 15, maxContentGroups: 4, maxBodyCharacters: 500, maxTableColumns: 5, minBodyFontSize: 18, withinLimit: true }, sourceRefs: [], preserve: [] }] });
    const legacy = buildPresentationLayoutIR(plan, { autoAdjust: false });
    const changed = { ...legacy, pages: [{ ...legacy.pages[0], boxes: [{ ...legacy.pages[0].boxes[0], x: 0.2 }] }] };
    const result = adaptLegacyPresentationLayout({ layout: changed, plan, content, tokens: { background: 'FFFFFF', surface: 'EEEEEE', text: '222222', muted: '777777', accent: '0000FF', secondaryAccent: 'FF0000' } });
    expect(result.status).toBe('adapted');
    if (result.status !== 'adapted') throw new Error('expected adapted legacy text scene');
    expect(result.layout.pages[0].elements[0].geometry.x).toBeCloseTo(13.333 * 0.2);
    expect(derivePresentationRenderPlanFromLayoutIR(result.layout, content).pages[0].elements[0].content).toEqual({ type: 'text', text: 'Cover statement' });
    const complex = { ...plan, coverScene: { ...scene, elements: [{ ...scene.elements[0], type: 'image' as const }] } };
    expect(adaptLegacyPresentationLayout({ layout: changed, plan: complex, content, tokens: { background: 'FFFFFF', surface: 'EEEEEE', text: '222222', muted: '777777', accent: '0000FF', secondaryAccent: 'FF0000' } }))
      .toMatchObject({ status: 'compatibility_unsupported', reason: 'unsupported_scene_element', unsupportedTypes: ['image'] });
  });
});
