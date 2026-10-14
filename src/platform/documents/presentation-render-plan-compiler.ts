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
import type { PresentationRenderAsset } from './presentation-render-assets';
import type { PresentationNodeStyle } from '../../domain/entities/presentation-design-tree';
import type { PresentationRenderPlanStyle } from '../../domain/entities/presentation-render-plan';
import { buildDocumentContentSnapshot, parseDocumentContentSnapshot, documentContentSnapshotToOutline,
  documentContentReferenceIndex, type DocumentContentSnapshotV1, type DocumentContentResolvedRef } from '../../domain/entities/document-content-snapshot';
import type { ProductionPresentationLayoutIR } from '../../domain/entities/presentation-layout-ir';
import { canonicalizeLayoutJson } from '../../domain/entities/presentation-layout-ir';
import { buildProductionPresentationLayoutIR, derivePresentationRenderPlanFromLayoutIR } from './presentation-layout-ir-adapter';
import { buildPresentationLayoutConstraintModel } from './presentation-page-features';
import { solvePresentationLayoutWithRepair, type PresentationLayoutPageResult, type PresentationLayoutRepairAction } from './presentation-layout-engine';
import type { PresentationTemplateTokens } from './presentation-template';
import { compilePresentationElementStyle, resolvePresentationPageStyle } from './presentation-style-compiler';
import { auditPresentationRenderPlan, type PresentationVisualAudit } from './presentation-visual-audit';
import { auditPresentationDesignExecution, type PresentationDesignExecutionAudit } from './presentation-design-execution-audit';
import type {
  PresentationDesignCompilationSnapshot as LegacyCompatibleSnapshot,
  PresentationDesignStrategy
} from './presentation-design-compiler';

export type PresentationDesignPath = 'design-aware' | 'legacy-fallback';
export type PresentationDesignStatus = 'validated' | 'invalid' | 'missing';

export interface PresentationDesignCompileDiagnostic {
  readonly nodeId?: string;
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
  readonly designExecution?: PresentationDesignExecutionAudit;
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
  readonly designExecution?: PresentationDesignExecutionAudit;
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
  options: { readonly contentSnapshot?: DocumentContentSnapshotV1; readonly assets?: readonly PresentationRenderAsset[] } = {}
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
  if (designIR.pages.some(page => !page.designTree && page.contentRoles.image.length > 0)) return failed('unsupported_content_type', 'failed', 'skipped', designIR);
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
  const layout = solvePresentationLayoutWithRepair(model.features, model.constraints);
  if (layout.status !== 'success') {
    const diagnostics = layout.diagnostics.map(item => ({ code: item.code, pageNumber: item.pageNumber, ...(item.nodeId ? { nodeId: item.nodeId } : {}) }));
    return { designIR, constraints: layout.constraints, features: model.features, layouts: layout.pages, diagnostics, layoutStatus: 'failed', renderPlanStatus: 'skipped', repairCount: layout.repairCount, repairs: layout.repairs };
  }

