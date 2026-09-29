import {
  parsePresentationDesignIR,
  type PresentationDesignIRPage,
  type ProductionPresentationDesignIR
} from '../../domain/entities/presentation-design-contract';
import {
  parsePresentationRenderPlan,
  type PresentationRenderPlan,
  type PresentationRenderPlanDiagnostic,
  type PresentationRenderPlanElement,
  type PresentationRenderPlanStyle
} from '../../domain/entities/presentation-render-plan';
import type { DocumentOutline, DocumentOutlineBlock } from '../../domain/entities/document-generation';
import { buildPresentationLayoutConstraintModel } from './presentation-page-features';
import { solvePresentationLayoutWithRepair, type PresentationLayoutPageResult, type PresentationLayoutRepairAction } from './presentation-layout-engine';
import type { PresentationTemplateTokens } from './presentation-template';
import type {
  PresentationDesignCompilationSnapshot as LegacyCompatibleSnapshot,
  PresentationDesignStrategy
} from './presentation-design-compiler';

export type PresentationDesignPath = 'design-aware' | 'legacy-fallback';
export type PresentationDesignStatus = 'validated' | 'invalid' | 'missing';

export interface PresentationDesignCompileDiagnostic {
  readonly code: string;
  readonly pageNumber?: number;
  readonly path?: string;
  readonly message?: string;
}

export interface PresentationDesignPageSummary {
  readonly pageNumber: number;
  readonly pageRole: PresentationDesignIRPage['pageRole'];
  readonly pageIntent: string;
  readonly composition?: PresentationLayoutPageResult['composition'];
  readonly selectedLayout?: PresentationLayoutPageResult['selectedLayout'];
  readonly elementCount: number;
  readonly density: PresentationLayoutPageResult['density'];
  readonly whitespace: PresentationLayoutPageResult['whitespace'];
  readonly primaryRegion?: PresentationLayoutPageResult['primaryRegion'];
  readonly geometrySignature?: string;
  readonly fallback: boolean;
}

/** Sanitized production observation; it intentionally contains no render-plan body text. */
export interface PresentationDesignCompilationSnapshot extends LegacyCompatibleSnapshot {
  readonly designPath: PresentationDesignPath;
  readonly fallbackReason?: string;
  readonly artDirectionStatus: PresentationDesignStatus;
  readonly designIrStatus: PresentationDesignStatus;
  readonly layoutStatus: 'success' | 'failed' | 'skipped';
  readonly renderPlanStatus: 'valid' | 'invalid' | 'skipped';
  readonly repairCount: number;
  readonly repairs: readonly { readonly attempt: number; readonly action: PresentationLayoutRepairAction; readonly pages: readonly number[] }[];
  readonly diagnostics: readonly PresentationDesignCompileDiagnostic[];
  readonly strategies: readonly { readonly pageNumber: number; readonly strategy: PresentationDesignStrategy | 'legacy-template' }[];
  readonly pages: readonly PresentationDesignPageSummary[];
}

export interface PresentationDesignCompilation {
  readonly designIR?: ProductionPresentationDesignIR;
  readonly plan?: PresentationRenderPlan;
  readonly constraints?: ReturnType<typeof buildPresentationLayoutConstraintModel>['constraints'];
  readonly features?: ReturnType<typeof buildPresentationLayoutConstraintModel>['features'];
  readonly layouts?: readonly PresentationLayoutPageResult[];
  readonly diagnostics: readonly PresentationDesignCompileDiagnostic[];
  readonly layoutStatus: 'success' | 'failed' | 'skipped';
  readonly renderPlanStatus: 'valid' | 'invalid' | 'skipped';
  readonly repairCount: number;
  readonly repairs?: readonly { readonly attempt: number; readonly action: PresentationLayoutRepairAction; readonly pages: readonly number[] }[];
}

