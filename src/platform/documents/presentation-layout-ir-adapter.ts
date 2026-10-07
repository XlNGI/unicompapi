import { createHash } from 'node:crypto';
import {
  parseDocumentContentSnapshot,
  documentContentReferenceIndex,
  type DocumentContentSnapshotV1,
  type DocumentContentResolvedRef
} from '../../domain/entities/document-content-snapshot';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR, type ProductionPresentationDesignIR } from '../../domain/entities/presentation-design-contract';
import {
  canonicalizeLayoutJson,
  parseProductionPresentationLayoutIR,
  type PresentationLayoutLegacyReason,
  type ProductionPresentationLayoutIR,
  type ProductionPresentationLayoutPage,
  type ProductionPresentationLayoutDiagnostic
} from '../../domain/entities/presentation-layout-ir';
import {
  parsePresentationRenderPlan,
  type PresentationRenderPlan,
  type PresentationRenderPlanElement,
  type PresentationRenderPlanContent
} from '../../domain/entities/presentation-render-plan';
import type { PresentationLayoutRepairAction } from './presentation-layout-engine';
import type { DocumentOutline } from '../../domain/entities/document-generation';
import type { PresentationLayoutIR as LegacyPresentationLayoutIR } from '../../domain/entities/presentation-design';
import type { PresentationPlan, PresentationPageScene } from '../../domain/entities/presentation-plan';
import type { PresentationTemplateTokens } from './presentation-template';
import { extractPresentationPageFeatures } from './presentation-page-features';
import type { ResolvedPresentationContentOrganization } from '../../domain/entities/presentation-layout-constraints';
import { parsePresentationLayoutOrganization, type PresentationLayoutOrganizationV1 } from '../../domain/entities/presentation-layout-organization';

interface ContentReference {
  readonly id: string;
  readonly sectionId?: string;
  readonly systemPage?: 'cover' | 'closing';
  readonly content?: PresentationRenderPlanContent;
}

interface LayoutBuildInput {
  readonly renderPlan: PresentationRenderPlan;
  readonly content: DocumentContentSnapshotV1;
  readonly diagnostics?: readonly { readonly code: string; readonly pageNumber?: number }[];
  readonly repairs?: readonly { readonly attempt: number; readonly action: PresentationLayoutRepairAction; readonly pages: readonly number[] }[];
  readonly organizations?: readonly { readonly pageNumber: number; readonly organization: ResolvedPresentationContentOrganization }[];
}

/** Wraps already solved coordinates; neither this boundary nor the legacy adapter solves geometry. */
export function buildProductionPresentationLayoutIR(input: LayoutBuildInput & { readonly design: ProductionPresentationDesignIR }): ProductionPresentationLayoutIR {
  return buildLayout(input, { origin: 'solver' }, input.design);
}

/** Explicit compatibility boundary. It requires a reason and never reuses positional identities. */
export function adaptLegacyPresentationRenderPlan(input: LayoutBuildInput & {
  readonly fallbackReason: PresentationLayoutLegacyReason;
  readonly design?: ProductionPresentationDesignIR;
}): ProductionPresentationLayoutIR {
  return buildLayout(input, { origin: 'legacy-render-plan', fallbackReason: input.fallbackReason }, input.design);
}

export type LegacyPresentationLayoutAdaptation =
  | { readonly status: 'adapted'; readonly scope: 'legacy_scene_projection'; readonly coverage: 'explicit_scene_boxes';
      readonly excludedArtifactElements: readonly ['template_decorations', 'page_numbers', 'external_images']; readonly layout: ProductionPresentationLayoutIR }
  | { readonly status: 'compatibility_unsupported'; readonly reason: 'missing_scene' | 'unsupported_scene_element' | 'page_identity_unsupported' | 'source_mismatch' | 'invalid_legacy_layout'; readonly pageNumbers: readonly number[]; readonly unsupportedTypes: readonly string[] };

/**
 * Temporary v1 scene boxes remain a compatibility input. Only explicit text
 * scene boxes with unambiguous canonical identities are projected. Template
 * decoration, generated page numbers and separately supplied raster assets are
 * outside this projection; it is never a contract for the entire old artifact.
 * Unsupported scenes retain the old output with an explicit audit result.
 */
