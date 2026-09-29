import { describe, expect, it } from 'vitest';
import {
  buildFallbackPresentationDesignIR,
  type PresentationDesignIRV2
} from '../../src/domain/entities/presentation-design-contract';
import {
  parsePresentationLayoutConstraintModel,
  validatePresentationLayoutConstraintModel
} from '../../src/domain/entities/presentation-layout-constraints';
import {
  buildPresentationLayoutConstraintModel,
  extractPresentationPageFeatures
} from '../../src/platform/documents/presentation-page-features';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';

function outlineFixture() {
  return parseDocumentOutline(JSON.stringify({
    kind: 'ppt',
    title: 'Product impact',
    sections: [{
      pageKind: 'comparison',
      heading: 'Two indicators show measurable improvement',
      level: 1,
      takeaway: 'Retention leads the evidence',
      action: 'Expand the rollout',
      blocks: [
        { type: 'paragraph', text: 'Both indicators improved across the last quarter.' },
        { type: 'bullets', items: ['Retention 92%', 'Adoption 68%'] },
        { type: 'table', header: ['Measure', 'Before', 'After'], rows: [['Retention', '81%', '92%'], ['Adoption', '54%', '68%']] },
        { type: 'chart', chartKind: 'bar', title: 'Quarterly movement', data: [{ label: 'Retention', value: 92 }, { label: 'Adoption', value: 68 }] },
        { type: 'numbered', items: ['Review the cohort', 'Scale the rollout', 'Measure impact'] }
      ]
    }]
  }));
}

function designedIR(): PresentationDesignIRV2 {
  const outline = outlineFixture();
  const baseline = buildFallbackPresentationDesignIR(outline);
  const basePage = baseline.pages[1]!;
  const metricRefs = ['outline.sections[0].blocks[1].items[0]', 'outline.sections[0].blocks[1].items[1]'];
  const paragraphRef = 'outline.sections[0].blocks[0]';
  const tableRef = 'outline.sections[0].blocks[2]';
  const chartRef = 'outline.sections[0].blocks[3]';
  const primaryRef = 'outline.sections[0].heading';
  return {
    ...baseline,
    pages: baseline.pages.map((page, index) => index !== 1 ? page : {
      ...basePage,
      pageRole: 'comparison',
      pageIntent: 'Compare the two key indicators with retention as the leading measure',
      hierarchy: { primary: [primaryRef], secondary: metricRefs, supporting: [paragraphRef, tableRef, chartRef] },
      composition: { principle: 'comparison', focalArea: 'right', balance: 'asymmetric-right', flow: 'left-to-right' },
      density: 'dense',
      whitespace: 'generous',
      emphasis: { target: metricRefs[0]!, strength: 'dominant' },
      contentRoles: {
        title: [primaryRef], body: [paragraphRef], metric: metricRefs,
        evidence: [paragraphRef, tableRef], image: [], chart: [chartRef]
      }
    })
  };
}

