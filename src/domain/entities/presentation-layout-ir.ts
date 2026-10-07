import {
  validatePresentationRenderPlan,
  type PresentationRenderInputIdentity,
  type PresentationRenderPlan,
  type PresentationRenderPlanElement,
  type PresentationRenderSourceReference
} from './presentation-render-plan';
import type { PresentationPageRole } from './presentation-design-contract';
import { parsePresentationLayoutOrganization, type PresentationLayoutOrganizationV1 } from './presentation-layout-organization';

export type PresentationLayoutContentSource = Exclude<PresentationRenderSourceReference, { readonly kind: 'outline' }>;

/** Host-assigned identities survive insertion/reordering; pageNumber is display order only. */
export type PresentationLayoutPageSource =
  | { readonly kind: 'system'; readonly key: 'cover' | 'closing' }
  | { readonly kind: 'content'; readonly sectionId: string };

export interface ProductionPresentationLayoutElement extends Omit<PresentationRenderPlanElement, 'renderId' | 'source' | 'content'> {
  readonly elementId: string;
  readonly source: PresentationLayoutContentSource;
}

export interface ProductionPresentationLayoutPage {
  readonly pageId: string;
  readonly source: PresentationLayoutPageSource;
  readonly pageNumber: number;
  readonly pageRole: PresentationPageRole;
  readonly backgroundColor: string;
  readonly elements: readonly ProductionPresentationLayoutElement[];
  readonly organization?: PresentationLayoutOrganizationV1;
}

export interface ProductionPresentationLayoutDiagnostic {
  readonly code: string;
  readonly pageId?: string;
  readonly elementIds?: readonly string[];
}

export interface ProductionPresentationLayoutRepair {
  readonly attempt: number;
  readonly action: 'reduce_gap' | 'rebalance_regions' | 'reduce_font_size' | 'compatible_composition';
  readonly pageIds: readonly string[];
}

export type PresentationLayoutLegacyReason =
  | 'design_missing' | 'design_invalid' | 'unsupported_design' | 'layout_failed' | 'legacy_workflow';

/**
 * The sole persisted production geometry contract. Coordinates/styles are Host
 * compiler output, never an LLM instruction. Constraints/features are transient
 * solver inputs; Render Plan is a read-only projection of this value.
 */
export interface ProductionPresentationLayoutIR {
  readonly schemaVersion: 1;
  readonly identity: PresentationRenderInputIdentity;
  readonly compatibility:
    | { readonly origin: 'solver' }
    | { readonly origin: 'legacy-render-plan'; readonly fallbackReason: PresentationLayoutLegacyReason };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly minimumFontSize: number;
  readonly pages: readonly ProductionPresentationLayoutPage[];
  readonly diagnostics: readonly ProductionPresentationLayoutDiagnostic[];
  readonly repairs: readonly ProductionPresentationLayoutRepair[];
}

export interface PresentationLayoutIRValidationOptions {
  readonly expectedContentIdentity?: { readonly lineageId: string; readonly revision: number; readonly digest: string };
  readonly expectedSourceIdsByPage?: readonly { readonly pageId: string; readonly sourceIds: readonly string[] }[];
}

export interface PresentationLayoutIRDiagnostic {
  readonly code: 'invalid_layout_ir' | 'unknown_field' | 'duplicate_identity' | 'invalid_source' | 'source_coverage_mismatch' | 'stale_input_identity' | 'invalid_render_projection';
  readonly path: string;
}

export class PresentationLayoutIRParseError extends TypeError {
  readonly diagnostics: readonly PresentationLayoutIRDiagnostic[];
  constructor(diagnostics: readonly PresentationLayoutIRDiagnostic[]) {
    super(diagnostics[0]?.code ?? 'invalid_layout_ir');
    this.name = 'PresentationLayoutIRParseError';
    this.diagnostics = diagnostics;
  }
}

export function parseProductionPresentationLayoutIR(value: unknown, options: PresentationLayoutIRValidationOptions = {}): ProductionPresentationLayoutIR {
  const diagnostics = validateProductionPresentationLayoutIR(value, options);
  if (diagnostics.length) throw new PresentationLayoutIRParseError(diagnostics);
  return canonicalizeLayoutJson(value) as ProductionPresentationLayoutIR;
}

