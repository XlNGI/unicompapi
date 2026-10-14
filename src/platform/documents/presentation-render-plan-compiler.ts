import {
  parsePresentationDesignIR,
  type PresentationDesignIRPage,
  type ProductionPresentationDesignIR
} from '../../domain/entities/presentation-design-contract';
import {
  parsePresentationRenderPlan,
  type PresentationRenderPlan,
  type PresentationRenderPlanDiagnostic,
  type PresentationRenderPlanElement
} from '../../domain/entities/presentation-render-plan';
import type { DocumentOutline } from '../../domain/entities/document-generation';
import { buildDocumentContentSnapshot, parseDocumentContentSnapshot, documentContentSnapshotToOutline,
  documentContentReferenceIndex, type DocumentContentSnapshotV1, type DocumentContentResolvedRef } from '../../domain/entities/document-content-snapshot';
import type { ProductionPresentationLayoutIR } from '../../domain/entities/presentation-layout-ir';
import { canonicalizeLayoutJson } from '../../domain/entities/presentation-layout-ir';
import { buildProductionPresentationLayoutIR, derivePresentationRenderPlanFromLayoutIR,
  parseVerifiedProductionPresentationLayoutIR, computePresentationLayoutDigest } from './presentation-layout-ir-adapter';
import { buildPresentationLayoutConstraintModel } from './presentation-page-features';
import { solvePresentationLayoutWithRepair, type PresentationLayoutPageResult, type PresentationLayoutRepairAction } from './presentation-layout-engine';
import type { PresentationTemplateTokens } from './presentation-template';
import { compilePresentationElementStyle, resolvePresentationPageStyle } from './presentation-style-compiler';
import { auditPresentationRenderPlan, type PresentationVisualAudit } from './presentation-visual-audit';
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
  readonly visualAudit?: PresentationVisualAudit;
}

export interface PresentationDesignCompilation {
  readonly contentSnapshot?: DocumentContentSnapshotV1;
  readonly layoutIR?: ProductionPresentationLayoutIR;
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
  readonly visualAudit?: PresentationVisualAudit;
}