export function adaptLegacyPresentationLayout(input: {
  readonly layout: LegacyPresentationLayoutIR;
  readonly plan: PresentationPlan;
  readonly content: DocumentContentSnapshotV1;
  readonly tokens: PresentationTemplateTokens;
}): LegacyPresentationLayoutAdaptation {
  const unsupported = (reason: Extract<LegacyPresentationLayoutAdaptation, { status: 'compatibility_unsupported' }>['reason'], pageNumbers: readonly number[] = [], unsupportedTypes: readonly string[] = []): LegacyPresentationLayoutAdaptation => ({
    status: 'compatibility_unsupported', reason, pageNumbers: [...new Set(pageNumbers)].slice(0, 40), unsupportedTypes: [...new Set(unsupportedTypes)].slice(0, 8)
  });
  try {
    const content = parseDocumentContentSnapshot(input.content);
    const expectedCount = content.sections.length ? content.sections.length + 2 : 1;
    if (input.plan.pages.length !== expectedCount || input.layout.pages.length !== expectedCount || expectedCount > 40) return unsupported('page_identity_unsupported');
    const canvas = { width: 13.333, height: 7.5 };
    const pages: PresentationRenderPlan['pages'][number][] = [];
    for (const page of input.plan.pages) {
      const scene: PresentationPageScene | undefined = page.scene ?? (page.pageNumber === 1 ? input.plan.coverScene : page.pageNumber === expectedCount ? input.plan.closingScene : undefined);
      if (!scene || scene.elements.length === 0) return unsupported('missing_scene', [page.pageNumber]);
      const types = scene.elements.filter(element => element.type !== 'text' || element.parentId !== undefined).map(element => element.parentId !== undefined ? 'nested-text'
        : ['shape', 'line', 'image', 'table', 'chart', 'group'].includes(element.type) ? element.type : 'unknown');
      if (types.length) return unsupported('unsupported_scene_element', [page.pageNumber], types);
      const boxes = input.layout.pages.find(item => item.pageNumber === page.pageNumber)?.boxes;
      if (!boxes || boxes.length !== scene.elements.length || boxes.length > 128 || new Set(boxes.map(box => box.elementId)).size !== boxes.length) return unsupported('invalid_legacy_layout', [page.pageNumber]);
      const section = content.sections[page.pageNumber - 2];
      const identities = page.pageNumber === 1 ? content.coverSceneContentIds : page.pageNumber === expectedCount ? content.closingSceneContentIds : section?.sceneContentIds;
      const sourceScene = page.pageNumber === 1 ? content.coverScene : page.pageNumber === expectedCount ? content.closingScene : section?.scene;
      if (!identities || !sourceScene) return unsupported('source_mismatch', [page.pageNumber]);
      if (page.pageNumber > 1 && page.pageNumber < expectedCount && (!section || (page.sourceSection !== `outline.sections[${page.pageNumber - 2}]` && page.sourceSection !== section.heading))) return unsupported('page_identity_unsupported', [page.pageNumber]);
      const elements: PresentationRenderPlanElement[] = [];
      for (const element of scene.elements) {
        const box = boxes.find(item => item.elementId === element.elementId);
        const source = sourceScene.elements.find(item => item.elementId === element.elementId);
        const ref = identities[element.elementId];
        if (!box || box.parentId !== undefined || !ref || element.content === undefined || element.content !== source?.content) return unsupported('source_mismatch', [page.pageNumber]);
        // Mirror the old renderScenePage text policy. The template's font and
        // text fill are not used there; metric text has a distinct default.
        const fontSize = element.style?.fontSize || 14;
        const metric = fontSize >= 32;
        elements.push({
          renderId: `legacy-${digest([page.pageNumber, element.elementId]).slice(0, 32)}`,
          source: { kind: 'content', ref }, type: 'text',
          geometry: { x: box.x * canvas.width, y: box.y * canvas.height, width: box.width * canvas.width, height: box.height * canvas.height },
          style: {
            fontFamily: element.style?.fontFamily || 'Microsoft YaHei',
            fontSize, bold: fontSize >= 16, color: element.style?.textColor || (metric ? input.tokens.accent : input.tokens.text),
            alignment: 'left', verticalAlignment: metric ? 'bottom' : 'top'
          }, content: { type: 'text', text: element.content }, zIndex: box.zIndex
        });
      }
      pages.push({ pageNumber: page.pageNumber, pageRole: page.pageNumber === 1 ? 'hero' : page.pageNumber === expectedCount ? 'closing' : 'content', backgroundColor: input.tokens.background, elements });
    }
    const layout = adaptLegacyPresentationRenderPlan({ renderPlan: { schemaVersion: 1, canvas, minimumFontSize: 14, pages }, content, fallbackReason: 'legacy_workflow',
      diagnostics: input.layout.diagnostics.map(item => ({ code: item.code, pageNumber: item.pageNumber })) });
    return { status: 'adapted', scope: 'legacy_scene_projection', coverage: 'explicit_scene_boxes',
      excludedArtifactElements: ['template_decorations', 'page_numbers', 'external_images'], layout };
  } catch {
    return unsupported('invalid_legacy_layout');
  }
}

