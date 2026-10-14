import { planPresentationArtDirection, type PresentationArtDirectionResult } from '../../application/presentation-art-direction';
import type { ProductionPresentationDesignIR } from '../../domain/entities/presentation-design-contract';
import { compilePresentationRenderPlan } from './presentation-render-plan-compiler';
import type { PresentationTemplateTokens } from './presentation-template';
import type { PresentationRenderAsset } from './presentation-render-assets';

/** Initial design plus at most two targeted corrections under the existing total Host budget. */
export async function planExecutablePresentationDesign(options: Parameters<typeof planPresentationArtDirection>[0] & {
  readonly tokens: PresentationTemplateTokens;
  readonly assets: readonly PresentationRenderAsset[];
  readonly onRepair?: (attempt: number, targetPages: readonly number[]) => void | Promise<void>;
}): Promise<PresentationArtDirectionResult> {
  let result = await planPresentationArtDirection(options);
  for (let attempt = 0; result.designIR?.pages.some(page => page.designTree); attempt += 1) {
    options.signal.throwIfAborted(); options.executionBudget?.assertCanProceed('design');
    const compilation = compilePresentationRenderPlan(options.outline, result.designIR, options.tokens, { assets: options.assets });
    if (compilation.renderPlanStatus === 'valid') return { ...result, correctionCount: attempt };
    if (attempt >= 2 || !options.request) return { input: result.input, diagnostics: [{ code: 'design_execution_failed' }, ...compilation.diagnostics.map(({ code }) => ({ code }))] };
    const targets = [...new Set(compilation.diagnostics.map(item => item.pageNumber).filter((page): page is number => page !== undefined))];
    const targetPages = targets.length ? targets : result.designIR.pages.filter(page => page.designTree).map(page => page.pageNumber);
    await options.onRepair?.(attempt + 1, targetPages);
    result = await requestPresentationDesignCorrection({ ...options, previousDesign: result.designIR, targetPages,
      diagnostics: compilation.diagnostics.slice(0, 96).map(item => ({ code: item.code, pageNumber: item.pageNumber ?? targetPages[0],
        ...(item.nodeId ? { nodeId: item.nodeId } : {}) })) });
    if (!result.designIR) return result;
  }
  return result;
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
