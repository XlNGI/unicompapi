import type { DocumentOutline, DocumentOutlineBlock } from '../../domain/entities/document-generation';
import {
  type PresentationElementConstraint,
  type PresentationLayoutCanvas,
  type PresentationLayoutConstraintModel,
  type PresentationLayoutElementRole,
  type PresentationLayoutHierarchyLevel,
  type PresentationLayoutRegion,
  type PresentationLayoutThemeTokens,
  type PresentationPageContentUnitFeature,
  type PresentationPageFeatures
} from '../../domain/entities/presentation-layout-constraints';
import {
  parsePresentationDesignIR,
  type PresentationDesignGlobal,
  type PresentationDesignIRPage
} from '../../domain/entities/presentation-design-contract';

const DEFAULT_CANVAS: PresentationLayoutCanvas = { width: 13.333, height: 7.5 };
const DEFAULT_THEME_TOKENS: PresentationLayoutThemeTokens = {
  typography: { fontFamily: 'Microsoft YaHei', minimumFontSize: 14, maximumFontSize: 48, baseFontSize: 24 },
  spacing: { baseGap: 0.28, minimumGap: 0.12 },
  colors: { background: 'FFFFFF', surface: 'FFFFFF', accent: '1F5FBF', secondaryAccent: 'F29A38', text: '1B2638', muted: '64748B' }
};

interface InternalContentUnit extends PresentationPageContentUnitFeature {
  readonly aliases: readonly string[];
}

/**
 * Deterministically extracts renderable content signals for a validated Outline
 * page. It records content references and measures only; it never assigns layout.
 */
export function extractPresentationPageFeatures(
  outline: DocumentOutline,
  page: PresentationDesignIRPage
): PresentationPageFeatures {
  if (outline.kind !== 'ppt') throw new TypeError('Presentation page features require a PPT outline');
  const sectionIndex = page.pageNumber - 2;
  const section = sectionIndex >= 0 && sectionIndex < outline.sections.length ? outline.sections[sectionIndex] : undefined;
  const isCover = page.pageNumber === 1;
  const isClosing = page.pageNumber === outline.sections.length + 2 && outline.sections.length > 0;
  if (!isCover && !isClosing && !section) throw new TypeError(`Page ${page.pageNumber} does not resolve to the Outline`);

  const units = isCover ? coverUnits(outline) : isClosing ? closingUnits(outline) : sectionUnits(section!, sectionIndex);
  const assigned = units.map(unit => applyDesignAssignments(unit, page));
  const contentAssigned = assigned.filter(unit => unit.kind !== 'generated');
  const features = assigned.map(({ aliases: _aliases, ...feature }) => feature);
  const primaryUnit = [...assigned]
    .filter(unit => unit.hierarchy === 'primary')
    .sort((left, right) => left.priority === right.priority ? left.sourceRef.localeCompare(right.sourceRef) : right.priority - left.priority)[0];
  const blockCount = section?.blocks.length ?? 0;
  const textLength = contentAssigned.reduce((total, unit) => total + unit.textLength, 0);
  const metricCount = contentAssigned.reduce((total, unit) => total + unit.metricCount, 0);
  const evidenceCount = contentAssigned.reduce((total, unit) => total + unit.evidenceCount, 0);
  const chartCount = contentAssigned.filter(unit => unit.kind === 'chart').length;
  const tableCount = contentAssigned.filter(unit => unit.kind === 'table').length;
  const imageCount = sceneImageCount(isCover ? outline.coverScene : isClosing ? outline.closingScene : section?.scene);
  const numbered = section?.blocks.some(block => block.type === 'numbered') ?? false;
  const hasSequence = page.pageRole === 'process' || page.composition.flow === 'sequence' || numbered;
  const comparisonCandidate = page.pageRole === 'comparison' || section?.pageKind === 'comparison' ||
    (metricCount >= 2 && evidenceCount >= 2);

  return Object.freeze({
    pageNumber: page.pageNumber,
    pageRole: page.pageRole,
    semanticRole: section?.pageKind ?? (isCover ? 'cover' : isClosing ? 'closing' : page.pageRole),
    textLength,
    blockCount,
    contentUnitCount: contentAssigned.length,
    metricCount,
    evidenceCount,
    chartCount,
    tableCount,
    imageCount,
    hasChart: chartCount > 0,
    hasTable: tableCount > 0,
    hasImage: imageCount > 0,
    hasSequence,
    comparisonCandidate,
    ...(primaryUnit ? { dominantPrimaryContent: primaryUnit.sourceRef } : {}),
    contentDensity: estimateContentDensity(textLength, contentAssigned.length, tableCount, contentAssigned),
    units: Object.freeze(features)
  });
}