/** The writer gets content exclusively from the matching canonical snapshot, never from Layout IR. */
export function derivePresentationRenderPlanFromLayoutIR(value: ProductionPresentationLayoutIR, contentValue: DocumentContentSnapshotV1): PresentationRenderPlan {
  const layout = parseProductionPresentationLayoutIR(value);
  const content = parseDocumentContentSnapshot(contentValue);
  verifyLayoutDigest(layout);
  verifyContentIdentity(layout, content);
  verifyOrganizationBinding(layout, content);
  const index = contentReferenceIndex(content);
  const allowedSources = contentSourceAllowlist(content, index);
  const projection: PresentationRenderPlan = {
    schemaVersion: 1, inputIdentity: { ...layout.identity }, canvas: { ...layout.canvas }, minimumFontSize: layout.minimumFontSize,
    pages: layout.pages.map(page => ({
      pageNumber: page.pageNumber, pageRole: page.pageRole, backgroundColor: page.backgroundColor,
      elements: page.elements.map(element => {
        const resolved = element.source.kind === 'generated'
          ? generatedContent(element.source.key, page.pageNumber)
          : contentForSource(index, element.source.ref, page, allowedSources, layout.compatibility.origin === 'legacy-render-plan');
        if (element.type !== resolved.type) throw new TypeError('layout_content_type_mismatch');
        return {
          renderId: element.elementId, source: { ...element.source }, type: element.type,
          geometry: { ...element.geometry }, style: structuredClone(element.style),
          content: structuredClone(resolved), zIndex: element.zIndex
        };
      })
    }))
  };
  verifySolverSourceCoverage(layout, allowedSources);
  return parsePresentationRenderPlan(projection);
}

export function parseVerifiedProductionPresentationLayoutIR(value: unknown, options: {
  readonly content?: DocumentContentSnapshotV1;
  readonly design?: ProductionPresentationDesignIR;
} = {}): ProductionPresentationLayoutIR {
  const layout = parseProductionPresentationLayoutIR(value);
  verifyLayoutDigest(layout);
  if (options.content) {
    const content = parseDocumentContentSnapshot(options.content);
    verifyContentIdentity(layout, content);
    verifyOrganizationBinding(layout, content, options.design);
    const index = contentReferenceIndex(content);
    const allowedSources = contentSourceAllowlist(content, index);
    for (const page of layout.pages) for (const element of page.elements) {
      const payload = element.source.kind === 'generated' ? generatedContent(element.source.key, page.pageNumber) : contentForSource(index, element.source.ref, page, allowedSources, layout.compatibility.origin === 'legacy-render-plan');
      if (payload.type !== element.type) throw new TypeError('layout_content_type_mismatch');
    }
    verifySolverSourceCoverage(layout, allowedSources);
  }
  if (options.design && digest(options.design) !== layout.identity.designDigest) throw new TypeError('layout_design_identity_mismatch');
  return layout;
}

