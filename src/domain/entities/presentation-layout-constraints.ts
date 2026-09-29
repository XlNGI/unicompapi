import {
  presentationBalances,
  presentationCompositionPrinciples,
  presentationEmphasisStrengths,
  presentationFocalAreas,
  presentationDesignWhitespaces,
  type PresentationBalance,
  type PresentationCompositionPrinciple,
  type PresentationDesignWhitespace,
  type PresentationEmphasisStrength,
  type PresentationFocalArea,
  type PresentationPageRole
} from './presentation-design-contract';
import type { PresentationPageKind } from './document-generation';

export const presentationLayoutDensityLevels = ['sparse', 'balanced', 'dense'] as const;
export type PresentationLayoutDensity = (typeof presentationLayoutDensityLevels)[number];

export const presentationLayoutElementRoles = ['title', 'body', 'metric', 'evidence', 'chart', 'table', 'action'] as const;
export type PresentationLayoutElementRole = (typeof presentationLayoutElementRoles)[number];

export const presentationLayoutHierarchyLevels = ['primary', 'secondary', 'supporting', 'unassigned'] as const;
export type PresentationLayoutHierarchyLevel = (typeof presentationLayoutHierarchyLevels)[number];

export const presentationLayoutRegions = ['left', 'center', 'right', 'top', 'bottom', 'leading', 'trailing', 'supporting'] as const;
export type PresentationLayoutRegion = (typeof presentationLayoutRegions)[number];

export const presentationLayoutAlignments = ['start', 'center', 'end', 'justify'] as const;
export type PresentationLayoutAlignment = (typeof presentationLayoutAlignments)[number];

export const presentationLayoutFlows = ['top-to-bottom', 'left-to-right', 'radial', 'sequence', 'comparison'] as const;
export type PresentationLayoutFlow = (typeof presentationLayoutFlows)[number];

export const presentationLayoutRelationships = [
  'above', 'near', 'align', 'paired', 'dominates', 'supports'
] as const;
export type PresentationLayoutRelationshipKind = (typeof presentationLayoutRelationships)[number];

export interface PresentationPageContentUnitFeature {
  readonly sourceRef: string;
  readonly kind: 'generated' | 'title' | 'heading' | 'takeaway' | 'action' | 'paragraph' | 'quote' | 'item' | 'table' | 'chart';
  readonly role: PresentationLayoutElementRole;
  readonly hierarchy: PresentationLayoutHierarchyLevel;
  readonly priority: number;
  readonly textLength: number;
  readonly estimatedTextWidthEm: number;
  readonly itemCount: number;
  readonly metricCount: number;
  readonly evidenceCount: number;
  readonly tableRows?: number;
  readonly tableColumns?: number;
  /** Numeric width measurements for header + body rows; source text is never retained. */
  readonly tableCellWidthsEm?: readonly (readonly number[])[];
  readonly chartPoints?: number;
}

/** Content-derived, deterministic signals. No geometry or runtime identifiers are included. */
export interface PresentationPageFeatures {
  readonly pageNumber: number;
  readonly pageRole: PresentationPageRole;
  readonly semanticRole: PresentationPageKind | PresentationPageRole;
  readonly textLength: number;
  readonly blockCount: number;
  readonly contentUnitCount: number;
  readonly metricCount: number;
  readonly evidenceCount: number;
  readonly chartCount: number;
  readonly tableCount: number;
  readonly imageCount: number;
  readonly hasChart: boolean;
  readonly hasTable: boolean;
  readonly hasImage: boolean;
  readonly hasSequence: boolean;
  readonly comparisonCandidate: boolean;
  readonly dominantPrimaryContent?: string;
  readonly contentDensity: PresentationLayoutDensity;
  readonly units: readonly PresentationPageContentUnitFeature[];
}

export interface PresentationLayoutCanvas {
  readonly width: number;
  readonly height: number;
}

export interface PresentationLayoutTypographyTokens {
  readonly fontFamily: string;
  readonly minimumFontSize: number;
  readonly maximumFontSize: number;
  readonly baseFontSize: number;
}

export interface PresentationLayoutSpacingTokens {
  readonly baseGap: number;
  readonly minimumGap: number;
}