export interface BuildPresentationLayoutConstraintModelOptions {
  readonly canvas?: PresentationLayoutCanvas;
  readonly themeTokens?: PresentationLayoutThemeTokens;
}

/** Creates content features and non-geometric constraints for every Design IR page. */
export function buildPresentationLayoutConstraintModel(
  outline: DocumentOutline,
  candidate: unknown,
  options: BuildPresentationLayoutConstraintModelOptions = {}
): { readonly features: readonly PresentationPageFeatures[]; readonly constraints: PresentationLayoutConstraintModel } {
  if (outline.kind !== 'ppt') throw new TypeError('Presentation layout constraints require a PPT outline');
  const design = parsePresentationDesignIR(candidate, {
    outline,
    expectedPageCount: outline.sections.length === 0 ? 1 : outline.sections.length + 2
  });
  const canvas = options.canvas ?? DEFAULT_CANVAS;
  const tokens = options.themeTokens ?? DEFAULT_THEME_TOKENS;
  validateInputs(canvas, tokens);
  const features = design.pages.map(page => extractPresentationPageFeatures(outline, page));
  const pages = design.pages.map((page, index) => derivePageConstraint(page, design.globalDesign, features[index], canvas, tokens));
  return {
    features: Object.freeze(features),
    constraints: Object.freeze({ schemaVersion: 1, canvas, themeTokens: tokens, pages: Object.freeze(pages) })
  };
}

function coverUnits(outline: DocumentOutline): InternalContentUnit[] {
  return [makeUnit('outline.title', 'title', outline.title, ['outline.title']), pageNumberUnit()];
}

function closingUnits(outline: DocumentOutline): InternalContentUnit[] {
  const last = outline.sections.length - 1;
  const section = outline.sections[last];
  if (!section) return coverUnits(outline);
  let takeawayIndex = last;
  while (takeawayIndex >= 0 && !outline.sections[takeawayIndex]?.takeaway) takeawayIndex -= 1;
  return [
    ...(section.action ? [makeUnit(`outline.sections[${last}].action`, 'action', section.action, [`outline.sections[${last}]`])] : []),
    ...(takeawayIndex >= 0 ? [makeUnit(`outline.sections[${takeawayIndex}].takeaway`, 'takeaway', outline.sections[takeawayIndex].takeaway!, [`outline.sections[${takeawayIndex}]`])] : []),
    makeUnit('outline.title', 'title', outline.title, [`outline.sections[${last}]`]),
    pageNumberUnit()
  ];
}

function sectionUnits(section: NonNullable<DocumentOutline['sections'][number]>, sectionIndex: number): InternalContentUnit[] {
  const prefix = `outline.sections[${sectionIndex}]`;
  const units = [makeUnit(`${prefix}.heading`, 'heading', section.heading, [prefix])];
  if (section.takeaway !== undefined) units.push(makeUnit(`${prefix}.takeaway`, 'takeaway', section.takeaway, [prefix]));
  section.blocks.forEach((block, blockIndex) => {
    const ref = `${prefix}.blocks[${blockIndex}]`;
    units.push(...blockUnits(block, ref, prefix));
  });
  if (section.action !== undefined) units.push(makeUnit(`${prefix}.action`, 'action', section.action, [prefix]));
  units.push(pageNumberUnit());
  return units;
}

function pageNumberUnit(): InternalContentUnit {
  return {
    sourceRef: 'generated.page-number',
    kind: 'generated',
    role: 'body',
    hierarchy: 'supporting',
    priority: 5,
    textLength: 2,
    estimatedTextWidthEm: estimateTextWidthEm('0'),
    itemCount: 1,
    metricCount: 0,
    evidenceCount: 0,
    aliases: []
  };
}

