import { presentationDocumentPageLimits } from './document-generation';

/** User intent, pinned by the host; a model-provided page number is only a target. */
export interface PresentationPageRequirement {
  readonly mode: 'target' | 'exact' | 'max' | 'range';
  readonly targetPages: number;
  readonly countBasis: 'total' | 'content';
  readonly minimumPages?: number;
  readonly maximumPages?: number;
}

export function presentationPlanningTotalPages(requirement: PresentationPageRequirement): number {
  return requirement.targetPages + (requirement.countBasis === 'content'
    ? presentationDocumentPageLimits.systemGeneratedPages : 0);
}

export function validatePresentationPageRequirement(requirement: PresentationPageRequirement): void {
  const positiveInteger = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) > 0;
  if (!['target', 'exact', 'max', 'range'].includes(requirement.mode) ||
      !['total', 'content'].includes(requirement.countBasis) ||
      !positiveInteger(requirement.targetPages)) throw new TypeError('invalid_page_requirement');
  if (requirement.mode === 'max' &&
      (!positiveInteger(requirement.maximumPages) || requirement.targetPages > requirement.maximumPages)) {
    throw new TypeError('invalid_page_requirement');
  }
  if (requirement.mode === 'range' &&
      (!positiveInteger(requirement.minimumPages) || !positiveInteger(requirement.maximumPages) ||
       requirement.minimumPages > requirement.maximumPages || requirement.targetPages < requirement.minimumPages ||
       requirement.targetPages > requirement.maximumPages)) throw new TypeError('invalid_page_requirement');
  if ((requirement.mode === 'target' || requirement.mode === 'exact') &&
      (requirement.minimumPages !== undefined || requirement.maximumPages !== undefined)) {
    throw new TypeError('invalid_page_requirement');
  }
  if (requirement.mode === 'max' && requirement.minimumPages !== undefined) throw new TypeError('invalid_page_requirement');
  const extra = requirement.countBasis === 'content' ? presentationDocumentPageLimits.systemGeneratedPages : 0;
  const totals = [presentationPlanningTotalPages(requirement),
    ...(requirement.minimumPages === undefined ? [] : [requirement.minimumPages + extra]),
    ...(requirement.maximumPages === undefined ? [] : [requirement.maximumPages + extra])];
  if (totals.some(total => total < presentationDocumentPageLimits.minimumRequestedPages || total > presentationDocumentPageLimits.maximumPages)) {
    throw new TypeError('unsupported_page_requirement');
  }
}

export function assessPresentationPageCount(actualTotalPages: number, requirement: PresentationPageRequirement) {
  const actualPages = requirement.countBasis === 'content'
    ? Math.max(0, actualTotalPages - presentationDocumentPageLimits.systemGeneratedPages) : actualTotalPages;
  const satisfied = requirement.mode === 'max' ? actualPages <= requirement.maximumPages!
    : requirement.mode === 'range' ? actualPages >= requirement.minimumPages! && actualPages <= requirement.maximumPages!
      : actualPages === requirement.targetPages;
  return { actualPages, actualTotalPages, targetPages: requirement.targetPages,
    countBasis: requirement.countBasis, mode: requirement.mode,
    ...(requirement.minimumPages === undefined ? {} : { minimumPages: requirement.minimumPages }),
    ...(requirement.maximumPages === undefined ? {} : { maximumPages: requirement.maximumPages }),
    satisfied, blocking: !satisfied && requirement.mode !== 'target' } as const;
}
