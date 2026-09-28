import {
  type DocumentOutline,
  type DocumentOutlineBlock,
  type DocumentOutlineSection,
  type DocumentWorkspaceKind,
  type PresentationPageKind,
  type PresentationSectionMetadata
} from '../../domain';
import { parsePresentationPageScene } from '../../domain';
import { parseDocumentIR, type DocumentOperation } from '../../domain/entities/document-agent';
import {
  outlineAliasDefinitions,
  buildDocumentOutlineJsonSchema,
  outlineContractLimits,
  outlineDocumentKinds,
  outlinePageKindAliases,
  outlinePresentationPageKinds,
  type OutlineJsonSchema
} from '../../shared/document-outline-contract';

export const presentationPageKinds = outlinePresentationPageKinds;
export type {
  DocumentOutline,
  DocumentOutlineBlock,
  DocumentOutlineSection,
  PresentationPageKind,
  PresentationSectionMetadata
} from '../../domain';

export class DocumentOutlineError extends Error {
  constructor(
    readonly safeCode: 'document_invalid_outline',
    message: string
  ) {
    super(message);
    this.name = 'DocumentOutlineError';
  }
}

const MAX_TITLE_LENGTH = outlineContractLimits.maxTitleLength;
const MAX_SECTIONS = outlineContractLimits.maxSections;
const MAX_BLOCKS_PER_SECTION = outlineContractLimits.maxBlocksPerSection;
const MAX_ITEMS = outlineContractLimits.maxItems;
const MAX_TEXT_LENGTH = outlineContractLimits.maxTextLength;
const MAX_TABLE_COLUMNS = outlineContractLimits.maxTableColumns;
const MAX_TABLE_ROWS = outlineContractLimits.maxTableRows;
const MAX_TABLE_CELL_LENGTH = outlineContractLimits.maxTableCellLength;
const MAX_CHART_ITEMS = outlineContractLimits.maxChartItems;
const MAX_CHART_LABEL_LENGTH = outlineContractLimits.maxChartLabelLength;
export const presentationOutlineLimits = {
  maxTotalCharacters: outlineContractLimits.maxTotalCharacters,
  maxContentGroups: outlineContractLimits.maxContentGroups,
  maxEstimatedPages: outlineContractLimits.maxEstimatedPages
} as const;

export interface DocumentDraftIRPlan {
  readonly operation: DocumentOperation;
  readonly attachmentRefs: readonly string[];
}