export function computeDocumentContentDigest(value: DocumentContentSnapshotV1): string {
  return digest(parseDocumentContentSnapshot(value));
}

export function computePresentationLayoutDigest(value: ProductionPresentationLayoutIR): string {
  const identity: Record<string, unknown> = { ...value.identity };
  delete identity.layoutDigest;
  return digest({ ...value, identity });
}

function buildLayout(input: LayoutBuildInput, compatibility: ProductionPresentationLayoutIR['compatibility'], designValue?: ProductionPresentationDesignIR): ProductionPresentationLayoutIR {
  const content = parseDocumentContentSnapshot(input.content);
  if (content.kind !== 'ppt') throw new TypeError('layout_requires_presentation_content');
  const plan = parsePresentationRenderPlan(input.renderPlan, { expectedPageCount: content.sections.length === 0 ? 1 : content.sections.length + 2 });
  const design = designValue === undefined ? undefined : parsePresentationDesignIR(designValue, {
    outline: contentOutline(content), expectedPageCount: plan.pages.length
  });
  const index = contentReferenceIndex(content);
  const allowedSources = contentSourceAllowlist(content, index);
  const pages = plan.pages.map((page): ProductionPresentationLayoutPage => {
    const section = content.sections[page.pageNumber - 2];
    const source = page.pageNumber === 1 ? { kind: 'system' as const, key: 'cover' as const }
      : page.pageNumber === plan.pages.length ? { kind: 'system' as const, key: 'closing' as const }
      : section ? { kind: 'content' as const, sectionId: section.sectionId } : undefined;
    if (!source) throw new TypeError('layout_page_source_unresolved');
    const pageId = `page-${digest([content.identityScope, source]).slice(0, 32)}`;
    const pageIdentity = { pageId, source, pageNumber: page.pageNumber };
    const resolvedOrganization = input.organizations?.find(item => item.pageNumber === page.pageNumber)?.organization;
    const organization = resolvedOrganization ? projectOrganization(resolvedOrganization, pageId, index) : undefined;
    if (design?.pages[page.pageNumber - 1].organization && !organization) throw new TypeError('layout_organization_missing');
    return {
      ...pageIdentity, pageNumber: page.pageNumber, pageRole: page.pageRole, backgroundColor: page.backgroundColor,
      ...(organization ? { organization } : {}),
      elements: page.elements.map(element => {
        const reference = element.source.kind === 'generated' ? undefined : index.get(element.source.ref);
        const canonicalSource = element.source.kind === 'generated' ? element.source
          : reference ? { kind: 'content' as const, ref: reference.id } : undefined;
        if (!canonicalSource) throw new TypeError('layout_content_source_unresolved');
        const expected = canonicalSource.kind === 'generated' ? generatedContent(canonicalSource.key, page.pageNumber)
          : contentForSource(index, canonicalSource.ref, pageIdentity, allowedSources, compatibility.origin === 'legacy-render-plan');
        if (JSON.stringify(canonicalizeLayoutJson(element.content)) !== JSON.stringify(canonicalizeLayoutJson(expected))) throw new TypeError('layout_candidate_content_mismatch');
        return {
          elementId: `element-${digest([pageId, canonicalSource]).slice(0, 32)}`,
          source: { ...canonicalSource }, type: element.type,
          geometry: { ...element.geometry }, style: structuredClone(element.style), zIndex: element.zIndex
        };
      })
    };
  });
  const diagnostics: ProductionPresentationLayoutDiagnostic[] = (input.diagnostics ?? []).map(item => ({
    code: item.code,
    ...(item.pageNumber === undefined ? {} : { pageId: pageIdForNumber(pages, item.pageNumber) })
  }));
  const candidate: ProductionPresentationLayoutIR = {
    schemaVersion: 1,
    identity: {
      layoutId: `layout-${digest(content.identityScope).slice(0, 32)}`, layoutDigest: '0'.repeat(64),
      contentLineageId: content.identityScope, contentRevision: content.revision, contentDigest: digest(content),
      ...(design ? { designDigest: digest(design) } : {})
    }, compatibility, canvas: { ...plan.canvas }, minimumFontSize: plan.minimumFontSize, pages,
    diagnostics, repairs: (input.repairs ?? []).map(repair => ({
      attempt: repair.attempt, action: repair.action, pageIds: repair.pages.map(number => pageIdForNumber(pages, number))
    }))
  };
  verifySolverSourceCoverage(candidate, allowedSources);
  verifyOrganizationBinding(candidate, content, design);
  const validated = parseProductionPresentationLayoutIR(candidate);
  return { ...validated, identity: { ...validated.identity, layoutDigest: computePresentationLayoutDigest(validated) } };
}