function blockUnits(block: DocumentOutlineBlock, ref: string, sectionRef: string): InternalContentUnit[] {
  if (block.type === 'paragraph' || block.type === 'quote') return [makeUnit(ref, block.type, block.text, [sectionRef])];
  if (block.type === 'bullets' || block.type === 'numbered') return block.items.map((text, index) => makeUnit(`${ref}.items[${index}]`, 'item', text, [ref, sectionRef], block.items.length));
  if (block.type === 'table') {
    const text = [...block.header, ...block.rows.flat()].join(' ');
    const tableCellWidthsEm = [block.header, ...block.rows].map(row => row.map(estimateTextWidthEm));
    return [makeUnit(ref, 'table', text, [sectionRef], block.rows.length, {
      tableRows: block.rows.length,
      tableColumns: block.header.length,
      tableCellWidthsEm
    })];
  }
  const text = [block.title, ...block.data.flatMap(point => [point.label, String(point.value)])].filter(Boolean).join(' ');
  return [makeUnit(ref, 'chart', text, [sectionRef], block.data.length, { chartPoints: block.data.length })];
}

function makeUnit(
  sourceRef: string,
  kind: InternalContentUnit['kind'],
  text: string,
  aliases: readonly string[],
  itemCount = 1,
  detail: Pick<InternalContentUnit, 'tableRows' | 'tableColumns' | 'tableCellWidthsEm' | 'chartPoints'> = {}
): InternalContentUnit {
  return {
    sourceRef,
    kind,
    role: kind === 'title' || kind === 'heading' ? 'title' : kind === 'action' ? 'action' : kind === 'chart' ? 'chart' : kind === 'table' ? 'table' : 'body',
    hierarchy: 'unassigned',
    priority: 25,
    textLength: text.length,
    estimatedTextWidthEm: estimateTextWidthEm(text),
    itemCount,
    metricCount: 0,
    evidenceCount: kind === 'quote' || kind === 'chart' || kind === 'table' ? 1 : 0,
    aliases,
    ...detail
  };
}

function applyDesignAssignments(unit: InternalContentUnit, page: PresentationDesignIRPage): InternalContentUnit {
  if (unit.kind === 'generated') return unit;
  const hierarchyGroups: readonly [PresentationLayoutHierarchyLevel, readonly string[], number][] = [
    ['primary', page.hierarchy.primary, 100], ['secondary', page.hierarchy.secondary, 70], ['supporting', page.hierarchy.supporting, 40]
  ];
  let hierarchy: PresentationLayoutHierarchyLevel = 'unassigned';
  let priority = 25;
  for (const [level, refs, basePriority] of hierarchyGroups) {
    const index = refs.findIndex(ref => matches(unit, ref));
    if (index >= 0) { hierarchy = level; priority = Math.max(1, basePriority - Math.min(index, 20)); break; }
  }
  const roleNames: readonly [PresentationLayoutElementRole, readonly string[]][] = [
    ['title', page.contentRoles.title], ['body', page.contentRoles.body], ['metric', page.contentRoles.metric],
    ['evidence', page.contentRoles.evidence], ['chart', page.contentRoles.chart]
  ];
  const assignedRole = unit.kind === 'table' ? 'table'
    : unit.kind === 'chart' ? 'chart'
      : roleNames.find(([, refs]) => refs.some(ref => matches(unit, ref)))?.[0] ?? unit.role;
  return {
    ...unit,
    role: assignedRole,
    hierarchy,
    priority,
    metricCount: assignedRole === 'metric' ? 1 : 0,
    evidenceCount: assignedRole === 'evidence' || assignedRole === 'chart' || assignedRole === 'table' ? 1 : unit.evidenceCount
  };
}

function derivePageConstraint(
  page: PresentationDesignIRPage,
  global: PresentationDesignGlobal,
  features: PresentationPageFeatures,
  canvas: PresentationLayoutCanvas,
  tokens: PresentationLayoutThemeTokens
) {
  const marginFactor = page.whitespace === 'generous' ? 0.105 : page.whitespace === 'minimal' ? 0.045 : 0.07;
  const densityScale = page.density === 'dense' ? 0.84 : page.density === 'sparse' ? 1.2 : 1;
  const rhythmScale = global.visualRhythm === 'calm' ? 1.15 : global.visualRhythm === 'dynamic' ? 0.88 : 1;
  const preferredGap = tokens.spacing.baseGap * densityScale * rhythmScale * (page.whitespace === 'generous' ? 1.35 : page.whitespace === 'minimal' ? 0.78 : 1);
  const safeArea = Object.freeze({ topInset: canvas.height * marginFactor, rightInset: canvas.width * marginFactor, bottomInset: canvas.height * marginFactor, leftInset: canvas.width * marginFactor });
  const contentBounds = Object.freeze({ maximumWidth: canvas.width - safeArea.leftInset - safeArea.rightInset, maximumHeight: canvas.height - safeArea.topInset - safeArea.bottomInset });
  const elements = features.units.map(unit => makeElementConstraint(unit, page, global, contentBounds, tokens));
  const relationships = deriveRelationships(elements, page, features);
  const emphasisTarget = resolveElementReference(page.emphasis.target, elements);
  return Object.freeze({
    pageNumber: page.pageNumber,
    pageRole: page.pageRole,
    pageIntent: page.pageIntent,
    designIntent: Object.freeze({
      composition: Object.freeze({ ...page.composition }),
      emphasis: Object.freeze({ target: emphasisTarget, strength: page.emphasis.strength }),
      whitespace: page.whitespace
    }),
    density: page.density,
    contentDensity: features.contentDensity,
    safeArea,
    contentBounds,
    minimumGap: tokens.spacing.minimumGap,
    preferredGap,
    maximumElementCount: Math.max(1, Math.min(128, elements.length + (page.density === 'dense' ? 4 : 1))),
    elements: Object.freeze(elements),
    relationships: Object.freeze(relationships)
  });
}

