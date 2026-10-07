import type { DocumentContentSnapshotV1 } from '../../domain/entities/document-content-snapshot';
import type { DocumentOutline } from '../../domain/entities/document-generation';
import type { ProductionPresentationDesignIR } from '../../domain/entities/presentation-design-contract';
import type { ProductionPresentationLayoutIR } from '../../domain/entities/presentation-layout-ir';
import type { PresentationRenderPlan } from '../../domain/entities/presentation-render-plan';
import type { PresentationDesignCompilationSnapshot } from './presentation-render-plan-compiler';

/** Private Host plan. The persistent writer must succeed before producing a candidate artifact. */
export interface PresentationProductionPlan {
  readonly contentSnapshot: DocumentContentSnapshotV1;
  readonly outline: DocumentOutline;
  readonly designIR?: ProductionPresentationDesignIR;
  readonly layoutIR?: ProductionPresentationLayoutIR;
  readonly renderPlan?: PresentationRenderPlan;
  readonly snapshot: PresentationDesignCompilationSnapshot;
}

export type PresentationPlanPrepared = (plan: PresentationProductionPlan) => void | Promise<void>;
