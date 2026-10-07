import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocumentContentSnapshot } from '../../src/domain/entities/document-content-snapshot';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR, type ProductionPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import type { PresentationRenderPlanElement, PresentationRenderPlanPage } from '../../src/domain/entities/presentation-render-plan';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { createConfiguredOfficeRenderAdapter, inspectPptxGeometry } from '../../src/platform/documents/office-render-adapter';
import { parsePresentationDesignAttempt, persistPreparedPresentationAttempt, presentationAttemptPath, type PresentationDesignAttempt } from '../../src/platform/documents/presentation-design-attempts';
import { computeDocumentContentDigest } from '../../src/platform/documents/presentation-layout-ir-adapter';
import type { PresentationProductionPlan } from '../../src/platform/documents/presentation-production-plan';
import { resolvePresentationPageStyle } from '../../src/platform/documents/presentation-style-compiler';
import { resolvePresentationTemplate, type PresentationTemplateId } from '../../src/platform/documents/presentation-template';
import { NodeProjectStorage } from '../../src/platform/storage';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { stylePagesDesign, stylePagesFacts, stylePagesOutline, stylePagesRoles } from '../fixtures/presentation-style-pages';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-style-production-'));
  roots.push(root);
  return root;
}

function elementXml(xml: string, elementId: string): string {
  const objectName = `name="UniComp Render ${elementId}"`;
  const found = [...xml.matchAll(/<p:(?:sp|graphicFrame)\b[^>]*>[\s\S]*?<\/p:(?:sp|graphicFrame)>/gu)]
    .find(match => match[0].includes(objectName));
  expect(found, objectName).toBeDefined();
  return found![0];
}
function color(xml: string): string | undefined { return /<a:solidFill>\s*<a:srgbClr val="([A-Fa-f0-9]{6})"/u.exec(xml)?.[1].toUpperCase(); }
function textRun(xml: string): string { return /<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/u.exec(xml)?.[0] ?? ''; }
function text(xml: string): string { return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(match => match[1]).join(''); }
function assertGeometry(xml: string, element: PresentationRenderPlanElement): void {
  const offset = /<a:off x="(-?\d+)" y="(-?\d+)"/u.exec(xml);
  const extent = /<a:ext cx="(\d+)" cy="(\d+)"/u.exec(xml);
  const actual = [Number(offset?.[1]), Number(offset?.[2]), Number(extent?.[1]), Number(extent?.[2])];
  const expected = [element.geometry.x, element.geometry.y, element.geometry.width, element.geometry.height];
  expected.forEach((value, index) => expect(Math.abs(actual[index] - Math.round(value * 914_400))).toBeLessThanOrEqual(1));
}
function assertTextStyle(xml: string, element: PresentationRenderPlanElement): void {
  expect(element.content.type).toBe('text');
  const run = textRun(xml);
  expect(run).toContain(`sz="${Math.round(element.style.fontSize * 100)}"`);
  expect(run).toContain(`typeface="${element.style.fontFamily}"`);
  expect(color(run)).toBe(element.style.color.toUpperCase());
  expect(/\bb="1"/u.test(run)).toBe(element.style.bold);
  const properties = /<p:spPr>[\s\S]*?<\/p:spPr>/u.exec(xml)?.[0] ?? '';
  expect(color(properties)).toBe(element.style.fill?.toUpperCase());
  expect(text(xml)).toBe(element.content.type === 'text' ? element.content.text : '');
}
function assertTableStyle(xml: string, element: PresentationRenderPlanElement): void {
  expect(element.content.type).toBe('table');
  if (element.content.type !== 'table') return;
  const table = element.content;
  const cells = [...xml.matchAll(/<a:tc>[\s\S]*?<\/a:tc>/gu)].map(match => match[0]);
  const expectedCells = [table.header, ...table.rows].flat();
  expect(cells).toHaveLength(expectedCells.length);
  cells.forEach((cell, index) => {
    const header = index < table.header.length;
    const run = textRun(cell);
    const properties = /<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/u.exec(cell)?.[0] ?? '';
    expect(text(cell)).toBe(expectedCells[index]);
    expect(run).toContain(`sz="${Math.round(element.style.fontSize * 100)}"`);
    expect(run).toContain(`typeface="${element.style.fontFamily}"`);
    expect(color(run)).toBe((header ? element.style.tableHeaderColor ?? element.style.color : element.style.color).toUpperCase());
    // OOXML cell borders have their own nested fills before the cell background.
    const background = [...properties.matchAll(/<a:solidFill>[\s\S]*?<\/a:solidFill>/gu)].at(-1)?.[0] ?? '';
    expect(color(background)).toBe((header ? element.style.tableHeaderFill : element.style.tableBodyFill)?.toUpperCase());
  });
}
function styleSignature(page: PresentationRenderPlanPage): unknown {
  return { background: page.backgroundColor, elements: page.elements.map(element => ({ source: element.source,
    fontFamily: element.style.fontFamily, bold: element.style.bold, color: element.style.color, fill: element.style.fill,
    headerFill: element.style.tableHeaderFill, headerColor: element.style.tableHeaderColor, bodyFill: element.style.tableBodyFill,
    borderColor: element.style.borderColor, chartColors: element.style.chartColors, mutedColor: element.style.mutedColor })) };
}

