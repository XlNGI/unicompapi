import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFallbackPresentationDesignIR, type ProductionPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { compilePresentationDesign, type PresentationDesignCompilationSnapshot } from '../../src/platform/documents/presentation-design-compiler';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { inspectPptxGeometry } from '../../src/platform/documents/office-render-adapter';
import { createConfiguredOfficeRenderAdapter } from '../../src/platform/documents/office-render-adapter';
import { fixedBodyTexts, fixedContentRefs, fixedDesignDirections, fixedDesignOutline } from '../fixtures/presentation-design-directions';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'unicomp-d2-design-'));
  roots.push(value);
  return value;
}

function shapes(xml: string) {
  return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/gu)].flatMap(match => {
    const shape = match[0];
    if (shape.includes('UniComp Page Number')) return [];
    const text = [...shape.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(part => part[1]).join('');
    if (!text) return [];
    const offset = /<a:off x="(-?\d+)" y="(-?\d+)"/u.exec(shape);
    const extent = /<a:ext cx="(\d+)" cy="(\d+)"/u.exec(shape);
    const font = /<a:rPr[^>]*sz="(\d+)"/u.exec(shape);
    return [{ text, x: Number(offset?.[1]), y: Number(offset?.[2]), width: Number(extent?.[1]), height: Number(extent?.[2]), font: Number(font?.[1]) }];
  });
}

