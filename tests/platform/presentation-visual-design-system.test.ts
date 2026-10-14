import { describe, expect, it } from 'vitest';
import { parsePresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { auditPresentationRenderPlan } from '../../src/platform/documents/presentation-visual-audit';
import { stylePagesDesign, stylePagesOutline } from '../fixtures/presentation-style-pages';

describe('presentation visual design system', () => {
  it('keeps model-selected palette, typography and page treatment through the compiler', () => {
    const base = stylePagesDesign();
    const design = parsePresentationDesignIR({
      ...base,
      globalDesign: {
        ...base.globalDesign,
        visualSystem: {
          palette: { background: '07111F', surface: '102A43', text: 'F5FAFF', muted: 'B7C9DC', accent: '35D6C8', secondaryAccent: 'FE5EA8' },
          typography: { displayScale: 1.08, bodyScale: 0.96, displayWeight: 800, bodyWeight: 400, lineSpacing: 1.25, charSpacing: 0.3 }
        }
      },
      pages: base.pages.map(page => page.pageNumber === 3 ? { ...page, visualTreatment: { surface: 'outlined', accent: 'edge' } } : page)
    }, { outline: stylePagesOutline });
    const compiled = compilePresentationRenderPlan(stylePagesOutline, design, resolvePresentationTemplate('business_minimal').tokens);
    expect(compiled.plan).toBeDefined();
    expect(compiled.plan!.pages[0].backgroundColor).not.toBe(resolvePresentationTemplate('business_minimal').tokens.background);
    expect(compiled.plan!.pages[0].backgroundColor).toMatch(/^[0-9A-F]{6}$/u);
    const treatedPage = compiled.plan!.pages[2];
    expect(treatedPage.elements.some(element => element.style.borderWidth === 1)).toBe(true);
    expect(treatedPage.elements.some(element => element.style.fontWeight === 800)).toBe(true);
    expect(treatedPage.elements.some(element => element.style.lineSpacingMultiple === 1.25 && element.style.charSpacing === 0.3)).toBe(true);
  });

  it('reports deterministic visual signals and explicitly marks multimodal review unavailable', () => {
    const base = stylePagesDesign();
    const compiled = compilePresentationRenderPlan(stylePagesOutline, base, resolvePresentationTemplate('business_minimal').tokens);
    const audit = auditPresentationRenderPlan(compiled.plan!);
    expect(audit.multimodalReview).toBe('not_available');
    expect(['passed', 'warning']).toContain(audit.status);
    expect(audit.diagnostics.every(item => item.severity === 'warning')).toBe(true);
  });

  it('persists semantic process track primitives in the render plan', () => {
    const compiled = compilePresentationRenderPlan(stylePagesOutline, stylePagesDesign(), resolvePresentationTemplate('business_minimal').tokens);
    const process = compiled.plan?.pages.find(page => page.pageRole === 'process');
    expect(process).toBeDefined();
    expect(process!.elements.filter(element => element.type === 'shape').map(element => element.content)).toEqual(
      expect.arrayContaining([{ type: 'shape', shapeKind: 'ellipse' }, { type: 'shape', shapeKind: 'line' }])
    );
  });

  it('lets Design IR choose a different primitive without changing page content', () => {
    const base = stylePagesDesign();
    const nodesOnly = parsePresentationDesignIR({
      ...base,
      pages: base.pages.map(page => page.pageRole === 'process'
        ? { ...page, visualTreatment: { surface: 'flat', accent: 'edge', component: 'nodes' } }
        : page)
    }, { outline: stylePagesOutline });
    const compiled = compilePresentationRenderPlan(stylePagesOutline, nodesOnly, resolvePresentationTemplate('business_minimal').tokens);
    const process = compiled.plan?.pages.find(page => page.pageRole === 'process');
    expect(process?.elements.filter(element => element.type === 'shape').map(element => element.content)).toEqual(
      expect.arrayContaining([{ type: 'shape', shapeKind: 'ellipse' }])
    );
    // Edge accents now execute independently; only the sequence track is disabled by nodes.
    expect(process?.elements.some(element => element.content.type === 'shape' && element.content.shapeKind === 'line' && element.style.borderWidth !== 1.5)).toBe(false);
    expect(process?.elements.some(element => element.content.type === 'shape' && element.content.shapeKind === 'line' && element.style.borderWidth === 1.5)).toBe(true);
  });
});
