/** A bounded, model-authored composition inside the production Design IR. */
export const designTreeNodeTypes = ['row', 'column', 'grid', 'overlay', 'content', 'shape', 'image'] as const;
export const designTreeAnchors = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
export interface PresentationNodeStyle {
  readonly fontSize?: number;
  /** The Office writer supports regular/bold, not arbitrary variable-font weights. */
  readonly fontWeight?: 400 | 700;
  readonly fontFamily?: string;
  readonly color?: string;
  readonly fill?: string;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly alignment?: 'left' | 'center' | 'right' | 'justify';
  readonly verticalAlignment?: 'top' | 'middle' | 'bottom';
  readonly lineSpacing?: number;
  readonly charSpacing?: number;
  readonly chartKind?: 'bar' | 'line' | 'pie' | 'doughnut';
  readonly chartColors?: readonly string[];
  readonly showLegend?: boolean;
  readonly showValues?: boolean;
}
export interface PresentationTextSpan {
  readonly start: number;
  readonly end: number;
  readonly style: Pick<PresentationNodeStyle, 'color' | 'fontWeight' | 'fontSize'>;
}
export interface PresentationDesignNode {
  readonly nodeId: string;
  readonly type: (typeof designTreeNodeTypes)[number];
  readonly weight?: number;
  /** Fractions of the parent's short edge; no final coordinates. */
  readonly gap?: number;
  readonly padding?: number;
  readonly columns?: number;
  readonly columnSpan?: number;
  readonly anchor?: (typeof designTreeAnchors)[number];
  readonly widthFraction?: number;
  readonly heightFraction?: number;
  readonly style?: PresentationNodeStyle;
  readonly children?: readonly PresentationDesignNode[];
  readonly contentRef?: string;
  readonly textSpans?: readonly PresentationTextSpan[];
  readonly shapeKind?: 'rect' | 'roundRect' | 'ellipse' | 'line';
  /** Host-projected local asset alias, never a file path or runtime identity. */
  readonly assetKey?: string;
  readonly imageFit?: 'contain' | 'cover';
  readonly imageMask?: 'none' | 'ellipse';
}
export interface PresentationDesignTree {
  readonly schemaVersion: 1;
  readonly root: PresentationDesignNode;
  /** Font reduction is opt-in; composition and proportions are always preserved. */
  readonly minimumFontScale?: number;
}
export class PresentationDesignTreeError extends TypeError {
  constructor(readonly path: string, readonly reason: 'invalid_shape' | 'unknown_field' | 'invalid_content_reference' = 'invalid_shape') {
    super('presentation_design_tree_invalid');
  }
}
const referencePattern = '^outline\\.(?:title|sections\\[(?:0|[1-9]\\d*)\\]\\.(?:heading|takeaway|action|blocks\\[(?:0|[1-9]\\d*)\\](?:\\.items\\[(?:0|[1-9]\\d*)\\])?))$';
const styleKeys = ['fontSize', 'fontWeight', 'fontFamily', 'color', 'fill', 'borderColor', 'borderWidth', 'alignment', 'verticalAlignment', 'lineSpacing', 'charSpacing', 'chartKind', 'chartColors', 'showLegend', 'showValues'] as const;
const nodeKeys = ['nodeId', 'type', 'weight', 'gap', 'padding', 'columns', 'columnSpan', 'anchor', 'widthFraction', 'heightFraction', 'style', 'children', 'contentRef', 'textSpans', 'shapeKind', 'assetKey', 'imageFit', 'imageMask'] as const;

export function parsePresentationNodeStyle(value: unknown, path = '$.style'): PresentationNodeStyle {
  const record = object(value, path, styleKeys);
  if (!Object.keys(record).length) fail(path);
  for (const key of ['color', 'fill', 'borderColor']) if (record[key] !== undefined && (typeof record[key] !== 'string' || !/^[a-f0-9]{6}$/iu.test(record[key]))) fail(`${path}.${key}`);
  for (const [key, min, max] of [['fontSize', 14, 96], ['borderWidth', 0, 8], ['lineSpacing', 1, 2], ['charSpacing', -2, 8]] as const) optionalNumber(record, key, min, max, path);
  if (record.fontWeight !== undefined && record.fontWeight !== 400 && record.fontWeight !== 700) fail(`${path}.fontWeight`);
  if (record.fontFamily !== undefined && (typeof record.fontFamily !== 'string' || !record.fontFamily.trim() || record.fontFamily.length > 80 || /[\u0000-\u001f:/\\]/u.test(record.fontFamily))) fail(`${path}.fontFamily`);
  optionalEnum(record, 'alignment', ['left', 'center', 'right', 'justify'], path);
  optionalEnum(record, 'verticalAlignment', ['top', 'middle', 'bottom'], path);
  optionalEnum(record, 'chartKind', ['bar', 'line', 'pie', 'doughnut'], path);
  if (record.chartColors !== undefined && (!Array.isArray(record.chartColors) || record.chartColors.length < 1 || record.chartColors.length > 8 || record.chartColors.some(color => typeof color !== 'string' || !/^[a-f0-9]{6}$/iu.test(color)))) fail(path);
  for (const key of ['showLegend', 'showValues']) if (record[key] !== undefined && typeof record[key] !== 'boolean') fail(`${path}.${key}`);
  return structuredClone(record) as PresentationNodeStyle;
}