function projectOrganization(value: ResolvedPresentationContentOrganization, pageId: string,
  index: ReadonlyMap<string, ContentReference>): PresentationLayoutOrganizationV1 {
  const groupIds = new Map(value.groups.map(group => [group.groupId, `group-${digest([pageId, group.groupId]).slice(0, 32)}`]));
  const groups = value.groups.map(group => ({ groupId: groupIds.get(group.groupId)!, role: group.role,
    sourceRefs: group.sourceRefs.map(ref => {
      const canonical = index.get(ref);
      if (!canonical) throw new TypeError('layout_organization_source_unresolved');
      return canonical.id;
    }) }));
  return { schemaVersion: 1, source: value.source, layout: value.layout, groups,
    relationships: value.relationships.map(relation => ({ ...relation,
      fromGroupId: groupIds.get(relation.fromGroupId)!, toGroupId: groupIds.get(relation.toGroupId)! })) };
}

/** Stored membership is verified against the admitted design and current canonical facts. */
function verifyOrganizationBinding(layout: ProductionPresentationLayoutIR, content: DocumentContentSnapshotV1,
  design?: ProductionPresentationDesignIR): void {
  const index = contentReferenceIndex(content);
  const outline = contentOutline(content);
  for (const page of layout.pages) {
    const designPage = design?.pages[page.pageNumber - 1];
    if (!page.organization) {
      if (designPage?.organization) throw new TypeError('layout_organization_missing');
      continue;
    }
    const refs = page.elements.flatMap(element => element.source.kind === 'content' ? [element.source.ref] : []);
    parsePresentationLayoutOrganization(page.organization, refs);
    verifyOrganizationGeometry(page, designPage?.composition.flow);
    if (designPage) {
      const resolved = extractPresentationPageFeatures(outline, designPage).contentOrganization;
      if (!resolved || digest(projectOrganization(resolved, page.pageId, index)) !== digest(page.organization)) {
        throw new TypeError('layout_organization_design_mismatch');
      }
    }
  }
}

