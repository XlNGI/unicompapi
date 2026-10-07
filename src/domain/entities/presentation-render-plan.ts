import type { PresentationPageRole } from './presentation-design-contract';

export type PresentationRenderElementType = 'text' | 'table' | 'chart';
export type PresentationRenderAlignment = 'left' | 'center' | 'right' | 'justify';
export type PresentationRenderVerticalAlignment = 'top' | 'middle' | 'bottom';

export interface PresentationRenderPlanGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PresentationRenderSourceReference =
  | { readonly kind: 'outline'; readonly ref: string }
  | { readonly kind: 'content'; readonly ref: string }
  | { readonly kind: 'generated'; readonly key: 'closing-label' | 'page-number' };

/** Host provenance of the sole Layout IR from which this writer input was projected. */
export interface PresentationRenderInputIdentity {
  readonly layoutId: string;
  readonly layoutDigest: string;
  readonly contentLineageId: string;
  readonly contentRevision: number;
  readonly contentDigest: string;
  readonly designDigest?: string;
}

export interface PresentationRenderPlanStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly color: string;
  readonly fill?: string;
  readonly alignment: PresentationRenderAlignment;
  readonly verticalAlignment: PresentationRenderVerticalAlignment;
  readonly tableHeaderFill?: string;
  readonly tableHeaderColor?: string;
  readonly tableBodyFill?: string;
  readonly borderColor?: string;
  readonly chartColors?: readonly string[];
  readonly mutedColor?: string;
  readonly showLegend?: boolean;
  readonly showValues?: boolean;
}