  let candidatePlan: PresentationRenderPlan;
  try {
    candidatePlan = buildRenderPlan(contentSnapshot, designIR, model.features, layout.constraints, layout.pages, tokens, options.assets ?? []);
  } catch (error) {
    return {
      designIR, constraints: layout.constraints, features: model.features, layouts: layout.pages,
      diagnostics: [{ code: error instanceof TypeError && /^design_[a-z0-9_]+$/u.test(error.message) ? error.message : 'unresolved_content_reference' }], layoutStatus: 'success', renderPlanStatus: 'invalid', repairCount: layout.repairCount, repairs: layout.repairs
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
    const layoutIR = buildProductionPresentationLayoutIR({ renderPlan: solved, content: contentSnapshot, design: designIR,
      repairs: layout.repairs, diagnostics: layout.diagnostics,
      organizations: layout.pages.flatMap(page => page.contentOrganization ? [{ pageNumber: page.pageNumber, organization: page.contentOrganization }] : []) });
    const plan = derivePresentationRenderPlanFromLayoutIR(layoutIR, contentSnapshot);
    const designExecution = auditPresentationDesignExecution(designIR, solved, plan);
    const visualAudit = auditPresentationRenderPlan(plan);
    return {
      contentSnapshot, designIR, layoutIR, plan, constraints: layout.constraints, features: model.features, layouts: layout.pages,
      diagnostics: [], visualAudit, ...(designExecution ? { designExecution } : {}), layoutStatus: 'success', renderPlanStatus: 'valid', repairCount: layout.repairCount, repairs: layout.repairs
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
    ...(compilation?.designExecution ? { designExecution: compilation.designExecution } : {}),
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
  tokens: PresentationTemplateTokens,
  assets: readonly PresentationRenderAsset[]
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
      if (placement.designStyle && content.type !== 'text' &&
        (placement.designStyle.lineSpacing !== undefined || placement.designStyle.charSpacing !== undefined ||
          content.type === 'chart' && (placement.designStyle.fontWeight !== undefined || placement.designStyle.alignment !== undefined || placement.designStyle.verticalAlignment !== undefined || placement.designStyle.borderColor !== undefined || placement.designStyle.borderWidth !== undefined))) {
        throw new TypeError('design_style_unsupported');
      }
      if (content.type !== 'chart' && placement.designStyle && ['chartKind', 'chartColors', 'showLegend', 'showValues'].some(key => key in placement.designStyle!)) throw new TypeError('design_style_unsupported');
      const style = {
        ...compilePresentationElementStyle({ pageStyle, contentType: content.type === 'image' ? 'text' : content.type, sourceRef: placement.sourceRef,
          generated: placement.sourceRef === 'generated.page-number', hierarchy: placement.hierarchy,
          role: placement.role, fontSize: placement.fontSize,
          alignment: placement.alignment === 'start' ? 'left' : placement.alignment === 'end' ? 'right' : placement.alignment,
          verticalAlignment: placement.sourceRef === 'generated.page-number' || placement.hierarchy === 'primary' ? 'middle' : 'top' }),
        ...(designPage.designTree && content.type === 'text' && placement.sourceRef !== 'generated.page-number'
          ? { fill: undefined, borderColor: undefined, borderWidth: undefined, bold: false, fontWeight: design.globalDesign.visualSystem?.typography?.bodyWeight ?? 400,
              color: design.globalDesign.visualSystem?.palette?.text ?? pageStyle.textColor, verticalAlignment: 'top' as const } : {}),
        ...(content.type === 'chart' ? {
          showLegend: content.chartKind === 'pie' && content.data.length <= 6,
          showValues: content.data.length <= 4 && designPage.density !== 'dense'
        } : {}),
        ...compileAuthoredStyle(placement.designStyle),
        ...(content.type === 'table' && placement.designStyle?.fill ? { tableBodyFill: placement.designStyle.fill, tableHeaderFill: placement.designStyle.fill } : {}),
        ...(content.type === 'table' && placement.designStyle?.color ? { tableHeaderColor: placement.designStyle.color } : {}),
        ...(placement.textSpans ? { textSpans: placement.textSpans } : {})
      };
      if (placement.textSpans && (content.type !== 'text' || placement.textSpans.some(span => span.end > content.text.length))) throw new TypeError('design_text_span_invalid');
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
    const decorations = (layout.authoredNodes ? buildAuthoredDecorations(layout, pageStyle, assets)
      : [...buildSequenceDecorations(layout, pageStyle, designPage.visualTreatment?.component),
        ...(designPage.visualTreatment ? buildTreatmentDecorations(layout, pageStyle, constraints.canvas) : [])])
      .map((element, zIndex) => ({ ...element, zIndex }));
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

function compileAuthoredStyle(style?: PresentationNodeStyle): Partial<PresentationRenderPlanStyle> {
  if (!style) return {};
  const { lineSpacing, ...paint } = style;
  delete paint.fontSize;
  return { ...paint, ...(lineSpacing === undefined ? {} : { lineSpacingMultiple: lineSpacing }),
    ...(style.fontWeight === undefined ? {} : { bold: style.fontWeight === 700 }) };
}
function buildAuthoredDecorations(layout: PresentationLayoutPageResult,
  pageStyle: ReturnType<typeof resolvePresentationPageStyle>, assets: readonly PresentationRenderAsset[]): PresentationRenderPlanElement[] {
  const elements: PresentationRenderPlanElement[] = [];
  for (const resolved of layout.authoredNodes ?? []) {
    const { node, geometry, style } = resolved;
    if (node.type === 'content') continue;
    if (node.type !== 'shape' && node.type !== 'image' && node.style?.fill === undefined && node.style?.borderColor === undefined) continue;
    const baseStyle: PresentationRenderPlanStyle = { fontFamily: pageStyle.fontFamily, fontSize: 14, bold: false, color: pageStyle.accentColor,
      alignment: 'left', verticalAlignment: 'top', ...compileAuthoredStyle(style) };
    if (node.type === 'image') {
      const asset = assets.find(asset => asset.assetKey === node.assetKey);
      if (!asset) throw new TypeError('design_asset_unavailable');
      const source = { kind: 'generated' as const, key: 'asset-image' as const, assetKey: asset.assetKey, assetDigest: asset.digest,
        imageFit: node.imageFit!, aspectRatio: asset.aspectRatio, ...(node.imageMask ? { imageMask: node.imageMask } : {}) };
      elements.push({ renderId: `p${layout.pageNumber}-node-${node.nodeId}`, source, type: 'image', geometry, style: baseStyle,
        content: { type: 'image', assetKey: source.assetKey, assetDigest: source.assetDigest, imageFit: source.imageFit, aspectRatio: source.aspectRatio,
          ...(node.imageMask ? { imageMask: node.imageMask } : {}) }, zIndex: elements.length });
    } else {
      const shapeKind = node.shapeKind ?? 'rect';
      const key = shapeKind === 'ellipse' ? 'decoration-node' : shapeKind === 'line' ? 'decoration-line'
        : shapeKind === 'roundRect' ? 'decoration-roundRect' : 'decoration-rect';
      elements.push({ renderId: `p${layout.pageNumber}-node-${node.nodeId}`, source: { kind: 'generated', key }, type: 'shape', geometry,
        style: { ...baseStyle, fill: style.fill ?? (node.type === 'shape' ? style.color ?? pageStyle.accentColor : pageStyle.backgroundColor), borderColor: style.borderColor ?? style.fill ?? style.color ?? pageStyle.accentColor,
          borderWidth: style.borderWidth ?? (style.borderColor ? 1 : 0) }, content: { type: 'shape', shapeKind }, zIndex: elements.length });
    }
  }
  return elements;
}
function buildTreatmentDecorations(layout: PresentationLayoutPageResult,
  style: ReturnType<typeof resolvePresentationPageStyle>, canvas: PresentationRenderPlan['canvas']): PresentationRenderPlanElement[] {
  const result: PresentationRenderPlanElement[] = [];
  const add = (key: 'decoration-line' | 'decoration-roundRect', shapeKind: 'line' | 'roundRect', geometry: PresentationRenderPlanElement['geometry']) => result.push({
    renderId: `p${layout.pageNumber}-treatment-${result.length}`, source: { kind: 'generated', key }, type: 'shape', geometry,
    style: { fontFamily: style.fontFamily, fontSize: 14, bold: false, color: style.accentColor,
      borderColor: style.accentColor, borderWidth: 1.5, alignment: 'left', verticalAlignment: 'top' }, content: { type: 'shape', shapeKind }, zIndex: result.length });
  if (style.accentTreatment === 'rule') add('decoration-line', 'line', { x: canvas.width * 0.07, y: canvas.height * 0.04, width: canvas.width * 0.2, height: 0.02 });
  if (style.accentTreatment === 'edge') add('decoration-line', 'line', { x: canvas.width * 0.035, y: canvas.height * 0.07, width: 0.02, height: canvas.height * 0.86 });
  // frame is a generic page frame and is independent of process semantics.
  return result;
}

/** Process pages get explicit, persisted track/node primitives when the semantic organization is a sequence. */
function buildSequenceDecorations(
  layout: PresentationLayoutPageResult,
  pageStyle: ReturnType<typeof resolvePresentationPageStyle>,
  component: 'none' | 'nodes' | 'track' | 'frame' | undefined
): PresentationRenderPlanElement[] {
  if (component === 'frame') return [{ renderId: `p${layout.pageNumber}-dec-frame`, source: { kind: 'generated', key: 'decoration-roundRect' },
    type: 'shape', geometry: { x: 0.2, y: 0.2, width: Math.max(...layout.placements.map(item => item.geometry.x + item.geometry.width)) - 0.05,
      height: Math.max(...layout.placements.map(item => item.geometry.y + item.geometry.height)) - 0.05 },
    style: { fontFamily: pageStyle.fontFamily, fontSize: 14, bold: false, color: pageStyle.accentColor, fill: pageStyle.backgroundColor,
      borderColor: pageStyle.accentColor, borderWidth: 1, alignment: 'center', verticalAlignment: 'middle' }, content: { type: 'shape', shapeKind: 'roundRect' }, zIndex: 0 }];
  if (layout.pageRole !== 'process' || layout.composition !== 'sequence' || layout.contentOrganization?.layout !== 'sequence' || component === 'none') return [];
  const steps = layout.placements.filter(item => item.sourceRef !== 'generated.page-number' && item.hierarchy !== 'primary')
    .sort((left, right) => left.geometry.x - right.geometry.x);
  if (steps.length < 2 || steps.length > 14) return [];
  const y = Math.max(0.28, Math.min(...steps.map(step => step.geometry.y)) - 0.24);
  const centers = steps.map(step => step.geometry.x + step.geometry.width / 2);
  const style = {
    fontFamily: pageStyle.fontFamily, fontSize: 1, bold: false, color: pageStyle.accentColor,
    alignment: 'center' as const, verticalAlignment: 'middle' as const
  };
  const elements: PresentationRenderPlanElement[] = [];
  if (component === undefined || component === 'nodes' || component === 'track') centers.forEach((center, index) => elements.push({ renderId: `p${layout.pageNumber}-dec-node-${index + 1}`,
    source: { kind: 'generated', key: 'decoration-node' }, type: 'shape', geometry: { x: center - 0.10, y, width: 0.20, height: 0.20 }, style,
    content: { type: 'shape', shapeKind: 'ellipse' }, zIndex: index }));
  if (component === 'nodes') return elements;
  centers.slice(0, -1).forEach((center, index) => {
    const next = centers[index + 1]!;
    elements.push({ renderId: `p${layout.pageNumber}-dec-line-${index + 1}`, source: { kind: 'generated', key: 'decoration-line' }, type: 'shape',
      geometry: { x: center + 0.10, y: y + 0.087, width: Math.max(0.02, next - center - 0.20), height: 0.025 }, style,
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
