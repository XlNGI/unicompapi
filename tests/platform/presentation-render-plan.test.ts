import { describe, expect, it } from 'vitest';
import {
  parsePresentationRenderPlan,
  validatePresentationRenderPlan,
  type PresentationRenderPlan
} from '../../src/domain/entities/presentation-render-plan';

function plan(): PresentationRenderPlan {
  return {
    schemaVersion: 1,
    canvas: { width: 13.333, height: 7.5 },
    minimumFontSize: 14,
    pages: [{
      pageNumber: 1,
      pageRole: 'hero',
      backgroundColor: 'F7F7F5',
      elements: [{
        renderId: 'p1-e1',
        source: { kind: 'outline', ref: 'outline.title' },
        type: 'text',
        geometry: { x: 0.8, y: 0.8, width: 7.2, height: 2.4 },
        style: { fontFamily: 'Microsoft YaHei', fontSize: 36, bold: true, color: '242A2E', alignment: 'left', verticalAlignment: 'middle' },
        content: { type: 'text', text: 'Product impact' },
        zIndex: 0
      }]
    }]
  };
}

describe('Presentation Render Plan v1 validation', () => {
  it('accepts a complete plan and rejects malformed JSON-like input safely', () => {
    const candidate = plan();
    expect(validatePresentationRenderPlan(candidate, { expectedPageCount: 1, validSourceRefsByPage: [{ pageNumber: 1, sourceRefs: ['outline.title'] }] })).toEqual([]);
    expect(parsePresentationRenderPlan(candidate).pages[0]!.elements[0]!.renderId).toBe('p1-e1');
    expect(validatePresentationRenderPlan(null).map(item => item.code)).toContain('invalid_render_plan');
  });

  it('rejects unknown fields, unsupported element types, and malformed content contracts', () => {
    const candidate = plan() as unknown as Record<string, unknown>;
    const withUnknown = { ...candidate, extra: true };
    expect(validatePresentationRenderPlan(withUnknown).map(item => item.code)).toContain('unknown_field');

    const unsupported = plan() as unknown as { pages: Array<{ elements: Array<Record<string, unknown>> }> };
    unsupported.pages[0]!.elements[0]!.type = 'image';
    expect(validatePresentationRenderPlan(unsupported).map(item => item.code)).toContain('unsupported_element_type');

    const brokenContent = plan() as unknown as { pages: Array<{ elements: Array<{ content: Record<string, unknown> }> }> };
    brokenContent.pages[0]!.elements[0]!.content.extra = 'not allowed';
    expect(validatePresentationRenderPlan(brokenContent).map(item => item.code)).toContain('unknown_field');
  });

  it('checks page count and identity, global render IDs, and page-local content references', () => {
    const candidate = plan();
    expect(validatePresentationRenderPlan(candidate, { expectedPageCount: 2 }).map(item => item.code)).toContain('page_count_mismatch');
    expect(validatePresentationRenderPlan(candidate, { validSourceRefsByPage: [{ pageNumber: 1, sourceRefs: [] }] }).map(item => item.code)).toContain('invalid_source_ref');

    const duplicatePage = { ...candidate, pages: [candidate.pages[0], { ...candidate.pages[0]!, pageNumber: 1 }] };
    expect(validatePresentationRenderPlan(duplicatePage).map(item => item.code)).toContain('invalid_page_number');

    const duplicateElement = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [candidate.pages[0]!.elements[0]!, { ...candidate.pages[0]!.elements[0]!, source: { kind: 'generated', key: 'closing-label' } }] }] };
    expect(validatePresentationRenderPlan(duplicateElement).map(item => item.code)).toContain('duplicate_render_id');

    const missingInventory = validatePresentationRenderPlan(candidate, { validSourceRefsByPage: [] });
    expect(missingInventory.map(item => item.code)).toContain('invalid_source_ref');

    const duplicateZ = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [candidate.pages[0]!.elements[0]!, {
      ...candidate.pages[0]!.elements[0]!, renderId: 'p1-e2', source: { kind: 'generated', key: 'closing-label' }
    }] }] };
    expect(validatePresentationRenderPlan(duplicateZ).map(item => item.code)).toContain('duplicate_z_index');
  });

  it('rejects negative size, out-of-bounds elements, and material overlap', () => {
    const candidate = plan();
    const negative = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [{ ...candidate.pages[0]!.elements[0]!, geometry: { ...candidate.pages[0]!.elements[0]!.geometry, width: 0 } }] }] };
    expect(validatePresentationRenderPlan(negative).map(item => item.code)).toContain('negative_size');

    const overflow = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [{ ...candidate.pages[0]!.elements[0]!, geometry: { ...candidate.pages[0]!.elements[0]!.geometry, x: 12.9 } }] }] };
    expect(validatePresentationRenderPlan(overflow).map(item => item.code)).toContain('layout_overflow');

    const overlap = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [candidate.pages[0]!.elements[0]!, { ...candidate.pages[0]!.elements[0]!, renderId: 'p1-e2', source: { kind: 'generated', key: 'closing-label' }, geometry: { x: 1, y: 1, width: 2, height: 1 } }] }] };
    expect(validatePresentationRenderPlan(overlap).map(item => item.code)).toContain('layout_overlap');
  });

  it('enforces the minimum font size and the supported z-order range', () => {
    const candidate = plan();
    const tooSmall = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [{ ...candidate.pages[0]!.elements[0]!, style: { ...candidate.pages[0]!.elements[0]!.style, fontSize: 12 }, zIndex: 10_001 }] }] };
    const diagnostics = validatePresentationRenderPlan(tooSmall);
    expect(diagnostics.map(item => item.code)).toContain('font_below_minimum');
    expect(diagnostics.map(item => item.code)).toContain('invalid_render_plan');
  });

  it('validates current table and chart primitives without accepting malformed data', () => {
    const candidate = plan();
    const table = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [{ ...candidate.pages[0]!.elements[0]!, type: 'table' as const,
      content: { type: 'table' as const, header: ['Metric', 'Value'], rows: [['Retention', '92%']] },
      style: { ...candidate.pages[0]!.elements[0]!.style, tableHeaderFill: 'FFFFFF', tableBodyFill: 'F7F7F5', borderColor: '677078' }
    }] }] };
    expect(validatePresentationRenderPlan(table).filter(item => item.code !== 'layout_overlap')).toEqual([]);
    const coloredHeader = { ...table, pages: [{ ...table.pages[0]!, elements: [{ ...table.pages[0]!.elements[0]!,
      style: { ...table.pages[0]!.elements[0]!.style, tableHeaderFill: '193B65', tableHeaderColor: 'FFFFFF' }
    }] }] };
    expect(validatePresentationRenderPlan(coloredHeader)).toEqual([]);
    expect(parsePresentationRenderPlan(coloredHeader).pages[0]!.elements[0]!.style.tableHeaderColor).toBe('FFFFFF');
    const invalidHeader = { ...coloredHeader, pages: [{ ...coloredHeader.pages[0]!, elements: [{ ...coloredHeader.pages[0]!.elements[0]!,
      style: { ...coloredHeader.pages[0]!.elements[0]!.style, tableHeaderColor: 'url(invalid)' }
    }] }] };
    expect(validatePresentationRenderPlan(invalidHeader).some(item => item.path.endsWith('.tableHeaderColor'))).toBe(true);
    const headerOnText = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [{ ...candidate.pages[0]!.elements[0]!,
      style: { ...candidate.pages[0]!.elements[0]!.style, tableHeaderColor: 'FFFFFF' }
    }] }] };
    expect(validatePresentationRenderPlan(headerOnText).some(item => item.path.endsWith('.tableHeaderColor'))).toBe(true);

    const chart = { ...candidate, pages: [{ ...candidate.pages[0]!, elements: [{ ...candidate.pages[0]!.elements[0]!, type: 'chart' as const,
      content: { type: 'chart' as const, chartKind: 'bar' as const, title: 'Quarterly movement', data: [{ label: 'Retention', value: 92 }] },
      style: { ...candidate.pages[0]!.elements[0]!.style, chartColors: ['2D3A3E'], mutedColor: '677078', showLegend: false, showValues: true }
    }] }] };
    expect(validatePresentationRenderPlan(chart)).toEqual([]);

    const missingChartOptions = { ...chart, pages: [{ ...chart.pages[0]!, elements: [{ ...chart.pages[0]!.elements[0]!, style: {
      ...chart.pages[0]!.elements[0]!.style, showLegend: undefined, showValues: undefined
    } }] }] };
    expect(validatePresentationRenderPlan(missingChartOptions).map(item => item.code)).toContain('invalid_render_plan');

    const invalidTable = { ...table, pages: [{ ...table.pages[0]!, elements: [{ ...table.pages[0]!.elements[0]!, content: { ...table.pages[0]!.elements[0]!.content, rows: [['only one cell']] } }] }] };
    expect(validatePresentationRenderPlan(invalidTable).map(item => item.code)).toContain('invalid_render_plan');
  });
});