export interface PresentationLayoutColorTokens {
  readonly background: string;
  readonly surface: string;
  readonly accent: string;
  readonly secondaryAccent: string;
  readonly text: string;
  readonly muted: string;
}

export interface PresentationLayoutThemeTokens {
  readonly typography: PresentationLayoutTypographyTokens;
  readonly spacing: PresentationLayoutSpacingTokens;
  readonly colors: PresentationLayoutColorTokens;
}

/** Page-level limits describe available extents and insets, not element placement. */
export interface PresentationPageConstraint {
  readonly pageNumber: number;
  readonly pageRole: PresentationPageRole;
  readonly pageIntent: string;
  readonly designIntent: {
    readonly composition: {
      readonly principle: PresentationCompositionPrinciple;
      readonly focalArea: PresentationFocalArea;
      readonly balance: PresentationBalance;
      readonly flow: PresentationLayoutFlow;
    };
    readonly emphasis: {
      readonly target: string;
      readonly strength: PresentationEmphasisStrength;
    };
    readonly whitespace: PresentationDesignWhitespace;
  };
  readonly density: PresentationLayoutDensity;
  readonly contentDensity: PresentationLayoutDensity;
  readonly safeArea: {
    readonly topInset: number;
    readonly rightInset: number;
    readonly bottomInset: number;
    readonly leftInset: number;
  };
  readonly contentBounds: {
    readonly maximumWidth: number;
    readonly maximumHeight: number;
  };
  readonly minimumGap: number;
  readonly preferredGap: number;
  readonly maximumElementCount: number;
  readonly elements: readonly PresentationElementConstraint[];
  readonly relationships: readonly PresentationRelationshipConstraint[];
}

export interface PresentationElementConstraint {
  readonly sourceRef: string;
  readonly role: PresentationLayoutElementRole;
  readonly hierarchy: PresentationLayoutHierarchyLevel;
  readonly priority: number;
  readonly textLength: number;
  readonly estimatedTextWidthEm: number;
  readonly itemCount: number;
  readonly tableRows?: number;
  readonly tableColumns?: number;
  readonly tableCellWidthsEm?: readonly (readonly number[])[];
  readonly preferredRegion: PresentationLayoutRegion;
  readonly alignment: PresentationLayoutAlignment;
  readonly minWidth: number;
  readonly preferredWidth: number;
  readonly maxWidth: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly preferredHeight: number;
  readonly minimumFontSize: number;
  readonly preferredFontSize: number;
  readonly maximumFontSize: number;
  readonly aspectRatio?: number;
}

export interface PresentationRelationshipConstraint {
  readonly kind: PresentationLayoutRelationshipKind;
  readonly fromRef: string;
  readonly toRef: string;
  readonly strength: 'required' | 'preferred';
}

/** Layout Constraint Model v1. Its contract intentionally has no x/y fields. */
export interface PresentationLayoutConstraintModel {
  readonly schemaVersion: 1;
  readonly canvas: PresentationLayoutCanvas;
  readonly themeTokens: PresentationLayoutThemeTokens;
  readonly pages: readonly PresentationPageConstraint[];
}

export interface PresentationLayoutConstraintDiagnostic {
  readonly code: 'invalid_shape' | 'unknown_field' | 'invalid_value' | 'invalid_reference' | 'page_count_mismatch' | 'duplicate_page';
  readonly path: string;
  readonly message: string;
}

export class PresentationLayoutConstraintParseError extends TypeError {
  readonly diagnostics: readonly PresentationLayoutConstraintDiagnostic[];

  constructor(diagnostics: readonly PresentationLayoutConstraintDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Invalid Presentation Layout Constraint Model');
    this.name = 'PresentationLayoutConstraintParseError';
    this.diagnostics = diagnostics;
  }
}

export interface PresentationLayoutConstraintValidationOptions {
  readonly expectedPageCount?: number;
  readonly validSourceRefsByPage?: readonly { readonly pageNumber: number; readonly sourceRefs: readonly string[] }[];
}

const MAX_PAGES = 40;
const MAX_ELEMENTS_PER_PAGE = 128;
const MAX_TEXT_LENGTH = 48_000;
const MAX_DIMENSION = 100_000;
const sourceRefPattern = /^(?:outline\.(?:title|sections\[(?:0|[1-9]\d*)\](?:\.(?:heading|takeaway|action|blocks\[(?:0|[1-9]\d*)\](?:\.items\[(?:0|[1-9]\d*)\])?))?)|generated\.page-number)$/u;

