import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePresentationDesignIR, parsePresentationDesignTree, type PresentationDesignNode, type PresentationDesignTree } from '../../src/domain/entities/presentation-design-contract';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { derivePresentationRenderPlanFromLayoutIR } from '../../src/platform/documents/presentation-layout-ir-adapter';
import { loadPresentationRenderAssets } from '../../src/platform/documents/presentation-render-assets';
import { auditPresentationDesignExecution } from '../../src/platform/documents/presentation-design-execution-audit';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { inspectPptxGeometry, createConfiguredOfficeRenderAdapter } from '../../src/platform/documents/office-render-adapter';
import type { DocumentRenderResult } from '../../src/platform/documents/temporary-document-workflow';
import { authoredFixtureDesign, autonomousOutline, bodyRefs, splitTree } from '../fixtures/presentation-autonomous-design';

const tokens = resolvePresentationTemplate('business_minimal').tokens;
const compile = (tree = splitTree()) => compilePresentationRenderPlan(autonomousOutline, authoredFixtureDesign(autonomousOutline, tree), tokens);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const dir = await mkdtemp(path.join(os.tmpdir(), 'unicomp-autonomous-')); roots.push(dir); return dir; }

describe('model authored composition executes in the production pipeline', () => {
  it('preserves 65/35 regions, nesting, explicit font sizes and content through the sole Layout IR', () => {
    const result = compile();
    expect(result.diagnostics).toEqual([]);
    expect(result.layouts![1].selectedLayout).toBe('design-tree');
    const nodes = result.layouts![1].authoredNodes!;
    const main = nodes.find(item => item.node.nodeId === 'main')!, evidence = nodes.find(item => item.node.nodeId === 'evidence')!;
    expect(main.geometry.width / evidence.geometry.width).toBeCloseTo(65 / 35, 3);
    expect(result.plan!.pages[1].elements.find(element => element.content.type === 'text' && element.content.text === autonomousOutline.sections[0].heading)?.style.fontSize).toBe(34);
    const projection = derivePresentationRenderPlanFromLayoutIR(result.layoutIR!, result.contentSnapshot!);
    expect(projection).toEqual(result.plan);
    expect(result.designExecution).toMatchObject({ status: 'passed', authoredPageCount: 3 });
    const changed = compile(splitTree(40));
    expect(changed.plan!.pages[1].elements.map(item => item.geometry)).not.toEqual(result.plan!.pages[1].elements.map(item => item.geometry));
    expect(changed.plan!.pages[0]).toEqual(result.plan!.pages[0]);
  });
  it('executes grid column spans and retains nested row weights', () => {
    const tree: PresentationDesignTree = { schemaVersion: 1, root: { nodeId: 'grid', type: 'grid', columns: 3, gap: 0.02, children: [
      { nodeId: 'heading', type: 'content', contentRef: bodyRefs[0], columnSpan: 3, style: { fontSize: 32 } },
      { nodeId: 'a', type: 'content', contentRef: bodyRefs[1], columnSpan: 2, style: { fontSize: 22 } },
      { nodeId: 'nested', type: 'column', columnSpan: 1, children: bodyRefs.slice(2).map((contentRef, i) => ({ nodeId: `nested-${i}`, type: 'content', contentRef, style: { fontSize: 20 } })) }
    ] } };
    const result = compile(tree);
    expect(result.diagnostics).toEqual([]);
    const nodes = result.layouts![1].authoredNodes!;
    const top = nodes.find(item => item.node.nodeId === 'heading')!.geometry;
    const left = nodes.find(item => item.node.nodeId === 'a')!.geometry;
    const right = nodes.find(item => item.node.nodeId === 'nested')!.geometry;
    expect(top.width).toBeCloseTo(left.width + right.width + (right.x - left.x - left.width), 3);
    expect(left.width).toBeGreaterThan(right.width * 2);
  });
  it('executes anchors and decorative layering, rejects accidental foreground overlap', () => {
    const children: PresentationDesignNode[] = [
      { nodeId: 'background', type: 'shape', shapeKind: 'roundRect', anchor: 'center', style: { fill: 'F1F5F9', borderColor: 'CBD5E1' } },
      ...bodyRefs.map((contentRef, i): PresentationDesignNode => ({ nodeId: `leaf-${i}`, type: 'content', contentRef,
        anchor: ['top-left', 'top-right', 'bottom-left', 'bottom-right'][i] as PresentationDesignNode['anchor'], widthFraction: 0.45, heightFraction: 0.4, style: { fontSize: 22 } }))
    ];
    const result = compile({ schemaVersion: 1, root: { nodeId: 'overlay', type: 'overlay', children } });
    expect(result.diagnostics).toEqual([]);
    expect(result.plan!.pages[1].elements[0].content).toEqual({ type: 'shape', shapeKind: 'roundRect' });
    const collision = compile({ schemaVersion: 1, root: { nodeId: 'overlay', type: 'overlay', children: children.map(node => ({ ...node, anchor: 'center' })) } });
    expect(collision.plan).toBeUndefined(); expect(collision.diagnostics.some(item => item.code === 'layout_overlap')).toBe(true);
    expect(collision.repairCount).toBe(0);
  });
  it('checks projected geometry/style/content fidelity, including palette on cover and closing pages', () => {
    const design = authoredFixtureDesign();
    const result = compilePresentationRenderPlan(autonomousOutline, design, tokens);
    expect(result.plan!.pages.every(page => page.backgroundColor === 'FFFFFF')).toBe(true);
    const changed = { ...result.plan!, pages: result.plan!.pages.map((page, i) => i !== 1 ? page : { ...page,
      elements: page.elements.map((element, j) => j !== 0 ? element : { ...element, geometry: { ...element.geometry, width: 1 } }) }) };
    expect(() => auditPresentationDesignExecution(design, result.plan!, changed)).toThrow('design_execution_mismatch');
  });
  it('does not silently shrink explicit type or replace an infeasible model composition', () => {
    const tree = splitTree();
    const huge = { ...tree, root: { ...tree.root, children: tree.root.children!.map(node => node.nodeId !== 'main' ? node : {
      ...node, children: node.children!.map(child => ({ ...child, style: { fontSize: 96 as const } })) }) } };
    const failed = compile(huge);
    expect(failed.plan).toBeUndefined(); expect(failed.repairCount).toBe(0);
    expect(failed.diagnostics.some(item => item.code === 'font_below_minimum' && item.nodeId)).toBe(true);
  });
  it.each(['bar', 'line', 'pie', 'doughnut'] as const)('lets the model choose %s representation without changing chart facts', async kind => {
    const outline = { ...autonomousOutline, sections: [{ ...autonomousOutline.sections[0], blocks: [{ type: 'chart' as const, chartKind: 'bar' as const,
      data: [{ label: 'A', value: 12 }, { label: 'B', value: 18 }] }] }] };
    const design = authoredFixtureDesign(outline);
    const pages = design.pages.map(page => page.pageNumber !== 2 ? page : { ...page, designTree: { ...page.designTree!, root: { ...page.designTree!.root,
      children: page.designTree!.root.children!.map(node => node.contentRef?.endsWith('.blocks[0]') ? { ...node,
        style: { fontSize: 18, chartKind: kind, chartColors: ['1F5FBF', '148070'], showLegend: true, showValues: false } } : node) } } });
    const result = compilePresentationRenderPlan(outline, { ...design, pages }, tokens);
    expect(result.diagnostics).toEqual([]);
    const chart = result.plan!.pages[1].elements.find(element => element.type === 'chart')!;
    expect(chart.style).toMatchObject({ chartKind: kind, showLegend: true, showValues: false });
    expect(chart.content).toMatchObject({ chartKind: 'bar', data: outline.sections[0].blocks[0].data });
    const file = await generateTemporaryDocumentFile({ kind: 'ppt', outline, designIR: { ...design, pages }, outputDirectory: await temporary(), now: '2026-10-14T16:00:00.000Z' });
    const zip = await JSZip.loadAsync(await readFile(file.temporaryPath));
    const charts = Object.values(zip.files).filter(file => /^ppt\/charts\/chart\d+\.xml$/u.test(file.name));
    expect(charts).toHaveLength(1);
    const chartXml = await charts[0].async('string');
    expect(chartXml).toContain(`<c:${kind}Chart`);
    expect(chartXml).toContain('<c:v>12</c:v>'); expect(chartXml).toContain('<c:v>18</c:v>');
  });
  it('writes model-selected geometry, partial typography and decoration into real PPTX XML', async () => {
    const result = await generateTemporaryDocumentFile({ kind: 'ppt', outline: autonomousOutline, designIR: authoredFixtureDesign(autonomousOutline, splitTree()),
      outputDirectory: await temporary(), now: '2026-10-14T16:00:00.000Z', presentationTemplate: 'business_minimal' });
    const zip = await JSZip.loadAsync(await readFile(result.temporaryPath));
    const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(xml).toContain('sz="3400"'); expect(xml).toContain('sz="3800"'); expect(xml).toContain('b="1"');
    expect(xml).toContain('客户续费率'); expect(xml).toContain('prst="rect"');
    expect(await inspectPptxGeometry(result.temporaryPath)).toEqual([]);
  });
  it('binds, embeds, crops and masks approved local image bytes without persisting paths', async () => {
    const dir = await temporary(); const imagePath = path.join(dir, 'source.png');
    // Valid local PNG copied from the repository evidence; no remote assets.
    const bytes = await readFile(path.resolve('docs/evidence/ppt-visual-audit-20261013/optimized-page-4.png'));
    await writeFile(imagePath, bytes);
    const assets = await loadPresentationRenderAssets([{ absolutePath: imagePath }]);
    const tree = splitTree();
    const root = { ...tree.root, children: [{ nodeId: 'copy', type: 'column' as const, weight: 65, children: tree.root.children!.map(node => ({ ...node, weight: undefined })) },
      { nodeId: 'photo', type: 'image' as const, weight: 35, assetKey: 'image-1', imageFit: 'cover' as const, imageMask: 'ellipse' as const }] };
    const design = authoredFixtureDesign(autonomousOutline, { ...tree, root });
    const compiled = compilePresentationRenderPlan(autonomousOutline, design, tokens, { assets });
    expect(compiled.diagnostics).toEqual([]);
    expect(JSON.stringify(compiled.layoutIR)).not.toContain(imagePath);
    expect(JSON.stringify(compiled.layoutIR)).not.toContain('base64');
    expect(compiled.plan!.pages[1].elements.find(element => element.type === 'image')?.content).toMatchObject({ assetDigest: createHash('sha256').update(bytes).digest('hex') });
    const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline: autonomousOutline, designIR: design, images: [{ absolutePath: imagePath }],
      outputDirectory: path.join(dir, 'output'), now: '2026-10-14T16:00:00.000Z' });
    const zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
    expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('prst="ellipse"');
    const media = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('ppt/media/'));
    expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toMatch(/<a:srcRect[^>]*[lrtb]="\d+"/u);
    expect(await media[0].async('nodebuffer')).toEqual(bytes);
    expect(compilePresentationRenderPlan(autonomousOutline, design, tokens).diagnostics).toEqual([{ code: 'design_asset_unavailable' }]);
  });
  it('renders the authored PPTX through configured local Office/PDF QA', async () => {
    const dir = await temporary(); const renderer = createConfiguredOfficeRenderAdapter();
    expect(renderer, 'Local Office/PDF renderer must be configured').toBeDefined();
    const file = await generateTemporaryDocumentFile({ kind: 'ppt', outline: autonomousOutline, designIR: authoredFixtureDesign(autonomousOutline, splitTree()),
      outputDirectory: dir, now: '2026-10-14T16:00:00.000Z' });
    const output = execFileSync(process.execPath, [path.resolve('tests/harness/autonomous-ppt-native-qa.cjs'), file.temporaryPath],
      { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    const rendered = JSON.parse(output.split('\n').find(line => line.startsWith('QA_RESULT:'))!.slice('QA_RESULT:'.length)) as DocumentRenderResult;
    expect(rendered.previewCount).toBe(3);
    expect((rendered.diagnostics ?? []).filter(item => item.severity === 'error')).toEqual([]);
  }, 30000);
});