function verifyOrganizationGeometry(page: ProductionPresentationLayoutPage, flow?: string): void {
  const organization = page.organization!;
  const elementIndex = new Map(page.elements.flatMap(element => element.source.kind === 'content' ? [[element.source.ref, element.geometry] as const] : []));
  const bounds = (refs: readonly string[]) => {
    const boxes = refs.map(ref => elementIndex.get(ref)!);
    const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
    return { left, top, right: Math.max(...boxes.map(box => box.x + box.width)), bottom: Math.max(...boxes.map(box => box.y + box.height)) };
  };
  const groupIndex = new Map(organization.groups.map(group => [group.groupId, group]));
  const supportParents = new Map<string, string>();
  for (const relation of organization.relationships.filter(relation => relation.kind === 'supports')) {
    if (supportParents.has(relation.fromGroupId)) throw new TypeError('layout_organization_support_ambiguous');
    supportParents.set(relation.fromGroupId, relation.toGroupId);
  }
  const owner = (id: string): string => {
    let current = id;
    for (let index = 0; index <= organization.groups.length; index += 1) {
      const next = supportParents.get(current);
      if (!next) return current;
      current = next;
    }
    throw new TypeError('layout_organization_invalid');
  };
  const clusters = new Map<string, string[]>();
  for (const group of organization.groups) {
    const root = owner(group.groupId);
    clusters.set(root, [...(clusters.get(root) ?? []), ...group.sourceRefs]);
  }
  const epsilon = 0.025;
  const overlap = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > epsilon && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > epsilon;
  const clusterBoxes = [...clusters.values()].map(bounds);
  for (const [index, box] of clusterBoxes.entries()) for (const other of clusterBoxes.slice(index + 1)) {
    if (overlap(box, other)) throw new TypeError('layout_organization_groups_interleaved');
  }
  if (page.pageRole !== 'hero' && page.pageRole !== 'closing') {
    const headerRefs = organization.groups.filter(group => group.role === 'header').flatMap(group => group.sourceRefs);
    const businessRefs = organization.groups.filter(group => group.role !== 'header').flatMap(group => group.sourceRefs);
    if (headerRefs.length && businessRefs.length && bounds(headerRefs).bottom > bounds(businessRefs).top + epsilon) {
      throw new TypeError('layout_organization_header_position');
    }
  }
  for (const relation of organization.relationships) {
    if (groupIndex.get(relation.fromGroupId)?.role === 'header' || groupIndex.get(relation.toGroupId)?.role === 'header') {
      throw new TypeError('layout_organization_header_relationship');
    }
    const from = bounds(clusters.get(owner(relation.fromGroupId))!), to = bounds(clusters.get(owner(relation.toGroupId))!);
    if (relation.kind === 'sequence') {
      const verticalOrder = from.bottom <= to.top + epsilon;
      const horizontalOrder = from.right <= to.left + epsilon && Math.abs(from.top - to.top) <= epsilon;
      if (flow === 'top-to-bottom' ? !verticalOrder : !(verticalOrder || horizontalOrder)) throw new TypeError('layout_organization_sequence_order');
    } else if (relation.kind === 'compare') {
      const horizontal = (from.right <= to.left + epsilon || to.right <= from.left + epsilon) && Math.abs(from.top - to.top) <= epsilon;
      const vertical = from.bottom <= to.top + epsilon || to.bottom <= from.top + epsilon;
      if (flow === 'top-to-bottom' ? !vertical : !horizontal) throw new TypeError('layout_organization_comparison_position');
    }
  }
}

function verifyLayoutDigest(layout: ProductionPresentationLayoutIR): void {
  if (computePresentationLayoutDigest(layout) !== layout.identity.layoutDigest) throw new TypeError('layout_digest_mismatch');
}
function verifyContentIdentity(layout: ProductionPresentationLayoutIR, content: DocumentContentSnapshotV1): void {
  if (layout.identity.contentLineageId !== content.identityScope || layout.identity.contentRevision !== content.revision || layout.identity.contentDigest !== digest(content)) throw new TypeError('layout_content_identity_mismatch');
  if (layout.pages.length !== (content.sections.length === 0 ? 1 : content.sections.length + 2)) throw new TypeError('layout_content_page_mismatch');
  const expected = new Set(content.sections.map(section => section.sectionId));
  const actual = layout.pages.filter(page => page.source.kind === 'content').map(page => page.source.kind === 'content' ? page.source.sectionId : '');
  if (actual.length !== expected.size || actual.some((id, index) => !expected.has(id) || id !== content.sections[index]?.sectionId)) throw new TypeError('layout_content_page_mismatch');
}
/** Solver output must render every canonical feature once, including its one Host page number. */
function verifySolverSourceCoverage(layout: ProductionPresentationLayoutIR,
  allowedSources: ReadonlyMap<number, ReadonlySet<string>>): void {
  // Old scene-box projections explicitly cover only their scene text. They are
  // not evidence of full Outline coverage and never enter the production solver.
  if (layout.compatibility.origin !== 'solver') return;
  for (const page of layout.pages) {
    const expected = allowedSources.get(page.pageNumber);
    const actual = page.elements.flatMap(element => element.source.kind === 'content' ? [element.source.ref] : []);
    if (!expected || actual.length !== expected.size || new Set(actual).size !== actual.length ||
      actual.some(reference => !expected.has(reference))) throw new TypeError('layout_source_coverage_mismatch');
    const generated = page.elements.flatMap(element => element.source.kind === 'generated' ? [element.source.key] : []);
    if (generated.length !== 1 || generated[0] !== 'page-number') throw new TypeError('layout_generated_source_coverage_mismatch');
  }
}
function contentForSource(index: ReadonlyMap<string, ContentReference>, ref: string, page: Pick<ProductionPresentationLayoutPage, 'source' | 'pageNumber'>,
  allowedSources: ReadonlyMap<number, ReadonlySet<string>>, legacy: boolean): PresentationRenderPlanContent {
  const resolved = index.get(ref);
  if (!resolved?.content) throw new TypeError('layout_content_source_unresolved');
  const allowed = allowedSources.get(page.pageNumber)?.has(resolved.id) === true;
  const ownBody = page.source.kind === 'content' && resolved.sectionId === page.source.sectionId;
  const ownLegacyScene = legacy && page.source.kind === 'system' && resolved.systemPage === page.source.key;
  if (page.source.kind === 'content' ? !ownBody : (!allowed && !ownLegacyScene)) throw new TypeError('layout_content_source_wrong_page');
  return resolved.content;
}
function pageIdForNumber(pages: readonly ProductionPresentationLayoutPage[], number: number): string {
  const page = pages.find(item => item.pageNumber === number);
  if (!page) throw new TypeError('layout_repair_page_unresolved');
  return page.pageId;
}
function generatedContent(key: 'closing-label' | 'page-number', pageNumber: number): PresentationRenderPlanContent {
  return { type: 'text', text: key === 'page-number' ? String(pageNumber) : '谢谢观看' };
}

