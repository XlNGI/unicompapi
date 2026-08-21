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
    default:
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `${label}.type is not supported`
      );
  }
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
  return value;
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