export function compilePresentationRenderPlan(
  outline: DocumentOutline,
  candidate: unknown,
  tokens: PresentationTemplateTokens
): PresentationDesignCompilation {
  if (outline.kind !== 'ppt') return failed('invalid_outline', 'skipped', 'skipped');
  let designIR: ProductionPresentationDesignIR;
  try {
    designIR = parsePresentationDesignIR(candidate, {
      outline,
      expectedPageCount: outline.sections.length === 0 ? 1 : outline.sections.length + 2
    });
  } catch {
    return failed('invalid_design_ir', 'skipped', 'skipped');
  }
  if (designIR.pages.some(page => page.contentRoles.image.length > 0)) return failed('unsupported_content_type', 'failed', 'skipped', designIR);
  if (designIR.pages.some(page => page.composition.flow === 'radial' || page.composition.focalArea === 'full-bleed')) {
    return failed('unsupported_design_value', 'failed', 'skipped', designIR);
  }

  let model: ReturnType<typeof buildPresentationLayoutConstraintModel>;
  try {
    model = buildPresentationLayoutConstraintModel(outline, designIR, {
      themeTokens: {
        typography: { fontFamily: tokens.fontFamily ?? 'Microsoft YaHei', minimumFontSize: 14, maximumFontSize: 48, baseFontSize: 24 },
        spacing: { baseGap: 0.28, minimumGap: 0.12 },
        colors: {
          background: tokens.background, surface: tokens.surface, accent: tokens.accent,
          secondaryAccent: tokens.secondaryAccent, text: tokens.text, muted: tokens.muted
        }
      }
    });
  } catch {
    return failed('invalid_layout_constraints', 'failed', 'skipped', designIR);
  }
  const layout = solvePresentationLayoutWithRepair(model.features, model.constraints);
  if (layout.status !== 'success') {
    const diagnostics = layout.diagnostics.map(item => ({ code: item.code, pageNumber: item.pageNumber }));
    return { designIR, constraints: layout.constraints, features: model.features, layouts: layout.pages, diagnostics, layoutStatus: 'failed', renderPlanStatus: 'skipped', repairCount: layout.repairCount, repairs: layout.repairs };
  }

  let candidatePlan: PresentationRenderPlan;
  try {
    candidatePlan = buildRenderPlan(outline, designIR, model.features, layout.constraints, layout.pages, tokens);
  } catch {
    return {
      designIR, constraints: layout.constraints, features: model.features, layouts: layout.pages,
      diagnostics: [{ code: 'unresolved_content_reference' }], layoutStatus: 'success', renderPlanStatus: 'invalid', repairCount: layout.repairCount, repairs: layout.repairs
    };
  }
  const validSourceRefsByPage = model.features.map(page => ({
    pageNumber: page.pageNumber,
    sourceRefs: page.units.filter(unit => unit.sourceRef !== 'generated.page-number').map(unit => unit.sourceRef)
  }));
  try {
    const plan = parsePresentationRenderPlan(candidatePlan, {
      expectedPageCount: designIR.pages.length,
      minimumFontSize: layout.constraints.themeTokens.typography.minimumFontSize,
      validSourceRefsByPage
    });
    return {
      designIR, plan, constraints: layout.constraints, features: model.features, layouts: layout.pages,
      diagnostics: [], layoutStatus: 'success', renderPlanStatus: 'valid', repairCount: layout.repairCount, repairs: layout.repairs
    };
  } catch (error) {
    const diagnostics = error instanceof Error && 'diagnostics' in error
      ? (error as Error & { diagnostics: readonly PresentationRenderPlanDiagnostic[] }).diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message, pageNumber: pageNumberFromPath(item.path) }))
      : [{ code: 'invalid_render_plan' }];
    return {
      designIR, constraints: layout.constraints, features: model.features, layouts: layout.pages, diagnostics,
      layoutStatus: 'success', renderPlanStatus: 'invalid', repairCount: layout.repairCount, repairs: layout.repairs
    };
  }
}

