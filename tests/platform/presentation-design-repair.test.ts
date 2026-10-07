import { describe, expect, it } from 'vitest';
import type { RepairPlan } from '../../src/domain/entities/repair-plan';
import { repairPresentationDesign } from '../../src/platform/documents/presentation-design-repair';
import { compilePresentationRenderPlan } from '../../src/platform/documents/presentation-render-plan-compiler';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { repairProductionDesign, repairProductionOutline } from '../fixtures/presentation-repair-production';

const plan: RepairPlan = { kind: 'repair', diagnosisCodes: ['text_overflow'], preserve: [], reason: 'Change the target layout',
  operations: [{ operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'comparison' }], expectedRevision: 3 };

describe('controlled Design IR repair', () => {
  it('changes actual target geometry while retaining references, facts and every other design page', () => {
    const design = repairProductionDesign();
    const before = JSON.stringify({ outline: repairProductionOutline, design, plan });
    const repaired = repairPresentationDesign({ outline: repairProductionOutline, designIR: design, plan });
    expect(repaired.targetSectionIndexes).toEqual([0]);
    expect(repaired.targetPageNumbers).toEqual([2]);
    expect(repaired.designIR.globalDesign).toEqual(design.globalDesign);
    for (const index of [0, 2, 3]) expect(repaired.designIR.pages[index]).toEqual(design.pages[index]);
    expect(repaired.designIR.pages[1]).toMatchObject({ hierarchy: design.pages[1].hierarchy,
      contentRoles: design.pages[1].contentRoles, emphasis: design.pages[1].emphasis, pageIntent: design.pages[1].pageIntent });
    const tokens = resolvePresentationTemplate('business_minimal').tokens;
    const initial = compilePresentationRenderPlan(repairProductionOutline, design, tokens);
    const candidate = compilePresentationRenderPlan(repairProductionOutline, repaired.designIR, tokens);
    expect(initial.renderPlanStatus, JSON.stringify(initial.diagnostics)).toBe('valid');
    expect(candidate.renderPlanStatus, JSON.stringify(candidate.diagnostics)).toBe('valid');
    expect(initial.plan!.pages[1].elements.map(element => element.content)).toEqual(candidate.plan!.pages[1].elements.map(element => element.content));
    expect(initial.plan!.pages[1].elements.map(element => element.geometry)).not.toEqual(candidate.plan!.pages[1].elements.map(element => element.geometry));
    for (const index of [0, 2, 3]) expect(candidate.plan!.pages[index]).toEqual(initial.plan!.pages[index]);
    expect(JSON.stringify({ outline: repairProductionOutline, design, plan })).toBe(before);
  });

  it.each([
    { operation: 'replace_text', target: { sectionIndex: 0 }, value: 'Changed facts' },
    { operation: 'replace_page_layout', target: { pageNumber: 2 }, value: 'comparison' },
    { operation: 'replace_page_layout', target: { sectionIndex: 0, blockIndex: 0 }, value: 'comparison' },
    { operation: 'replace_page_layout', target: { sectionIndex: 9 }, value: 'comparison' },
    { operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'cover' },
    { operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'closing' },
    { operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'custom free geometry' }
  ])('rejects unsupported repair target or value %#', operation => {
    expect(() => repairPresentationDesign({ outline: repairProductionOutline, designIR: repairProductionDesign(),
      plan: { ...plan, operations: [operation] } as RepairPlan })).toThrow();
  });

  it('rejects duplicate target decisions and a layout that would leave the design unchanged', () => {
    const design = repairProductionDesign();
    expect(() => repairPresentationDesign({ outline: repairProductionOutline, designIR: design,
      plan: { ...plan, operations: [plan.operations[0], plan.operations[0]] } })).toThrow('repair_design_target_not_allowed');
    const next = repairPresentationDesign({ outline: repairProductionOutline, designIR: design, plan });
    expect(() => repairPresentationDesign({ outline: repairProductionOutline, designIR: next.designIR, plan })).toThrow('repair_design_unchanged');
  });
});