export interface PresentationRenderTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface PresentationRenderTableContent {
  readonly type: 'table';
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface PresentationRenderChartContent {
  readonly type: 'chart';
  readonly chartKind: 'bar' | 'pie';
  readonly title?: string;
  readonly data: readonly { readonly label: string; readonly value: number }[];
}

export type PresentationRenderPlanContent = PresentationRenderTextContent | PresentationRenderTableContent | PresentationRenderChartContent;

export interface PresentationRenderPlanElement {
  readonly renderId: string;
  readonly source: PresentationRenderSourceReference;
  readonly type: PresentationRenderElementType;
  readonly geometry: PresentationRenderPlanGeometry;
  readonly style: PresentationRenderPlanStyle;
  readonly content: PresentationRenderPlanContent;
  readonly zIndex: number;
}

export interface PresentationRenderPlanPage {
  readonly pageNumber: number;
  readonly pageRole: PresentationPageRole;
  readonly backgroundColor: string;
  readonly elements: readonly PresentationRenderPlanElement[];
}

/** Final deterministic input to the PPTX writer. It contains coordinates; Design IR does not. */
export interface PresentationRenderPlan {
  readonly schemaVersion: 1;
  readonly inputIdentity?: PresentationRenderInputIdentity;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly minimumFontSize: number;
  readonly pages: readonly PresentationRenderPlanPage[];
}

export type PresentationRenderPlanDiagnosticCode =
  | 'invalid_render_plan'
  | 'unknown_field'
  | 'page_count_mismatch'
  | 'invalid_page_number'
  | 'duplicate_render_id'
  | 'duplicate_z_index'
  | 'invalid_source_ref'
  | 'layout_overflow'
  | 'negative_size'
  | 'layout_overlap'
  | 'font_below_minimum'
  | 'unsupported_element_type';

export interface PresentationRenderPlanDiagnostic {
  readonly code: PresentationRenderPlanDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export class PresentationRenderPlanParseError extends TypeError {
  readonly diagnostics: readonly PresentationRenderPlanDiagnostic[];

  constructor(diagnostics: readonly PresentationRenderPlanDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Invalid Presentation Render Plan');
    this.name = 'PresentationRenderPlanParseError';
    this.diagnostics = diagnostics;
  }
}

export interface PresentationRenderPlanValidationOptions {
  readonly expectedPageCount?: number;
  readonly minimumFontSize?: number;
  readonly validSourceRefsByPage?: readonly { readonly pageNumber: number; readonly sourceRefs: readonly string[] }[];
  readonly overlapRatioThreshold?: number;
}

const MAX_PAGES = 40;
const MAX_ELEMENTS_PER_PAGE = 128;
const MAX_TEXT_LENGTH = 16_000;
const MAX_DIMENSION = 100_000;
const MIN_BOX_SIZE = 0.01;
const DEFAULT_MINIMUM_FONT_SIZE = 14;
const sourceRefPattern = /^outline\.(?:title|sections\[(?:0|[1-9]\d*)\](?:\.(?:heading|takeaway|action|blocks\[(?:0|[1-9]\d*)\](?:\.items\[(?:0|[1-9]\d*)\])?))?)$/u;
const pageRoles: readonly PresentationPageRole[] = ['hero', 'statement', 'comparison', 'metric', 'process', 'evidence', 'section', 'content', 'closing'];
const alignments: readonly PresentationRenderAlignment[] = ['left', 'center', 'right', 'justify'];
const verticalAlignments: readonly PresentationRenderVerticalAlignment[] = ['top', 'middle', 'bottom'];

export function parsePresentationRenderPlan(
  value: unknown,
  options: PresentationRenderPlanValidationOptions = {}
): PresentationRenderPlan {
  const diagnostics = validatePresentationRenderPlan(value, options);
  if (diagnostics.length > 0 || !isRecord(value)) throw new PresentationRenderPlanParseError(diagnostics);
  return value as unknown as PresentationRenderPlan;
}

export function validatePresentationRenderPlan(
  value: unknown,
  options: PresentationRenderPlanValidationOptions = {}
): readonly PresentationRenderPlanDiagnostic[] {
  const diagnostics: PresentationRenderPlanDiagnostic[] = [];
  if (!isRecord(value)) return [issue('invalid_render_plan', '$', 'Render Plan must be an object')];
  checkKeys(value, ['schemaVersion', 'inputIdentity', 'canvas', 'minimumFontSize', 'pages'], '$', diagnostics, ['inputIdentity']);
  if (value.inputIdentity !== undefined) validateInputIdentity(value.inputIdentity, diagnostics);
  if (value.schemaVersion !== 1) diagnostics.push(issue('invalid_render_plan', '$.schemaVersion', 'schemaVersion must be 1'));
  const canvas = validateCanvas(value.canvas, '$.canvas', diagnostics);
  const planMinFont = isPositiveFinite(value.minimumFontSize, 300) ? value.minimumFontSize : options.minimumFontSize ?? DEFAULT_MINIMUM_FONT_SIZE;
  if (!isPositiveFinite(value.minimumFontSize, 300)) diagnostics.push(issue('invalid_render_plan', '$.minimumFontSize', 'minimumFontSize must be positive and bounded'));
  const pagesValue = value.pages;
  if (!Array.isArray(pagesValue) || pagesValue.length < 1 || pagesValue.length > MAX_PAGES) {
    diagnostics.push(issue('invalid_render_plan', '$.pages', `pages must contain 1-${MAX_PAGES} items`));
    return diagnostics;
  }
  if (options.expectedPageCount !== undefined && pagesValue.length !== options.expectedPageCount) {
    diagnostics.push(issue('page_count_mismatch', '$.pages', `expected ${options.expectedPageCount} pages`));
  }

  const pageNumbers: number[] = [];
  const renderIds = new Set<string>();
  pagesValue.forEach((page, pageIndex) => {
    const path = `$.pages[${pageIndex}]`;
    if (!isRecord(page)) { diagnostics.push(issue('invalid_render_plan', path, 'page must be an object')); return; }
    checkKeys(page, ['pageNumber', 'pageRole', 'backgroundColor', 'elements'], path, diagnostics);
    const pageNumber = page.pageNumber;
    if (!isIntegerInRange(pageNumber, 1, MAX_PAGES)) diagnostics.push(issue('invalid_page_number', `${path}.pageNumber`, 'pageNumber is out of range'));
    else pageNumbers.push(pageNumber);
    if (!enumHas(pageRoles, page.pageRole)) diagnostics.push(issue('invalid_render_plan', `${path}.pageRole`, 'pageRole is invalid'));
    if (!isColor(page.backgroundColor)) diagnostics.push(issue('invalid_render_plan', `${path}.backgroundColor`, 'backgroundColor must be a six digit hex color'));
    if (!Array.isArray(page.elements) || page.elements.length < 1 || page.elements.length > MAX_ELEMENTS_PER_PAGE) {
      diagnostics.push(issue('invalid_render_plan', `${path}.elements`, 'elements must be a bounded non-empty array'));
      return;
    }
    const sourceRefs = new Set<string>();
    const zIndices = new Set<number>();
    const geometries: Array<{ readonly path: string; readonly geometry: PresentationRenderPlanGeometry }> = [];
    page.elements.forEach((element, elementIndex) => {
      const elementPath = `${path}.elements[${elementIndex}]`;
      if (isRecord(element) && isIntegerInRange(element.zIndex, 0, 10_000)) {
        if (zIndices.has(element.zIndex)) diagnostics.push(issue('duplicate_z_index', `${elementPath}.zIndex`, 'zIndex must be unique within a page'));
        zIndices.add(element.zIndex);
      }
      const parsed = validateElement(element, elementPath, pageNumber as number, planMinFont, sourceRefs, renderIds, options, diagnostics);
      if (parsed && canvas) geometries.push({ path: elementPath, geometry: parsed });
    });
    if (canvas) {
      geometries.forEach(item => {
        if (!isInsideCanvas(item.geometry, canvas)) diagnostics.push(issue('layout_overflow', `${item.path}.geometry`, 'element geometry exceeds the canvas bounds'));
      });
      validateOverlaps(geometries, `${path}.elements`, options.overlapRatioThreshold ?? 0.08, diagnostics);
    }
  });
  const duplicates = pageNumbers.filter((number, index) => pageNumbers.indexOf(number) !== index);
  duplicates.forEach(number => diagnostics.push(issue('invalid_page_number', '$.pages', `page ${number} is duplicated`)));
  if (pageNumbers.length === pagesValue.length) pageNumbers.forEach((number, index) => {
    if (number !== index + 1) diagnostics.push(issue('invalid_page_number', `$.pages[${index}].pageNumber`, 'pages must be ordered consecutively from 1'));
  });
  return diagnostics;
}

function validateCanvas(value: unknown, path: string, diagnostics: PresentationRenderPlanDiagnostic[]): { readonly width: number; readonly height: number } | undefined {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_render_plan', path, 'canvas must be an object')); return undefined; }
  checkKeys(value, ['width', 'height'], path, diagnostics);
  if (!isPositiveFinite(value.width, MAX_DIMENSION) || !isPositiveFinite(value.height, MAX_DIMENSION)) {
    diagnostics.push(issue('invalid_render_plan', path, 'canvas dimensions must be positive and bounded'));
    return undefined;
  }
  return { width: value.width, height: value.height };
}

function validateElement(
  value: unknown,
  path: string,
  pageNumber: number,
  minimumFontSize: number,
  pageSourceRefs: Set<string>,
  renderIds: Set<string>,
  options: PresentationRenderPlanValidationOptions,
  diagnostics: PresentationRenderPlanDiagnostic[]
): PresentationRenderPlanGeometry | undefined {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_render_plan', path, 'element must be an object')); return undefined; }
  checkKeys(value, ['renderId', 'source', 'type', 'geometry', 'style', 'content', 'zIndex'], path, diagnostics);
  if (typeof value.renderId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.renderId)) diagnostics.push(issue('invalid_render_plan', `${path}.renderId`, 'renderId is invalid'));
  else if (renderIds.has(value.renderId)) diagnostics.push(issue('duplicate_render_id', `${path}.renderId`, 'renderId must be unique across the plan'));
  else renderIds.add(value.renderId);
  validateSource(value.source, `${path}.source`, pageNumber, pageSourceRefs, options, diagnostics);
  if (!['text', 'table', 'chart'].includes(String(value.type))) diagnostics.push(issue('unsupported_element_type', `${path}.type`, 'element type is unsupported'));
  const geometry = validateGeometry(value.geometry, `${path}.geometry`, diagnostics);
  const style = validateStyle(value.style, `${path}.style`, value.type, diagnostics);
  validateContent(value.content, String(value.type), `${path}.content`, diagnostics);
  if (style) {
    const isPageNumber = isRecord(value.source) && value.source.kind === 'generated' && value.source.key === 'page-number';
    if (!isPageNumber && style.fontSize < Math.max(minimumFontSize, options.minimumFontSize ?? DEFAULT_MINIMUM_FONT_SIZE)) {
      diagnostics.push(issue('font_below_minimum', `${path}.style.fontSize`, 'fontSize is below the validated minimum'));
    }
  }
  if (!isIntegerInRange(value.zIndex, 0, 10_000)) diagnostics.push(issue('invalid_render_plan', `${path}.zIndex`, 'zIndex must be a non-negative bounded integer'));
  return geometry;
}

function validateSource(
  value: unknown,
  path: string,
  pageNumber: number,
  pageSourceRefs: Set<string>,
  options: PresentationRenderPlanValidationOptions,
  diagnostics: PresentationRenderPlanDiagnostic[]
): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_source_ref', path, 'source must be an object')); return; }
  if (value.kind === 'outline' || value.kind === 'content') {
    checkKeys(value, ['kind', 'ref'], path, diagnostics);
    const valid = typeof value.ref === 'string' && (value.kind === 'outline' ? sourceRefPattern.test(value.ref) : /^[A-Za-z0-9_:-]{1,128}$/u.test(value.ref));
    if (!valid) { diagnostics.push(issue('invalid_source_ref', `${path}.ref`, 'Content source reference is invalid')); return; }
    if (typeof value.ref !== 'string') return;
    if (pageSourceRefs.has(value.ref)) diagnostics.push(issue('invalid_source_ref', `${path}.ref`, 'an Outline source may appear only once per page'));
    pageSourceRefs.add(value.ref);
    if (options.validSourceRefsByPage !== undefined) {
      const inventory = options.validSourceRefsByPage.find(page => page.pageNumber === pageNumber);
      if (!inventory) diagnostics.push(issue('invalid_source_ref', `${path}.ref`, 'page has no source-reference inventory'));
      else if (!inventory.sourceRefs.includes(value.ref)) diagnostics.push(issue('invalid_source_ref', `${path}.ref`, 'source does not belong to this page'));
    }
  } else if (value.kind === 'generated') {
    checkKeys(value, ['kind', 'key'], path, diagnostics);
    if (value.key !== 'closing-label' && value.key !== 'page-number') diagnostics.push(issue('invalid_source_ref', `${path}.key`, 'generated source key is unsupported'));
  } else diagnostics.push(issue('invalid_source_ref', `${path}.kind`, 'source kind is unsupported'));
}