export function parsePresentationLayoutConstraintModel(
  value: unknown,
  options: PresentationLayoutConstraintValidationOptions = {}
): PresentationLayoutConstraintModel {
  const diagnostics = validatePresentationLayoutConstraintModel(value, options);
  if (diagnostics.length > 0 || !isRecord(value)) throw new PresentationLayoutConstraintParseError(diagnostics);
  return value as unknown as PresentationLayoutConstraintModel;
}

export function validatePresentationLayoutConstraintModel(
  value: unknown,
  options: PresentationLayoutConstraintValidationOptions = {}
): readonly PresentationLayoutConstraintDiagnostic[] {
  const diagnostics: PresentationLayoutConstraintDiagnostic[] = [];
  if (!isRecord(value)) return [issue('invalid_shape', '$', 'model must be an object')];
  checkKeys(value, ['schemaVersion', 'canvas', 'themeTokens', 'pages'], '$', diagnostics);
  if (value.schemaVersion !== 1) diagnostics.push(issue('invalid_value', '$.schemaVersion', 'schemaVersion must be 1'));
  validateCanvas(value.canvas, '$.canvas', diagnostics);
  validateTheme(value.themeTokens, '$.themeTokens', diagnostics);
  if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > MAX_PAGES) {
    diagnostics.push(issue('invalid_shape', '$.pages', `pages must contain 1-${MAX_PAGES} items`));
  } else {
    const pageNumbers: number[] = [];
    value.pages.forEach((page, index) => {
      const pagePath = `$.pages[${index}]`;
      if (!isRecord(page)) { diagnostics.push(issue('invalid_shape', pagePath, 'page must be an object')); return; }
      checkKeys(page, ['pageNumber', 'pageRole', 'pageIntent', 'designIntent', 'density', 'contentDensity', 'safeArea', 'contentBounds', 'minimumGap', 'preferredGap', 'maximumElementCount', 'elements', 'relationships'], pagePath, diagnostics);
      if (!isIntegerInRange(page.pageNumber, 1, MAX_PAGES)) diagnostics.push(issue('invalid_value', `${pagePath}.pageNumber`, 'pageNumber is out of range'));
      else pageNumbers.push(page.pageNumber);
      if (typeof page.pageRole !== 'string' || !enumHas(['hero', 'statement', 'comparison', 'metric', 'process', 'evidence', 'section', 'content', 'closing'], page.pageRole)) diagnostics.push(issue('invalid_value', `${pagePath}.pageRole`, 'pageRole is invalid'));
      if (typeof page.pageIntent !== 'string' || page.pageIntent.trim().length === 0 || page.pageIntent.length > 600) diagnostics.push(issue('invalid_value', `${pagePath}.pageIntent`, 'pageIntent must contain 1-600 characters'));
      if (!enumHas(presentationLayoutDensityLevels, page.density)) diagnostics.push(issue('invalid_value', `${pagePath}.density`, 'density is invalid'));
      if (!enumHas(presentationLayoutDensityLevels, page.contentDensity)) diagnostics.push(issue('invalid_value', `${pagePath}.contentDensity`, 'contentDensity is invalid'));
      validatePageLimits(page, pagePath, diagnostics);
      const refs = new Set<string>();
      if (!Array.isArray(page.elements) || page.elements.length > MAX_ELEMENTS_PER_PAGE) diagnostics.push(issue('invalid_shape', `${pagePath}.elements`, `elements must contain at most ${MAX_ELEMENTS_PER_PAGE} items`));
      else page.elements.forEach((element, elementIndex) => validateElement(element, `${pagePath}.elements[${elementIndex}]`, refs, diagnostics));
      if (!Array.isArray(page.relationships) || page.relationships.length > MAX_ELEMENTS_PER_PAGE * 2) diagnostics.push(issue('invalid_shape', `${pagePath}.relationships`, 'relationships must be a bounded array'));
      else page.relationships.forEach((relationship, relationshipIndex) => validateRelationship(relationship, `${pagePath}.relationships[${relationshipIndex}]`, refs, diagnostics));
      validateDesignIntent(page.designIntent, `${pagePath}.designIntent`, refs, diagnostics);
    });
    const duplicates = pageNumbers.filter((page, index) => pageNumbers.indexOf(page) !== index);
    duplicates.forEach(page => diagnostics.push(issue('duplicate_page', '$.pages', `page ${page} is duplicated`)));
    if (options.expectedPageCount !== undefined && value.pages.length !== options.expectedPageCount) diagnostics.push(issue('page_count_mismatch', '$.pages', `expected ${options.expectedPageCount} pages`));
    if (pageNumbers.length === value.pages.length) {
      pageNumbers.forEach((pageNumber, index) => {
        if (pageNumber !== index + 1) diagnostics.push(issue('page_count_mismatch', `$.pages[${index}].pageNumber`, 'pages must be ordered consecutively from 1'));
      });
    }
    if (options.validSourceRefsByPage) validatePageReferences(value.pages, options.validSourceRefsByPage, diagnostics);
  }
  return diagnostics;
}