function isSafeIRReference(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

export function parseDocumentOutline(jsonText: string): DocumentOutline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `Document outline is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isRecord(parsed)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'Document outline must be a JSON object'
    );
  }
  const kind = parseKind(parsed.kind);
  const contract = buildDocumentOutlineJsonSchema(kind);
  assertContractKeys(parsed, 'outline', contract);
  const title = parseBoundedText(
    parsed.title,
    'outline.title',
    MAX_TITLE_LENGTH
  );
  if (!Array.isArray(parsed.sections)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'Document outline sections must be an array'
    );
  }
  if (parsed.sections.length > MAX_SECTIONS) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `Document outline exceeds ${MAX_SECTIONS} sections`
    );
  }
  const sections = parsed.sections.map((item, index) =>
    parseSection(item, index, kind, contract)
  );
  const coverScene = kind === 'ppt' && parsed.coverScene !== undefined
    ? parseSafeScene(normalizeSceneAliases(parsed.coverScene), 'outline.coverScene')
    : undefined;
  const closingScene = kind === 'ppt' && parsed.closingScene !== undefined
    ? parseSafeScene(normalizeSceneAliases(parsed.closingScene), 'outline.closingScene')
    : undefined;
  return validateDocumentOutline({
    kind,
    title,
    sections,
    ...(coverScene !== undefined ? { coverScene } : {}),
    ...(closingScene !== undefined ? { closingScene } : {})
  });
}

export function parseDocumentContent(
  content: string,
  kind: DocumentWorkspaceKind,
  plan?: DocumentDraftIRPlan
): DocumentOutline {
  const cleaned = stripPreamble(content);
  const candidate = unwrapJsonFence(cleaned);
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
    return parseMarkdownToOutline(cleaned, kind);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonRecord(candidate);
  } catch (error) {
    // Excel responses are often emitted as a large JSON object. A common
    // provider truncation is one missing closing bracket for the `rows` array
    // immediately before the table object closes (`]}` instead of `]]}`).
    // Repair only that narrowly identifiable shape, then run the canonical
    // outline parser so the result is still subject to all normal limits and
    // type checks. Other malformed responses continue through the existing
    // recovery path in the application service.
    if (kind === 'excel') {
      const repaired = repairExcelRowsArray(candidate);
      if (repaired) return repaired;
    }
    throw error;
  }
  if (plan) assertModelDoesNotOverrideIRPlan(parsed, plan);
  if ('kind' in parsed) {
    const outline = parseDocumentOutline(candidate);
    if (outline.kind !== kind) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `Document outline kind must be ${kind}`
      );
    }
    return outline;
  }
  return normalizeObservedDocument(parsed, kind);
}

export function recoverDocumentContent(
  content: string,
  kind: DocumentWorkspaceKind,
  plan?: DocumentDraftIRPlan
): DocumentOutline {
  const cleaned = stripPreamble(content);
  const candidate = unwrapJsonFence(cleaned);
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
    return parseMarkdownToOutline(cleaned, kind);
  }
  if (plan && candidate.startsWith('{')) {
    try { assertModelDoesNotOverrideIRPlan(parseJsonRecord(candidate), plan); } catch (error) {
      if (error instanceof DocumentOutlineError && /Document IR plan conflict/i.test(error.message)) throw error;
    }
  }

  const sections: Array<{
    heading: string;
    level: 1;
    blocks: DocumentOutlineBlock[];
    pageKind?: PresentationPageKind;
    takeaway?: string;
    action?: string;
  }> = [];
  const tokens = extractJsonStringTokens(candidate);
  const sceneRanges = kind === 'ppt'
    ? findPresentationSceneRanges(candidate)
    : [];
  let title = '';
  let currentSection: (typeof sections)[number] | undefined;
  let activeKey: string | undefined;
  let previousEnd = 0;
  let pendingItems: string[] = [];
  const unassigned: string[] = [];

  const ensureSection = () => {
    if (currentSection) return currentSection;
    currentSection = { heading: '内容概览', level: 1, blocks: [] };
    sections.push(currentSection);
    return currentSection;
  };
  const flushItems = () => {
    if (pendingItems.length > 0) {
      ensureSection().blocks.push({ type: 'bullets', items: pendingItems });
      pendingItems = [];
    }
  };

  for (const token of tokens) {
    if (sceneRanges.some((range) => token.start >= range.start && token.start < range.end)) {
      // Scene strings are layout instructions. They must never become fallback
      // body bullets when a streamed response is truncated or malformed.
      activeKey = undefined;
      previousEnd = token.end;
      continue;
    }
    const between = candidate.slice(previousEnd, token.start);
    if (activeKey === 'items' && between.includes(']')) {
      flushItems();
      activeKey = undefined;
    }
    const after = candidate.slice(token.end);
    if (/^\s*:/.test(after)) {
      if (activeKey === 'items') flushItems();
      activeKey = token.value;
      previousEnd = token.end;
      continue;
    }

    switch (activeKey) {
      case 'title':
        title ||= token.value;
        activeKey = undefined;
        break;
      case 'heading':
        flushItems();
        currentSection = {
          heading: token.value,
          level: 1,
          blocks: []
        };
        sections.push(currentSection);
        activeKey = undefined;
        break;
      case 'takeaway':
        ensureSection().takeaway = token.value;
        activeKey = undefined;
        break;
      case 'action':
        ensureSection().action = token.value;
        activeKey = undefined;
        break;
      case 'items':
        pendingItems.push(token.value);
        break;
      case 'text':
      case 'caption':
        ensureSection().blocks.push({ type: 'paragraph', text: token.value });
        activeKey = undefined;
        break;
      case 'pageKind':
        {
          const pageKind = normalizePresentationPageKind(token.value);
          if (pageKind) ensureSection().pageKind = pageKind;
        }
        activeKey = undefined;
        break;
      case 'label':
        unassigned.push(token.value);
        activeKey = undefined;
        break;
      default:
        if (!presentationStructuralValues.has(token.value)) {
          unassigned.push(token.value);
        }
        activeKey = undefined;
        break;
    }
    previousEnd = token.end;
  }
  flushItems();

  const used = new Set([
    title,
    ...sections.flatMap((section) => [
      section.heading,
      section.takeaway ?? '',
      section.action ?? '',
      ...section.blocks.flatMap((block) =>
        block.type === 'paragraph' || block.type === 'quote'
          ? [block.text]
          : block.type === 'bullets' || block.type === 'numbered'
            ? [...block.items]
            : []
      )
    ])
  ]);
  const remaining = unassigned.filter(
    (value) => value.length > 1 && !used.has(value) &&
      !(kind === 'ppt' && isPresentationSceneMetadataValue(value))
  );
  if (remaining.length > 0) {
    ensureSection().blocks.push({ type: 'bullets', items: remaining });
  }
  if (!title) {
    const candidateTitle =
      sections[0]?.heading ??
      remaining[0] ??
      (kind === 'ppt' ? '演示文稿' : kind === 'excel' ? '数据表格' : '文档');
    title = candidateTitle.length <= MAX_TITLE_LENGTH
      ? candidateTitle
      : kind === 'ppt'
        ? '演示文稿'
        : kind === 'excel'
          ? '数据表格'
          : '文档';
  }
  if (sections.length === 0) {
    sections.push({
      heading: '内容概览',
      level: 1,
      blocks: [{ type: 'paragraph', text: cleaned }]
    });
  }
  return validateDocumentOutline({
    kind,
    title,
    sections: sections.map((section) => ({
      heading: section.heading,
      level: section.level,
      blocks: section.blocks,
      ...(kind === 'ppt' && section.pageKind !== undefined
        ? { pageKind: section.pageKind }
        : {}),
      ...(kind === 'ppt' && section.takeaway !== undefined
        ? { takeaway: section.takeaway }
        : {}),
      ...(kind === 'ppt' && section.action !== undefined
        ? { action: section.action }
        : {})
    }))
  });
}

export function recoverPresentationContent(content: string): DocumentOutline {
  return recoverDocumentContent(content, 'ppt');
}

export function parseMarkdownToOutline(
  markdown: string,
  kind: DocumentWorkspaceKind
): DocumentOutline {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''));
  let title = '';
  const sections: DocumentOutlineSection[] = [];
  let currentSection: DocumentOutlineSection | undefined;
  let pendingTable: { header: string[]; rows: string[][] } | undefined;
  let headingCount = 0;

  const flushTable = () => {
    if (!pendingTable) return;
    if (!currentSection) {
      currentSection = {
        heading: '内容',
        level: 1,
        blocks: []
      };
      sections.push(currentSection);
    }
    (currentSection.blocks as DocumentOutlineBlock[]).push({
      type: 'table',
      header: pendingTable.header,
      rows: pendingTable.rows
    });
    pendingTable = undefined;
  };

  for (const rawLine of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(rawLine);
    if (heading) {
      flushTable();
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      if (heading[1].length === 1 && headingCount === 0) {
        title = stripInlineMarkdown(heading[2].trim());
        headingCount += 1;
        continue;
      }
      headingCount += 1;
      currentSection = {
        heading: stripInlineMarkdown(heading[2].trim()),
        level,
        blocks: []
      };
      sections.push(currentSection);
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushTable();
      continue;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = splitTableRow(trimmed);
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
        continue;
      }
      const cleanedCells = cells.map((cell) => stripInlineMarkdown(cell));
      if (pendingTable) {
        pendingTable.rows.push(cleanedCells);
      } else {
        pendingTable = { header: cleanedCells, rows: [] };
      }
      continue;
    }
    flushTable();
    ensureSection();
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(rawLine);
    const numbered = /^\s*\d+[.、）)]\s+(.+)$/.exec(rawLine);
    const quote = /^\s*>\s?(.+)$/.exec(rawLine);
    if (bullet) {
      appendTextBlock('bullets', stripInlineMarkdown(bullet[1].trim()));
    } else if (numbered) {
      appendTextBlock('numbered', stripInlineMarkdown(numbered[1].trim()));
    } else if (quote) {
      appendTextBlock('quote', stripInlineMarkdown(quote[1].trim()));
    } else {
      appendTextBlock('paragraph', stripInlineMarkdown(trimmed));
    }
  }
  flushTable();

  if (sections.length === 0) {
    const body = lines.map((line) => line.trim()).filter(Boolean);
    if (body.length > 0) {
      sections.push({
        heading: '内容',
        level: 1,
        blocks: [{ type: 'paragraph', text: stripInlineMarkdown(body.join('\n')) }]
      });
    }
  }
  return validateDocumentOutline({
    kind,
    title: title || stripInlineMarkdown(lines.map((line) => line.trim()).find(Boolean) ?? '')?.slice(0, 40) || '文档',
    sections
  });

  function ensureSection(): DocumentOutlineSection {
    if (currentSection) return currentSection;
    currentSection = {
      heading: '内容',
      level: 1,
      blocks: []
    };
    sections.push(currentSection);
    return currentSection;
  }

  function appendTextBlock(
    type: 'paragraph' | 'bullets' | 'numbered' | 'quote',
    text: string
  ): void {
    const section = ensureSection();
    const blocks = section.blocks as DocumentOutlineBlock[];
    const last = blocks[blocks.length - 1];
    if (type === 'paragraph' || type === 'quote') {
      blocks.push({ type, text });
    } else if (last && last.type === type) {
      if (last.items.length >= MAX_ITEMS) {
        throw new DocumentOutlineError(
          'document_invalid_outline',
          `Markdown list exceeds ${MAX_ITEMS} items`
        );
      }
      blocks[blocks.length - 1] = {
        type,
        items: [...last.items, text]
      };
    } else {
      blocks.push({ type, items: [text] });
    }
  }
}

function splitTableRow(line: string): string[] {
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function schemaField(schema: OutlineJsonSchema, key: string): OutlineJsonSchema {
  const properties = schema.properties;
  if (!isRecord(properties) || !isRecord(properties[key])) {
    throw new DocumentOutlineError('document_invalid_outline', `Outline contract is missing ${key}`);
  }
  return properties[key] as OutlineJsonSchema;
}

function schemaItems(schema: OutlineJsonSchema): OutlineJsonSchema {
  if (!isRecord(schema.items)) {
    throw new DocumentOutlineError('document_invalid_outline', 'Outline contract items are invalid');
  }
  return schema.items as OutlineJsonSchema;
}

function blockSchemaForType(schema: OutlineJsonSchema, type: string): OutlineJsonSchema {
  const variants = schema.oneOf;
  if (!Array.isArray(variants)) {
    throw new DocumentOutlineError('document_invalid_outline', 'Outline contract block variants are invalid');
  }
  const variant = variants.find((item) => {
    if (!isRecord(item) || !isRecord(item.properties) || !isRecord(item.properties.type)) return false;
    return item.properties.type.const === type;
  });
  if (!isRecord(variant)) {
    throw new DocumentOutlineError('document_invalid_outline', `Outline contract block type ${type} is missing`);
  }
  return variant as OutlineJsonSchema;
}

function assertContractKeys(
  value: Record<string, unknown>,
  label: string,
  schema: OutlineJsonSchema
): void {
  if (!isRecord(schema.properties)) {
    throw new DocumentOutlineError('document_invalid_outline', `${label} contract properties are invalid`);
  }
  const unsupported = Object.keys(value).find((key) => !Object.prototype.hasOwnProperty.call(schema.properties, key));
  if (unsupported) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} contains unsupported field: ${unsupported}`
    );
  }
}