describe('presentation page features and Layout Constraint Model v1', () => {
  it('extracts deterministic content counts and source references from the Outline', () => {
    const outline = outlineFixture();
    const design = designedIR();
    const page = design.pages[1]!;
    const features = extractPresentationPageFeatures(outline, page);

    expect(features).toMatchObject({
      pageNumber: 2,
      pageRole: 'comparison',
      semanticRole: 'comparison',
      blockCount: 5,
      metricCount: 2,
      evidenceCount: 2,
      chartCount: 1,
      tableCount: 1,
      hasChart: true,
      hasTable: true,
      hasSequence: true,
      comparisonCandidate: true,
      dominantPrimaryContent: 'outline.sections[0].heading',
      contentDensity: 'dense'
    });
    expect(features.units.map(unit => unit.sourceRef)).toContain('outline.sections[0].blocks[1].items[1]');
    expect(features.textLength).toBeGreaterThan(100);
    expect(extractPresentationPageFeatures(outline, page)).toEqual(features);
  });

  it('derives bounded role/font/region constraints and explicit relationships without placement coordinates', () => {
    const outline = outlineFixture();
    const { features, constraints } = buildPresentationLayoutConstraintModel(outline, designedIR(), {
      canvas: { width: 12, height: 8 },
      themeTokens: {
        typography: { fontFamily: 'Aptos', minimumFontSize: 12, maximumFontSize: 44, baseFontSize: 22 },
        spacing: { baseGap: 0.3, minimumGap: 0.1 },
        colors: { background: 'FFFFFF', surface: 'FFFFFF', accent: '113355', secondaryAccent: '557799', text: '111111', muted: '666666' }
      }
    });
    const page = constraints.pages[1]!;
    const metric = page.elements.find(element => element.role === 'metric')!;

    expect(features).toHaveLength(3);
    expect(page).toMatchObject({
      pageRole: 'comparison',
      density: 'dense',
      designIntent: {
        composition: { principle: 'comparison', focalArea: 'right', balance: 'asymmetric-right', flow: 'left-to-right' },
        emphasis: { target: 'outline.sections[0].blocks[1].items[0]', strength: 'dominant' },
        whitespace: 'generous'
      }
    });
    expect(page.safeArea.leftInset).toBeCloseTo(1.26);
    expect(page.contentBounds.maximumWidth).toBeCloseTo(9.48);
    expect(page.minimumGap).toBe(0.1);
    expect(page.preferredGap).toBeGreaterThan(page.minimumGap);
    expect(metric).toMatchObject({ hierarchy: 'secondary', priority: 70, preferredRegion: 'supporting', minimumFontSize: 12, maximumFontSize: 44 });
    expect(metric.minWidth).toBeLessThanOrEqual(metric.preferredWidth);
    expect(metric.preferredWidth).toBeLessThanOrEqual(metric.maxWidth);
    expect(metric.minimumFontSize).toBeLessThanOrEqual(metric.preferredFontSize);
    expect(metric.preferredFontSize).toBeLessThanOrEqual(metric.maximumFontSize);
    expect(page.relationships.map(item => item.kind)).toEqual(expect.arrayContaining(['above', 'near', 'align', 'paired', 'dominates']));
    expect(validatePresentationLayoutConstraintModel(constraints, {
      expectedPageCount: 3,
      validSourceRefsByPage: features.map(item => ({ pageNumber: item.pageNumber, sourceRefs: item.units.map(unit => unit.sourceRef) }))
    })).toEqual([]);
    expect(parsePresentationLayoutConstraintModel(constraints).schemaVersion).toBe(1);
  });

  it('keeps deterministic CJK width measurements and table cell widths without retaining text', () => {
    const base = outlineFixture();
    const cjkText = '中文宽度测量'.repeat(12);
    const latinText = 'iiiiii'.repeat(12);
    const cjkOutline = {
      ...base,
      sections: base.sections.map(section => ({
        ...section,
        blocks: section.blocks.map((block, index) => index === 0 && block.type === 'paragraph' ? { ...block, text: cjkText } : block)
      }))
    };
    const latinOutline = {
      ...base,
      sections: base.sections.map(section => ({
        ...section,
        blocks: section.blocks.map((block, index) => index === 0 && block.type === 'paragraph' ? { ...block, text: latinText } : block)
      }))
    };
    const cjk = buildPresentationLayoutConstraintModel(cjkOutline, buildFallbackPresentationDesignIR(cjkOutline));
    const latin = buildPresentationLayoutConstraintModel(latinOutline, buildFallbackPresentationDesignIR(latinOutline));
    const paragraphRef = 'outline.sections[0].blocks[0]';
    const tableRef = 'outline.sections[0].blocks[2]';
    const cjkParagraph = cjk.constraints.pages[1]!.elements.find(element => element.sourceRef === paragraphRef)!;
    const latinParagraph = latin.constraints.pages[1]!.elements.find(element => element.sourceRef === paragraphRef)!;
    const table = cjk.constraints.pages[1]!.elements.find(element => element.sourceRef === tableRef)!;

    expect(cjkParagraph.estimatedTextWidthEm).toBeGreaterThan(latinParagraph.estimatedTextWidthEm * 1.5);
    expect(table).toMatchObject({ tableRows: 2, tableColumns: 3 });
    expect(table.tableCellWidthsEm).toHaveLength(3);
    expect(table.tableCellWidthsEm?.every(row => row.length === 3 && row.every(Number.isFinite))).toBe(true);
    expect(JSON.stringify(cjk.constraints)).not.toContain(cjkText);
    expect(JSON.stringify(cjk.constraints)).not.toContain('81%');
    expect(validatePresentationLayoutConstraintModel({
      ...cjk.constraints,
      pages: cjk.constraints.pages.map(page => page.pageNumber !== 2 ? page : {
        ...page,
        elements: page.elements.map(element => element.sourceRef !== tableRef ? element : {
          ...element,
          tableCellWidthsEm: [[1, 2], [3, 4], [5, 6]]
        })
      })
    }).map(item => item.code)).toContain('invalid_shape');
  });

  it('changes safe area and spacing when the design changes whitespace or density', () => {
    const outline = outlineFixture();
    const design = designedIR();
    const first = buildPresentationLayoutConstraintModel(outline, design).constraints.pages[1]!;
    const compactWhitespaceIR: PresentationDesignIRV2 = {
      ...design,
      pages: design.pages.map((page, index) => index === 1 ? { ...page, whitespace: 'minimal' } : page)
    };
    const compactWhitespace = buildPresentationLayoutConstraintModel(outline, compactWhitespaceIR).constraints.pages[1]!;
    const sparseIR: PresentationDesignIRV2 = {
      ...design,
      pages: design.pages.map((page, index) => index === 1 ? { ...page, density: 'sparse' } : page)
    };
    const sparse = buildPresentationLayoutConstraintModel(outline, sparseIR).constraints.pages[1]!;

    expect(first.safeArea.leftInset).toBeGreaterThan(compactWhitespace.safeArea.leftInset);
    expect(first.preferredGap).toBeGreaterThan(compactWhitespace.preferredGap);
    expect(first.preferredGap).toBeLessThan(sparse.preferredGap);
    expect(first.contentDensity).toBe(compactWhitespace.contentDensity);
  });

  it('rejects unknown coordinate fields, invalid bounds, duplicate pages, and foreign source references', () => {
    const outline = outlineFixture();
    const { features, constraints } = buildPresentationLayoutConstraintModel(outline, designedIR());
    const page = constraints.pages[1]!;
    const element = page.elements[0]!;
    const withCoordinate = {
      ...constraints,
      pages: constraints.pages.map((item, index) => index === 1 ? {
        ...item,
        elements: [{ ...element, x: 0.4 }, ...item.elements.slice(1)]
      } : item)
    };
    expect(validatePresentationLayoutConstraintModel(withCoordinate).map(item => item.code)).toContain('unknown_field');

    const badBounds = {
      ...constraints,
      pages: constraints.pages.map((item, index) => index === 1 ? {
        ...item,
        elements: [{ ...element, minWidth: 12, maxWidth: 2 }, ...item.elements.slice(1)]
      } : item)
    };
    expect(validatePresentationLayoutConstraintModel(badBounds).map(item => item.code)).toContain('invalid_value');

    const duplicatePage = { ...constraints, pages: [constraints.pages[0], { ...page, pageNumber: 1 }, constraints.pages[2]] };
    expect(validatePresentationLayoutConstraintModel(duplicatePage).map(item => item.code)).toContain('duplicate_page');

    expect(validatePresentationLayoutConstraintModel(constraints, {
      validSourceRefsByPage: features.map(item => ({ pageNumber: item.pageNumber, sourceRefs: item.units.filter(unit => unit.sourceRef !== element.sourceRef).map(unit => unit.sourceRef) }))
    }).map(item => item.code)).toContain('invalid_reference');
  });

  it('is deterministic and its contract contains no final x/y geometry', () => {
    const outline = outlineFixture();
    const first = buildPresentationLayoutConstraintModel(outline, designedIR());
    const second = buildPresentationLayoutConstraintModel(outline, designedIR());
    expect(first).toEqual(second);

    const keys: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      if (Array.isArray(value)) { value.forEach(collect); return; }
      for (const [key, child] of Object.entries(value)) { keys.push(key); collect(child); }
    };
    collect(first.constraints);
    expect(keys).not.toContain('x');
    expect(keys).not.toContain('y');
  });
});