export function compilePresentationRenderPlan(
  outline: DocumentOutline,
  candidate: unknown,
  tokens: PresentationTemplateTokens,
  options: { readonly contentSnapshot?: DocumentContentSnapshotV1;
    readonly visualRevision?: { readonly previousLayoutIR: ProductionPresentationLayoutIR;
      readonly previousDesignIR: ProductionPresentationDesignIR; readonly targetPageNumbers: readonly number[] } } = {}
): PresentationDesignCompilation {
  if (outline.kind !== 'ppt') return failed('invalid_outline', 'skipped', 'skipped');
  let contentSnapshot: DocumentContentSnapshotV1;
  try {
    contentSnapshot = options.contentSnapshot ? parseDocumentContentSnapshot(options.contentSnapshot) : buildDocumentContentSnapshot({ outline });
    const projection = documentContentSnapshotToOutline(contentSnapshot);
    if (JSON.stringify(canonicalizeLayoutJson(outline)) !== JSON.stringify(canonicalizeLayoutJson(projection))) {
      return failed('content_snapshot_conflict', 'skipped', 'skipped');
    }
    outline = projection;
  } catch { return failed('invalid_content_snapshot', 'skipped', 'skipped'); }
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
  } catch (error) {
    return failed(error instanceof TypeError && error.message.startsWith('content_organization_')
      ? 'invalid_content_organization' : 'invalid_layout_constraints', 'failed', 'skipped', designIR);
  }
  if (designIR.pages.some((page, index) => (page.visualTreatment?.component === 'nodes' || page.visualTreatment?.component === 'track') &&
    (page.pageRole !== 'process' || model.features[index].contentOrganization?.layout !== 'sequence'))) {
    return failed('unsupported_visual_component', 'failed', 'skipped', designIR);
  }
  const layout = solvePresentationLayoutWithRepair(model.features, model.constraints);
  if (layout.status !== 'success') {
    const diagnostics = layout.diagnostics.map(item => ({ code: item.code, pageNumber: item.pageNumber }));
    return { designIR, constraints: layout.constraints, features: model.features, layouts: layout.pages, diagnostics, layoutStatus: 'failed', renderPlanStatus: 'skipped', repairCount: layout.repairCount, repairs: layout.repairs };
  }

  let candidatePlan: PresentationRenderPlan;
  try {
    candidatePlan = buildRenderPlan(contentSnapshot, designIR, model.features, layout.constraints, layout.pages, tokens);
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
    const solved = parsePresentationRenderPlan(candidatePlan, {
      expectedPageCount: designIR.pages.length,
      minimumFontSize: layout.constraints.themeTokens.typography.minimumFontSize,
      validSourceRefsByPage
    });
    let layoutIR = buildProductionPresentationLayoutIR({ renderPlan: solved, content: contentSnapshot, design: designIR,
      repairs: layout.repairs, diagnostics: layout.diagnostics,
      organizations: layout.pages.flatMap(page => page.contentOrganization ? [{ pageNumber: page.pageNumber, organization: page.contentOrganization }] : []) });
    if (options.visualRevision) {
      const { previousLayoutIR, previousDesignIR, targetPageNumbers } = options.visualRevision;
      const prior = parseVerifiedProductionPresentationLayoutIR(previousLayoutIR, { content: contentSnapshot, design: previousDesignIR });
      const targets = new Set(targetPageNumbers);
      if (!targets.size || targets.size !== targetPageNumbers.length || [...targets].some(page => !Number.isSafeInteger(page) || page < 1 || page > designIR.pages.length) ||
        (targets.size !== designIR.pages.length && JSON.stringify(designIR.globalDesign) !== JSON.stringify(previousDesignIR.globalDesign)) ||
        designIR.pages.some(page => !targets.has(page.pageNumber) && JSON.stringify(canonicalizeLayoutJson(page)) !==
          JSON.stringify(canonicalizeLayoutJson(previousDesignIR.pages[page.pageNumber - 1])))) throw new TypeError('layout_visual_revision_scope_invalid');
      layoutIR = { ...layoutIR, pages: layoutIR.pages.map(page => targets.has(page.pageNumber) ? page : prior.pages[page.pageNumber - 1]) };
      layoutIR = { ...layoutIR, identity: { ...layoutIR.identity, layoutDigest: computePresentationLayoutDigest(layoutIR) } };
      layoutIR = parseVerifiedProductionPresentationLayoutIR(layoutIR, { content: contentSnapshot, design: designIR });
    }
    const plan = derivePresentationRenderPlanFromLayoutIR(layoutIR, contentSnapshot);
    const visualAudit = auditPresentationRenderPlan(plan);
    return {
      contentSnapshot, designIR, layoutIR, plan, constraints: layout.constraints, features: model.features, layouts: layout.pages,
      diagnostics: [], visualAudit, layoutStatus: 'success', renderPlanStatus: 'valid', repairCount: layout.repairCount, repairs: layout.repairs
    };
  } catch (error) {
    const diagnostics = error instanceof Error && 'diagnostics' in error
      ? (error as Error & { diagnostics: readonly PresentationRenderPlanDiagnostic[] }).diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message, pageNumber: pageNumberFromPath(item.path) }))
      : [{ code: error instanceof TypeError && /^(?:layout|content|invalid)_[a-z0-9_]{1,70}$/u.test(error.message)
        ? error.message : 'invalid_render_plan' }];
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
    ...(compilation?.visualAudit ? { visualAudit: compilation.visualAudit } : {}),
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
  content: DocumentContentSnapshotV1,
  design: ProductionPresentationDesignIR,
  features: ReturnType<typeof buildPresentationLayoutConstraintModel>['features'],
  constraints: ReturnType<typeof buildPresentationLayoutConstraintModel>['constraints'],
  layouts: readonly PresentationLayoutPageResult[],
  tokens: PresentationTemplateTokens
): PresentationRenderPlan {
  const references = documentContentReferenceIndex(content);
  const pages = layouts.map(layout => {
    const designPage = design.pages.find(page => page.pageNumber === layout.pageNumber)!;
    const featurePage = features.find(page => page.pageNumber === layout.pageNumber)!;
    const pageStyle = resolvePresentationPageStyle({ design: design.globalDesign, page: designPage,
      tokens: { ...tokens, fontFamily: constraints.themeTokens.typography.fontFamily } });
    const elements = layout.placements.map((placement): PresentationRenderPlanElement => {
      const unit = featurePage.units.find(item => item.sourceRef === placement.sourceRef);
      if (!unit) throw new TypeError('layout_source_unresolved');
      const content = placement.sourceRef === 'generated.page-number'
        ? { type: 'text' as const, text: String(layout.pageNumber) }
        : resolveContent(references, placement.sourceRef);
      const source = placement.sourceRef === 'generated.page-number'
        ? { kind: 'generated' as const, key: 'page-number' as const }
        : { kind: 'outline' as const, ref: placement.sourceRef };
      const style = {
        ...compilePresentationElementStyle({ pageStyle, contentType: content.type, sourceRef: placement.sourceRef,
          generated: placement.sourceRef === 'generated.page-number', hierarchy: placement.hierarchy,
          role: placement.role, fontSize: placement.fontSize,
          alignment: placement.alignment === 'start' ? 'left' : placement.alignment === 'end' ? 'right' : placement.alignment,
          verticalAlignment: placement.sourceRef === 'generated.page-number' || placement.hierarchy === 'primary' ? 'middle' : 'top' }),
        ...(content.type === 'chart' ? {
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
    const decorations = [
      ...buildSequenceDecorations(layout, pageStyle, designPage.visualTreatment?.component),
      ...buildPageDecorations(layout, pageStyle, designPage, constraints.canvas)
    ].map((element, zIndex) => ({ ...element, zIndex }));
    return { pageNumber: layout.pageNumber, pageRole: designPage.pageRole, backgroundColor: pageStyle.backgroundColor,
      elements: [...decorations, ...elements.map(element => ({ ...element, zIndex: element.zIndex + decorations.length }))] };
  });
  return {
    schemaVersion: 1,
    canvas: constraints.canvas,
    minimumFontSize: constraints.themeTokens.typography.minimumFontSize,
    pages
  };
}

/** Explicit accents/frame are primitives around solved content, never alternate page templates. */
function buildPageDecorations(layout: PresentationLayoutPageResult, pageStyle: ReturnType<typeof resolvePresentationPageStyle>,
  designPage: PresentationDesignIRPage, canvas: PresentationRenderPlan['canvas']): PresentationRenderPlanElement[] {
  const treatment = designPage.visualTreatment;
  if (!treatment) return [];
  const content = layout.placements.filter(item => item.sourceRef !== 'generated.page-number');
  const focus = content.find(item => item.sourceRef === designPage.emphasis.target) ?? content.find(item => item.role === 'title') ?? content[0];
  if (!focus) return [];
  const style = { fontFamily: pageStyle.fontFamily, fontSize: 1, bold: false, color: pageStyle.accentColor,
    alignment: 'left' as const, verticalAlignment: 'middle' as const };
  const result: PresentationRenderPlanElement[] = [];
  if (treatment.accent !== 'none') {
    const box = focus.geometry;
    const rule = treatment.accent === 'rule'
      ? { x: box.x, y: Math.min(canvas.height - 0.025, box.y + box.height + 0.04), width: Math.min(0.9, box.width), height: 0.025 }
      : { x: Math.max(0, box.x - 0.10), y: box.y, width: 0.025, height: box.height };
    result.push({ renderId: `p${layout.pageNumber}-dec-accent`, source: { kind: 'generated', key: 'decoration-line' },
      type: 'shape', geometry: rule, style, content: { type: 'shape', shapeKind: 'line' }, zIndex: 0 });
  }
  if (treatment.component === 'frame') {
    const x = Math.max(0, Math.min(...content.map(item => item.geometry.x)) - 0.12);
    const y = Math.max(0, Math.min(...content.map(item => item.geometry.y)) - 0.12);
    const right = Math.min(canvas.width, Math.max(...content.map(item => item.geometry.x + item.geometry.width)) + 0.12);
    const bottom = Math.min(canvas.height, Math.max(...content.map(item => item.geometry.y + item.geometry.height)) + 0.12);
    result.push({ renderId: `p${layout.pageNumber}-dec-frame`, source: { kind: 'generated', key: 'decoration-frame' }, type: 'shape',
      geometry: { x, y, width: right - x, height: bottom - y }, style,
      content: { type: 'shape', shapeKind: 'roundRect' }, zIndex: result.length });
  }
  return result;
}

/** Process pages get explicit, persisted track/node primitives when the semantic organization is a sequence. */
function buildSequenceDecorations(
  layout: PresentationLayoutPageResult,
  pageStyle: ReturnType<typeof resolvePresentationPageStyle>,
  component: 'none' | 'nodes' | 'track' | 'frame' | undefined
): PresentationRenderPlanElement[] {
  if (layout.pageRole !== 'process' || layout.composition !== 'sequence' || layout.contentOrganization?.layout !== 'sequence' || component === 'none' || component === 'frame') return [];
  const steps = layout.contentOrganization.groups.filter(group => group.role === 'step').flatMap(group => {
    const members = layout.placements.filter(item => group.sourceRefs.includes(item.sourceRef));
    if (!members.length) return [];
    const x = Math.min(...members.map(item => item.geometry.x)), y = Math.min(...members.map(item => item.geometry.y));
    return [{ x, y, width: Math.max(...members.map(item => item.geometry.x + item.geometry.width)) - x,
      height: Math.max(...members.map(item => item.geometry.y + item.geometry.height)) - y }];
  });
  if (steps.length < 2 || steps.length > 14) return [];
  const vertical = Math.max(...steps.map(step => step.y)) - Math.min(...steps.map(step => step.y)) >
    Math.max(...steps.map(step => step.x)) - Math.min(...steps.map(step => step.x));
  steps.sort((left, right) => vertical ? left.y - right.y : left.x - right.x);
  const edge = vertical ? Math.max(0.12, Math.min(...steps.map(step => step.x)) - 0.24)
    : Math.max(0.28, Math.min(...steps.map(step => step.y)) - 0.24);
  const centers = steps.map(step => vertical ? step.y + step.height / 2 : step.x + step.width / 2);
  const style = {
    fontFamily: pageStyle.fontFamily, fontSize: 1, bold: false, color: pageStyle.accentColor,
    alignment: 'center' as const, verticalAlignment: 'middle' as const
  };
  const elements: PresentationRenderPlanElement[] = [];
  if (component === undefined || component === 'nodes' || component === 'track') centers.forEach((center, index) => elements.push({ renderId: `p${layout.pageNumber}-dec-node-${index + 1}`,
    source: { kind: 'generated', key: 'decoration-node' }, type: 'shape', geometry: { x: vertical ? edge : center - 0.10,
      y: vertical ? center - 0.10 : edge, width: 0.20, height: 0.20 }, style,
    content: { type: 'shape', shapeKind: 'ellipse' }, zIndex: index }));
  if (component === 'nodes') return elements;
  centers.slice(0, -1).forEach((center, index) => {
    const next = centers[index + 1]!;
    elements.push({ renderId: `p${layout.pageNumber}-dec-line-${index + 1}`, source: { kind: 'generated', key: 'decoration-line' }, type: 'shape',
      geometry: { x: vertical ? edge + 0.087 : center + 0.10, y: vertical ? center + 0.10 : edge + 0.087,
        width: vertical ? 0.025 : Math.max(0.02, next - center - 0.20), height: vertical ? Math.max(0.02, next - center - 0.20) : 0.025 }, style,
      content: { type: 'shape', shapeKind: 'line' }, zIndex: centers.length + index });
  });
  return elements;
}

function resolveContent(references: Readonly<Record<string, DocumentContentResolvedRef>>, ref: string): Exclude<PresentationRenderPlanElement['content'], { readonly type: 'shape' }> {
  const resolved = references[ref];
  if (resolved?.text !== undefined) return { type: 'text', text: resolved.text };
  const block = resolved?.payload;
  if (!block) throw new TypeError('layout_source_unresolved');
  if (block.type === 'paragraph' || block.type === 'quote') return { type: 'text', text: block.text };
  if (block.type === 'table') return { type: 'table', header: [...block.header], rows: block.rows.map(row => [...row]) };
  if (block.type === 'chart') return { type: 'chart', chartKind: block.chartKind, ...(block.title ? { title: block.title } : {}), data: block.data.map(point => ({ ...point })) };
  throw new TypeError('layout_source_unresolved');
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