function parseSection(
  value: unknown,
  index: number,
  kind: DocumentWorkspaceKind,
  contract: OutlineJsonSchema
): DocumentOutlineSection {
  if (!isRecord(value)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${index}] must be an object`
    );
  }
  const sectionContract = schemaItems(schemaField(contract, 'sections'));
  assertContractKeys(value, `outline.sections[${index}]`, sectionContract);
  const heading = parseBoundedText(
    value.heading,
    `outline.sections[${index}].heading`,
    MAX_TITLE_LENGTH
  );
  if (value.level !== 1 && value.level !== 2 && value.level !== 3) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${index}].level must be 1, 2 or 3`
    );
  }
  if (!Array.isArray(value.blocks)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${index}].blocks must be an array`
    );
  }
  if (value.blocks.length > MAX_BLOCKS_PER_SECTION) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${index}] exceeds ${MAX_BLOCKS_PER_SECTION} blocks`
    );
  }
  let blocks = value.blocks.map((block, blockIndex) =>
    parseBlock(block, index, blockIndex, kind, sectionContract)
  );
  if (kind === 'excel') {
    blocks = appendExcelFooter(blocks, value.footers, index, sectionContract);
  }
  return {
    heading,
    level: value.level as 1 | 2 | 3,
    blocks,
    ...(kind === 'ppt' ? parsePresentationSectionMetadata(value, index) : {})
  };
}