function validateCanvas(value: unknown, path: string, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_shape', path, 'canvas must be an object')); return; }
  checkKeys(value, ['width', 'height'], path, diagnostics);
  for (const key of ['width', 'height'] as const) if (!isPositiveFinite(value[key], MAX_DIMENSION)) diagnostics.push(issue('invalid_value', `${path}.${key}`, 'must be a positive bounded number'));
}

function validateTheme(value: unknown, path: string, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_shape', path, 'themeTokens must be an object')); return; }
  checkKeys(value, ['typography', 'spacing', 'colors'], path, diagnostics);
  if (isRecord(value.typography)) {
    checkKeys(value.typography, ['fontFamily', 'minimumFontSize', 'maximumFontSize', 'baseFontSize'], `${path}.typography`, diagnostics);
    if (typeof value.typography.fontFamily !== 'string' || value.typography.fontFamily.trim().length === 0 || value.typography.fontFamily.length > 128) diagnostics.push(issue('invalid_value', `${path}.typography.fontFamily`, 'fontFamily must contain 1-128 characters'));
    const min = value.typography.minimumFontSize;
    const max = value.typography.maximumFontSize;
    const base = value.typography.baseFontSize;
    if (![min, max, base].every(item => isPositiveFinite(item, 300)) || (typeof min === 'number' && typeof max === 'number' && min > max)) diagnostics.push(issue('invalid_value', `${path}.typography`, 'font size bounds are invalid'));
    if (typeof base === 'number' && typeof min === 'number' && typeof max === 'number' && (base < min || base > max)) diagnostics.push(issue('invalid_value', `${path}.typography.baseFontSize`, 'base font size must be within the font bounds'));
  } else diagnostics.push(issue('invalid_shape', `${path}.typography`, 'typography must be an object'));
  if (isRecord(value.spacing)) {
    checkKeys(value.spacing, ['baseGap', 'minimumGap'], `${path}.spacing`, diagnostics);
    const base = value.spacing.baseGap;
    const min = value.spacing.minimumGap;
    if (![base, min].every(item => isNonNegativeFinite(item, MAX_DIMENSION)) || (typeof base === 'number' && typeof min === 'number' && min > base)) diagnostics.push(issue('invalid_value', `${path}.spacing`, 'spacing bounds are invalid'));
  } else diagnostics.push(issue('invalid_shape', `${path}.spacing`, 'spacing must be an object'));
  if (isRecord(value.colors)) {
    const colorKeys = ['background', 'surface', 'accent', 'secondaryAccent', 'text', 'muted'] as const;
    checkKeys(value.colors, colorKeys, `${path}.colors`, diagnostics);
    for (const key of colorKeys) if (typeof value.colors[key] !== 'string' || !/^[0-9A-F]{6}$/iu.test(value.colors[key] as string)) diagnostics.push(issue('invalid_value', `${path}.colors.${key}`, 'color must be a six digit hex value'));
  } else diagnostics.push(issue('invalid_shape', `${path}.colors`, 'colors must be an object'));
}