async function writeDeck(options: {
  readonly design: ProductionPresentationDesignIR;
  readonly template?: PresentationTemplateId;
  readonly outline?: DocumentOutline;
  readonly attempt?: { readonly storage: NodeProjectStorage; readonly previous?: PresentationDesignAttempt };
}) {
  const outline = options.outline ?? stylePagesOutline;
  const contentSnapshot = buildDocumentContentSnapshot({ outline, identityScope: 'style-production-facts' });
  let prepared: PresentationProductionPlan | undefined;
  let attempt: PresentationDesignAttempt | undefined;
  const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, contentSnapshot, designIR: options.design,
    presentationTemplate: options.template ?? 'business_minimal', outputDirectory: await temporaryRoot(), now: '2026-10-06T12:00:00.000Z',
    onPlanPrepared: async value => {
      prepared = structuredClone(value);
      if (options.attempt) attempt = await persistPreparedPresentationAttempt({ storage: options.attempt.storage,
        executionId: 'style-repair-execution', sourceDraftId: 'style-repair-draft', draftRevision: 1,
        attempt: options.attempt.previous ? 1 : 0, previousAttempt: options.attempt.previous,
        prepared: value, targetSectionIds: options.attempt.previous ? [contentSnapshot.sections[0].sectionId] : [],
        diagnosisCodes: options.attempt.previous ? ['text_overflow'] : [], now: '2026-10-06T12:00:00.000Z' });
    }
  });
  expect(prepared?.snapshot.designPath, JSON.stringify(prepared?.snapshot.diagnostics)).toBe('design-aware');
  expect(prepared!.renderPlan).toBeDefined();
  expect(prepared!.layoutIR).toBeDefined();
  const zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
  const xmlPages = await Promise.all(prepared!.renderPlan!.pages.map(page => zip.file(`ppt/slides/slide${page.pageNumber}.xml`)!.async('string')));
  return { generated, prepared: prepared!, contentSnapshot, xmlPages, zip, attempt };
}