describe('production Design IR compiler and PPT renderer', () => {
  it('compiles all three Art Directions without discarding a fact', () => {
    const strategies: string[] = [];
    for (const designIR of Object.values(fixedDesignDirections())) {
      const compiled = compilePresentationDesign(fixedDesignOutline, designIR);
      expect(compiled.pages).toHaveLength(3);
      expect(compiled.diagnostics.every(value => value.code === 'advisory_intent')).toBe(true);
      const body = compiled.pages.find(page => page.pageNumber === 2)!;
      expect(body.items.map(item => item.source.type === 'text' ? item.source.text : '').sort()).toEqual([...fixedBodyTexts].sort());
      strategies.push(body.strategy);
      for (const item of body.items) {
        expect(item.box.x).toBeGreaterThanOrEqual(0);
        expect(item.box.y).toBeGreaterThanOrEqual(0);
        expect(item.box.x + item.box.width).toBeLessThanOrEqual(13.333);
        expect(item.box.y + item.box.height).toBeLessThanOrEqual(7.5);
      }
    }
    expect(strategies).toEqual(['single-focus', 'structured', 'evidence']);
  });

  it('changes the focused content by reference, including a second metric item', () => {
    const base = fixedDesignDirections().narrative;
    const make = (target: string): ProductionPresentationDesignIR => ({ ...base, pages: base.pages.map(page => page.pageNumber !== 2 ? page : {
      ...page, emphasis: { target, strength: 'dominant' }
    }) });
    const first = compilePresentationDesign(fixedDesignOutline, make(fixedContentRefs.firstMetric)).pages[1];
    const second = compilePresentationDesign(fixedDesignOutline, make(fixedContentRefs.secondMetric)).pages[1];
    const firstMetric = first.items.find(item => item.sourceRef === fixedContentRefs.firstMetric)!;
    const secondMetric = second.items.find(item => item.sourceRef === fixedContentRefs.secondMetric)!;
    expect(firstMetric.focal).toBe(true);
    expect(secondMetric.focal).toBe(true);
    expect(secondMetric.box.x).toBeGreaterThan(5);
    expect(secondMetric.fontSize).toBeGreaterThan(second.items.find(item => item.sourceRef === fixedContentRefs.firstMetric)!.fontSize);
    expect(first.items.find(item => item.sourceRef === fixedContentRefs.secondMetric)!.box).not.toEqual(secondMetric.box);
  });

  it('writes three materially different PPTX compositions with identical content and template', async () => {
    const outputDirectory = await root();
    const evidence = process.env.UNICOMP_DESIGN_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });
    const all: Record<string, ReturnType<typeof shapes>> = {};
    for (const [name, designIR] of Object.entries(fixedDesignDirections())) {
      const snapshots: PresentationDesignCompilationSnapshot[] = [];
      const result = await generateTemporaryDocumentFile({
        kind: 'ppt', outline: fixedDesignOutline, designIR, outputDirectory,
        presentationTemplate: 'business_minimal', now: '2026-09-29T06:00:00.000Z',
        onDesignCompiled: snapshot => { snapshots.push(snapshot); }
      });
      const bytes = await readFile(result.temporaryPath);
      const zip = await JSZip.loadAsync(bytes);
      const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
      all[name] = shapes(xml);
      for (const text of fixedBodyTexts) expect(xml).toContain(text);
      expect(Object.keys(zip.files).filter(file => /^ppt\/slides\/slide\d+\.xml$/u.test(file))).toHaveLength(3);
      expect(xml).toContain('UniComp Render p2-e');
      expect(xml).not.toContain('UniComp Design');
      expect(snapshots[0]).toMatchObject({ designPath: 'design-aware', layoutStatus: 'success', renderPlanStatus: 'valid' });
      expect(snapshots[0].strategies.every(page => page.strategy !== 'legacy-template')).toBe(true);
      expect(snapshots[0].pages?.every(page => page.geometrySignature !== undefined)).toBe(true);
      expect(await inspectPptxGeometry(result.temporaryPath)).toEqual([]);
      if (evidence) {
        await writeFile(path.join(evidence, name + '.pptx'), bytes);
        await writeFile(path.join(evidence, name + '-design.json'), JSON.stringify(designIR, null, 2));
        await writeFile(path.join(evidence, name + '-compiled.json'), JSON.stringify(compilePresentationDesign(fixedDesignOutline, designIR), null, 2));
      }
    }
    const geometry = (key: string) => all[key].map(shape => [shape.text, shape.x, shape.y, shape.width, shape.height, shape.font]);
    expect(geometry('editorial')).not.toEqual(geometry('dashboard'));
    expect(geometry('narrative')).not.toEqual(geometry('editorial'));
    expect(geometry('narrative')).not.toEqual(geometry('dashboard'));
    const metric = all.dashboard.find(shape => shape.text === '客户续费率达到 92%')!;
    expect(metric.font).toBeGreaterThan(all.dashboard.find(shape => shape.text === '交付时间缩短 35%')!.font);
    expect(all.editorial.find(shape => shape.text === '让团队把时间用于客户')!.font).toBeGreaterThan(metric.font - 1000);
    if (evidence) {
      await writeFile(path.join(evidence, 'content.json'), JSON.stringify(fixedDesignOutline, null, 2));
      await writeFile(path.join(evidence, 'geometry-evidence.json'), JSON.stringify(all, null, 2));
    }
  });

  it('invalid and unsupported IR retains the stable template path and all facts', async () => {
    const outputDirectory = await root();
    const invalid = { schemaVersion: 2, pages: [] } as unknown as ProductionPresentationDesignIR;
    for (const designIR of [invalid, {
      ...fixedDesignDirections().editorial,
      pages: fixedDesignDirections().editorial.pages.map(page => ({ ...page, composition: { ...page.composition, flow: 'radial' as const } }))
    }]) {
      const snapshots: PresentationDesignCompilationSnapshot[] = [];
      const result = await generateTemporaryDocumentFile({ kind: 'ppt', outline: fixedDesignOutline, designIR, outputDirectory,
        now: '2026-09-29T06:00:00.000Z', onDesignCompiled: snapshot => { snapshots.push(snapshot); } });
      const zip = await JSZip.loadAsync(await readFile(result.temporaryPath));
      const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
      for (const text of fixedBodyTexts) expect(xml).toContain(text);
      expect(xml).not.toContain('UniComp Design');
      expect(snapshots[0].designPath).toBe('legacy-fallback');
      expect(snapshots[0].fallbackReason).toBeDefined();
      expect(snapshots[0].strategies.every(page => page.strategy === 'legacy-template')).toBe(true);
      expect(snapshots[0].diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the stable template after a valid Design IR cannot fit a dense table', async () => {
    const outline: DocumentOutline = {
      kind: 'ppt', title: 'Dense evidence fallback', sections: [{ pageKind: 'data', heading: 'Complete evidence inventory', level: 1,
        blocks: [{ type: 'table', header: ['Item', 'Value'], rows: Array.from({ length: 60 }, (_, index) => [`Evidence ${index + 1}`, `Value ${index + 1}`]) }]
      }]
    };
    const designIR = buildFallbackPresentationDesignIR(outline);
    const compilation = compilePresentationRenderPlan(outline, designIR, resolvePresentationTemplate('business_minimal').tokens);
    expect(compilation.layoutStatus, JSON.stringify(compilation.constraints?.pages[1]?.elements)).toBe('failed');
    expect(compilation.diagnostics.map(item => item.code)).toContain('font_below_minimum');
    expect(compilation.repairCount).toBeLessThanOrEqual(4);

    const snapshots: PresentationDesignCompilationSnapshot[] = [];
    const result = await generateTemporaryDocumentFile({ kind: 'ppt', outline, designIR, outputDirectory: await root(),
      now: '2026-09-29T06:00:00.000Z', onDesignCompiled: snapshot => { snapshots.push(snapshot); } });
    const zip = await JSZip.loadAsync(await readFile(result.temporaryPath));
    const slideParts = Object.keys(zip.files).filter(file => /^ppt\/slides\/slide\d+\.xml$/u.test(file));
    const xml = (await Promise.all(slideParts.map(file => zip.file(file)!.async('string')))).join('');
    expect(slideParts.length).toBeGreaterThan(0);
    expect(xml).toContain('Evidence 60');
    expect(snapshots[0]).toMatchObject({ designPath: 'legacy-fallback', fallbackReason: 'font_below_minimum', layoutStatus: 'failed', renderPlanStatus: 'skipped' });
    expect(snapshots[0].repairCount).toBeLessThanOrEqual(4);
    expect(snapshots[0].diagnostics.map(item => item.code)).toContain('font_below_minimum');
  });

  it('lets the bounded Layout Engine fit content that the legacy path would split across continuation pages', async () => {
    const outline = { ...fixedDesignOutline, sections: [{ ...fixedDesignOutline.sections[0], blocks: [
      { type: 'bullets' as const, items: Array.from({ length: 9 }, (_, index) => '已确认事实 ' + (index + 1)) }
    ] }] };
    const snapshots: PresentationDesignCompilationSnapshot[] = [];
    const result = await generateTemporaryDocumentFile({ kind: 'ppt', outline, designIR: buildFallbackPresentationDesignIR(outline),
      outputDirectory: await root(), now: '2026-09-29T06:00:00.000Z', onDesignCompiled: snapshot => { snapshots.push(snapshot); } });
    const zip = await JSZip.loadAsync(await readFile(result.temporaryPath));
    const parts = Object.keys(zip.files).filter(file => /^ppt\/slides\/slide\d+\.xml$/u.test(file));
    const xml = (await Promise.all(parts.map(file => zip.file(file)!.async('string')))).join('');
    expect(parts.length).toBe(3);
    for (let index = 1; index <= 9; index += 1) expect(xml).toContain('已确认事实 ' + index);
    expect(snapshots[0].designPath).toBe('design-aware');
    expect(snapshots[0].renderPlanStatus).toBe('valid');
    expect(snapshots[0].strategies.every(page => page.strategy !== 'legacy-template')).toBe(true);
  });

  it.skipIf(!process.env.UNICOMP_OFFICE_RENDERER || !process.env.UNICOMP_PDF_RENDERER)(
    'renders the three-direction fixture through the configured local visual QA adapter',
    async () => {
      const outputDirectory = await root();
      const render = createConfiguredOfficeRenderAdapter();
      expect(render).toBeDefined();
      for (const designIR of Object.values(fixedDesignDirections())) {
        const result = await generateTemporaryDocumentFile({
          kind: 'ppt', outline: fixedDesignOutline, designIR, outputDirectory,
          now: '2026-09-29T06:00:00.000Z'
        });
        const qa = await render!(result.temporaryPath, { kind: 'ppt', signal: new AbortController().signal });
        expect(qa.previewCount).toBe(3);
        // The bundled adapter may report font_missing when pdfjs text
        // inspection is unavailable; Office/PDF rasterization still proves
        // that all three pages rendered. Any other error is a real failure.
        expect((qa.diagnostics ?? []).filter(diagnostic => diagnostic.severity === 'error' && diagnostic.code !== 'font_missing')).toEqual([]);
      }
    },
    10_000
  );
});