function resolveElementReference(reference: string, elements: readonly PresentationElementConstraint[]): string {
  const exact = elements.find(element => element.sourceRef === reference);
  if (exact) return exact.sourceRef;
  const matches = elements.filter(element => element.sourceRef.startsWith(reference + '.'));
  const preferred = matches.find(element => element.role === 'title') ?? matches.find(element => element.hierarchy === 'primary') ?? matches[0];
  return preferred?.sourceRef ?? reference;
}

function makeElementConstraint(
  unit: PresentationPageContentUnitFeature,
  page: PresentationDesignIRPage,
  global: PresentationDesignGlobal,
  bounds: { readonly maximumWidth: number; readonly maximumHeight: number },
  tokens: PresentationLayoutThemeTokens
): PresentationElementConstraint {
  if (unit.kind === 'generated') {
    return Object.freeze({
      sourceRef: unit.sourceRef, role: 'body', hierarchy: 'supporting', priority: unit.priority,
      textLength: unit.textLength, estimatedTextWidthEm: unit.estimatedTextWidthEm, itemCount: unit.itemCount, preferredRegion: 'bottom', alignment: 'end',
      minWidth: 0.45, preferredWidth: 0.45, maxWidth: 0.45,
      minHeight: 0.18, preferredHeight: 0.18, maxHeight: 0.18,
      minimumFontSize: 10, preferredFontSize: 10, maximumFontSize: 10
    });
  }
  const preferredRegion = choosePreferredRegion(unit, page);
  const roleMinimumWidth: Record<PresentationLayoutElementRole, number> = { title: 2.4, body: 1.4, metric: 1.15, evidence: 1.6, chart: 3.4, table: 3.4, action: 1.4 };
  const minWidth = Math.min(roleMinimumWidth[unit.role], bounds.maximumWidth);
  const minHeight = unit.role === 'chart' || unit.role === 'table' ? 1.35 : unit.role === 'title' ? 0.48 : 0.34;
  const fontBase = unit.role === 'title' ? Math.max(30, tokens.typography.baseFontSize * 1.3)
    : unit.hierarchy === 'primary' ? Math.max(27, tokens.typography.baseFontSize * 1.15)
      : unit.hierarchy === 'secondary' ? tokens.typography.baseFontSize * 0.9 : tokens.typography.baseFontSize * 0.76;
  const directionScale = global.typographyDirection === 'display-led' && unit.hierarchy === 'primary' ? 1.12
    : global.typographyDirection === 'body-led' && unit.hierarchy === 'supporting' ? 1.08
      : global.typographyDirection === 'data-led' && unit.role === 'metric' ? 1.12 : 1;
  const preferredFontSize = clamp(fontBase * directionScale * (page.density === 'dense' ? 0.9 : page.density === 'sparse' ? 1.04 : 1), tokens.typography.minimumFontSize, tokens.typography.maximumFontSize);
  const tableColumnWidths = unit.tableCellWidthsEm?.[0]?.map((_width, columnIndex) => Math.max(...unit.tableCellWidthsEm!.map(row => row[columnIndex] ?? 0)));
  const estimatedSingleLineWidth = unit.role === 'table' && tableColumnWidths
    ? tableColumnWidths.reduce((sum, width) => sum + width, 0) * preferredFontSize / 72 + tableColumnWidths.length * 0.12
    : unit.estimatedTextWidthEm * preferredFontSize / 72;
  const targetLines = unit.role === 'title' || unit.role === 'metric' ? 1.4 : unit.role === 'action' ? 2 : 2.5;
  const preferredWidth = Math.min(bounds.maximumWidth, Math.max(minWidth, estimatedSingleLineWidth / targetLines));
  const preferredTableLayout = unit.role === 'table' && unit.tableCellWidthsEm
    ? estimateTableLayout(unit.tableCellWidthsEm, preferredFontSize, preferredWidth)
    : undefined;
  const estimatedLines = preferredTableLayout?.lines ?? estimateTextLines(unit.estimatedTextWidthEm, preferredFontSize, preferredWidth);
  const preferredHeight = clamp(Math.max(minHeight, preferredTableLayout?.height ?? estimatedLines * preferredFontSize / 72 * 1.45), minHeight, bounds.maximumHeight);
  const maxHeight = Math.min(bounds.maximumHeight, Math.max(preferredHeight, unit.role === 'chart' || unit.role === 'table' ? bounds.maximumHeight * 0.82 : preferredHeight * 2.2));
  return Object.freeze({
    sourceRef: unit.sourceRef,
    role: unit.role,
    hierarchy: unit.hierarchy,
    priority: unit.priority,
    textLength: unit.textLength,
    estimatedTextWidthEm: unit.estimatedTextWidthEm,
    itemCount: unit.itemCount,
    ...(unit.role === 'table' ? {
      tableRows: unit.tableRows,
      tableColumns: unit.tableColumns,
      tableCellWidthsEm: unit.tableCellWidthsEm
    } : {}),
    preferredRegion,
    alignment: preferredRegion === 'center' ? 'center' : preferredRegion === 'right' || preferredRegion === 'trailing' ? 'end' : 'start',
    minWidth,
    maxWidth: bounds.maximumWidth,
    minHeight,
    maxHeight,
    preferredHeight,
    minimumFontSize: tokens.typography.minimumFontSize,
    preferredFontSize,
    maximumFontSize: tokens.typography.maximumFontSize,
    ...(unit.role === 'chart' ? { aspectRatio: 1.6 } : unit.role === 'metric' ? { aspectRatio: 1.25 } : {}),
    preferredWidth
  } as PresentationElementConstraint);
}

