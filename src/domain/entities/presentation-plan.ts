import {
  presentationPageKinds,
  presentationTemplateIds,
  type DocumentOutlineBlock,
  type PresentationPageKind,
  type PresentationTemplateId
} from './document-generation';

export const presentationCompositionKinds = [
  'cover',
  'section',
  'editorial',
  'split',
  'cards',
  'timeline',
  'data',
  'image_text',
  'closing'
] as const;
export type PresentationPlanCompositionKind =
  (typeof presentationCompositionKinds)[number];

export interface PresentationPlanCapacity {
  readonly contentGroups: number;
  readonly bodyCharacters: number;
  readonly maxContentGroups: number;
  readonly maxBodyCharacters: number;
  readonly maxTableColumns: number;
  readonly minBodyFontSize: number;
  readonly withinLimit: boolean;
}

export interface PresentationPlanElement {
  readonly elementId: string;
  readonly sourceBlockIndex?: number;
  readonly content: DocumentOutlineBlock;
}

export type PresentationSceneElementType =
  | 'text' | 'shape' | 'line' | 'image' | 'table' | 'chart' | 'group';

export interface PresentationSceneGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PresentationSceneStyle {
  readonly fill?: string;
  readonly stroke?: string;
  readonly textColor?: string;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly radius?: number;
}

export interface PresentationSceneElement {
  readonly elementId: string;
  readonly type: PresentationSceneElementType;
  readonly geometry: PresentationSceneGeometry;
  readonly zIndex: number;
  readonly parentId?: string;
  readonly readingOrder?: number;
  readonly content?: string;
  readonly assetRef?: string;
  readonly style?: PresentationSceneStyle;
}

export interface PresentationPageScene {
  readonly schemaVersion: 1;
  readonly elements: readonly PresentationSceneElement[];
}

export interface PresentationPlanPage {
  readonly pageId?: string;
  readonly pageRevision?: number;
  readonly pageNumber: number;
  readonly sourceSection: string;
  readonly pageKind: PresentationPageKind;
  readonly layout: PresentationPageKind;
  readonly composition: PresentationPlanCompositionKind;
  readonly takeaway?: string;
  readonly elements: readonly PresentationPlanElement[];
  readonly capacity: PresentationPlanCapacity;
  readonly sourceRefs: readonly string[];
  readonly preserve: readonly string[];
  readonly scene?: PresentationPageScene;
}

export interface PresentationPlanRevision {
  readonly baseWorkId: string;
  readonly expectedRevision: number;
  readonly targetPages: readonly number[];
}

export interface PresentationPlan {
  readonly kind: 'ppt';
  readonly title: string;
  readonly templateId: PresentationTemplateId;
  readonly pages: readonly PresentationPlanPage[];
  readonly sourceRefs: readonly string[];
  readonly preserve: readonly string[];
  readonly revision?: PresentationPlanRevision;
}

const limits = {
  maxTextLength: 2_000,
  maxTitleLength: 200,
  maxPages: 40,
  maxElements: 100,
  maxListItems: 100,
  maxTableColumns: 50,
  maxTableRows: 200,
  maxChartItems: 50
} as const;

export function parsePresentationPlan(value: unknown): PresentationPlan {
  const record = requireRecord(value, 'PresentationPlan');
  requireExactKeys(record, [
    'kind',
    'title',
    'templateId',
    'pages',
    'sourceRefs',
    'preserve',
    'revision'
  ]);
  if (record.kind !== 'ppt') {
    throw new TypeError('PresentationPlan.kind must be ppt');
  }
  const pages = requireArray(record.pages, 'pages');
  if (pages.length === 0 || pages.length > limits.maxPages) {
    throw new TypeError('PresentationPlan.pages has an invalid length');
  }
  const parsedPages = pages.map((page, index) => parsePage(page, index));
  parsedPages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) {
      throw new TypeError('PresentationPlan page numbers must be contiguous');
    }
  });
  return {
    kind: 'ppt',
    title: requireText(record.title, 'title', limits.maxTitleLength),
    templateId: requireEnum(
      record.templateId,
      presentationTemplateIds,
      'templateId'
    ),
    pages: parsedPages,
    sourceRefs: requireUniqueTextList(record.sourceRefs, 'sourceRefs'),
    preserve: requireUniqueTextList(record.preserve, 'preserve'),
    ...(record.revision !== undefined
      ? { revision: parseRevision(record.revision, parsedPages.length) }
      : {})
  };
}