function repairExcelRowsArray(candidate: string): DocumentOutline | undefined {
  // Another frequent shape error is a table followed by a paragraph where
  // the model closed both `blocks` and its section before emitting that
  // paragraph. In that case the tail is `]}]},{"type":"paragraph"` but the
  // valid table tail is `]]},{"type":"paragraph"` (the second bracket closes
  // `rows`). Try this targeted rewrite first.
  const misplacedParagraph = /\]\s*}\s*]\s*}\s*,\s*(?=\{\s*"type"\s*:\s*"paragraph")/g;
  let match: RegExpExecArray | null;
  while ((match = misplacedParagraph.exec(candidate)) !== null) {
    const before = candidate.slice(0, match.index);
    if (!/"rows"\s*:\s*\[[\s\S]*$/u.test(before)) continue;
    const repaired =
      before +
      ']]},' +
      candidate.slice(match.index + match[0].length);
    try {
      const parsed = parseJsonRecord(repaired);
      if (parsed.kind === 'excel') return parseDocumentOutline(repaired);
    } catch {
      // Continue with the bracket-only candidates below.
    }
  }

  const insertionPoints: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < candidate.length - 1; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== ']') continue;
    let next = index + 1;
    while (/\s/.test(candidate[next] ?? '')) next += 1;
    if (candidate[next] === '}') insertionPoints.push(index + 1);
  }

  for (const insertionPoint of insertionPoints) {
    const repaired =
      candidate.slice(0, insertionPoint) +
      ']' +
      candidate.slice(insertionPoint);
    try {
      const parsed = parseJsonRecord(repaired);
      if (parsed.kind !== 'excel') continue;
      return parseDocumentOutline(repaired);
    } catch {
      // Try the next narrowly scoped insertion point, if any.
    }
  }
  return undefined;
}

function appendExcelFooter(
  blocks: DocumentOutlineBlock[],
  value: unknown,
  sectionIndex: number,
  sectionContract?: OutlineJsonSchema
): DocumentOutlineBlock[] {
  if (value === undefined) return blocks;
  if (!isRecord(value) || !Array.isArray(value.values)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${sectionIndex}].footers must contain a values array`
    );
  }
  if (sectionContract) {
    assertContractKeys(value, `outline.sections[${sectionIndex}].footers`, schemaField(sectionContract, 'footers'));
  }
  const tableIndex = blocks.reduce(
    (last, block, blockIndex) => (block.type === 'table' ? blockIndex : last),
    -1
  );
  if (tableIndex < 0) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${sectionIndex}].footers requires a table block`
    );
  }
  const table = blocks[tableIndex];
  if (table.type !== 'table') return blocks;
  const label =
    typeof value.label === 'string' && value.label.trim().length > 0
      ? value.label
      : '合计';
  const footerValues = value.values.map((cell, cellIndex) => {
    if (typeof cell === 'string') return cell;
    if (typeof cell === 'number' && Number.isFinite(cell)) return String(cell);
    if (cell === null || cell === undefined) return '';
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${sectionIndex}].footers.values[${cellIndex}] is invalid`
    );
  });
  const row =
    footerValues.length === table.header.length
      ? [label, ...footerValues.slice(1)]
      : footerValues.length === table.header.length - 1
        ? [label, ...footerValues]
        : undefined;
  if (!row) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${sectionIndex}].footers.values must contain ${table.header.length} or ${table.header.length - 1} cells`
    );
  }
  const next = [...blocks];
  next[tableIndex] = { ...table, rows: [...table.rows, row] };
  return next;
}