export function buildPresentationDesignSnapshot(
  compilation: PresentationDesignCompilation | undefined,
  options: {
    readonly requested: boolean;
    readonly legacyPageCount: number;
    readonly designPath: PresentationDesignPath;
    readonly artDirectionStatus?: PresentationDesignStatus;
    readonly designIrStatus?: PresentationDesignStatus;
    readonly artDirectionDiagnostics?: readonly { readonly code: string }[];
    readonly fallbackReason?: string;
  }
): PresentationDesignCompilationSnapshot {
  const path = options.designPath;
  const designIR = compilation?.designIR;
  const layouts = new Map((compilation?.layouts ?? []).map(page => [page.pageNumber, page]));
  const pageCount = path === 'legacy-fallback'
    ? options.legacyPageCount
    : designIR?.pages.length ?? options.legacyPageCount;
  const pages = Array.from({ length: pageCount }, (_, index): PresentationDesignPageSummary => {
    const pageNumber = index + 1;
    const page = designIR?.pages.find(item => item.pageNumber === pageNumber);
    const layout = layouts.get(pageNumber);
    const constraint = compilation?.constraints?.pages.find(item => item.pageNumber === pageNumber);
    return {
      pageNumber,
      pageRole: path === 'legacy-fallback'
        ? (pageNumber === 1 ? 'hero' : pageNumber === pageCount ? 'closing' : 'content')
        : page?.pageRole ?? 'content',
      pageIntent: page?.pageIntent.slice(0, 600) ?? 'legacy template page',
      ...(layout ? { composition: layout.composition, selectedLayout: layout.selectedLayout, primaryRegion: layout.primaryRegion, geometrySignature: layout.geometrySignature } : {}),
      elementCount: layout?.placements.length ?? 0,
      density: constraint?.density ?? 'balanced',
      whitespace: constraint?.designIntent.whitespace ?? 'balanced',
      fallback: path === 'legacy-fallback'
    };
  });
  const diagnostics = [
    ...(options.artDirectionDiagnostics ?? []).slice(0, 40).map(({ code }) => ({ code })),
    ...(compilation?.diagnostics ?? [])
  ].slice(0, 40);
  const strategies = pages.map(page => ({
    pageNumber: page.pageNumber,
    strategy: path === 'design-aware' ? legacyStrategy(page.composition) : 'legacy-template' as const
  }));
  return {
    designPath: path,
    ...(options.fallbackReason ? { fallbackReason: options.fallbackReason.slice(0, 80) } : {}),
    ...(designIR ? { designIR } : {}),
    artDirectionStatus: options.artDirectionStatus ?? (options.requested ? (designIR ? 'validated' : compilation?.diagnostics.some(item => item.code === 'invalid_design_ir') ? 'invalid' : 'missing') : 'missing'),
    designIrStatus: options.designIrStatus ?? (designIR ? 'validated' : options.requested ? 'invalid' : 'missing'),
    layoutStatus: path === 'legacy-fallback' ? (compilation?.layoutStatus ?? 'skipped') : compilation?.layoutStatus ?? 'skipped',
    renderPlanStatus: path === 'legacy-fallback' ? (compilation?.renderPlanStatus ?? 'skipped') : compilation?.renderPlanStatus ?? 'skipped',
    repairCount: compilation?.repairCount ?? 0,
    repairs: compilation?.repairs ?? [],
    diagnostics,
    strategies,
    pages
  };
}

function legacyStrategy(composition: PresentationLayoutPageResult['composition'] | undefined): PresentationDesignStrategy {
  if (composition === 'evidence-led') return 'evidence';
  return composition ?? 'single-focus';
}

function buildRenderPlan(
  outline: DocumentOutline,
  design: ProductionPresentationDesignIR,
  features: ReturnType<typeof buildPresentationLayoutConstraintModel>['features'],
  constraints: ReturnType<typeof buildPresentationLayoutConstraintModel>['constraints'],
  layouts: readonly PresentationLayoutPageResult[],
  tokens: PresentationTemplateTokens
): PresentationRenderPlan {
  const pages = layouts.map(layout => {
    const designPage = design.pages.find(page => page.pageNumber === layout.pageNumber)!;
    const featurePage = features.find(page => page.pageNumber === layout.pageNumber)!;
    const constraintPage = constraints.pages.find(page => page.pageNumber === layout.pageNumber)!;
    const elements = layout.placements.map((placement): PresentationRenderPlanElement => {
      const unit = featurePage.units.find(item => item.sourceRef === placement.sourceRef);
      if (!unit) throw new TypeError('layout_source_unresolved');
      const content = placement.sourceRef === 'generated.page-number'
        ? { type: 'text' as const, text: String(layout.pageNumber) }
        : resolveContent(outline, placement.sourceRef);
      const source = placement.sourceRef === 'generated.page-number'
        ? { kind: 'generated' as const, key: 'page-number' as const }
        : { kind: 'outline' as const, ref: placement.sourceRef };
      const emphasized = placement.sourceRef === constraintPage.designIntent.emphasis.target;
      const color = renderColor(placement, design, tokens, emphasized);
      const style: PresentationRenderPlanStyle = {
        fontFamily: constraints.themeTokens.typography.fontFamily,
        fontSize: placement.fontSize,
        bold: placement.sourceRef !== 'generated.page-number' && (emphasized || placement.hierarchy === 'primary' || placement.role === 'title'),
        color,
        alignment: placement.alignment === 'start' ? 'left' : placement.alignment === 'end' ? 'right' : placement.alignment,
        verticalAlignment: placement.sourceRef === 'generated.page-number' || placement.hierarchy === 'primary' ? 'middle' : 'top',
        ...(content.type === 'table' ? { tableHeaderFill: tokens.surface, tableBodyFill: tokens.background, borderColor: tokens.muted } : {}),
        ...(content.type === 'chart' ? {
          chartColors: [tokens.accent, tokens.secondaryAccent, tokens.muted],
          mutedColor: tokens.muted,
          showLegend: content.chartKind === 'pie' && content.data.length <= 6,
          showValues: content.data.length <= 4 && designPage.density !== 'dense'
        } : {})
      };
      return {
        renderId: `p${layout.pageNumber}-e${placement.zIndex + 1}`,
        source,
        type: content.type,
        geometry: placement.geometry,
        style,
        content,
        zIndex: placement.zIndex
      };
    });
    return { pageNumber: layout.pageNumber, pageRole: designPage.pageRole, backgroundColor: tokens.background, elements };
  });
  return {
    schemaVersion: 1,
    canvas: constraints.canvas,
    minimumFontSize: constraints.themeTokens.typography.minimumFontSize,
    pages
  };
}