function validateInputIdentity(value: unknown, diagnostics: PresentationRenderPlanDiagnostic[]): void {
  const path = '$.inputIdentity';
  if (!isRecord(value)) { diagnostics.push(issue('invalid_render_plan', path, 'inputIdentity must be an object')); return; }
  checkKeys(value, ['layoutId', 'layoutDigest', 'contentLineageId', 'contentRevision', 'contentDigest', 'designDigest'], path, diagnostics, ['designDigest']);
  for (const key of ['layoutId', 'contentLineageId'] as const) {
    if (typeof value[key] !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/u.test(value[key])) diagnostics.push(issue('invalid_render_plan', `${path}.${key}`, 'identity must be a bounded stable identifier'));
  }
  for (const key of ['layoutDigest', 'contentDigest', 'designDigest'] as const) {
    if ((key !== 'designDigest' || value[key] !== undefined) && (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[key]))) diagnostics.push(issue('invalid_render_plan', `${path}.${key}`, 'digest must be a SHA-256 hex value'));
  }
  if (!isIntegerInRange(value.contentRevision, 1, Number.MAX_SAFE_INTEGER)) diagnostics.push(issue('invalid_render_plan', `${path}.contentRevision`, 'revision must be a positive integer'));
}

function validateGeometry(value: unknown, path: string, diagnostics: PresentationRenderPlanDiagnostic[]): PresentationRenderPlanGeometry | undefined {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_render_plan', path, 'geometry must be an object')); return undefined; }
  checkKeys(value, ['x', 'y', 'width', 'height'], path, diagnostics);
  for (const key of ['x', 'y'] as const) if (!isNonNegativeFinite(value[key], MAX_DIMENSION)) diagnostics.push(issue('invalid_render_plan', `${path}.${key}`, `${key} must be non-negative and bounded`));
  for (const key of ['width', 'height'] as const) {
    if (!isPositiveFinite(value[key], MAX_DIMENSION)) diagnostics.push(issue('negative_size', `${path}.${key}`, `${key} must be positive and bounded`));
    else if (value[key] < MIN_BOX_SIZE) diagnostics.push(issue('negative_size', `${path}.${key}`, `${key} is below minimum geometry size`));
  }
  if (![value.x, value.y, value.width, value.height].every(item => typeof item === 'number' && Number.isFinite(item)) ||
      typeof value.width !== 'number' || typeof value.height !== 'number' || value.width <= 0 || value.height <= 0) return undefined;
  return { x: value.x as number, y: value.y as number, width: value.width, height: value.height };
}