function parsePresentationSectionMetadata(
  value: Record<string, unknown>,
  index: number
): PresentationSectionMetadata {
  const label = `outline.sections[${index}]`;
  const pageKind =
    value.pageKind === undefined
      ? undefined
      : normalizePresentationPageKind(value.pageKind);
  if (value.pageKind !== undefined && pageKind === undefined) {
    throw new DocumentOutlineError('document_invalid_outline', `${label}.pageKind is invalid`);
  }
  const takeaway = parseOptionalBoundedText(
    value.takeaway,
    `${label}.takeaway`,
    MAX_TEXT_LENGTH
  );
  const action = parseOptionalBoundedText(
    value.action,
    `${label}.action`,
    MAX_TEXT_LENGTH
  );
  const scene = value.scene === undefined ? undefined : parseSafeScene(value.scene, `${label}.scene`);
  return {
    ...(pageKind !== undefined ? { pageKind } : {}),
    ...(takeaway !== undefined ? { takeaway } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(scene !== undefined ? { scene } : {})
  };
}

function parseSafeScene(
  value: unknown,
  label: string
): PresentationSectionMetadata['scene'] {
  let scene: PresentationSectionMetadata['scene'];
  try {
    scene = parsePresentationPageScene(normalizeSceneAliases(value));
  } catch (error) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (scene && scene.elements.length > 30) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} exceeds 30 design elements`
    );
  }
  if (scene && !scene.elements.some((element) => element.type === 'text' && element.content)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} must contain text content`
    );
  }
  if (scene?.elements.some((element) => element.type === 'image' || element.assetRef !== undefined)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} cannot choose image files or asset paths`
    );
  }
  return scene;
}

/**
 * Accept only documented legacy aliases before the strict scene parser runs.
 * Unknown fields remain rejected by parsePresentationPageScene.
 */
function normalizeSceneAliases(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.elements)) return value;
  return {
    ...value,
    elements: value.elements.map((item) => {
      if (!isRecord(item)) return item;
      const rest: Record<string, unknown> = { ...item };
      const elementStyle: Record<string, unknown> = isRecord(rest.style) ? { ...rest.style } : {};
      for (const [alias, target] of Object.entries(outlineAliasDefinitions.sceneElement)) {
        if (target === 'style.fill' && elementStyle.fill === undefined && rest[alias] !== undefined) elementStyle.fill = rest[alias];
        if (target === 'style.stroke' && elementStyle.stroke === undefined && rest[alias] !== undefined) elementStyle.stroke = rest[alias];
        if (target === 'type' && rest.type === undefined && rest[alias] !== undefined) rest.type = 'shape';
        delete rest[alias];
      }
      return {
        ...rest,
        ...(Object.keys(elementStyle).length > 0 ? { style: normalizeSceneStyleAliases(elementStyle) } : {})
      };
    })
  };
}

function normalizeSceneStyleAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const style: Record<string, unknown> = { ...value };
  for (const [alias, target] of Object.entries(outlineAliasDefinitions.sceneStyle)) {
    if (target === 'fill' && style.fill === undefined && style[alias] !== undefined) style.fill = style[alias];
    if (target === 'stroke' && style.stroke === undefined && style[alias] !== undefined) style.stroke = style[alias];
    delete style[alias];
  }
  return style;
}

function assertModelDoesNotOverrideIRPlan(
  value: Record<string, unknown>,
  plan: DocumentDraftIRPlan
): void {
  // Construct the authoritative IR from the upstream plan first. Model fields
  // below are only conflict signals; they never become the source of truth.
  const upstreamIR = plan.attachmentRefs.every(isSafeIRReference)
    ? parseDocumentIR(plan)
    : { operation: plan.operation, attachmentRefs: [...plan.attachmentRefs] };
  if (value.operation !== undefined && value.operation !== upstreamIR.operation) {
    throw new DocumentOutlineError('document_invalid_outline', 'Document IR plan conflict: model operation cannot override the upstream operation');
  }
  if (value.attachmentRefs !== undefined) {
    if (!Array.isArray(value.attachmentRefs) ||
        JSON.stringify(value.attachmentRefs) !== JSON.stringify(upstreamIR.attachmentRefs)) {
      throw new DocumentOutlineError('document_invalid_outline', 'Document IR plan conflict: model attachmentRefs cannot override the upstream references');
    }
  }
  if (upstreamIR.operation === 'create' && ['documentRef', 'pageRefs', 'workRef', 'toolCalls'].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key))) {
    throw new DocumentOutlineError('document_invalid_outline', 'Document IR plan conflict: create output cannot add existing-document dependencies');
  }
}

function normalizePresentationPageKind(
  value: unknown
): PresentationPageKind | undefined {
  if (typeof value !== 'string') return undefined;
  // Providers occasionally decorate enum values with display-style casing,
  // whitespace, or a dash (for example `Image-Text`). Normalize only those
  // harmless lexical variations; the resulting value still has to be one of
  // the renderer's canonical enums or an explicitly supported alias.
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  if (presentationPageKinds.includes(normalized as PresentationPageKind)) {
    return normalized as PresentationPageKind;
  }
  return outlinePageKindAliases[normalized];
}

function parseOptionalBoundedText(
  value: unknown,
  label: string,
  maximumLength = MAX_TEXT_LENGTH
): string | undefined {
  return value === undefined
    ? undefined
    : parseBoundedText(value, label, maximumLength);
}

function validateDocumentOutline(outline: DocumentOutline): DocumentOutline {
  if (outline.kind !== 'ppt') return outline;

  let totalCharacters = outline.title.length;
  let contentGroups = 0;
  let estimatedPages = 2;
  for (const section of outline.sections) {
    totalCharacters += section.heading.length;
    totalCharacters += section.takeaway?.length ?? 0;
    totalCharacters += section.action?.length ?? 0;
    const sectionContentGroups = section.blocks.reduce(
      (total, block) => total + countBlockContentGroups(block),
      0
    );
    contentGroups += sectionContentGroups;
    estimatedPages += Math.max(1, Math.ceil(sectionContentGroups / 4));
    for (const block of section.blocks) {
      totalCharacters += countBlockCharacters(block);
    }
  }

  if (totalCharacters > presentationOutlineLimits.maxTotalCharacters) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'PPT outline exceeds the total text budget'
    );
  }
  if (contentGroups > presentationOutlineLimits.maxContentGroups) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'PPT outline exceeds the content-group budget'
    );
  }
  if (estimatedPages > presentationOutlineLimits.maxEstimatedPages) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'PPT outline exceeds the estimated page budget'
    );
  }
  return outline;
}

function countBlockContentGroups(block: DocumentOutlineBlock): number {
  return block.type === 'bullets' || block.type === 'numbered'
    ? block.items.length
    : 1;
}

function countBlockCharacters(block: DocumentOutlineBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'quote':
      return block.text.length;
    case 'bullets':
    case 'numbered':
      return block.items.reduce((total, item) => total + item.length, 0);
    case 'chart':
      return (
        (block.title?.length ?? 0) +
        block.data.reduce(
          (total, item) => total + item.label.length + String(item.value).length,
          0
        )
      );
    case 'table':
      return (
        block.header.reduce((total, cell) => total + cell.length, 0) +
        block.rows.reduce(
          (total, row) =>
            total + row.reduce((rowTotal, cell) => rowTotal + cell.length, 0),
          0
        )
      );
  }
}

function parseBlock(
  value: unknown,
  sectionIndex: number,
  blockIndex: number,
  kind: DocumentWorkspaceKind,
  sectionContract: OutlineJsonSchema
): DocumentOutlineBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${sectionIndex}].blocks[${blockIndex}] is invalid`
    );
  }
  const label = `outline.sections[${sectionIndex}].blocks[${blockIndex}]`;
  const blockContract = blockSchemaForType(
    schemaItems(schemaField(sectionContract, 'blocks')),
    value.type
  );
  assertContractKeys(value, label, blockContract);
  switch (value.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        text: parseBoundedText(value.text, `${label}.text`, MAX_TEXT_LENGTH)
      };
    case 'quote':
      return {
        type: 'quote',
        text: parseBoundedText(value.text, `${label}.text`, MAX_TEXT_LENGTH)
      };
    case 'bullets':
    case 'numbered':
      return {
        type: value.type,
        items: parseItems(value.items, `${label}.items`)
      };
    case 'table':
      return parseTable(value, label, kind);
    case 'chart':
      return parseChart(value, label);
    default:
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.type is not supported`
      );
  }
}

function parseChart(
  value: Record<string, unknown>,
  label: string
): DocumentOutlineBlock {
  if (value.chartKind !== 'bar' && value.chartKind !== 'pie') {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label}.chartKind must be bar or pie`
    );
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label}.title must be a string`
    );
  }
  if (!Array.isArray(value.data)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label}.data must be an array`
    );
  }
  if (value.data.length > MAX_CHART_ITEMS) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} exceeds ${MAX_CHART_ITEMS} chart items`
    );
  }
  const data = value.data.map((item, index) => {
    if (!isRecord(item)) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.data[${index}] must be an object`
      );
    }
    if (
      typeof item.label !== 'string' ||
      item.label.trim().length === 0 ||
      item.label.length > MAX_CHART_LABEL_LENGTH ||
      typeof item.value !== 'number' ||
      !Number.isFinite(item.value)
    ) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.data[${index}] is invalid`
      );
    }
    return { label: item.label, value: item.value };
  });
  return {
    type: 'chart',
    chartKind: value.chartKind,
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    data
  };
}

function parseTable(
  value: Record<string, unknown>,
  label: string,
  kind: DocumentWorkspaceKind = 'word'
): DocumentOutlineBlock {
  const header = parseItems(value.header, `${label}.header`, MAX_TABLE_COLUMNS);
  if (!Array.isArray(value.rows)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label}.rows must be an array`
    );
  }
  if (value.rows.length > MAX_TABLE_ROWS) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} exceeds ${MAX_TABLE_ROWS} rows`
    );
  }
  const rows = value.rows.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.rows[${rowIndex}] must be an array`
      );
    }
    if (row.length !== header.length) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.rows[${rowIndex}] must contain ${header.length} cells`
      );
    }
    return row.map((cell, cellIndex) => {
      if (
        (typeof cell !== 'string' && !(kind === 'excel' && typeof cell === 'number')) ||
        (typeof cell === 'number' && !Number.isFinite(cell)) ||
        String(cell).length > MAX_TABLE_CELL_LENGTH
      ) {
        throw new DocumentOutlineError(
          'document_invalid_outline',
          `${label}.rows[${rowIndex}][${cellIndex}] is invalid`
        );
      }
      return String(cell);
    });
  });
  return { type: 'table', header, rows };
}

function parseItems(
  value: unknown,
  label: string,
  maxItems = MAX_ITEMS
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} must be an array`
    );
  }
  if (value.length > maxItems) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} exceeds ${maxItems} items`
    );
  }
  return value.map((item, index) =>
    parseBoundedText(item, `${label}[${index}]`, MAX_TEXT_LENGTH)
  );
}

function parseBoundedText(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} must be a non-blank string`
    );
  }
  if (value.length > maxLength) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} exceeds ${maxLength} characters`
    );
  }
  return stripInlineMarkdown(value);
}

export function unwrapJsonFence(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  return (fenced ? fenced[1] : content).trim();
}

export function stripPreamble(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const chatty = /^(好的|好的，|明白|以下|以下为|根据|为您|这是|我将|首先)/;
  let start = 0;
  while (start < lines.length) {
    const line = lines[start];
    if (!line) {
      start += 1;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('{') || !chatty.test(line)) {
      break;
    }
    start += 1;
  }
  return lines.slice(start).join('\n').trim();
}

export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

const presentationStructuralValues = new Set([
  'ppt',
  'word',
  'excel',
  'paragraph',
  'bullets',
  'numbered',
  'quote',
  'table',
  'chart',
  'bar',
  'pie',
  'scene',
  'coverScene',
  'closingScene',
  'schemaVersion',
  'elements',
  'elementId',
  'geometry',
  'x',
  'y',
  't',
  'l',
  'r',
  'b',
  'width',
  'height',
  'zIndex',
  'parentId',
  'readingOrder',
  'style',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'textColor',
  'fill',
  'stroke',
  'opacity',
  'align',
  'verticalAlign',
  ...presentationPageKinds
]);

interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Finds the value ranges of scene fields without requiring valid JSON. The
 * model response is often still streaming when recovery runs, so a tolerant
 * brace scanner is safer than attempting a second JSON parse here.
 */
function findPresentationSceneRanges(content: string): readonly TextRange[] {
  const ranges: TextRange[] = [];
  const keyPattern = /"(?:scene|coverScene|closingScene)"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(content)) !== null) {
    const valueStart = firstNonWhitespace(content, match.index + match[0].length);
    if (valueStart >= content.length) {
      ranges.push({ start: match.index, end: content.length });
      continue;
    }
    const opener = content[valueStart];
    if (opener !== '{' && opener !== '[') {
      ranges.push({ start: match.index, end: valueStart });
      continue;
    }
    const end = scanBalancedValue(content, valueStart);
    ranges.push({ start: match.index, end });
  }
  return ranges;
}

function firstNonWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function scanBalancedValue(value: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    if (stack[stack.length - 1] === expected) stack.pop();
    else return index;
    if (stack.length === 0) return index + 1;
  }
  return value.length;
}

function isPresentationSceneMetadataValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/^[{}\[\],:]+$/u.test(normalized)) return true;
  if (/^(?:elementId|schemaVersion|geometry|elements|zIndex|parentId|readingOrder|style|font(?:Size|Family|Weight)|textColor|fill|stroke|opacity|align|verticalAlign|x|y|t|l|r|b|width|height)\s*:/u.test(normalized)) return true;
  if (/(?:elementId|schemaVersion|zIndex|parentId|readingOrder|geometry|fontSize|textColor|width|height|\bt)\s*:/u.test(normalized)) return true;
  return false;
}

function extractJsonStringTokens(
  content: string
): readonly { readonly value: string; readonly start: number; readonly end: number }[] {
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  const pattern = /"(?:\\.|[^"\\])*"/g;
  let match = pattern.exec(content);
  while (match) {
    try {
      const value = JSON.parse(match[0]);
      if (typeof value === 'string' && value.trim()) {
        tokens.push({
          value: stripInlineMarkdown(value),
          start: match.index,
          end: match.index + match[0].length
        });
      }
    } catch {
      // Skip one malformed string and continue recovering the remaining text.
    }
    match = pattern.exec(content);
  }
  return tokens;
}

function parseKind(value: unknown): DocumentWorkspaceKind {
  if (
    typeof value !== 'string' ||
    !outlineDocumentKinds.includes(value as DocumentWorkspaceKind)
  ) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'outline.kind must be one of word, excel, ppt'
    );
  }
  return value as DocumentWorkspaceKind;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `Document outline is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isRecord(parsed)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'Document outline must be a JSON object'
    );
  }
  return parsed;
}