function resolveContent(outline: DocumentOutline, ref: string): PresentationRenderPlanElement['content'] {
  if (ref === 'outline.title') return { type: 'text', text: outline.title };
  const field = /^outline\.sections\[(\d+)\]\.(heading|takeaway|action)$/u.exec(ref);
  if (field) {
    const section = outline.sections[Number(field[1])];
    const text = section?.[field[2] as 'heading' | 'takeaway' | 'action'];
    if (typeof text === 'string') return { type: 'text', text };
  }
  const blockRef = /^outline\.sections\[(\d+)\]\.blocks\[(\d+)\](?:\.items\[(\d+)\])?$/u.exec(ref);
  if (!blockRef) throw new TypeError('layout_source_unresolved');
  const block: DocumentOutlineBlock | undefined = outline.sections[Number(blockRef[1])]?.blocks[Number(blockRef[2])];
  if (!block) throw new TypeError('layout_source_unresolved');
  if (blockRef[3] !== undefined) {
    const items = block.type === 'bullets' || block.type === 'numbered' ? block.items : undefined;
    const text = items?.[Number(blockRef[3])];
    if (typeof text !== 'string') throw new TypeError('layout_source_unresolved');
    return { type: 'text', text };
  }
  if (block.type === 'paragraph' || block.type === 'quote') return { type: 'text', text: block.text };
  if (block.type === 'table') return { type: 'table', header: [...block.header], rows: block.rows.map(row => [...row]) };
  if (block.type === 'chart') return { type: 'chart', chartKind: block.chartKind, ...(block.title ? { title: block.title } : {}), data: block.data.map(point => ({ ...point })) };
  throw new TypeError('layout_source_unresolved');
}

function renderColor(
  placement: PresentationLayoutPageResult['placements'][number],
  design: ProductionPresentationDesignIR,
  tokens: PresentationTemplateTokens,
  emphasized: boolean
): string {
  const direction = design.globalDesign.colorDirection;
  if (emphasized && direction !== 'monochrome' && direction !== 'neutral') return tokens.accent;
  if (placement.hierarchy === 'supporting' && direction === 'restrained') return tokens.muted;
  return tokens.text;
}

function failed(
  code: string,
  layoutStatus: PresentationDesignCompilation['layoutStatus'],
  renderPlanStatus: PresentationDesignCompilation['renderPlanStatus'],
  designIR?: ProductionPresentationDesignIR
): PresentationDesignCompilation {
  return { ...(designIR ? { designIR } : {}), diagnostics: [{ code }], layoutStatus, renderPlanStatus, repairCount: 0 };
}

function pageNumberFromPath(path: string): number | undefined {
  const match = /^\$\.pages\[(\d+)\]/u.exec(path);
  return match ? Number(match[1]) + 1 : undefined;
}