export function validateProductionPresentationLayoutIR(value: unknown, options: PresentationLayoutIRValidationOptions = {}): readonly PresentationLayoutIRDiagnostic[] {
  const issues: PresentationLayoutIRDiagnostic[] = [];
  const issue = (code: PresentationLayoutIRDiagnostic['code'], path: string): void => { issues.push({ code, path }); };
  const keys = (record: Record<string, unknown>, names: readonly string[], path: string, optional: readonly string[] = []): void => {
    for (const key of Object.keys(record)) if (!names.includes(key)) issue('unknown_field', `${path}.${key}`);
    for (const key of names) if (!optional.includes(key) && !Object.prototype.hasOwnProperty.call(record, key)) issue('invalid_layout_ir', `${path}.${key}`);
  };
  if (!isRecord(value)) return [{ code: 'invalid_layout_ir', path: '$' }];
  keys(value, ['schemaVersion', 'identity', 'compatibility', 'canvas', 'minimumFontSize', 'pages', 'diagnostics', 'repairs'], '$');
  if (value.schemaVersion !== 1) issue('invalid_layout_ir', '$.schemaVersion');
  if (!isRecord(value.identity)) issue('invalid_layout_ir', '$.identity');
  if (!isRecord(value.compatibility)) issue('invalid_layout_ir', '$.compatibility');
  else if (value.compatibility.origin === 'solver') {
    keys(value.compatibility, ['origin'], '$.compatibility');
    if (!isRecord(value.identity) || typeof value.identity.designDigest !== 'string') issue('invalid_layout_ir', '$.identity.designDigest');
  } else if (value.compatibility.origin === 'legacy-render-plan') {
    keys(value.compatibility, ['origin', 'fallbackReason'], '$.compatibility');
    if (!['design_missing', 'design_invalid', 'unsupported_design', 'layout_failed', 'legacy_workflow'].includes(String(value.compatibility.fallbackReason))) issue('invalid_layout_ir', '$.compatibility.fallbackReason');
  } else issue('invalid_layout_ir', '$.compatibility.origin');

  const pageIds = new Set<string>();
  const elementIds = new Set<string>();
  const pageSources = new Set<string>();
  if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 40) issue('invalid_layout_ir', '$.pages');
  else for (const [pageIndex, page] of value.pages.entries()) {
    const path = `$.pages[${pageIndex}]`;
    if (!isRecord(page)) { issue('invalid_layout_ir', path); continue; }
    keys(page, ['pageId', 'source', 'pageNumber', 'pageRole', 'backgroundColor', 'elements', 'organization'], path, ['organization']);
    if (!isStableId(page.pageId)) issue('invalid_layout_ir', `${path}.pageId`);
    else if (pageIds.has(page.pageId)) issue('duplicate_identity', `${path}.pageId`);
    else pageIds.add(page.pageId);
    if (!isRecord(page.source)) issue('invalid_source', `${path}.source`);
    else {
      if (page.source.kind === 'system') {
        keys(page.source, ['kind', 'key'], `${path}.source`);
        if (page.source.key !== 'cover' && page.source.key !== 'closing') issue('invalid_source', `${path}.source.key`);
        else if ((page.source.key === 'cover' && pageIndex !== 0) || (page.source.key === 'closing' && pageIndex !== value.pages.length - 1)) issue('invalid_source', `${path}.source.key`);
      } else if (page.source.kind === 'content') {
        keys(page.source, ['kind', 'sectionId'], `${path}.source`);
        if (!isStableId(page.source.sectionId)) issue('invalid_source', `${path}.source.sectionId`);
      } else issue('invalid_source', `${path}.source.kind`);
      const sourceKey = JSON.stringify(page.source);
      if (pageSources.has(sourceKey)) issue('duplicate_identity', `${path}.source`);
      pageSources.add(sourceKey);
    }
    const sources = new Set<string>();
    if (!Array.isArray(page.elements) || page.elements.length < 1 || page.elements.length > 128) issue('invalid_layout_ir', `${path}.elements`);
    else for (const [elementIndex, element] of page.elements.entries()) {
      const elementPath = `${path}.elements[${elementIndex}]`;
      if (!isRecord(element)) { issue('invalid_layout_ir', elementPath); continue; }
      keys(element, ['elementId', 'source', 'type', 'geometry', 'style', 'zIndex'], elementPath);
      if (!isStableId(element.elementId) || (typeof element.elementId === 'string' && element.elementId.length > 80)) issue('invalid_layout_ir', `${elementPath}.elementId`);
      else if (elementIds.has(element.elementId)) issue('duplicate_identity', `${elementPath}.elementId`);
      else elementIds.add(element.elementId);
      if (!isRecord(element.source) || (element.source.kind !== 'content' && element.source.kind !== 'generated')) issue('invalid_source', `${elementPath}.source`);
      if (isRecord(element.source) && element.source.kind === 'content' && typeof element.source.ref === 'string') sources.add(element.source.ref);
    }
    if (options.expectedSourceIdsByPage) {
      const expected = options.expectedSourceIdsByPage.find(item => item.pageId === page.pageId);
      if (!expected || expected.sourceIds.length !== sources.size || expected.sourceIds.some(ref => !sources.has(ref))) issue('source_coverage_mismatch', `${path}.elements`);
    }
    if (page.organization !== undefined) {
      try { parsePresentationLayoutOrganization(page.organization, [...sources]); }
      catch { issue('invalid_layout_ir', `${path}.organization`); }
    }
  }
  if (options.expectedSourceIdsByPage && options.expectedSourceIdsByPage.length !== pageIds.size) issue('source_coverage_mismatch', '$.pages');
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 128) issue('invalid_layout_ir', '$.diagnostics');
  else for (const [index, diagnostic] of value.diagnostics.entries()) {
    const path = `$.diagnostics[${index}]`;
    if (!isRecord(diagnostic)) { issue('invalid_layout_ir', path); continue; }
    keys(diagnostic, ['code', 'pageId', 'elementIds'], path, ['pageId', 'elementIds']);
    if (typeof diagnostic.code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(diagnostic.code)) issue('invalid_layout_ir', `${path}.code`);
    if (diagnostic.pageId !== undefined && (typeof diagnostic.pageId !== 'string' || !pageIds.has(diagnostic.pageId))) issue('invalid_source', `${path}.pageId`);
    if (diagnostic.elementIds !== undefined && (!Array.isArray(diagnostic.elementIds) || diagnostic.elementIds.length > 128 || diagnostic.elementIds.some(id => typeof id !== 'string' || !elementIds.has(id)))) issue('invalid_source', `${path}.elementIds`);
  }
  if (!Array.isArray(value.repairs) || value.repairs.length > 4) issue('invalid_layout_ir', '$.repairs');
  else for (const [index, repair] of value.repairs.entries()) {
    const path = `$.repairs[${index}]`;
    if (!isRecord(repair)) { issue('invalid_layout_ir', path); continue; }
    keys(repair, ['attempt', 'action', 'pageIds'], path);
    if (repair.attempt !== index + 1 || !['reduce_gap', 'rebalance_regions', 'reduce_font_size', 'compatible_composition'].includes(String(repair.action))) issue('invalid_layout_ir', path);
    if (!Array.isArray(repair.pageIds) || repair.pageIds.length < 1 || repair.pageIds.length > 40 || new Set(repair.pageIds).size !== repair.pageIds.length || repair.pageIds.some(id => typeof id !== 'string' || !pageIds.has(id))) issue('invalid_source', `${path}.pageIds`);
  }
  if (options.expectedContentIdentity && isRecord(value.identity)) {
    const expected = options.expectedContentIdentity;
    if (value.identity.contentLineageId !== expected.lineageId || value.identity.contentRevision !== expected.revision || value.identity.contentDigest !== expected.digest) issue('stale_input_identity', '$.identity');
  }
  if (Array.isArray(value.pages) && value.pages.length <= 40 && value.pages.every(page => isRecord(page) && Array.isArray(page.elements) && page.elements.length <= 128 && page.elements.every(isRecord))) {
    const projection = projectRenderPlan(value as unknown as ProductionPresentationLayoutIR);
    for (const diagnostic of validatePresentationRenderPlan(projection)) issue('invalid_render_projection', diagnostic.path);
  }
  return issues;
}

/** Geometry/style validation reuses the writer validator with synthetic content only. */
function projectRenderPlan(layout: ProductionPresentationLayoutIR): PresentationRenderPlan {
  return {
    schemaVersion: 1,
    inputIdentity: layout.identity,
    canvas: layout.canvas,
    minimumFontSize: layout.minimumFontSize,
    pages: layout.pages.map(page => ({
      pageNumber: page.pageNumber, pageRole: page.pageRole, backgroundColor: page.backgroundColor,
      elements: page.elements.map(element => ({
        renderId: element.elementId, source: element.source, type: element.type,
        geometry: element.geometry, style: element.style, zIndex: element.zIndex,
        content: element.type === 'table' ? { type: 'table' as const, header: ['geometry'], rows: [['validation']] }
          : element.type === 'chart' ? { type: 'chart' as const, chartKind: 'bar' as const, data: [{ label: 'geometry', value: 1 }] }
          : { type: 'text' as const, text: 'geometry validation' }
      }))
    }))
  };
}

/** Stable JSON normalization for digest boundaries, without importing Platform hashing. */
export function canonicalizeLayoutJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeLayoutJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalizeLayoutJson(value[key])]));
  return value;
}

function isStableId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,128}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