describe('bounded autonomous design contract', () => {
  it.each([
    { ...splitTree(), root: { ...splitTree().root, x: 0.1 } },
    { schemaVersion: 1, root: { nodeId: 'unsafe', type: 'image', assetKey: 'C:\\secret.png', imageFit: 'cover' } },
    { schemaVersion: 1, root: { nodeId: 'unsafe', type: 'content', contentRef: bodyRefs[0], style: { fontWeight: 800 } } },
    { schemaVersion: 1, root: { nodeId: 'unsafe', type: 'content', contentRef: bodyRefs[0], style: { fontFamily: 'https://font.example' } } }
  ])('rejects unknown coordinates, paths, unavailable type weights and unsafe font strings', value => {
    expect(() => parsePresentationDesignTree(value)).toThrow();
  });
  it('rejects missing, duplicated and cross-page content instead of producing partial slides', () => {
    const design = authoredFixtureDesign();
    const page = design.pages[1];
    for (const refs of [bodyRefs.slice(1), [...bodyRefs, bodyRefs[1]], [...bodyRefs.slice(0, -1), 'outline.title']]) {
      const changed = { ...design, pages: design.pages.map(old => old.pageNumber !== 2 ? old : { ...page,
        designTree: { schemaVersion: 1, root: { nodeId: 'root', type: 'column', children: refs.map((contentRef, i) => ({ nodeId: `leaf-${i}`, type: 'content', contentRef })) } } }) };
      expect(() => parsePresentationDesignIR(changed, { outline: autonomousOutline })).toThrow();
    }
  });
  it('limits depth and node counts before execution', () => {
    let root: PresentationDesignNode = { nodeId: 'leaf', type: 'content', contentRef: 'outline.title' };
    for (let i = 0; i < 10; i += 1) root = { nodeId: `level-${i}`, type: 'column', children: [root] };
    expect(() => parsePresentationDesignTree({ schemaVersion: 1, root })).toThrow();
  });
  it('rejects text spans outside canonical text and incapable element styles', () => {
    const tree = splitTree();
    const bad = { ...tree, root: { ...tree.root, children: tree.root.children!.map(node => node.nodeId !== 'main' ? node : {
      ...node, children: node.children!.map(child => child.nodeId !== 'metric' ? child : { ...child, textSpans: [{ start: 0, end: 100, style: { fontWeight: 700 as const } }] }) }) } };
    expect(compile(bad).diagnostics).toEqual([{ code: 'design_text_span_invalid' }]);
  });
});
