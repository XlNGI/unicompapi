import { parseRepairPlan, type RepairPlan } from '../../domain/entities/repair-plan';
import type { DocumentOutline, PresentationPageKind } from '../../domain/entities/document-generation';
import { parsePresentationDesignIR, type PresentationDesignComposition, type PresentationPageRole,
  type ProductionPresentationDesignIR } from '../../domain/entities/presentation-design-contract';

interface ControlledLayout {
  readonly pageRole: PresentationPageRole;
  readonly composition: PresentationDesignComposition;
}

/** The planner selects a supported layout hint; it never supplies geometry or new facts. */
const layouts: Readonly<Partial<Record<PresentationPageKind, ControlledLayout>>> = {
  section: { pageRole: 'section', composition: { principle: 'stacked', focalArea: 'left', balance: 'asymmetric-left', flow: 'top-to-bottom' } },
  insight: { pageRole: 'statement', composition: { principle: 'single-focus', focalArea: 'center', balance: 'weighted', flow: 'top-to-bottom' } },
  comparison: { pageRole: 'comparison', composition: { principle: 'comparison', focalArea: 'center', balance: 'symmetric', flow: 'comparison' } },
  process: { pageRole: 'process', composition: { principle: 'timeline', focalArea: 'left', balance: 'weighted', flow: 'sequence' } },
  data: { pageRole: 'metric', composition: { principle: 'grid', focalArea: 'right', balance: 'symmetric', flow: 'left-to-right' } },
  image_text: { pageRole: 'content', composition: { principle: 'split', focalArea: 'left', balance: 'asymmetric-left', flow: 'left-to-right' } }
};

export interface PresentationDesignRepair {
  readonly designIR: ProductionPresentationDesignIR;
  readonly targetSectionIndexes: readonly number[];
  readonly targetPageNumbers: readonly number[];
}

/** Revalidate both boundaries and update only the selected pages' composition decisions. */
export function repairPresentationDesign(input: {
  readonly outline: DocumentOutline;
  readonly designIR: ProductionPresentationDesignIR;
  readonly plan: RepairPlan;
}): PresentationDesignRepair {
  const design = parsePresentationDesignIR(input.designIR, { outline: input.outline });
  const plan = parseRepairPlan(input.plan);
  const targets = new Map<number, ControlledLayout>();
  for (const operation of plan.operations) {
    const sectionIndex = operation.target.sectionIndex;
    const controlled = layouts[operation.value as PresentationPageKind];
    if (operation.operation !== 'replace_page_layout' || !controlled || sectionIndex === undefined ||
      sectionIndex < 0 || sectionIndex >= input.outline.sections.length ||
      Object.keys(operation.target).some(key => key !== 'sectionIndex') || operation.data !== undefined || targets.has(sectionIndex)) {
      throw new TypeError('repair_design_target_not_allowed');
    }
    targets.set(sectionIndex, controlled);
  }
  const next = parsePresentationDesignIR({ ...design, pages: design.pages.map(page => {
    const controlled = targets.get(page.pageNumber - 2);
    if (controlled && page.organization) {
      // A capacity repair may reflow the same business groups, never rename
      // comparison sides or discard declared sequence/support relationships.
      const compact = page.density !== 'dense' || page.whitespace !== 'minimal';
      return { ...page, density: compact ? 'dense' : 'balanced', whitespace: compact ? 'minimal' : 'balanced' };
    }
    return controlled ? { ...page, pageRole: controlled.pageRole, composition: controlled.composition } : page;
  }) }, { outline: input.outline });
  if (JSON.stringify(design) === JSON.stringify(next)) throw new TypeError('repair_design_unchanged');
  const targetSectionIndexes = [...targets.keys()].sort((left, right) => left - right);
  return { designIR: next, targetSectionIndexes, targetPageNumbers: targetSectionIndexes.map(index => index + 2) };
}