function normalizeObservedDocument(
  value: Record<string, unknown>,
  kind: DocumentWorkspaceKind
): DocumentOutline {
  if (kind === 'excel') {
    const excel = normalizeObservedExcel(value);
    if (excel) return parseDocumentOutline(JSON.stringify(excel));
  }
  if (!Array.isArray(value.sections)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'Observed document sections must be an array'
    );
  }
  const normalized = {
    kind,
    title: value.title,
    sections: value.sections.map((section, sectionIndex) => {
      if (!isRecord(section) || !Array.isArray(section.content)) {
        throw new DocumentOutlineError(
          'document_invalid_outline',
          `Observed document section ${sectionIndex} is invalid`
        );
      }
      return {
        heading: section.heading,
        level: 1,
        blocks: section.content.flatMap((block, blockIndex) =>
          normalizeObservedBlock(block, `sections[${sectionIndex}].content[${blockIndex}]`, 0)
        )
      };
    })
  };
  return parseDocumentOutline(JSON.stringify(normalized));
}

function normalizeObservedBlock(
  value: unknown,
  label: string,
  depth: number
): Record<string, unknown>[] {
  if (!isRecord(value) || typeof value.type !== 'string' || depth > 3) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} is invalid`
    );
  }
  switch (value.type) {
    case 'paragraph':
      return [{ type: 'paragraph', text: value.text }];
    case 'ordered_list':
      return [{ type: 'numbered', items: value.items }];
    case 'unordered_list':
    case 'bullet_list':
      return [{ type: 'bullets', items: value.items }];
    case 'table': {
      const table = normalizeObservedTable(value, label);
      return [
        ...(value.caption === undefined
          ? []
          : [{ type: 'paragraph', text: value.caption }]),
        { type: 'table', header: table.header, rows: table.rows }
      ];
    }
    case 'subsection': {
      if (!Array.isArray(value.content)) {
        throw new DocumentOutlineError(
          'document_invalid_outline',
          `${label}.content must be an array`
        );
      }
      return [
        { type: 'paragraph', text: value.heading },
        ...value.content.flatMap((block, index) =>
          normalizeObservedBlock(block, `${label}.content[${index}]`, depth + 1)
        )
      ];
    }
    default:
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.type is unsupported`
      );
  }
}