function validateStyle(value: unknown, path: string, elementType: unknown, diagnostics: PresentationRenderPlanDiagnostic[]): PresentationRenderPlanStyle | undefined {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_render_plan', path, 'style must be an object')); return undefined; }
  checkKeys(value, ['fontFamily', 'fontSize', 'bold', 'color', 'fill', 'alignment', 'verticalAlignment', 'tableHeaderFill', 'tableHeaderColor', 'tableBodyFill', 'borderColor', 'chartColors', 'mutedColor', 'showLegend', 'showValues'], path, diagnostics,
    ['fill', 'tableHeaderFill', 'tableHeaderColor', 'tableBodyFill', 'borderColor', 'chartColors', 'mutedColor', 'showLegend', 'showValues']);
  if (typeof value.fontFamily !== 'string' || value.fontFamily.trim().length === 0 || value.fontFamily.length > 128) diagnostics.push(issue('invalid_render_plan', `${path}.fontFamily`, 'fontFamily is invalid'));
  if (!isPositiveFinite(value.fontSize, 300)) diagnostics.push(issue('invalid_render_plan', `${path}.fontSize`, 'fontSize must be positive and bounded'));
  if (typeof value.bold !== 'boolean') diagnostics.push(issue('invalid_render_plan', `${path}.bold`, 'bold must be boolean'));
  for (const key of ['color', 'fill', 'tableHeaderFill', 'tableHeaderColor', 'tableBodyFill', 'borderColor', 'mutedColor'] as const) {
    if (value[key] !== undefined && !isColor(value[key])) diagnostics.push(issue('invalid_render_plan', `${path}.${key}`, `${key} must be a six digit hex color`));
  }
  if (value.tableHeaderColor !== undefined && elementType !== 'table') {
    diagnostics.push(issue('invalid_render_plan', `${path}.tableHeaderColor`, 'table header color is only allowed on table elements'));
  }
  if (!enumHas(alignments, value.alignment)) diagnostics.push(issue('invalid_render_plan', `${path}.alignment`, 'alignment is invalid'));
  if (!enumHas(verticalAlignments, value.verticalAlignment)) diagnostics.push(issue('invalid_render_plan', `${path}.verticalAlignment`, 'verticalAlignment is invalid'));
  if (value.chartColors !== undefined && (!Array.isArray(value.chartColors) || value.chartColors.length < 1 || value.chartColors.length > 8 || value.chartColors.some(color => !isColor(color)))) {
    diagnostics.push(issue('invalid_render_plan', `${path}.chartColors`, 'chartColors must contain 1-8 colors'));
  }
  if (elementType === 'chart') {
    if (typeof value.showLegend !== 'boolean') diagnostics.push(issue('invalid_render_plan', `${path}.showLegend`, 'chart showLegend must be boolean'));
    if (typeof value.showValues !== 'boolean') diagnostics.push(issue('invalid_render_plan', `${path}.showValues`, 'chart showValues must be boolean'));
  } else if (value.showLegend !== undefined || value.showValues !== undefined) {
    diagnostics.push(issue('invalid_render_plan', path, 'chart options are only allowed on chart elements'));
  }
  return value as unknown as PresentationRenderPlanStyle;
}

