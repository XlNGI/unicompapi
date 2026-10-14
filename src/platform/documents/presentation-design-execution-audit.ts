import type { ProductionPresentationDesignIR } from '../../domain/entities/presentation-design-contract';
import { flattenPresentationDesignTree } from '../../domain/entities/presentation-design-tree';
import type { PresentationRenderPlan } from '../../domain/entities/presentation-render-plan';
import { canonicalizeLayoutJson } from '../../domain/entities/presentation-layout-ir';

export interface PresentationDesignExecutionAudit {
  readonly status: 'passed';
  readonly authoredPageCount: number;
  readonly nodeCount: number;
  readonly verifiedElementCount: number;
}
/** Verify the final persisted projection against the solved authored design before writing. */
export function auditPresentationDesignExecution(design: ProductionPresentationDesignIR, solved: PresentationRenderPlan,
  projected: PresentationRenderPlan): PresentationDesignExecutionAudit | undefined {
  const authored = design.pages.filter(page => page.designTree);
  if (!authored.length) return undefined;
  let verifiedElementCount = 0;
  for (const page of authored) {
    const expected = solved.pages.find(item => item.pageNumber === page.pageNumber);
    const actual = projected.pages.find(item => item.pageNumber === page.pageNumber);
    if (!expected || !actual || expected.backgroundColor !== actual.backgroundColor || expected.elements.length !== actual.elements.length) throw new TypeError('design_execution_mismatch');
    const actualByOrder = new Map(actual.elements.map(element => [element.zIndex, element]));
    for (const element of expected.elements) {
      const implemented = actualByOrder.get(element.zIndex);
      const comparable = (element: PresentationRenderPlan['pages'][number]['elements'][number]) => canonicalizeLayoutJson({
        type: element.type, geometry: element.geometry, style: element.style, content: element.content
      });
      if (!implemented || JSON.stringify(comparable(element)) !== JSON.stringify(comparable(implemented))) throw new TypeError('design_execution_mismatch');
      verifiedElementCount += 1;
    }
  }
  return { status: 'passed', authoredPageCount: authored.length,
    nodeCount: authored.reduce((sum, page) => sum + flattenPresentationDesignTree(page.designTree!).length, 0), verifiedElementCount };
}