function normalizeObservedExcel(
  value: Record<string, unknown>
): Record<string, unknown> | undefined {
  const sources = Array.isArray(value.sheets)
    ? value.sheets
    : value.headers !== undefined || value.columns !== undefined
      ? [value]
      : undefined;
  if (!sources) return undefined;
  return {
    kind: 'excel',
    title: value.title,
    sections: sources.map((source, index) => {
      if (!isRecord(source)) {
        throw new DocumentOutlineError(
          'document_invalid_outline',
          `sheets[${index}] must be an object`
        );
      }
      const table = normalizeObservedTable(source, `sheets[${index}]`);
      return {
        heading: source.name ?? source.title ?? `工作表 ${index + 1}`,
        level: 1,
        blocks: [{ type: 'table', ...table }]
      };
    })
  };
}

function normalizeObservedTable(
  value: Record<string, unknown>,
  label: string
): { readonly header: readonly string[]; readonly rows: readonly string[][] } {
  const rawColumns = value.header ?? value.headers ?? value.columns;
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} table columns must be a non-empty array`
    );
  }
  const keys: string[] = [];
  const header = rawColumns.map((column, index) => {
    if (typeof column === 'string') {
      keys.push(column);
      return column;
    }
    if (!isRecord(column)) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label} column ${index} is invalid`
      );
    }
    const key = column.key ?? column.field ?? column.name ?? column.title;
    const title = column.title ?? column.name ?? column.label ?? key;
    if (typeof key !== 'string' || typeof title !== 'string') {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label} column ${index} is invalid`
      );
    }
    keys.push(key);
    return title;
  });
  const rawRows = value.rows ?? value.data;
  if (!Array.isArray(rawRows)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `${label} table rows must be an array`
    );
  }
  const rows = rawRows.map((row, rowIndex) => {
    const cells = Array.isArray(row)
      ? row
      : isRecord(row)
        ? keys.map((key) => row[key])
        : undefined;
    if (!cells) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label} row ${rowIndex} is invalid`
      );
    }
    return cells.map((cell) =>
      cell === null || cell === undefined ? '' : String(cell)
    );
  });
  return { header, rows };
}

export function isDocumentOutline(value: unknown): value is DocumentOutline {
  if (!isRecord(value)) return false;
  if (
    !outlineDocumentKinds.includes(value.kind as DocumentWorkspaceKind) ||
    typeof value.title !== 'string' ||
    value.title.trim().length === 0 ||
    !Array.isArray(value.sections)
  ) {
    return false;
  }
  try {
    parseDocumentOutline(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
