import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocumentContentSnapshot } from '../../src/domain/entities/document-content-snapshot';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildPresentationLayoutIR } from '../../src/domain/entities/presentation-design';
import type { PresentationPageScene } from '../../src/domain/entities/presentation-plan';
import type { ProductionPresentationLayoutIR } from '../../src/domain/entities/presentation-layout-ir';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { adaptLegacyPresentationLayout, computePresentationLayoutDigest } from '../../src/platform/documents/presentation-layout-ir-adapter';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { buildPresentationPlanFromOutline } from '../../src/platform/documents/presentation-plan';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { fixedDesignDirections, fixedDesignOutline } from '../fixtures/presentation-design-directions';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-layout-boundaries-'));
  roots.push(root);
  return root;
}
function textShapes(xml: string): readonly { readonly xml: string; readonly text: string; readonly geometry: readonly number[] }[] {
  return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/gu)].flatMap(match => {
    const shape = match[0];
    const text = [...shape.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(part => part[1]).join('');
    if (!text) return [];
    const offset = /<a:off x="(-?\d+)" y="(-?\d+)"/u.exec(shape);
    const extent = /<a:ext cx="(\d+)" cy="(\d+)"/u.exec(shape);
    return [{ xml: shape, text, geometry: [Number(offset?.[1]), Number(offset?.[2]), Number(extent?.[1]), Number(extent?.[2])] }];
  });
}
function assertGeometry(shape: ReturnType<typeof textShapes>[number], expected: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void {
  [expected.x, expected.y, expected.width, expected.height].forEach((value, index) => {
    expect(Math.abs(shape.geometry[index] - Math.round(value * 914_400))).toBeLessThanOrEqual(1);
  });
}

describe('production layout callback and legacy coverage boundaries', () => {
  it('writes the original canonical plan when a prepared callback mutates all received planning objects', async () => {
    const outline = structuredClone(fixedDesignOutline);
    const originalOutline = structuredClone(outline);
    const contentSnapshot = buildDocumentContentSnapshot({ outline, identityScope: 'callback-isolation' });
    const originalContent = structuredClone(contentSnapshot);
    const designIR = fixedDesignDirections().dashboard;
    const originalDesign = structuredClone(designIR);
    const compilation = compilePresentationRenderPlan(outline, designIR, resolvePresentationTemplate('business_minimal').tokens, { contentSnapshot });
    expect(compilation.layoutStatus).toBe('success');
    expect(compilation.plan).toBeDefined();
    expect(compilation.layoutIR).toBeDefined();
    const expectedPlan = structuredClone(compilation.plan!);
    const expectedLayout = structuredClone(compilation.layoutIR!);
    let alteredLayout: ProductionPresentationLayoutIR | undefined;
    let finalDesignPath: string | undefined;
    let callbacks = 0;
    const generated = await generateTemporaryDocumentFile({
      kind: 'ppt', outline, contentSnapshot, designIR, presentationTemplate: 'business_minimal',
      outputDirectory: await temporaryRoot(), now: '2026-10-06T10:00:00.000Z',
      onPlanPrepared: prepared => {
        callbacks += 1;
        expect(prepared.layoutIR?.identity).toEqual(expectedLayout.identity);
        Object.assign(prepared.contentSnapshot, { title: 'MUTATED CONTENT', revision: 999 });
        Object.assign(prepared.outline, { title: 'MUTATED OUTLINE' });
        Object.assign(prepared.outline.sections[0], { heading: 'MUTATED HEADING' });
        Object.assign(prepared.designIR!.globalDesign, { visualTone: 'minimal' });
        Object.assign(prepared.snapshot, { designPath: 'legacy-fallback', fallbackReason: 'callback_mutation' });
        for (const page of prepared.renderPlan!.pages) for (const element of page.elements) {
          Object.assign(element.geometry, { x: 0.1, y: 0.1, width: 1.5, height: 0.5 });
          Object.assign(element.style, { fontSize: 14, fontFamily: 'MUTATED FONT' });
          Object.assign(element.content, { text: 'MUTATED WRITER CONTENT' });
        }
        for (const page of prepared.layoutIR!.pages) for (const element of page.elements) {
          Object.assign(element.geometry, { x: 0.1, y: 0.1, width: 1.5, height: 0.5 });
          Object.assign(element.style, { fontSize: 14, fontFamily: 'MUTATED FONT' });
        }
        Object.assign(prepared.layoutIR!.identity, { layoutDigest: computePresentationLayoutDigest(prepared.layoutIR!) });
        alteredLayout = structuredClone(prepared.layoutIR!);
      },
      onDesignCompiled: snapshot => { finalDesignPath = snapshot.designPath; }
    });
    expect(callbacks).toBe(1);
    expect(alteredLayout!.identity.layoutDigest).not.toBe(expectedLayout.identity.layoutDigest);
    expect(outline).toEqual(originalOutline);
    expect(contentSnapshot).toEqual(originalContent);
    expect(designIR).toEqual(originalDesign);
    expect(finalDesignPath).toBe('design-aware');
    const zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
    for (const page of expectedPlan.pages) {
      const xml = await zip.file(`ppt/slides/slide${page.pageNumber}.xml`)!.async('string');
      const shapes = textShapes(xml);
      for (const element of page.elements) {
        expect(element.content.type).toBe('text');
        const shape = shapes.find(item => item.xml.includes(`name="UniComp Render ${element.renderId}"`));
        expect(shape, element.renderId).toBeDefined();
        expect(shape!.text).toBe(element.content.type === 'text' ? element.content.text : '');
        assertGeometry(shape!, element.geometry);
        expect(shape!.xml).toContain(`sz="${Math.round(element.style.fontSize * 100)}"`);
      }
      expect(xml).not.toContain('MUTATED');
    }
  });

  it('marks legacy scene projection coverage and matches the old text renderer while excluding its footer', async () => {
    const scene = (label: string): PresentationPageScene => ({ schemaVersion: 1, elements: [
      { elementId: `${label}-default`, type: 'text', content: `${label} default`, geometry: { x: 0.1, y: 0.1, width: 0.7, height: 0.15 }, zIndex: 0 },
      { elementId: `${label}-heading`, type: 'text', content: `${label} heading`, geometry: { x: 0.1, y: 0.35, width: 0.7, height: 0.15 }, style: { fontSize: 18, fontFamily: 'Arial', textColor: '123456', fill: 'FFFFFF' }, zIndex: 1 },
      { elementId: `${label}-metric`, type: 'text', content: `${label} metric`, geometry: { x: 0.1, y: 0.6, width: 0.7, height: 0.2 }, style: { fontSize: 40 }, zIndex: 2 }
    ] });
    const outline: DocumentOutline = { kind: 'ppt', title: 'Legacy coverage', coverScene: scene('cover'), closingScene: scene('closing'),
      sections: [{ heading: 'Body', level: 1, blocks: [{ type: 'paragraph', text: 'Body' }], scene: scene('body') }] };
    const content = buildDocumentContentSnapshot({ outline, identityScope: 'legacy-coverage' });
    const plan = buildPresentationPlanFromOutline(outline, { templateId: 'business_minimal' });
    const layout = buildPresentationLayoutIR(plan, { autoAdjust: false });
    const tokens = resolvePresentationTemplate('business_minimal').tokens;
    const adapted = adaptLegacyPresentationLayout({ layout, plan, content, tokens });
    expect(adapted).toMatchObject({ status: 'adapted', scope: 'legacy_scene_projection', coverage: 'explicit_scene_boxes',
      excludedArtifactElements: ['template_decorations', 'page_numbers', 'external_images'] });
    if (adapted.status !== 'adapted') throw new Error('expected legacy text projection');
    const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, presentationTemplate: 'business_minimal',
      outputDirectory: await temporaryRoot(), now: '2026-10-06T10:00:00.000Z' });
    const zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
    for (const page of adapted.layout.pages) {
      const xml = await zip.file(`ppt/slides/slide${page.pageNumber}.xml`)!.async('string');
      const shapes = textShapes(xml);
      const pageScene = page.pageNumber === 1 ? outline.coverScene! : page.pageNumber === 3 ? outline.closingScene! : outline.sections[0].scene!;
      expect(page.elements).toHaveLength(pageScene.elements.length);
      for (const [index, element] of page.elements.entries()) {
        const shape = shapes.find(item => item.text === pageScene.elements[index].content)!;
        expect(shape).toBeDefined();
        assertGeometry(shape, element.geometry);
        expect(shape.xml).toContain(`sz="${element.style.fontSize * 100}"`);
        expect(shape.xml).toContain(`typeface="${element.style.fontFamily}"`);
        expect(shape.xml).toContain(`<a:srgbClr val="${element.style.color}"`);
        expect(/<a:rPr[^>]* b="1"/u.test(shape.xml)).toBe(element.style.bold);
        expect(shape.xml).toContain(`anchor="${element.style.verticalAlignment === 'bottom' ? 'b' : 't'}"`);
        expect(element.style.fill).toBeUndefined();
      }
      if (page.pageNumber === 2) {
        expect(shapes).toHaveLength(page.elements.length + 1);
        expect(shapes.some(shape => shape.xml.includes('UniComp Page Number'))).toBe(true);
        expect(page.elements.some(element => element.source.kind === 'generated')).toBe(false);
      }
    }
  });
});