function validateContent(value: unknown, elementType: string, path: string, diagnostics: PresentationRenderPlanDiagnostic[]): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_render_plan', path, 'content must be an object')); return; }
  if (value.type !== elementType) diagnostics.push(issue('invalid_render_plan', `${path}.type`, 'content type must match its element type'));
  if (elementType === 'text') {
    checkKeys(value, ['type', 'text'], path, diagnostics);
    if (typeof value.text !== 'string' || value.text.trim().length === 0 || value.text.length > MAX_TEXT_LENGTH) diagnostics.push(issue('invalid_render_plan', `${path}.text`, 'text must be non-empty and bounded'));
  } else if (elementType === 'table') {
    checkKeys(value, ['type', 'header', 'rows'], path, diagnostics);
    if (!Array.isArray(value.header) || value.header.length < 1 || value.header.length > 12 || value.header.some(cell => !boundedText(cell))) diagnostics.push(issue('invalid_render_plan', `${path}.header`, 'table header is invalid'));
    if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 60 || value.rows.some(row => !Array.isArray(row) || row.length !== (Array.isArray(value.header) ? value.header.length : -1) || row.some(cell => !boundedText(cell)))) diagnostics.push(issue('invalid_render_plan', `${path}.rows`, 'table rows must be rectangular and bounded'));
  } else if (elementType === 'chart') {
    checkKeys(value, ['type', 'chartKind', 'title', 'data'], path, diagnostics, ['title']);
    if (value.chartKind !== 'bar' && value.chartKind !== 'pie') diagnostics.push(issue('invalid_render_plan', `${path}.chartKind`, 'chartKind is unsupported'));
    if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 500)) diagnostics.push(issue('invalid_render_plan', `${path}.title`, 'chart title is invalid'));
    if (!Array.isArray(value.data) || value.data.length < 1 || value.data.length > 20) diagnostics.push(issue('invalid_render_plan', `${path}.data`, 'chart data must contain 1-20 points'));
    else value.data.forEach((point, index) => {
      const pointPath = `${path}.data[${index}]`;
      if (!isRecord(point)) { diagnostics.push(issue('invalid_render_plan', pointPath, 'chart point must be an object')); return; }
      checkKeys(point, ['label', 'value'], pointPath, diagnostics);
      if (!boundedText(point.label) || typeof point.value !== 'number' || !Number.isFinite(point.value)) diagnostics.push(issue('invalid_render_plan', pointPath, 'chart point is invalid'));
    });
  } else diagnostics.push(issue('unsupported_element_type', path, 'content type is unsupported'));
}