export function parsePresentationPlanJson(jsonText: string): PresentationPlan {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw new TypeError(
      `PresentationPlan is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return parsePresentationPlan(value);
}

function parsePage(value: unknown, index: number): PresentationPlanPage {
  const label = `pages[${index}]`;
  const record = requireRecord(value, label);
  requireExactKeys(record, [
    'pageNumber',
    'pageId',
    'pageRevision',
    'sourceSection',
    'pageKind',
    'layout',
    'composition',
    'takeaway',
    'elements',
    'capacity',
    'sourceRefs',
    'preserve',
    'scene'
  ]);
  const pageKind = requireEnum(record.pageKind, presentationPageKinds, `${label}.pageKind`);
  const layout = requireEnum(record.layout, presentationPageKinds, `${label}.layout`);
  if (pageKind !== layout) {
    throw new TypeError(`${label}.layout must match pageKind`);
  }
  const elements = requireArray(record.elements, `${label}.elements`);
  if (elements.length > limits.maxElements) {
    throw new TypeError(`${label}.elements exceeds the maximum item count`);
  }
  return {
    ...(record.pageId !== undefined ? { pageId: requireSafeReference(record.pageId, `${label}.pageId`) } : {}),
    ...(record.pageRevision !== undefined ? { pageRevision: requireNonNegativeInteger(record.pageRevision, `${label}.pageRevision`) } : {}),
    pageNumber: requirePositiveInteger(record.pageNumber, `${label}.pageNumber`),
    sourceSection: requireText(record.sourceSection, `${label}.sourceSection`),
    pageKind,
    layout,
    composition: requireEnum(
      record.composition,
      presentationCompositionKinds,
      `${label}.composition`
    ),
    ...(record.takeaway !== undefined
      ? { takeaway: requireText(record.takeaway, `${label}.takeaway`) }
      : {}),
    elements: elements.map((element, elementIndex) =>
      parseElement(element, `${label}.elements[${elementIndex}]`)
    ),
    capacity: parseCapacity(record.capacity, `${label}.capacity`),
    sourceRefs: requireUniqueTextList(record.sourceRefs, `${label}.sourceRefs`),
    preserve: requireUniqueTextList(record.preserve, `${label}.preserve`),
    ...(record.scene !== undefined ? { scene: parseScene(record.scene, `${label}.scene`) } : {})
  };
}

function parseScene(value: unknown, label: string): PresentationPageScene {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['schemaVersion', 'elements']);
  if (record.schemaVersion !== 1) throw new TypeError(`${label}.schemaVersion is invalid`);
  const elements = requireArray(record.elements, `${label}.elements`);
  if (elements.length > limits.maxElements) throw new TypeError(`${label}.elements exceeds the maximum item count`);
  const parsed = elements.map((item, index) => parseSceneElement(item, `${label}.elements[${index}]`));
  const ids = new Set(parsed.map((item) => item.elementId));
  if (ids.size !== parsed.length || parsed.some((item) => item.parentId !== undefined && !ids.has(item.parentId))) {
    throw new TypeError(`${label}.elements contain invalid parent references`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(parsed.map((item) => [item.elementId, item]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`${label}.elements contain a parent cycle`);
    visiting.add(id);
    const parent = byId.get(id)?.parentId;
    if (parent) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  parsed.forEach((item) => visit(item.elementId));
  return { schemaVersion: 1, elements: parsed };
}

function parseSceneElement(value: unknown, label: string): PresentationSceneElement {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['elementId', 'type', 'geometry', 'zIndex', 'parentId', 'readingOrder', 'content', 'assetRef', 'style']);
  const type = requireEnum(record.type, ['text', 'shape', 'line', 'image', 'table', 'chart', 'group'] as const, `${label}.type`);
  const geometry = parseGeometry(record.geometry, `${label}.geometry`);
  const zIndex = requireNonNegativeInteger(record.zIndex, `${label}.zIndex`);
  if (zIndex > 10_000) throw new TypeError(`${label}.zIndex is too large`);
  const content = record.content === undefined ? undefined : requireText(record.content, `${label}.content`);
  const assetRef = record.assetRef === undefined ? undefined : requireSafeReference(record.assetRef, `${label}.assetRef`);
  const style = record.style === undefined ? undefined : parseSceneStyle(record.style, `${label}.style`);
  if (type === 'image' && assetRef === undefined) throw new TypeError(`${label}.image requires assetRef`);
  return {
    elementId: requireSafeReference(record.elementId, `${label}.elementId`),
    type,
    geometry,
    zIndex,
    ...(record.parentId !== undefined ? { parentId: requireSafeReference(record.parentId, `${label}.parentId`) } : {}),
    ...(record.readingOrder !== undefined ? { readingOrder: requireNonNegativeInteger(record.readingOrder, `${label}.readingOrder`) } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(assetRef !== undefined ? { assetRef } : {}),
    ...(style !== undefined ? { style } : {})
  };
}

function parseGeometry(value: unknown, label: string): PresentationSceneGeometry {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['x', 'y', 'width', 'height']);
  const numbers = ['x', 'y', 'width', 'height'].map((key) => record[key]);
  if (numbers.some((item) => typeof item !== 'number' || !Number.isFinite(item))) throw new TypeError(`${label} contains invalid numbers`);
  const [x, y, width, height] = numbers as number[];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw new TypeError(`${label} exceeds page bounds`);
  return { x, y, width, height };
}

function parseSceneStyle(value: unknown, label: string): PresentationSceneStyle {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['fill', 'stroke', 'textColor', 'fontSize', 'fontFamily', 'radius']);
  const fields: PresentationSceneStyle = {
    ...(record.fill !== undefined ? { fill: parseColor(record.fill, `${label}.fill`) } : {}),
    ...(record.stroke !== undefined ? { stroke: parseColor(record.stroke, `${label}.stroke`) } : {}),
    ...(record.textColor !== undefined ? { textColor: parseColor(record.textColor, `${label}.textColor`) } : {}),
    ...(record.fontSize !== undefined ? { fontSize: positiveNumber(record.fontSize, `${label}.fontSize`) } : {}),
    ...(record.fontFamily !== undefined ? { fontFamily: requireText(record.fontFamily, `${label}.fontFamily`, 100) } : {}),
    ...(record.radius !== undefined ? { radius: nonNegativeNumber(record.radius, `${label}.radius`) } : {})
  };
  return fields;
}

function parseColor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(value)) throw new TypeError(`${label} is invalid`);
  return value.toUpperCase();
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function parseElement(value: unknown, label: string): PresentationPlanElement {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['elementId', 'sourceBlockIndex', 'content']);
  return {
    elementId: requireSafeReference(record.elementId, `${label}.elementId`),
    ...(record.sourceBlockIndex !== undefined
      ? {
          sourceBlockIndex: requireNonNegativeInteger(
            record.sourceBlockIndex,
            `${label}.sourceBlockIndex`
          )
        }
      : {}),
    content: parseOutlineBlock(record.content, `${label}.content`)
  };
}

function parseCapacity(value: unknown, label: string): PresentationPlanCapacity {
  const record = requireRecord(value, label);
  requireExactKeys(record, [
    'contentGroups',
    'bodyCharacters',
    'maxContentGroups',
    'maxBodyCharacters',
    'maxTableColumns',
    'minBodyFontSize',
    'withinLimit'
  ]);
  const contentGroups = requireNonNegativeInteger(record.contentGroups, `${label}.contentGroups`);
  const bodyCharacters = requireNonNegativeInteger(record.bodyCharacters, `${label}.bodyCharacters`);
  const maxContentGroups = requireNonNegativeInteger(record.maxContentGroups, `${label}.maxContentGroups`);
  const maxBodyCharacters = requireNonNegativeInteger(record.maxBodyCharacters, `${label}.maxBodyCharacters`);
  const maxTableColumns = requirePositiveInteger(record.maxTableColumns, `${label}.maxTableColumns`);
  const minBodyFontSize = requirePositiveInteger(record.minBodyFontSize, `${label}.minBodyFontSize`);
  if (typeof record.withinLimit !== 'boolean') {
    throw new TypeError(`${label}.withinLimit must be a boolean`);
  }
  const expectedWithinLimit =
    contentGroups <= maxContentGroups && bodyCharacters <= maxBodyCharacters;
  if (record.withinLimit !== expectedWithinLimit) {
    throw new TypeError(`${label}.withinLimit does not match capacity values`);
  }
  return {
    contentGroups,
    bodyCharacters,
    maxContentGroups,
    maxBodyCharacters,
    maxTableColumns,
    minBodyFontSize,
    withinLimit: record.withinLimit
  };
}

function parseRevision(value: unknown, pageCount: number): PresentationPlanRevision {
  const record = requireRecord(value, 'revision');
  requireExactKeys(record, ['baseWorkId', 'expectedRevision', 'targetPages']);
  const targetPages = requireUniquePositiveIntegerList(record.targetPages, 'revision.targetPages');
  if (targetPages.length === 0 || targetPages.some((page) => page > pageCount)) {
    throw new TypeError('revision.targetPages must identify existing pages');
  }
  return {
    baseWorkId: requireSafeReference(record.baseWorkId, 'revision.baseWorkId'),
    expectedRevision: requireNonNegativeInteger(record.expectedRevision, 'revision.expectedRevision'),
    targetPages
  };
}

function parseOutlineBlock(value: unknown, label: string): DocumentOutlineBlock {
  const record = requireRecord(value, label);
  if (typeof record.type !== 'string') throw new TypeError(`${label}.type is invalid`);
  switch (record.type) {
    case 'paragraph':
    case 'quote':
      requireExactKeys(record, ['type', 'text']);
      return { type: record.type, text: requireText(record.text, `${label}.text`) };
    case 'bullets':
    case 'numbered':
      requireExactKeys(record, ['type', 'items']);
      return {
        type: record.type,
        items: requireTextList(record.items, `${label}.items`, limits.maxListItems)
      };
    case 'table': {
      requireExactKeys(record, ['type', 'header', 'rows']);
      const header = requireTextList(record.header, `${label}.header`, limits.maxTableColumns);
      const rows = requireArray(record.rows, `${label}.rows`);
      if (header.length === 0 || rows.length > limits.maxTableRows) {
        throw new TypeError(`${label} table dimensions are invalid`);
      }
      return {
        type: 'table',
        header,
        rows: rows.map((row, rowIndex) => {
          const cells = requireTextList(row, `${label}.rows[${rowIndex}]`, limits.maxTableColumns, true);
          if (cells.length !== header.length) {
            throw new TypeError(`${label}.rows[${rowIndex}] has an invalid column count`);
          }
          return cells;
        })
      };
    }
    case 'chart': {
      requireExactKeys(record, ['type', 'chartKind', 'title', 'data']);
      if (record.chartKind !== 'bar' && record.chartKind !== 'pie') {
        throw new TypeError(`${label}.chartKind is invalid`);
      }
      const data = requireArray(record.data, `${label}.data`);
      if (data.length > limits.maxChartItems) throw new TypeError(`${label}.data is too large`);
      return {
        type: 'chart',
        chartKind: record.chartKind,
        ...(record.title !== undefined
          ? { title: requireText(record.title, `${label}.title`) }
          : {}),
        data: data.map((item, itemIndex) => {
          const point = requireRecord(item, `${label}.data[${itemIndex}]`);
          requireExactKeys(point, ['label', 'value']);
          if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
            throw new TypeError(`${label}.data[${itemIndex}].value is invalid`);
          }
          return {
            label: requireText(point.label, `${label}.data[${itemIndex}].label`),
            value: point.value
          };
        })
      };
    }
    default:
      throw new TypeError(`${label}.type is unsupported`);
  }
}

function requireSafeReference(value: unknown, label: string): string {
  const reference = requireText(value, label, 200);
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/i.test(reference)) {
    throw new TypeError(`${label} must not contain a path or URL`);
  }
  return reference;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`unsupported field: ${unsupported}`);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function requireText(value: unknown, label: string, maxLength: number = limits.maxTextLength): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  if (value.length > maxLength) throw new TypeError(`${label} exceeds the maximum length`);
  return value;
}

function requireTextList(
  value: unknown,
  label: string,
  maxItems: number = limits.maxListItems,
  allowBlank = false
): readonly string[] {
  const list = requireArray(value, label);
  if (list.length > maxItems) throw new TypeError(`${label} exceeds the maximum item count`);
  return list.map((item, index) => {
    if (allowBlank && item === '') return '';
    return requireText(item, `${label}[${index}]`);
  });
}

function requireUniqueTextList(value: unknown, label: string): readonly string[] {
  const list = requireTextList(value, label);
  if (new Set(list).size !== list.length) throw new TypeError(`${label} must not contain duplicates`);
  return list;
}

function requireUniquePositiveIntegerList(value: unknown, label: string): readonly number[] {
  const list = requireArray(value, label).map((item, index) =>
    requirePositiveInteger(item, `${label}[${index}]`)
  );
  if (new Set(list).size !== list.length) throw new TypeError(`${label} must not contain duplicates`);
  return list;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}