/** D01 resolves all aliases/atoms in one bounded pass; no per-element reparsing. */
function contentReferenceIndex(content: DocumentContentSnapshotV1): ReadonlyMap<string, ContentReference> {
  const result = new Map<string, ContentReference>();
  for (const [alias, reference] of Object.entries(documentContentReferenceIndex(content))) {
    const payload = referenceContent(reference);
    const systemPage = alias.startsWith('outline.coverScene.') ? 'cover' as const : alias.startsWith('outline.closingScene.') ? 'closing' as const : undefined;
    const prior = result.get(reference.id);
    const entry = { id: reference.id, ...(reference.sectionId ? { sectionId: reference.sectionId } : {}), ...(payload ? { content: payload } : {}),
      ...(systemPage ? { systemPage } : prior?.systemPage ? { systemPage: prior.systemPage } : {}) };
    result.set(alias, entry);
    if (systemPage) result.set(reference.id, entry);
  }
  return result;
}
function contentOutline(content: DocumentContentSnapshotV1): DocumentOutline {
  return { kind: content.kind, title: content.title, sections: content.sections.map(section => ({
    heading: section.heading, level: section.level, blocks: section.blocks.map(block => block.payload),
    ...(section.takeaway === undefined ? {} : { takeaway: section.takeaway }),
    ...(section.action === undefined ? {} : { action: section.action })
  })) };
}
function contentSourceAllowlist(content: DocumentContentSnapshotV1, index: ReadonlyMap<string, ContentReference>): ReadonlyMap<number, ReadonlySet<string>> {
  const outline = contentOutline(content);
  const designPages = buildFallbackPresentationDesignIR(outline).pages;
  const pages = designPages.map(page => extractPresentationPageFeatures(outline, page));
  return new Map(pages.map(page => [page.pageNumber, new Set(page.units.filter(unit => unit.kind !== 'generated').map(unit => {
    const ref = unit.sourceRef;
    const reference = index.get(ref);
    if (!reference) throw new TypeError('layout_authority_source_unresolved');
    return reference.id;
  }))]));
}
function referenceContent(reference: DocumentContentResolvedRef): PresentationRenderPlanContent | undefined {
  const payload = reference.payload;
  if (payload?.type === 'paragraph' || payload?.type === 'quote') return { type: 'text', text: payload.text };
  if (payload?.type === 'table') return { type: 'table', header: payload.header, rows: payload.rows };
  if (payload?.type === 'chart') return { type: 'chart', chartKind: payload.chartKind, ...(payload.title ? { title: payload.title } : {}), data: payload.data };
  if (reference.text !== undefined) return { type: 'text', text: reference.text };
  return undefined;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonicalizeLayoutJson(value))).digest('hex'); }
