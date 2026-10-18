import { planPresentationArtDirection, type PresentationArtDirectionResult } from '../../application/presentation-art-direction';
import type { ProductionPresentationDesignIR } from '../../domain/entities/presentation-design-contract';
import { compilePresentationRenderPlan } from './presentation-render-plan-compiler';
import type { PresentationTemplateTokens } from './presentation-template';
import type { PresentationRenderAsset } from './presentation-render-assets';

const repairablePlanningCodes = new Set(['invalid_json', 'invalid_shape', 'unknown_field', 'invalid_enum', 'invalid_page_number',
  'duplicate_page', 'missing_page', 'invalid_content_reference', 'text_too_long', 'page_count_mismatch', 'invalid_design_tree',
  'design_tree_missing', 'invalid_content_organization']);

/** Initial design plus at most two targeted corrections under the existing total Host budget. */
export async function planExecutablePresentationDesign(options: Parameters<typeof planPresentationArtDirection>[0] & {
  readonly tokens: PresentationTemplateTokens;
  readonly assets: readonly PresentationRenderAsset[];
  readonly onRepair?: (attempt: number, targetPages: readonly number[]) => void | Promise<void>;
}): Promise<PresentationArtDirectionResult> {
  let result = await planPresentationArtDirection(options);
  let corrections = 0;
  while (true) {
    options.signal.throwIfAborted(); options.executionBudget?.assertCanProceed('design');
    const previous = result.designIR;
    const compilation = previous?.pages.some(page => page.designTree)
      ? compilePresentationRenderPlan(options.outline, previous, options.tokens, { assets: options.assets }) : undefined;
    if (previous && (!compilation || compilation.renderPlanStatus === 'valid')) return { ...result, correctionCount: corrections };
    if (corrections >= 2 || !options.request) return { input: result.input, correctionCount: corrections, ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
      diagnostics: compilation ? [{ code: 'design_execution_failed' }, ...compilation.diagnostics.map(({ code }) => ({ code }))] : result.diagnostics };
    if (!previous && (!result.diagnostics.length || result.diagnostics.some(item => !repairablePlanningCodes.has(item.code)))) {
      return { ...result, correctionCount: corrections };
    }
    const errors = compilation?.diagnostics ?? [];
    const targets = [...new Set(errors.map(item => item.pageNumber).filter((page): page is number => page !== undefined))];
    const targetPages = targets.length ? targets : previous?.pages.map(page => page.pageNumber) ?? result.input?.outline.pages.map(page => page.pageNumber) ?? [];
    corrections += 1;
    await options.onRepair?.(corrections, targetPages);
    result = previous ? await requestPresentationDesignCorrection({ ...options, previousDesign: previous, targetPages,
      diagnostics: errors.slice(0, 96).map(item => ({ code: item.code, pageNumber: item.pageNumber ?? targetPages[0],
        ...(item.nodeId ? { nodeId: item.nodeId } : {}) })) })
      : await planPresentationArtDirection({ ...options, planningDiagnostics: result.diagnostics.slice(0, 40).map(item => item.code) });
  }
}

export async function requestPresentationDesignCorrection(options: Parameters<typeof planPresentationArtDirection>[0] & {
  readonly previousDesign: ProductionPresentationDesignIR;
  readonly targetPages: readonly number[];
  readonly diagnostics: NonNullable<Parameters<typeof planPresentationArtDirection>[0]['designFeedback']>['diagnostics'];
}): Promise<PresentationArtDirectionResult> {
  options.executionBudget?.assertCanProceed('repair');
  return planPresentationArtDirection({ ...options, designFeedback: { previousDesign: options.previousDesign,
    targetPages: options.targetPages, diagnostics: options.diagnostics }, requireDesignTree: true });
}
