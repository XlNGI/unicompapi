import { describe, expect, it } from 'vitest';
import { buildPresentationLayoutConstraintModel } from '../../src/platform/documents/presentation-page-features';
import {
  fixedContentRefs,
  fixedDesignDirections,
  fixedDesignOutline
} from '../fixtures/presentation-design-directions';
import { solvePresentationLayout, solvePresentationLayoutWithRepair } from '../../src/platform/documents/presentation-layout-engine';
import type { PresentationDesignIRV2 } from '../../src/domain/entities/presentation-design-contract';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';

function solve(design: PresentationDesignIRV2, outline = fixedDesignOutline) {
  const { features, constraints } = buildPresentationLayoutConstraintModel(outline, design);
  return solvePresentationLayoutWithRepair(features, constraints);
}

function updateBodyPage(
  design: PresentationDesignIRV2,
  update: (page: PresentationDesignIRV2['pages'][number]) => PresentationDesignIRV2['pages'][number]
): PresentationDesignIRV2 {
  return { ...design, pages: design.pages.map(page => page.pageNumber === 2 ? update(page) : page) };
}

function pageTwo(result: ReturnType<typeof solve>) {
  expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
  return result.pages.find(page => page.pageNumber === 2)!;
}

describe('deterministic presentation Layout Engine', () => {
  it('selects composition from page semantics and produces materially different geometry for the three directions', () => {
    const directions = fixedDesignDirections();
    const pages = Object.fromEntries(Object.entries(directions).map(([name, design]) => [name, pageTwo(solve(design))]));

    expect(pages.editorial.composition).toBe('single-focus');
    expect(pages.dashboard.composition).toBe('structured');
    expect(pages.narrative.composition).toBe('evidence-led');
    expect(pages.editorial.geometrySignature).not.toBe(pages.dashboard.geometrySignature);
    expect(pages.editorial.geometrySignature).not.toBe(pages.narrative.geometrySignature);
    expect(pages.dashboard.geometrySignature).not.toBe(pages.narrative.geometrySignature);
  });

  it('is deterministic for the same input and emits bounded non-overlapping geometry', () => {
    const design = fixedDesignDirections().narrative;
    const first = pageTwo(solve(design));
    const second = pageTwo(solve(design));
    const constraintModel = buildPresentationLayoutConstraintModel(fixedDesignOutline, design);

    expect(first).toEqual(second);
    expect(first.placements).toHaveLength(constraintModel.constraints.pages[1]!.elements.length);
    for (const item of first.placements) {
      expect(item.geometry.x).toBeGreaterThanOrEqual(0);
      expect(item.geometry.y).toBeGreaterThanOrEqual(0);
      expect(item.geometry.x + item.geometry.width).toBeLessThanOrEqual(13.333);
      expect(item.geometry.y + item.geometry.height).toBeLessThanOrEqual(7.5);
      expect(item.fontSize).toBeGreaterThanOrEqual(item.sourceRef === 'generated.page-number' ? 10 : 14);
    }
  });

  it('lets whitespace and density change safe space, gaps, regions, and geometry', () => {
    const base = fixedDesignDirections().editorial;
    const baseResult = pageTwo(solve(base));
    const compact = updateBodyPage(base, page => ({ ...page, whitespace: 'minimal' }));
    const compactResult = pageTwo(solve(compact));
    const dense = updateBodyPage(base, page => ({ ...page, density: 'dense' }));
    const denseResult = pageTwo(solve(dense));

    expect(baseResult.geometrySignature).not.toBe(compactResult.geometrySignature);
    expect(baseResult.geometrySignature).not.toBe(denseResult.geometrySignature);
    expect(denseResult.selectedLayout).toBe('adaptive-grid');
  });

  it('lets hierarchy change element geometry while all other design inputs stay fixed', () => {
    const base = fixedDesignDirections().editorial;
    const reordered = updateBodyPage(base, page => ({
      ...page,
      hierarchy: {
        primary: [fixedContentRefs.evidence],
        secondary: [fixedContentRefs.takeaway, fixedContentRefs.title],
        supporting: [fixedContentRefs.firstMetric, fixedContentRefs.secondMetric, fixedContentRefs.body, fixedContentRefs.action]
      }
    }));
    const originalPage = pageTwo(solve(base));
    const reorderedPage = pageTwo(solve(reordered));
    const evidence = fixedContentRefs.evidence;

    expect(reorderedPage.geometrySignature).not.toBe(originalPage.geometrySignature);
    expect(reorderedPage.placements.find(item => item.sourceRef === evidence)!.fontSize)
      .toBeGreaterThan(originalPage.placements.find(item => item.sourceRef === evidence)!.fontSize);
  });

  it('lets focal area and emphasis move the focal content and change its relative size', () => {
    const base = fixedDesignDirections().narrative;
    const left = pageTwo(solve(updateBodyPage(base, page => ({
      ...page,
      composition: { ...page.composition, principle: 'comparison', focalArea: 'left', balance: 'weighted', flow: 'left-to-right' }
    }))));
    const right = pageTwo(solve(updateBodyPage(base, page => ({
      ...page,
      composition: { ...page.composition, principle: 'comparison', focalArea: 'right', balance: 'weighted', flow: 'left-to-right' }
    }))));
    const center = pageTwo(solve(updateBodyPage(base, page => ({
      ...page,
      composition: { ...page.composition, principle: 'single-focus', focalArea: 'center', balance: 'centered', flow: 'left-to-right' }
    }))));
    const focalRef = fixedContentRefs.evidence;
    const leftFocus = left.placements.find(item => item.sourceRef === focalRef)!;
    const rightFocus = right.placements.find(item => item.sourceRef === focalRef)!;

    expect(leftFocus.geometry.x).toBeLessThan(rightFocus.geometry.x);
    expect(leftFocus.geometry).not.toEqual(rightFocus.geometry);
    expect(center.geometrySignature).not.toBe(left.geometrySignature);
    expect(center.placements.find(item => item.sourceRef === focalRef)!.region).toBe('center');
  });

  it('uses balance and flow to change region sizing and ordering', () => {
    const base = fixedDesignDirections().narrative;
    const comparison = updateBodyPage(base, page => ({
      ...page,
      composition: { principle: 'comparison', focalArea: 'left', balance: 'symmetric', flow: 'left-to-right' }
    }));
    const asymmetric = updateBodyPage(comparison, page => ({
      ...page,
      composition: { ...page.composition, balance: 'asymmetric-right' }
    }));
    const vertical = updateBodyPage(comparison, page => ({
      ...page,
      composition: { ...page.composition, flow: 'top-to-bottom' }
    }));
    const symmetricResult = pageTwo(solve(comparison));
    const asymmetricResult = pageTwo(solve(asymmetric));
    const verticalResult = pageTwo(solve(vertical));

    expect(symmetricResult.geometrySignature).not.toBe(asymmetricResult.geometrySignature);
    expect(symmetricResult.geometrySignature).not.toBe(verticalResult.geometrySignature);
    expect(verticalResult.placements[0]!.geometry.y).toBeLessThan(verticalResult.placements.at(-1)!.geometry.y);
  });

  it('uses page roles and strong content features to avoid collapsing all pages to single-focus', () => {
    const base = fixedDesignDirections().editorial;
    const withRole = (pageRole: PresentationDesignIRV2['pages'][number]['pageRole']) => updateBodyPage(base, page => ({ ...page, pageRole }));
    const process = pageTwo(solve(withRole('process')));
    const evidence = pageTwo(solve(withRole('evidence')));
    const comparison = pageTwo(solve(withRole('comparison')));

    expect(process.composition).toBe('sequence');
    expect(evidence.composition).toBe('evidence-led');
    expect(comparison.composition).toBe('comparison');
  });

  it('uses element limits and relationship changes in solved geometry', () => {
    const design = fixedDesignDirections().narrative;
    const { features, constraints } = buildPresentationLayoutConstraintModel(fixedDesignOutline, design);
    const page = constraints.pages[1]!;
    const limited = {
      ...constraints,
      pages: constraints.pages.map(item => item.pageNumber !== 2 ? item : {
        ...item,
        elements: item.elements.map(element => {
          const maxWidth = Math.max(element.minWidth, 3);
          return element.sourceRef === fixedContentRefs.evidence
            ? { ...element, maxWidth, preferredWidth: Math.min(element.preferredWidth, maxWidth) }
            : element;
        })
      })
    };
    const withoutRelationships = {
      ...constraints,
      pages: constraints.pages.map(item => item.pageNumber === 2 ? { ...item, relationships: [] } : item)
    };
    const limitedPage = pageTwo(solvePresentationLayoutWithRepair(features, limited));
    const relationshipPage = pageTwo(solvePresentationLayoutWithRepair(features, withoutRelationships));
    const originalPage = pageTwo(solvePresentationLayoutWithRepair(features, constraints));

    expect(limitedPage.placements.find(item => item.sourceRef === fixedContentRefs.evidence)!.geometry.width).toBeLessThanOrEqual(3);
    expect(relationshipPage.geometrySignature).not.toBe(originalPage.geometrySignature);
    expect(page.relationships.length).toBeGreaterThan(0);
  });

  it('repairs gap and balances deterministically, then stops at the four-attempt bound', () => {
    const design = fixedDesignDirections().narrative;
    const { features, constraints } = buildPresentationLayoutConstraintModel(fixedDesignOutline, design);
    const stressed = {
      ...constraints,
      pages: constraints.pages.map(page => page.pageNumber === 2 ? { ...page, preferredGap: 30 } : page)
    };
    const repaired = solvePresentationLayoutWithRepair(features, stressed);
    expect(repaired.status).toBe('success');
    expect(repaired.repairCount).toBeGreaterThan(0);
    expect(repaired.repairCount).toBeLessThanOrEqual(4);
    expect(repaired.repairs[0]?.action).toBe('reduce_gap');

    const longOutline = {
      ...fixedDesignOutline,
      sections: fixedDesignOutline.sections.map(section => ({ ...section, blocks: section.blocks.map((block, index) =>
        index === 1 && block.type === 'paragraph' ? { ...block, text: 'Overflow content '.repeat(2000) } : block
      ) }))
    };
    const longModel = buildPresentationLayoutConstraintModel(longOutline, design);
    const bounded = solvePresentationLayoutWithRepair(longModel.features, longModel.constraints);
    expect(bounded.status).toBe('failed');
    expect(bounded.repairCount).toBeLessThanOrEqual(4);
    expect(bounded.diagnostics.some(item => item.code === 'font_below_minimum' || item.code === 'layout_overflow')).toBe(true);
  });

  it('derives content-sensitive unequal comparison regions rather than equal columns', () => {
    const base = fixedDesignDirections().dashboard;
    const comparison = updateBodyPage(base, page => ({
      ...page,
      composition: { principle: 'comparison', focalArea: 'left', balance: 'asymmetric-left', flow: 'left-to-right' },
      hierarchy: {
        primary: [fixedContentRefs.firstMetric],
        secondary: [fixedContentRefs.secondMetric],
        supporting: [fixedContentRefs.title, fixedContentRefs.takeaway, fixedContentRefs.evidence, fixedContentRefs.body, fixedContentRefs.action]
      },
      emphasis: { target: fixedContentRefs.firstMetric, strength: 'strong' }
    }));
    const page = pageTwo(solve(comparison));
    const first = page.placements.find(item => item.sourceRef === fixedContentRefs.firstMetric)!;
    const second = page.placements.find(item => item.sourceRef === fixedContentRefs.secondMetric)!;

    expect(first.geometry.x).toBeLessThan(second.geometry.x);
    expect(first.geometry.width).not.toBeCloseTo(second.geometry.width, 1);
  });

  it('rejects invalid constraints and stops when a minimum font cannot fit', () => {
    const design = fixedDesignDirections().editorial;
    const { features, constraints } = buildPresentationLayoutConstraintModel(fixedDesignOutline, design);
    const invalid = { ...constraints, schemaVersion: 2 } as unknown as typeof constraints;

    expect(solvePresentationLayout(features, invalid)).toMatchObject({ status: 'failed', pages: [] });

    const longTextOutline = {
      ...fixedDesignOutline,
      sections: fixedDesignOutline.sections.map(section => ({
        ...section,
        blocks: section.blocks.map((block, index) => index === 1 && block.type === 'paragraph'
          ? { ...block, text: 'Long supporting evidence '.repeat(500) }
          : block)
      }))
    };
    const longResult = solve(design, longTextOutline);
    expect(longResult.status).toBe('failed');
    expect(longResult.diagnostics.some(item => item.code === 'font_below_minimum' || item.code === 'layout_overflow')).toBe(true);
  });

  it('uses wider CJK glyph metrics when estimating long-text capacity', () => {
    const replaceEvidence = (text: string): DocumentOutline => ({
      ...fixedDesignOutline,
      sections: fixedDesignOutline.sections.map(section => ({
        ...section,
        blocks: section.blocks.map((block, index) => index === 1 && block.type === 'paragraph' ? { ...block, text } : block)
      }))
    });
    const cjkOutline = replaceEvidence('中'.repeat(300));
    const latinOutline = replaceEvidence('i'.repeat(300));
    const design = fixedDesignDirections().editorial;
    const cjkModel = buildPresentationLayoutConstraintModel(cjkOutline, design);
    const latinModel = buildPresentationLayoutConstraintModel(latinOutline, design);
    const sourceRef = fixedContentRefs.evidence;
    const cjkWidth = cjkModel.constraints.pages[1]!.elements.find(element => element.sourceRef === sourceRef)!.estimatedTextWidthEm;
    const latinWidth = latinModel.constraints.pages[1]!.elements.find(element => element.sourceRef === sourceRef)!.estimatedTextWidthEm;
    const cjkResult = solvePresentationLayoutWithRepair(cjkModel.features, cjkModel.constraints);
    expect(cjkWidth).toBeGreaterThan(latinWidth * 2.5);
    expect(JSON.stringify(cjkModel.constraints)).not.toContain('中'.repeat(20));
    expect(cjkResult.status).toBe('failed');
    expect(cjkResult.diagnostics.some(item => item.code === 'font_below_minimum')).toBe(true);
  });

  it('fits table cells by row, column count, and minimum font size', () => {
    const tableOutline = (columns: number, cellText: string): DocumentOutline => ({
      kind: 'ppt',
      title: 'Table text fit',
      sections: [{
        pageKind: 'data', heading: 'Evidence table', level: 1,
        blocks: [{
          type: 'table',
          header: Array.from({ length: columns }, (_, index) => `Column ${index + 1}`),
          rows: [Array.from({ length: columns }, (_, index) => index === 0 ? cellText : 'OK')]
        }]
      }]
    });
    const cellText = '中'.repeat(300);
    const oneColumnOutline = tableOutline(1, cellText);
    const fourColumnOutline = tableOutline(4, cellText);
    const oneColumnModel = buildPresentationLayoutConstraintModel(oneColumnOutline, buildFallbackPresentationDesignIR(oneColumnOutline));
    const fourColumnModel = buildPresentationLayoutConstraintModel(fourColumnOutline, buildFallbackPresentationDesignIR(fourColumnOutline));
    const oneColumnTable = oneColumnModel.constraints.pages[1]!.elements.find(element => element.role === 'table')!;
    const fourColumnTable = fourColumnModel.constraints.pages[1]!.elements.find(element => element.role === 'table')!;
    const oneColumnResult = solvePresentationLayoutWithRepair(oneColumnModel.features, oneColumnModel.constraints);
    const fourColumnResult = solvePresentationLayoutWithRepair(fourColumnModel.features, fourColumnModel.constraints);
    expect(oneColumnTable.tableRows).toBe(1);
    expect(oneColumnTable.tableColumns).toBe(1);
    expect(fourColumnTable.tableColumns).toBe(4);
    expect(fourColumnTable.tableCellWidthsEm?.[1]?.[0]).toBeGreaterThan(100);
    expect(oneColumnResult.status).toBe('success');
    expect(fourColumnResult.status).toBe('failed');
    expect(fourColumnResult.diagnostics.some(item => item.code === 'font_below_minimum')).toBe(true);
  });

  it('keeps the layout constraint builder as the only conversion from Design IR intent', () => {
    const outline = fixedDesignOutline;
    const original = buildFallbackPresentationDesignIR(outline);
    const changed = parsePresentationDesignIR({
      ...original,
      pages: original.pages.map(page => page.pageNumber === 2 ? {
        ...page,
        composition: { ...page.composition, focalArea: 'right' },
        whitespace: 'minimal'
      } : page)
    }, { outline });
    const first = buildPresentationLayoutConstraintModel(outline, original);
    const second = buildPresentationLayoutConstraintModel(outline, changed);

    expect(first.constraints.pages[1]!.designIntent).not.toEqual(second.constraints.pages[1]!.designIntent);
    expect(solvePresentationLayout(first.features, first.constraints).pages[1]!.geometrySignature)
      .not.toBe(solvePresentationLayout(second.features, second.constraints).pages[1]!.geometrySignature);
  });
});
