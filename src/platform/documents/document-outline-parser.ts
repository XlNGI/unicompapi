import {
  documentWorkspaceKinds,
  type DocumentWorkspaceKind
} from '../../domain';

export type DocumentOutlineBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'bullets'; readonly items: readonly string[] }
  | { readonly type: 'numbered'; readonly items: readonly string[] }
  | { readonly type: 'quote'; readonly text: string }
  | {
      readonly type: 'chart';
      readonly chartKind: 'bar' | 'pie';
      readonly title?: string;
      readonly data: readonly { readonly label: string; readonly value: number }[];
    }
  | {
      readonly type: 'table';
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export interface DocumentOutlineSection {
  readonly heading: string;
  readonly level: 1 | 2 | 3;
  readonly blocks: readonly DocumentOutlineBlock[];
}

export interface DocumentOutline {
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly sections: readonly DocumentOutlineSection[];
}

export class DocumentOutlineError extends Error {
  constructor(
    readonly safeCode: 'document_invalid_outline',
    message: string
  ) {
    super(message);
    this.name = 'DocumentOutlineError';
  }
}

const MAX_TITLE_LENGTH = 200;
const MAX_SECTIONS = 100;
const MAX_BLOCKS_PER_SECTION = 100;
const MAX_ITEMS = 50;
const MAX_TEXT_LENGTH = 2000;
const MAX_TABLE_COLUMNS = 50;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELL_LENGTH = 1000;
const MAX_CHART_ITEMS = 50;
const MAX_CHART_LABEL_LENGTH = 100;

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
  const title = parseBoundedText(parsed.title, 'outline.title', MAX_TITLE_LENGTH);
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
    parseSection(item, index)
  );
  return { kind, title, sections };
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
        title = heading[2].trim();
        headingCount += 1;
        continue;
      }
      headingCount += 1;
      currentSection = {
        heading: heading[2].trim(),
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
      if (pendingTable) {
        pendingTable.rows.push(cells);
      } else {
        pendingTable = { header: cells, rows: [] };
      }
      continue;
    }
    flushTable();
    ensureSection();
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(rawLine);
    const numbered = /^\s*\d+[.、）)]\s+(.+)$/.exec(rawLine);
    const quote = /^\s*>\s?(.+)$/.exec(rawLine);
    if (bullet) {
      appendTextBlock('bullets', bullet[1].trim());
    } else if (numbered) {
      appendTextBlock('numbered', numbered[1].trim());
    } else if (quote) {
      appendTextBlock('quote', quote[1].trim());
    } else {
      appendTextBlock('paragraph', trimmed);
    }
  }
  flushTable();

  if (sections.length === 0) {
    const body = lines.map((line) => line.trim()).filter(Boolean);
    if (body.length > 0) {
      sections.push({
        heading: '内容',
        level: 1,
        blocks: [{ type: 'paragraph', text: body.join('\n') }]
      });
    }
  }
  return {
    kind,
    title: title || lines.map((line) => line.trim()).find(Boolean)?.slice(0, 40) || '文档',
    sections
  };

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
      blocks[blocks.length - 1] = {
        type,
        items: [...last.items, text].slice(-50)
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

function parseSection(value: unknown, index: number): DocumentOutlineSection {
  if (!isRecord(value)) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${index}] must be an object`
    );
  }
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
  const blocks = value.blocks.map((block, blockIndex) =>
    parseBlock(block, index, blockIndex)
  );
  return { heading, level: value.level as 1 | 2 | 3, blocks };
}

function parseBlock(
  value: unknown,
  sectionIndex: number,
  blockIndex: number
): DocumentOutlineBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      `outline.sections[${sectionIndex}].blocks[${blockIndex}] is invalid`
    );
  }
  const label = `outline.sections[${sectionIndex}].blocks[${blockIndex}]`;
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
      return parseTable(value, label);
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
  label: string
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
    return row.map((cell, cellIndex) => {
      if (
        typeof cell !== 'string' ||
        cell.length > MAX_TABLE_CELL_LENGTH
      ) {
        throw new DocumentOutlineError(
          'document_invalid_outline',
          `${label}.rows[${rowIndex}][${cellIndex}] is invalid`
        );
      }
      return cell;
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

function parseKind(value: unknown): DocumentWorkspaceKind {
  if (
    typeof value !== 'string' ||
    !documentWorkspaceKinds.includes(value as DocumentWorkspaceKind)
  ) {
    throw new DocumentOutlineError(
      'document_invalid_outline',
      'outline.kind must be one of word, excel, ppt'
    );
  }
  return value as DocumentWorkspaceKind;
}

export function isDocumentOutline(value: unknown): value is DocumentOutline {
  if (!isRecord(value)) return false;
  if (
    !documentWorkspaceKinds.includes(value.kind as DocumentWorkspaceKind) ||
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