function validatePageLimits(page: Record<string, unknown>, path: string, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  for (const [container, allowed] of [['safeArea', ['topInset', 'rightInset', 'bottomInset', 'leftInset']], ['contentBounds', ['maximumWidth', 'maximumHeight']]] as const) {
    const value = page[container];
    if (!isRecord(value)) { diagnostics.push(issue('invalid_shape', `${path}.${container}`, `${container} must be an object`)); continue; }
    checkKeys(value, allowed, `${path}.${container}`, diagnostics);
    for (const key of allowed) if (!isNonNegativeFinite(value[key], MAX_DIMENSION)) diagnostics.push(issue('invalid_value', `${path}.${container}.${key}`, `${key} must be a non-negative bounded number`));
  }
  for (const key of ['minimumGap', 'preferredGap'] as const) if (!isNonNegativeFinite(page[key], MAX_DIMENSION)) diagnostics.push(issue('invalid_value', `${path}.${key}`, `${key} must be a non-negative bounded number`));
  if (typeof page.minimumGap === 'number' && typeof page.preferredGap === 'number' && page.minimumGap > page.preferredGap) diagnostics.push(issue('invalid_value', `${path}.minimumGap`, 'minimumGap cannot exceed preferredGap'));
  if (!isIntegerInRange(page.maximumElementCount, 1, MAX_ELEMENTS_PER_PAGE)) diagnostics.push(issue('invalid_value', `${path}.maximumElementCount`, 'maximumElementCount is out of range'));
}

function validateDesignIntent(value: unknown, path: string, refs: Set<string>, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_shape', path, 'designIntent must be an object')); return; }
  checkKeys(value, ['composition', 'emphasis', 'whitespace'], path, diagnostics);
  if (isRecord(value.composition)) {
    checkKeys(value.composition, ['principle', 'focalArea', 'balance', 'flow'], `${path}.composition`, diagnostics);
    if (!enumHas(presentationCompositionPrinciples, value.composition.principle)) diagnostics.push(issue('invalid_value', `${path}.composition.principle`, 'composition principle is invalid'));
    if (!enumHas(presentationFocalAreas, value.composition.focalArea)) diagnostics.push(issue('invalid_value', `${path}.composition.focalArea`, 'focalArea is invalid'));
    if (!enumHas(presentationBalances, value.composition.balance)) diagnostics.push(issue('invalid_value', `${path}.composition.balance`, 'balance is invalid'));
    if (!enumHas(presentationLayoutFlows, value.composition.flow)) diagnostics.push(issue('invalid_value', `${path}.composition.flow`, 'flow is invalid'));
  } else diagnostics.push(issue('invalid_shape', `${path}.composition`, 'composition must be an object'));
  if (isRecord(value.emphasis)) {
    checkKeys(value.emphasis, ['target', 'strength'], `${path}.emphasis`, diagnostics);
    if (typeof value.emphasis.target !== 'string' || !refs.has(value.emphasis.target)) diagnostics.push(issue('invalid_reference', `${path}.emphasis.target`, 'emphasis target must reference a page element'));
    if (!enumHas(presentationEmphasisStrengths, value.emphasis.strength)) diagnostics.push(issue('invalid_value', `${path}.emphasis.strength`, 'emphasis strength is invalid'));
  } else diagnostics.push(issue('invalid_shape', `${path}.emphasis`, 'emphasis must be an object'));
  if (!enumHas(presentationDesignWhitespaces, value.whitespace)) diagnostics.push(issue('invalid_value', `${path}.whitespace`, 'whitespace is invalid'));
}

