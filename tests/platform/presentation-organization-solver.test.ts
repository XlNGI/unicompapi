import { describe, expect, it } from 'vitest';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { buildPresentationLayoutConstraintModel } from '../../src/platform/documents/presentation-page-features';
import { solvePresentationLayoutWithRepair } from '../../src/platform/documents/presentation-layout-engine';

const outline: DocumentOutline = { kind: 'ppt', title: 'Two business objects', sections: [{ heading: 'Compare delivery', level: 1,
  pageKind: 'comparison', blocks: [{ type: 'bullets', items: ['A label', 'A evidence'] },
    { type: 'bullets', items: ['B label', 'B evidence'] }, { type: 'paragraph', text: 'Shared source for both objects' }] }] };
function design() {
  const base = buildFallbackPresentationDesignIR(outline);
  return parsePresentationDesignIR({ ...base, pages: base.pages.map(page => page.pageNumber === 2 ? { ...page,
    composition: { principle: 'comparison', focalArea: 'center', balance: 'symmetric', flow: 'comparison' },
    organization: { schemaVersion: 1, layout: 'comparison', groups: [
      { groupId: 'side-a', role: 'comparison-side', contentRefs: ['outline.sections[0].blocks[0]'] },
      { groupId: 'side-b', role: 'comparison-side', contentRefs: ['outline.sections[0].blocks[1]'] },
      { groupId: 'source', role: 'supporting', contentRefs: ['outline.sections[0].blocks[2]'] }
    ], relationships: [{ kind: 'compare', fromGroupId: 'side-a', toGroupId: 'side-b' }] }
  } : page) }, { outline });
}

describe('business organization at the Host feature/solver boundary', () => {
  it('expands block aliases to complete unique leaves and supplies the omitted real header', () => {
    const model = buildPresentationLayoutConstraintModel(outline, design());
    const organization = model.constraints.pages[1].contentOrganization!;
    expect(organization.groups.find(group => group.groupId === 'side-a')?.sourceRefs).toEqual([
      'outline.sections[0].blocks[0].items[0]', 'outline.sections[0].blocks[0].items[1]']);
    expect(organization.groups.find(group => group.role === 'header')?.sourceRefs).toEqual(['outline.sections[0].heading']);
    const result = solvePresentationLayoutWithRepair(model.features, model.constraints);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
    const page = result.pages[1];
    const a = page.placements.filter(item => item.groupId === 'side-a');
    const b = page.placements.filter(item => item.groupId === 'side-b');
    const header = page.placements.find(item => item.role === 'title')!;
    expect(a).toHaveLength(2); expect(b).toHaveLength(2);
    expect(Math.max(...a.map(item => item.geometry.x + item.geometry.width))).toBeLessThanOrEqual(Math.min(...b.map(item => item.geometry.x)));
    expect(header.geometry.y + header.geometry.height).toBeLessThanOrEqual(Math.min(...a.concat(b).map(item => item.geometry.y)));
  });

  it('refuses a parent alias and its leaf admitted into different business groups', () => {
    const original = design();
    const page = original.pages[1];
    const changed = parsePresentationDesignIR({ ...original, pages: original.pages.map(old => old.pageNumber === 2 ? { ...old,
      organization: { ...page.organization!, groups: page.organization!.groups.map(group => group.groupId === 'side-b' ? {
        ...group, contentRefs: [...group.contentRefs, 'outline.sections[0].blocks[0].items[0]'] } : group) }
    } : old) }, { outline });
    expect(() => buildPresentationLayoutConstraintModel(outline, changed)).toThrow('content_organization_source_duplicate');
  });

  it('refuses missing business content rather than inferring away an explicit source note', () => {
    const original = design(), page = original.pages[1];
    const changed = parsePresentationDesignIR({ ...original, pages: original.pages.map(old => old.pageNumber === 2 ? { ...old,
      organization: { ...page.organization!, groups: page.organization!.groups.filter(group => group.groupId !== 'source') }
    } : old) }, { outline });
    expect(() => buildPresentationLayoutConstraintModel(outline, changed)).toThrow('content_organization_source_missing');
  });

  it('keeps an ambiguous v2 split on its prior solver path', () => {
    const original = design();
    const legacy = parsePresentationDesignIR({ ...original, pages: original.pages.map(page => ({ ...page, organization: undefined })) }, { outline });
    const model = buildPresentationLayoutConstraintModel(outline, legacy);
    // Three separate business blocks include a shared note; there is no clear
    // two-block split to infer, so this v2 input stays on its prior solver path.
    expect(model.constraints.pages[1].contentOrganization).toBeUndefined();
    expect(solvePresentationLayoutWithRepair(model.features, model.constraints).status).toBe('success');
  });

  it('infers two unambiguous v2 business blocks without using the heading as a comparison side', () => {
    const simple: DocumentOutline = { ...outline, sections: [{ ...outline.sections[0], blocks: outline.sections[0].blocks.slice(0, 2) }] };
    const legacy = buildFallbackPresentationDesignIR(simple);
    const model = buildPresentationLayoutConstraintModel(simple, legacy);
    const organization = model.constraints.pages[1].contentOrganization!;
    expect(organization.source).toBe('inferred');
    const sides = organization.groups.filter(group => group.role === 'comparison-side');
    expect(sides).toHaveLength(2);
    expect(sides.flatMap(group => group.sourceRefs)).not.toContain('outline.sections[0].heading');
    expect(organization.groups.find(group => group.role === 'header')?.sourceRefs).toEqual(['outline.sections[0].heading']);
    const solved = solvePresentationLayoutWithRepair(model.features, model.constraints);
    expect(solved.status, JSON.stringify(solved.diagnostics)).toBe('success');
  });
});