function validateOverlaps(
  elements: readonly { readonly path: string; readonly geometry: PresentationRenderPlanGeometry }[],
  path: string,
  threshold: number,
  diagnostics: PresentationRenderPlanDiagnostic[]
): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 1) {
    diagnostics.push(issue('invalid_render_plan', path, 'overlap threshold is invalid'));
    return;
  }
  for (let left = 0; left < elements.length; left += 1) for (let right = left + 1; right < elements.length; right += 1) {
    const a = elements[left].geometry;
    const b = elements[right].geometry;
    const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const intersection = intersectionWidth * intersectionHeight;
    const smaller = Math.min(a.width * a.height, b.width * b.height);
    if (smaller > 0 && intersection / smaller > threshold) diagnostics.push(issue('layout_overlap', `${path}[${right}].geometry`, `element overlaps ${elements[left].path}`));
  }
}

function isInsideCanvas(geometry: PresentationRenderPlanGeometry, canvas: { readonly width: number; readonly height: number }): boolean {
  return geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= canvas.width + 1e-5 && geometry.y + geometry.height <= canvas.height + 1e-5;
}

function checkKeys(value: Record<string, unknown>, expected: readonly string[], path: string, diagnostics: PresentationRenderPlanDiagnostic[], optional: readonly string[] = []): void {
  Object.keys(value).filter(key => !expected.includes(key)).forEach(key => diagnostics.push(issue('unknown_field', `${path}.${key}`, 'unknown field is not allowed')));
  expected.filter(key => !optional.includes(key) && !Object.prototype.hasOwnProperty.call(value, key)).forEach(key => diagnostics.push(issue('invalid_render_plan', `${path}.${key}`, 'required field is missing')));
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-F]{6}$/iu.test(value);
}

function isPositiveFinite(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;
}

function isNonNegativeFinite(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function enumHas<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function issue(code: PresentationRenderPlanDiagnosticCode, path: string, message: string): PresentationRenderPlanDiagnostic {
  return { code, path, message };
}