export function parsePresentationDesignTree(value: unknown, allowedRefs?: readonly string[]): PresentationDesignTree {
  const tree = object(value, '$', ['schemaVersion', 'root', 'minimumFontScale']);
  if (tree.schemaVersion !== 1) fail('$.schemaVersion');
  optionalNumber(tree, 'minimumFontScale', 0.7, 1, '$');
  const ids = new Set<string>(), refs = new Set<string>();
  const visit = (value: unknown, path: string, depth: number): PresentationDesignNode => {
    if (depth > 8 || ids.size >= 96) fail(path);
    const node = object(value, path, nodeKeys);
    if (typeof node.nodeId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(node.nodeId) || ids.has(node.nodeId)) fail(`${path}.nodeId`);
    ids.add(node.nodeId);
    if (!designTreeNodeTypes.includes(node.type as PresentationDesignNode['type'])) fail(`${path}.type`);
    const container = ['row', 'column', 'grid', 'overlay'].includes(String(node.type));
    const applicable = new Set<string>(['nodeId', 'type', 'weight', 'columnSpan', 'anchor', 'widthFraction', 'heightFraction', 'style',
      ...(container ? ['gap', 'padding', 'children', ...(node.type === 'grid' ? ['columns'] : [])] : []),
      ...(node.type === 'content' ? ['contentRef', 'textSpans'] : []), ...(node.type === 'shape' ? ['shapeKind'] : []),
      ...(node.type === 'image' ? ['assetKey', 'imageFit', 'imageMask'] : [])]);
    for (const key of Object.keys(node)) if (!applicable.has(key)) fail(`${path}.${key}`, 'unknown_field');
    optionalNumber(node, 'weight', 0.01, 100, path);
    optionalNumber(node, 'gap', 0, 0.08, path); optionalNumber(node, 'padding', 0, 0.1, path);
    optionalNumber(node, 'widthFraction', 0.05, 1, path); optionalNumber(node, 'heightFraction', 0.05, 1, path);
    for (const key of ['columns', 'columnSpan']) if (node[key] !== undefined && (!Number.isInteger(node[key]) || Number(node[key]) < 1 || Number(node[key]) > 8)) fail(`${path}.${key}`);
    optionalEnum(node, 'anchor', designTreeAnchors, path);
    if (node.type === 'overlay' && (node.gap !== undefined || node.children instanceof Array && node.children.some(child => typeof child !== 'object' || child === null || !('anchor' in child)))) fail(path);
    if (node.style !== undefined) parsePresentationNodeStyle(node.style, `${path}.style`);
    if (node.type === 'shape' && node.style && Object.keys(node.style).some(key => !['color', 'fill', 'borderColor', 'borderWidth'].includes(key))) fail(`${path}.style`);
    if (node.type === 'image' && node.style !== undefined) fail(`${path}.style`);
    if (container) {
      if (!Array.isArray(node.children) || !node.children.length || node.children.length > 24) fail(`${path}.children`);
      node.children = node.children.map((child, index) => visit(child, `${path}.children[${index}]`, depth + 1));
      if (node.type === 'grid' && node.columns === undefined) fail(`${path}.columns`);
      for (const child of node.children as PresentationDesignNode[]) {
        if (node.type !== 'row' && node.type !== 'column' && child.weight !== undefined) fail(path);
        if (node.type !== 'grid' && child.columnSpan !== undefined) fail(path);
        if (node.type !== 'overlay' && (child.anchor !== undefined || child.widthFraction !== undefined || child.heightFraction !== undefined)) fail(path);
        if (node.type === 'grid' && (child.columnSpan ?? 1) > Number(node.columns)) fail(path);
      }
    } else if (node.type === 'content') {
      if (typeof node.contentRef !== 'string' || !new RegExp(referencePattern, 'u').test(node.contentRef) || refs.has(node.contentRef) || allowedRefs && !allowedRefs.includes(node.contentRef)) fail(`${path}.contentRef`, 'invalid_content_reference');
      refs.add(node.contentRef);
      if (node.textSpans !== undefined) {
        if (!Array.isArray(node.textSpans) || node.textSpans.length > 32) fail(`${path}.textSpans`);
        let end = 0;
        node.textSpans.forEach((value, index) => {
          const span = object(value, `${path}.textSpans[${index}]`, ['start', 'end', 'style']);
          if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || Number(span.start) < end || Number(span.end) <= Number(span.start) || Number(span.end) > 16000) fail(path);
          const style = object(span.style, path, ['fontSize', 'fontWeight', 'color']);
          parsePresentationNodeStyle(style, path); end = Number(span.end);
        });
      }
    } else if (node.type === 'shape') {
      if (!['rect', 'roundRect', 'ellipse', 'line'].includes(String(node.shapeKind))) fail(`${path}.shapeKind`);
    } else {
      if (typeof node.assetKey !== 'string' || !/^image-[1-9]\d{0,2}$/u.test(node.assetKey)) fail(`${path}.assetKey`);
      if (node.imageFit !== 'contain' && node.imageFit !== 'cover') fail(`${path}.imageFit`);
      optionalEnum(node, 'imageMask', ['none', 'ellipse'], path);
    }
    return structuredClone(node) as unknown as PresentationDesignNode;
  };
  const root = visit(tree.root, '$.root', 0);
  if (root.anchor !== undefined || root.columnSpan !== undefined || root.weight !== undefined || root.widthFraction !== undefined || root.heightFraction !== undefined) fail('$.root');
  return { schemaVersion: 1, root, ...(tree.minimumFontScale === undefined ? {} : { minimumFontScale: Number(tree.minimumFontScale) }) };
}
export function flattenPresentationDesignTree(tree: PresentationDesignTree): readonly PresentationDesignNode[] {
  const nodes: PresentationDesignNode[] = [];
  const visit = (node: PresentationDesignNode) => { nodes.push(node); node.children?.forEach(visit); };
  visit(tree.root); return nodes;
}
export function buildPresentationDesignTreeJsonSchema(): Record<string, unknown> {
  const num = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
  const style = { type: 'object', additionalProperties: false, minProperties: 1, properties: {
    fontSize: num(14, 96), fontWeight: { enum: [400, 700] }, fontFamily: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f:/\\\\]+$' },
    ...Object.fromEntries(['color', 'fill', 'borderColor'].map(key => [key, { type: 'string', pattern: '^[0-9A-Fa-f]{6}$' }])),
    borderWidth: num(0, 8), alignment: { enum: ['left', 'center', 'right', 'justify'] }, verticalAlignment: { enum: ['top', 'middle', 'bottom'] }, lineSpacing: num(1, 2), charSpacing: num(-2, 8),
    chartKind: { enum: ['bar', 'line', 'pie', 'doughnut'] }, chartColors: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[a-fA-F0-9]{6}$' } }, showLegend: { type: 'boolean' }, showValues: { type: 'boolean' }
  } };
  // Local recursive references live under the tree schema, embedded in the sole IR.
  const node = { type: 'object', additionalProperties: false, required: ['nodeId', 'type'], properties: {
    nodeId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,47}$' }, type: { enum: designTreeNodeTypes }, weight: num(0.01, 100), gap: num(0, 0.08), padding: num(0, 0.1),
    columns: { type: 'integer', minimum: 1, maximum: 8 }, columnSpan: { type: 'integer', minimum: 1, maximum: 8 }, anchor: { enum: designTreeAnchors },
    widthFraction: num(0.05, 1), heightFraction: num(0.05, 1), style,
    children: { type: 'array', minItems: 1, maxItems: 24, items: { $ref: '#/$defs/designNode' } }, contentRef: { type: 'string', pattern: referencePattern },
    textSpans: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'style'], properties: {
      start: { type: 'integer', minimum: 0, maximum: 15999 }, end: { type: 'integer', minimum: 1, maximum: 16000 },
      style: { ...style, properties: { fontSize: num(14, 96), fontWeight: { enum: [400, 700] }, color: { type: 'string', pattern: '^[0-9A-Fa-f]{6}$' } } }
    } } }, shapeKind: { enum: ['rect', 'roundRect', 'ellipse', 'line'] }, assetKey: { type: 'string', pattern: '^image-[1-9]\\d{0,2}$' }, imageFit: { enum: ['contain', 'cover'] }, imageMask: { enum: ['none', 'ellipse'] }
  } };
  return { type: 'object', additionalProperties: false, required: ['schemaVersion', 'root'], properties: {
    schemaVersion: { const: 1 }, root: { $ref: '#/$defs/designNode' }, minimumFontScale: num(0.7, 1)
  }, nodeDefinition: node };
}
function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(path);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) fail(path, 'unknown_field');
  return { ...record };
}
function optionalNumber(record: Record<string, unknown>, key: string, min: number, max: number, path: string): void {
  if (record[key] !== undefined && (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || record[key] < min || record[key] > max)) fail(`${path}.${key}`);
}
function optionalEnum(record: Record<string, unknown>, key: string, values: readonly string[], path: string): void {
  if (record[key] !== undefined && !values.includes(String(record[key]))) fail(`${path}.${key}`);
}
function fail(path: string, reason?: PresentationDesignTreeError['reason']): never { throw new PresentationDesignTreeError(path, reason); }