describe('semantic page style reaches the real PPTX writer', () => {
  it.each([
    { name: 'light', template: 'business_minimal' as const, monochrome: false },
    { name: 'dark', template: 'technology' as const, monochrome: false },
    { name: 'monochrome', template: 'technology' as const, monochrome: true }
  ])('writes a cohesive seven-role $name deck without changing facts, source identities or geometry', async ({ template, monochrome }) => {
    const design = stylePagesDesign(monochrome ? 'monochrome' : 'accent-led');
    const originalOutline = structuredClone(stylePagesOutline);
    const data = await writeDeck({ design, template });
    expect(data.prepared.renderPlan!.pages.map(page => page.pageRole)).toEqual(stylePagesRoles);
    expect(data.prepared.contentSnapshot).toEqual(data.contentSnapshot);
    expect(data.prepared.layoutIR!.identity.contentDigest).toBe(computeDocumentContentDigest(data.contentSnapshot));
    expect(stylePagesOutline).toEqual(originalOutline);
    for (const fact of stylePagesFacts) expect(data.xmlPages.join('')).toContain(fact);
    for (const [index, page] of data.prepared.renderPlan!.pages.entries()) {
      const xml = data.xmlPages[index];
      const palette = resolvePresentationPageStyle({ design: design.globalDesign, page: design.pages[index], tokens: resolvePresentationTemplate(template).tokens });
      expect(page.backgroundColor).toBe(palette.backgroundColor);
      expect(color(/<p:bg>[\s\S]*?<\/p:bg>/u.exec(xml)?.[0] ?? '')).toBe(page.backgroundColor.toUpperCase());
      const layoutPage = data.prepared.layoutIR!.pages[index];
      expect(page.elements.map(element => element.renderId)).toEqual(layoutPage.elements.map(element => element.elementId));
      for (const element of page.elements) {
        const actual = elementXml(xml, element.renderId);
        assertGeometry(actual, element);
        if (element.content.type === 'text') assertTextStyle(actual, element);
        else if (element.content.type === 'table') assertTableStyle(actual, element);
        if (element.source.kind === 'generated') expect(element.style.fill).toBeUndefined();
      }
      if (monochrome) {
        const colors = [page.backgroundColor, ...page.elements.flatMap(element => Object.values(element.style).flat())]
          .filter((value): value is string => typeof value === 'string' && /^[A-Fa-f0-9]{6}$/u.test(value));
        for (const value of colors) expect(value.slice(0, 2).toUpperCase()).toBe(value.slice(2, 4).toUpperCase());
        for (const value of colors) expect(value.slice(0, 2).toUpperCase()).toBe(value.slice(4, 6).toUpperCase());
      }
    }
    if (monochrome) {
      const unchangedMetrics = compilePresentationRenderPlan(stylePagesOutline, stylePagesDesign(), resolvePresentationTemplate(template).tokens,
        { contentSnapshot: data.contentSnapshot });
      expect(unchangedMetrics.plan).toBeDefined();
      expect(data.prepared.renderPlan!.pages.map(page => page.elements.map(element => [element.source, element.geometry, element.style.fontFamily, element.style.fontSize])))
        .toEqual(unchangedMetrics.plan!.pages.map(page => page.elements.map(element => [element.source, element.geometry, element.style.fontFamily, element.style.fontSize])));
      expect(data.prepared.layoutIR!.identity.layoutDigest).not.toBe(unchangedMetrics.layoutIR!.identity.layoutDigest);
    }
    expect(new Set(data.prepared.renderPlan!.pages.map(page => page.backgroundColor)).size).toBeGreaterThan(1);
    expect(data.prepared.renderPlan!.pages.some(page => page.elements.some(element => element.style.fill !== undefined))).toBe(true);
    expect(await inspectPptxGeometry(data.generated.temporaryPath)).toEqual([]);
  });

  it('changes the style when the same page changes semantic role instead of cycling by page number', async () => {
    const original = stylePagesDesign();
    const changed = parsePresentationDesignIR({ ...original, pages: original.pages.map(page => page.pageNumber === 2 ? { ...page, pageRole: 'metric' } : page) },
      { outline: stylePagesOutline });
    const before = await writeDeck({ design: original });
    const after = await writeDeck({ design: changed });
    expect(before.prepared.layoutIR!.pages.map(page => page.pageId)).toEqual(after.prepared.layoutIR!.pages.map(page => page.pageId));
    expect(before.prepared.layoutIR!.pages.map(page => page.elements.map(element => element.elementId)))
      .toEqual(after.prepared.layoutIR!.pages.map(page => page.elements.map(element => element.elementId)));
    expect(after.prepared.layoutIR!.identity.contentDigest).toBe(before.prepared.layoutIR!.identity.contentDigest);
    expect(styleSignature(after.prepared.renderPlan!.pages[1])).not.toEqual(styleSignature(before.prepared.renderPlan!.pages[1]));
    expect(after.xmlPages[1]).not.toBe(before.xmlPages[1]);
    for (const index of [0, 2, 3, 4, 5, 6]) expect(after.xmlPages[index]).toBe(before.xmlPages[index]);
  });

  it('preserves the semantic style through a new repaired candidate while changing only target geometry', async () => {
    const storage = new NodeProjectStorage(await temporaryRoot());
    const original = stylePagesDesign();
    const repair = parsePresentationDesignIR({ ...original, pages: original.pages.map(page => page.pageNumber === 2 ? {
      ...page, density: 'sparse', whitespace: 'generous',
      composition: { principle: 'comparison', focalArea: 'center', balance: 'symmetric', flow: 'comparison' }
    } : page) }, { outline: stylePagesOutline });
    const before = await writeDeck({ design: original, attempt: { storage } });
    const after = await writeDeck({ design: repair, attempt: { storage, previous: before.attempt } });
    expect(after.attempt).toMatchObject({ contentHash: before.attempt!.contentHash, contentVersion: before.attempt!.contentVersion,
      designVersion: 2, layoutVersion: 2, renderVersion: 2, parentAttempt: { attempt: 0, attemptHash: before.attempt!.attemptHash } });
    expect(after.prepared.renderPlan!.pages[1].elements.map(element => element.geometry))
      .not.toEqual(before.prepared.renderPlan!.pages[1].elements.map(element => element.geometry));
    expect(styleSignature(after.prepared.renderPlan!.pages[1])).toEqual(styleSignature(before.prepared.renderPlan!.pages[1]));
    for (const data of [before, after]) for (const element of data.prepared.renderPlan!.pages[1].elements) {
      const actual = elementXml(data.xmlPages[1], element.renderId);
      assertGeometry(actual, element);
      assertTextStyle(actual, element);
    }
    for (const index of [0, 2, 3, 4, 5, 6]) expect(after.xmlPages[index]).toBe(before.xmlPages[index]);
    for (const fact of stylePagesFacts) expect(after.xmlPages.join('')).toContain(fact);
    expect(parsePresentationDesignAttempt(await storage.readJson(presentationAttemptPath('style-repair-execution', 1)))).toEqual(after.attempt);
  });

  it.each([
    { colorDirection: 'accent-led' as const, chartKind: 'bar' as const },
    { colorDirection: 'monochrome' as const, chartKind: 'bar' as const },
    { colorDirection: 'accent-led' as const, chartKind: 'pie' as const }
  ])('writes dark $colorDirection $chartKind chart colors for data labels, title, axes and legend from the same IR', async ({ colorDirection, chartKind }) => {
    const points = chartKind === 'bar' ? [{ label: '客户续费率', value: 92 }, { label: '交付时间缩短', value: 35 }]
      : [{ label: '已交付', value: 92 }, { label: '待交付', value: 8 }];
    const outline: DocumentOutline = { kind: 'ppt', title: 'Atlas 试点指标', sections: [{ heading: '已核验结果', level: 1, pageKind: 'data',
      blocks: [{ type: 'chart', chartKind, title: '季度指标', data: points }] }] };
    const base = buildFallbackPresentationDesignIR(outline);
    const design = parsePresentationDesignIR({ ...base, globalDesign: { ...base.globalDesign, colorDirection, visualTone: 'technical' },
      pages: base.pages.map(page => page.pageNumber === 2 ? { ...page, pageRole: 'evidence',
        contentRoles: { ...page.contentRoles, chart: ['outline.sections[0].blocks[0]'] } } : page) }, { outline });
    const data = await writeDeck({ outline, design, template: 'technology' });
    const chartElement = data.prepared.renderPlan!.pages[1].elements.find(element => element.content.type === 'chart')!;
    expect(chartElement).toBeDefined();
    expect(chartElement.style.showValues).toBe(true);
    const frame = elementXml(data.xmlPages[1], chartElement.renderId);
    assertGeometry(frame, chartElement);
    const chartParts = Object.keys(data.zip.files).filter(part => /^ppt\/charts\/chart\d+\.xml$/u.test(part));
    expect(chartParts).toHaveLength(1);
    const chart = await data.zip.file(chartParts[0])!.async('string');
    const dataLabels = /<c:dLbls>[\s\S]*?<\/c:dLbls>/u.exec(chart)?.[0] ?? '';
    const title = /<c:title>[\s\S]*?<\/c:title>/u.exec(chart)?.[0] ?? '';
    const categoryAxis = /<c:catAx>[\s\S]*?<\/c:catAx>/u.exec(chart)?.[0] ?? '';
    const valueAxis = /<c:valAx>[\s\S]*?<\/c:valAx>/u.exec(chart)?.[0] ?? '';
    const series = /<c:ser>[\s\S]*?<\/c:ser>/u.exec(chart)?.[0] ?? '';
    expect(color(dataLabels)).toBe(chartElement.style.color.toUpperCase());
    expect(color(title)).toBe(chartElement.style.color.toUpperCase());
    if (chartKind === 'bar') {
      const categoryLabels = /<c:txPr>[\s\S]*?<\/c:txPr>/u.exec(categoryAxis)?.[0] ?? '';
      const valueLabels = /<c:txPr>[\s\S]*?<\/c:txPr>/u.exec(valueAxis)?.[0] ?? '';
      expect(color(categoryLabels)).toBe((chartElement.style.mutedColor ?? chartElement.style.color).toUpperCase());
      expect(color(valueLabels)).toBe((chartElement.style.mutedColor ?? chartElement.style.color).toUpperCase());
    } else {
      expect(chartElement.style.showLegend).toBe(true);
      const legend = /<c:legend>[\s\S]*?<\/c:legend>/u.exec(chart)?.[0] ?? '';
      expect(color(/<c:txPr>[\s\S]*?<\/c:txPr>/u.exec(legend)?.[0] ?? '')).toBe(chartElement.style.color.toUpperCase());
    }
    if (chartKind === 'bar') expect(color(series)).toBe(chartElement.style.chartColors![0].toUpperCase());
    else {
      const slices = [...series.matchAll(/<c:dPt>[\s\S]*?<\/c:dPt>/gu)].map(match => match[0]);
      expect(slices).toHaveLength(points.length);
      slices.forEach((slice, index) => expect(color(slice)).toBe(chartElement.style.chartColors![index].toUpperCase()));
    }
    for (const point of points) {
      expect(chart).toContain(`<c:v>${point.value}</c:v>`);
      expect(chart).toContain(point.label);
    }
    expect(data.prepared.contentSnapshot).toEqual(data.contentSnapshot);
    expect(data.prepared.layoutIR!.identity.contentDigest).toBe(computeDocumentContentDigest(data.contentSnapshot));
  });

  it.skipIf(!process.env.UNICOMP_OFFICE_RENDERER || !process.env.UNICOMP_PDF_RENDERER)(
    'renders independent light and dark seven-role decks through the configured local structural QA adapter',
    async () => {
      const renderer = createConfiguredOfficeRenderAdapter();
      expect(renderer).toBeDefined();
      // Each fixture owns an isolated Office profile. Await both child renders,
      // including failures, before afterEach removes their input directories.
      const results = await Promise.allSettled((['business_minimal', 'technology'] as const).map(async template => {
        const data = await writeDeck({ design: stylePagesDesign(), template });
        const result = await renderer!(data.generated.temporaryPath, { kind: 'ppt', signal: new AbortController().signal });
        expect(result.previewCount).toBe(7);
        // Inherit the existing pdfjs font-inspection limitation; rasterization
        // and every other structural diagnostic retain the current gate.
        expect((result.diagnostics ?? []).filter(diagnostic => diagnostic.severity === 'error' && diagnostic.code !== 'font_missing')).toEqual([]);
      }));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }, 10_000
  );
});
