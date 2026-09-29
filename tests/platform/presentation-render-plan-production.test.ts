import { describe, expect, it } from 'vitest';
import { buildFallbackPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { compilePresentationRenderPlan, buildPresentationDesignSnapshot } from '../../src/platform/documents/presentation-render-plan-compiler';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { fixedBodyTexts, fixedDesignDirections, fixedDesignOutline } from '../fixtures/presentation-design-directions';

const tokens = resolvePresentationTemplate('business_minimal').tokens;

describe('production Design IR to Render Plan compilation', () => {
  it('produces validated, renderer-ready plans whose geometry follows each Art Direction', () => {
    const directions = fixedDesignDirections();
    const compilations = Object.fromEntries(Object.entries(directions).map(([key, design]) => [
      key, compilePresentationRenderPlan(fixedDesignOutline, design, tokens)
    ]));
    const plans = Object.fromEntries(Object.entries(compilations).map(([key, compilation]) => [key, compilation.plan!]));

    for (const result of Object.values(compilations)) {
      expect(result.renderPlanStatus, JSON.stringify(result.diagnostics)).toBe('valid');
      expect(result.plan?.pages).toHaveLength(3);
      expect(result.plan?.pages.every(page => page.elements.some(element => element.source.kind === 'generated' && element.source.key === 'page-number'))).toBe(true);
    }
    const geometry = (name: keyof typeof plans) => plans[name].pages[1]!.elements.map(element => [element.source, element.geometry, element.style.fontSize]);
    expect(geometry('editorial')).not.toEqual(geometry('dashboard'));
    expect(geometry('editorial')).not.toEqual(geometry('narrative'));
    expect(geometry('dashboard')).not.toEqual(geometry('narrative'));
    for (const text of fixedBodyTexts) {
      expect(JSON.stringify(plans.editorial)).toContain(text);
    }
  });

  it('maps Outline references to text, table, and chart primitives without changing content', () => {
    const outline: DocumentOutline = {
      kind: 'ppt', title: 'Product evidence', sections: [{ pageKind: 'data', heading: 'Two forms of evidence', level: 1,
        takeaway: 'The evidence supports the same conclusion', blocks: [
          { type: 'table', header: ['Measure', 'Value'], rows: [['Retention', '92%']] },
          { type: 'chart', chartKind: 'bar', title: 'Quarterly results', data: [{ label: 'Retention', value: 92 }] }
        ]
      }]
    };
    const result = compilePresentationRenderPlan(outline, buildFallbackPresentationDesignIR(outline), tokens);
    expect(result.renderPlanStatus, JSON.stringify(result.diagnostics)).toBe('valid');
    const elements = result.plan!.pages[1]!.elements;
    expect(elements.find(element => element.type === 'table')?.content).toEqual({ type: 'table', header: ['Measure', 'Value'], rows: [['Retention', '92%']] });
    expect(elements.find(element => element.type === 'chart')?.content).toEqual({ type: 'chart', chartKind: 'bar', title: 'Quarterly results', data: [{ label: 'Retention', value: 92 }] });
    expect(elements.find(element => element.type === 'chart')?.style).toMatchObject({ showLegend: false, showValues: true });
  });

  it('reports bounded failures and emits a body-free compilation snapshot', () => {
    const invalid = compilePresentationRenderPlan(fixedDesignOutline, { schemaVersion: 2 }, tokens);
    expect(invalid.plan).toBeUndefined();
    expect(invalid).toMatchObject({ layoutStatus: 'skipped', renderPlanStatus: 'skipped' });
    expect(invalid.diagnostics.map(item => item.code)).toContain('invalid_design_ir');

    const valid = compilePresentationRenderPlan(fixedDesignOutline, fixedDesignDirections().editorial, tokens);
    const snapshot = buildPresentationDesignSnapshot(valid, { requested: true, legacyPageCount: 3, designPath: 'design-aware' });
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({ designPath: 'design-aware', artDirectionStatus: 'validated', designIrStatus: 'validated', layoutStatus: 'success', renderPlanStatus: 'valid' });
    for (const text of fixedBodyTexts) expect(serialized).not.toContain(text);
    expect(snapshot.pages.every(page => page.geometrySignature !== undefined)).toBe(true);

    const fallback = buildPresentationDesignSnapshot(valid, {
      requested: true, legacyPageCount: 5, designPath: 'legacy-fallback', fallbackReason: 'layout_failed'
    });
    expect(fallback.pages.map(page => page.pageNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(fallback.pages.map(page => page.pageRole)).toEqual(['hero', 'content', 'content', 'content', 'closing']);
    expect(fallback.pages.every(page => page.fallback)).toBe(true);
    expect(fallback.strategies).toHaveLength(5);
  });
});