function estimateTextWidthEm(text: string): number {
  let width = 0;
  for (const character of text) width += glyphAdvanceEm(character);
  return Math.round(width * 1000) / 1000;
}

function glyphAdvanceEm(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (/\p{Mark}/u.test(character) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (isWideGlyph(codePoint)) return 1;
  if (/\s/u.test(character)) return character === '\t' ? 1.12 : 0.28;
  if (/^[ilI|!.,:;'`]/u.test(character)) return 0.3;
  if (/^[MW@#%&]/u.test(character)) return 0.88;
  if (/^[A-Z]/u.test(character)) return 0.64;
  if (/^[a-z0-9]$/u.test(character)) return 0.54;
  if (/^[()[\]{}<>"?]/u.test(character)) return 0.38;
  return 0.58;
}

function isWideGlyph(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff);
}

function estimateTextLines(textWidthEm: number, fontSize: number, boxWidth: number): number {
  const availableWidth = Math.max(0.1, boxWidth - 0.12);
  return Math.max(1, Math.ceil((textWidthEm * fontSize / 72) / availableWidth));
}

function estimateTableLayout(
  cellWidthsEm: readonly (readonly number[])[],
  fontSize: number,
  boxWidth: number
): { readonly lines: number; readonly height: number } {
  const columns = cellWidthsEm[0]?.length ?? 1;
  const cellWidth = Math.max(0.1, (boxWidth - columns * 0.12) / columns);
  let lines = 0;
  for (const row of cellWidthsEm) {
    const rowLines = Math.max(1, ...row.map(width => Math.ceil((width * fontSize / 72 + 0.04) / cellWidth)));
    lines += rowLines;
  }
  return { lines, height: lines * fontSize / 72 * 1.3 + cellWidthsEm.length * 0.12 };
}

function choosePreferredRegion(unit: PresentationPageContentUnitFeature, page: PresentationDesignIRPage): PresentationLayoutRegion {
  if (unit.kind === 'generated') return 'bottom';
  if (unit.hierarchy !== 'primary') return 'supporting';
  const focal = page.composition.focalArea;
  if (focal === 'left' || focal === 'right' || focal === 'center' || focal === 'top' || focal === 'bottom') return focal;
  if (page.composition.flow === 'left-to-right') return 'leading';
  return unit.role === 'title' ? 'top' : 'center';
}

function deriveRelationships(
  elements: readonly PresentationElementConstraint[],
  page: PresentationDesignIRPage,
  features: PresentationPageFeatures
) {
  const relationships: Array<{ kind: 'above' | 'near' | 'align' | 'paired' | 'dominates' | 'supports'; fromRef: string; toRef: string; strength: 'required' | 'preferred' }> = [];
  const first = (role: PresentationLayoutElementRole) => elements.find(element => element.role === role);
  const title = first('title');
  const bodies = elements.filter(element => element.role === 'body' || element.role === 'evidence' || element.role === 'table' || element.role === 'chart');
  if (title && bodies[0]) relationships.push({ kind: 'above', fromRef: title.sourceRef, toRef: bodies[0].sourceRef, strength: 'preferred' });
  const metrics = elements.filter(element => element.role === 'metric');
  const evidence = elements.filter(element => element.role === 'evidence' || element.role === 'chart' || element.role === 'table');
  if (metrics[0] && evidence[0]) relationships.push({ kind: 'near', fromRef: metrics[0].sourceRef, toRef: evidence[0].sourceRef, strength: 'preferred' });
  const chart = elements.find(element => element.role === 'chart');
  const alignmentTarget = bodies.find(element => element.role !== 'chart');
  if (chart && alignmentTarget) relationships.push({ kind: 'align', fromRef: chart.sourceRef, toRef: alignmentTarget.sourceRef, strength: 'preferred' });
  if (features.comparisonCandidate && elements.length >= 2) {
    const pair = elements.filter(element => element.hierarchy !== 'supporting').slice(0, 2);
    if (pair.length === 2) relationships.push({ kind: 'paired', fromRef: pair[0].sourceRef, toRef: pair[1].sourceRef, strength: 'preferred' });
  }
  const primary = elements.filter(element => element.hierarchy === 'primary');
  const supporting = elements.filter(element => element.hierarchy === 'supporting');
  if (primary[0] && supporting[0]) relationships.push({ kind: 'dominates', fromRef: primary[0].sourceRef, toRef: supporting[0].sourceRef, strength: 'required' });
  if (page.emphasis.target && elements.some(element => element.sourceRef === page.emphasis.target) && primary[0] && primary[0].sourceRef !== page.emphasis.target) {
    relationships.push({ kind: 'dominates', fromRef: page.emphasis.target, toRef: primary[0].sourceRef, strength: 'preferred' });
  }
  return relationships;
}

function matches(unit: InternalContentUnit, ref: string): boolean {
  return unit.sourceRef === ref || unit.aliases.includes(ref);
}

function estimateContentDensity(
  textLength: number,
  unitCount: number,
  tableCount: number,
  units: readonly InternalContentUnit[]
): PresentationPageFeatures['contentDensity'] {
  const tableRows = units.reduce((total, unit) => total + (unit.tableRows ?? 0), 0);
  if (textLength > 700 || unitCount >= 10 || tableRows > 7 || tableCount > 1) return 'dense';
  if (textLength > 240 || unitCount >= 5 || tableRows > 3 || tableCount > 0) return 'balanced';
  return 'sparse';
}

function sceneImageCount(scene: { readonly elements: readonly { readonly type: string }[] } | undefined): number {
  return scene?.elements.filter(element => element.type === 'image').length ?? 0;
}

function validateInputs(canvas: PresentationLayoutCanvas, tokens: PresentationLayoutThemeTokens): void {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) throw new TypeError('Layout canvas dimensions must be positive finite numbers');
  const typography = tokens.typography;
  if (typeof typography.fontFamily !== 'string' || !typography.fontFamily.trim() || typography.fontFamily.length > 128 || ![typography.minimumFontSize, typography.maximumFontSize, typography.baseFontSize].every(Number.isFinite) || typography.minimumFontSize <= 0 || typography.minimumFontSize > typography.maximumFontSize || typography.baseFontSize < typography.minimumFontSize || typography.baseFontSize > typography.maximumFontSize) throw new TypeError('Layout typography tokens are invalid');
  if (![tokens.spacing.minimumGap, tokens.spacing.baseGap].every(Number.isFinite) || tokens.spacing.minimumGap < 0 || tokens.spacing.minimumGap > tokens.spacing.baseGap) throw new TypeError('Layout spacing tokens are invalid');
  if (Object.values(tokens.colors).some(color => !/^[0-9A-F]{6}$/iu.test(color))) throw new TypeError('Layout color tokens are invalid');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