function validateElement(value: unknown, path: string, refs: Set<string>, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_shape', path, 'element constraint must be an object')); return; }
  checkKeys(value, ['sourceRef', 'role', 'hierarchy', 'priority', 'textLength', 'estimatedTextWidthEm', 'itemCount', 'tableRows', 'tableColumns', 'tableCellWidthsEm', 'preferredRegion', 'alignment', 'minWidth', 'preferredWidth', 'maxWidth', 'minHeight', 'maxHeight', 'preferredHeight', 'minimumFontSize', 'preferredFontSize', 'maximumFontSize', 'aspectRatio'], path, diagnostics, ['aspectRatio', 'tableRows', 'tableColumns', 'tableCellWidthsEm']);
  if (typeof value.sourceRef !== 'string' || !sourceRefPattern.test(value.sourceRef)) diagnostics.push(issue('invalid_reference', `${path}.sourceRef`, 'sourceRef must identify Outline content'));
  else if (refs.has(value.sourceRef)) diagnostics.push(issue('invalid_reference', `${path}.sourceRef`, 'sourceRef must be unique on the page'));
  else refs.add(value.sourceRef);
  if (!enumHas(presentationLayoutElementRoles, value.role)) diagnostics.push(issue('invalid_value', `${path}.role`, 'role is invalid'));
  if (!enumHas(presentationLayoutHierarchyLevels, value.hierarchy)) diagnostics.push(issue('invalid_value', `${path}.hierarchy`, 'hierarchy is invalid'));
  if (!isIntegerInRange(value.priority, 0, 100)) diagnostics.push(issue('invalid_value', `${path}.priority`, 'priority must be from 0 to 100'));
  if (!isIntegerInRange(value.textLength, 0, MAX_TEXT_LENGTH)) diagnostics.push(issue('invalid_value', `${path}.textLength`, 'textLength is out of range'));
  if (!isNonNegativeFinite(value.estimatedTextWidthEm, MAX_TEXT_LENGTH * 2)) diagnostics.push(issue('invalid_value', `${path}.estimatedTextWidthEm`, 'estimatedTextWidthEm is out of range'));
  if (!isIntegerInRange(value.itemCount, 0, MAX_ELEMENTS_PER_PAGE)) diagnostics.push(issue('invalid_value', `${path}.itemCount`, 'itemCount is out of range'));
  validateTableMetrics(value, path, diagnostics);
  if (!enumHas(presentationLayoutRegions, value.preferredRegion)) diagnostics.push(issue('invalid_value', `${path}.preferredRegion`, 'preferredRegion is invalid'));
  if (!enumHas(presentationLayoutAlignments, value.alignment)) diagnostics.push(issue('invalid_value', `${path}.alignment`, 'alignment is invalid'));
  for (const key of ['minWidth', 'preferredWidth', 'maxWidth', 'minHeight', 'maxHeight', 'preferredHeight', 'minimumFontSize', 'preferredFontSize', 'maximumFontSize'] as const) if (!isPositiveFinite(value[key], MAX_DIMENSION)) diagnostics.push(issue('invalid_value', `${path}.${key}`, `${key} must be a positive bounded number`));
  validateRange(value, 'minWidth', 'maxWidth', path, diagnostics);
  validateRange(value, 'minWidth', 'preferredWidth', path, diagnostics);
  validateRange(value, 'preferredWidth', 'maxWidth', path, diagnostics);
  validateRange(value, 'minHeight', 'maxHeight', path, diagnostics);
  validateRange(value, 'minimumFontSize', 'maximumFontSize', path, diagnostics);
  if (typeof value.minimumFontSize === 'number' && typeof value.preferredFontSize === 'number' && typeof value.maximumFontSize === 'number' && (value.preferredFontSize < value.minimumFontSize || value.preferredFontSize > value.maximumFontSize)) diagnostics.push(issue('invalid_value', `${path}.preferredFontSize`, 'preferred font size must be within the font bounds'));
  if (typeof value.preferredHeight === 'number' && typeof value.minHeight === 'number' && typeof value.maxHeight === 'number' && (value.preferredHeight < value.minHeight || value.preferredHeight > value.maxHeight)) diagnostics.push(issue('invalid_value', `${path}.preferredHeight`, 'preferred height must be within the height bounds'));
  if (value.aspectRatio !== undefined && !isPositiveFinite(value.aspectRatio, 1_000)) diagnostics.push(issue('invalid_value', `${path}.aspectRatio`, 'aspectRatio must be a positive bounded number'));
}

