import { describe, expect, it } from 'vitest';
import { buildDocumentContentSnapshot } from '../../src/domain/entities/document-content-snapshot';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { computePresentationLayoutDigest, derivePresentationRenderPlanFromLayoutIR,
  parseVerifiedProductionPresentationLayoutIR } from '../../src/platform/documents/presentation-layout-ir-adapter';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import type { ProductionPresentationLayoutIR } from '../../src/domain/entities/presentation-layout-ir';
import { organizationPagesDesign, organizationPagesOutline } from '../fixtures/presentation-organization-pages';

function fixture() {
  const content = buildDocumentContentSnapshot({ outline: organizationPagesOutline, identityScope: 'organization-integrity' });
  const design = organizationPagesDesign();
  const result = compilePresentationRenderPlan(organizationPagesOutline, design, resolvePresentationTemplate('work_report').tokens, { contentSnapshot: content });
  expect(result.layoutIR, JSON.stringify(result.diagnostics)).toBeDefined();
  return { content, design, layout: result.layoutIR! };
}
function rehash(layout: ProductionPresentationLayoutIR): ProductionPresentationLayoutIR {
  return { ...layout, identity: { ...layout.identity, layoutDigest: computePresentationLayoutDigest(layout) } };
}

describe('organization membership and spatial execution integrity', () => {
  it('cannot remove an explicit organization while keeping a matching content and design identity', () => {
    const { content, design, layout } = fixture();
    const changed = rehash({ ...layout, pages: layout.pages.map((page, index) => index === 1 ? { ...page, organization: undefined } : page) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(changed, { content, design })).toThrow('layout_organization_missing');
  });

  it.each(['missing', 'duplicate', 'foreign'] as const)('rejects %s group membership even after recomputing the layout hash', mode => {
    const { content, design, layout } = fixture();
    const page = layout.pages[1], organization = page.organization!;
    const original = organization.groups[1].sourceRefs;
    const refs = mode === 'missing' ? original.slice(1) : mode === 'duplicate' ? [...original, original[0]] : ['another-document:a1', ...original.slice(1)];
    const changed = rehash({ ...layout, pages: layout.pages.map((old, index) => index === 1 ? { ...old, organization: {
      ...organization, groups: organization.groups.map((group, groupIndex) => groupIndex === 1 ? { ...group, sourceRefs: refs } : group)
    } } : old) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(changed, { content, design })).toThrow();
    expect(() => derivePresentationRenderPlanFromLayoutIR(changed, content)).toThrow();
  });

  it('rejects exchanged step geometry that reverses a declared sequence, with all facts and group identities intact', () => {
    const { content, design, layout } = fixture();
    const page = layout.pages[3], organization = page.organization!;
    const stepGroups = organization.groups.filter(group => group.role === 'step');
    const edge = organization.relationships.find(relation => relation.kind === 'sequence')!;
    const from = stepGroups.find(group => group.groupId === edge.fromGroupId)!;
    const to = stepGroups.find(group => group.groupId === edge.toGroupId)!;
    const fromElements = page.elements.filter(element => element.source.kind === 'content' && from.sourceRefs.includes(element.source.ref));
    const toElements = page.elements.filter(element => element.source.kind === 'content' && to.sourceRefs.includes(element.source.ref));
    expect(fromElements).toHaveLength(toElements.length);
    const swapped = page.elements.map(element => {
      const first = fromElements.indexOf(element), second = toElements.indexOf(element);
      return first >= 0 ? { ...element, geometry: toElements[first].geometry }
        : second >= 0 ? { ...element, geometry: fromElements[second].geometry } : element;
    });
    const changed = rehash({ ...layout, pages: layout.pages.map((old, index) => index === 3 ? { ...old, elements: swapped } : old) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(changed, { content, design })).toThrow('layout_organization_sequence_order');
    expect(() => derivePresentationRenderPlanFromLayoutIR(changed, content)).toThrow('layout_organization_sequence_order');
  });

  it('rejects relabelling a valid group membership as a different admitted business organization', () => {
    const { content, design, layout } = fixture();
    const page = layout.pages[1], organization = page.organization!;
    const changed = rehash({ ...layout, pages: layout.pages.map((old, index) => index === 1 ? { ...old,
      organization: { ...organization, source: 'inferred' } } : old) });
    expect(() => parseVerifiedProductionPresentationLayoutIR(changed, { content, design })).toThrow('layout_organization_design_mismatch');
  });
});