function validateTableMetrics(value: Record<string, unknown>, path: string, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  const fields = ['tableRows', 'tableColumns', 'tableCellWidthsEm'] as const;
  const hasMetrics = fields.some(field => Object.prototype.hasOwnProperty.call(value, field));
  if (value.role !== 'table') {
    if (hasMetrics) diagnostics.push(issue('invalid_value', path, 'table metrics are only valid for table elements'));
    return;
  }
  if (!isIntegerInRange(value.tableRows, 1, 60)) diagnostics.push(issue('invalid_value', `${path}.tableRows`, 'tableRows must be from 1 to 60'));
  if (!isIntegerInRange(value.tableColumns, 1, 12)) diagnostics.push(issue('invalid_value', `${path}.tableColumns`, 'tableColumns must be from 1 to 12'));
  const rows = value.tableRows;
  const columns = value.tableColumns;
  const matrix = value.tableCellWidthsEm;
  if (!Array.isArray(matrix) || matrix.length !== (typeof rows === 'number' ? rows + 1 : -1)) {
    diagnostics.push(issue('invalid_shape', `${path}.tableCellWidthsEm`, 'tableCellWidthsEm must include a header and every body row'));
    return;
  }
  matrix.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns) {
      diagnostics.push(issue('invalid_shape', `${path}.tableCellWidthsEm[${rowIndex}]`, 'table cell width row must match tableColumns'));
      return;
    }
    row.forEach((width, columnIndex) => {
      if (!isNonNegativeFinite(width, MAX_TEXT_LENGTH * 2)) diagnostics.push(issue('invalid_value', `${path}.tableCellWidthsEm[${rowIndex}][${columnIndex}]`, 'cell width must be a bounded non-negative number'));
    });
  });
}

function validateRelationship(value: unknown, path: string, refs: Set<string>, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  if (!isRecord(value)) { diagnostics.push(issue('invalid_shape', path, 'relationship must be an object')); return; }
  checkKeys(value, ['kind', 'fromRef', 'toRef', 'strength'], path, diagnostics);
  if (!enumHas(presentationLayoutRelationships, value.kind)) diagnostics.push(issue('invalid_value', `${path}.kind`, 'relationship kind is invalid'));
  for (const key of ['fromRef', 'toRef'] as const) if (typeof value[key] !== 'string' || !refs.has(value[key] as string)) diagnostics.push(issue('invalid_reference', `${path}.${key}`, `${key} must reference a page element`));
  if (value.fromRef === value.toRef) diagnostics.push(issue('invalid_reference', path, 'relationship endpoints must differ'));
  if (!['required', 'preferred'].includes(String(value.strength))) diagnostics.push(issue('invalid_value', `${path}.strength`, 'strength is invalid'));
}

function validatePageReferences(pages: unknown[], validPages: readonly { readonly pageNumber: number; readonly sourceRefs: readonly string[] }[], diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  const inventory = new Map(validPages.map(page => [page.pageNumber, new Set(page.sourceRefs)]));
  pages.forEach((page, index) => {
    if (!isRecord(page) || !Array.isArray(page.elements)) return;
    const allowed = inventory.get(Number(page.pageNumber));
    page.elements.forEach((element, elementIndex) => {
      if (isRecord(element) && typeof element.sourceRef === 'string' && allowed && !allowed.has(element.sourceRef)) diagnostics.push(issue('invalid_reference', `$.pages[${index}].elements[${elementIndex}].sourceRef`, 'sourceRef does not belong to this page'));
    });
  });
}

function validateRange(value: Record<string, unknown>, minimum: string, maximum: string, path: string, diagnostics: PresentationLayoutConstraintDiagnostic[]): void {
  if (typeof value[minimum] === 'number' && typeof value[maximum] === 'number' && value[minimum] > value[maximum]) diagnostics.push(issue('invalid_value', `${path}.${minimum}`, `${minimum} cannot exceed ${maximum}`));
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, diagnostics: PresentationLayoutConstraintDiagnostic[], optional: readonly string[] = []): void {
  Object.keys(value).filter(key => !allowed.includes(key)).forEach(key => diagnostics.push(issue('unknown_field', `${path}.${key}`, 'unknown field is not allowed')));
  allowed.filter(key => !optional.includes(key) && !Object.prototype.hasOwnProperty.call(value, key)).forEach(key => diagnostics.push(issue('invalid_shape', `${path}.${key}`, 'required field is missing')));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isPositiveFinite(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
}

function isNonNegativeFinite(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function enumHas<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function issue(code: PresentationLayoutConstraintDiagnostic['code'], path: string, message: string): PresentationLayoutConstraintDiagnostic {
  return { code, path, message };
}
