import {
  documentRevisionOperations,
  type DocumentOutline,
  type DocumentOutlineBlock,
  type DocumentRevisionOperation,
  type DocumentWorkspaceKind,
  type PresentationPageKind
} from '../../domain';
import { parseDocumentOutline, presentationPageKinds } from './document-outline-parser';

export interface DocumentStructureBlockSummary {
  readonly blockIndex: number;
  readonly type: DocumentOutlineBlock['type'];
  readonly itemCount: number;
  readonly characterCount: number;
}

export interface DocumentStructureSectionSummary {
  readonly sectionIndex: number;
  readonly heading: string;
  readonly level: 1 | 2 | 3;
  readonly blockCount: number;
  readonly blocks: readonly DocumentStructureBlockSummary[];
}

export interface DocumentStructureSnapshot {
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly sectionCount: number;
  readonly totalCharacters: number;
  readonly sections: readonly DocumentStructureSectionSummary[];
}

export interface DocumentPatchTarget {
  readonly sectionIndex?: number;
  readonly blockIndex?: number;
  readonly itemIndex?: number;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
  readonly pageNumber?: number;
}

export interface DocumentPatch {
  readonly operation: DocumentRevisionOperation;
  readonly target: DocumentPatchTarget;
  readonly value?: string;
  readonly data?: {
    readonly chartKind: 'bar' | 'pie';
    readonly title?: string;
    readonly points: readonly { readonly label: string; readonly value: number }[];
  };
}

export interface DocumentPatchChange {
  readonly operation: DocumentRevisionOperation;
  readonly affectedSections: readonly number[];
  readonly affectedBlocks: readonly string[];
  readonly changed: boolean;
}

export class StructuredDocumentToolError extends Error {
  constructor(
    readonly code:
      | 'invalid_patch'
      | 'target_not_found'
      | 'unsupported_operation'
      | 'kind_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'StructuredDocumentToolError';
  }
}

export function readStructuredDocument(
  document: DocumentOutline
): DocumentStructureSnapshot {
  return {
    kind: document.kind,
    title: document.title,
    sectionCount: document.sections.length,
    totalCharacters: document.sections.reduce(
      (total, section) =>
        total +
        section.heading.length +
        section.blocks.reduce((sum, block) => sum + blockCharacters(block), 0),
      0
    ),
    sections: document.sections.map((section, sectionIndex) => ({
      sectionIndex,
      heading: section.heading,
      level: section.level,
      blockCount: section.blocks.length,
      blocks: section.blocks.map((block, blockIndex) => ({
        blockIndex,
        type: block.type,
        itemCount: blockItemCount(block),
        characterCount: blockCharacters(block)
      }))
    }))
  };
}

export function parseDocumentPatch(value: unknown): DocumentPatch {
  if (!isRecord(value)) throw new StructuredDocumentToolError('invalid_patch', 'Patch must be an object');
  requireExactKeys(value, ['operation', 'target', 'value', 'data']);
  if (typeof value.operation !== 'string' || !documentRevisionOperations.includes(value.operation as DocumentRevisionOperation)) {
    throw new StructuredDocumentToolError('invalid_patch', 'Patch operation is invalid');
  }
  const target = parseTarget(value.target);
  const patch: DocumentPatch = {
    operation: value.operation as DocumentRevisionOperation,
    target,
    ...(value.value !== undefined ? { value: requireSafeText(value.value, 'value') } : {}),
    ...(value.data !== undefined ? { data: parseChartData(value.data) } : {})
  };
  if (patch.value === undefined && patch.data === undefined &&
      ['replace_text', 'insert_text', 'add_section', 'add_column', 'set_style'].includes(patch.operation)) {
    throw new StructuredDocumentToolError('invalid_patch', `${patch.operation} requires a value or data`);
  }
  return patch;
}

export function applyStructuredDocumentPatch(
  document: DocumentOutline,
  patchInput: DocumentPatch | unknown
): { readonly document: DocumentOutline; readonly change: DocumentPatchChange } {
  const patch = parseDocumentPatch(patchInput);
  const sections = document.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => cloneBlock(block))
  }));
  const affectedSections = new Set<number>();
  const affectedBlocks: string[] = [];
  const mark = (sectionIndex: number, blockIndex?: number) => {
    affectedSections.add(sectionIndex);
    if (blockIndex !== undefined) affectedBlocks.push(`${sectionIndex}:${blockIndex}`);
  };

  switch (patch.operation) {
    case 'add_section': {
      const heading = requirePatchValue(patch);
      sections.push({ heading, level: 1, blocks: [] });
      affectedSections.add(sections.length - 1);
      break;
    }
    case 'remove_section': {
      const sectionIndex = requireSectionIndex(patch.target, sections.length);
      sections.splice(sectionIndex, 1);
      affectedSections.add(sectionIndex);
      break;
    }
    case 'replace_text':
    case 'insert_text':
    case 'delete_text': {
      const sectionIndex = requireSectionIndex(patch.target, sections.length);
      const section = sections[sectionIndex];
      const blockIndex = patch.target.blockIndex;
      if (blockIndex === undefined) {
        if (patch.operation === 'insert_text') {
          section.blocks.push({ type: 'paragraph', text: requirePatchValue(patch) });
          mark(sectionIndex, section.blocks.length - 1);
          break;
        }
        throw targetError('a blockIndex is required for this text operation');
      }
      const block = requireBlock(section.blocks, blockIndex);
      const itemIndex = patch.target.itemIndex;
      if ((block.type === 'bullets' || block.type === 'numbered') && itemIndex !== undefined) {
        const items = [...block.items];
        if (itemIndex >= items.length) throw targetError('itemIndex is outside the target block');
        if (patch.operation === 'delete_text') items.splice(itemIndex, 1);
        else items[itemIndex] = requirePatchValue(patch);
        section.blocks[blockIndex] = { ...block, items };
      } else if (block.type === 'paragraph' || block.type === 'quote') {
        if (patch.operation === 'delete_text') section.blocks.splice(blockIndex, 1);
        else section.blocks[blockIndex] = { ...block, text: requirePatchValue(patch) };
      } else {
        throw new StructuredDocumentToolError('unsupported_operation', 'Text operation does not match the target block');
      }
      mark(sectionIndex, blockIndex);
      break;
    }
    case 'update_table':
    case 'update_cells': {
      const sectionIndex = requireSectionIndex(patch.target, sections.length);
      const blockIndex = requireBlockIndex(patch.target, sections[sectionIndex].blocks);
      const block = requireBlock(sections[sectionIndex].blocks, blockIndex);
      if (block.type !== 'table') throw new StructuredDocumentToolError('unsupported_operation', 'Target block is not a table');
      const rowIndex = patch.target.rowIndex;
      const columnIndex = patch.target.columnIndex;
      if (rowIndex === undefined || columnIndex === undefined || rowIndex >= block.rows.length || columnIndex >= block.header.length) {
        throw targetError('rowIndex and columnIndex must identify a table cell');
      }
      const rows = block.rows.map((row) => [...row]);
      rows[rowIndex][columnIndex] = requirePatchValue(patch);
      sections[sectionIndex].blocks[blockIndex] = { ...block, rows };
      mark(sectionIndex, blockIndex);
      break;
    }
    case 'add_column': {
      const sectionIndex = requireSectionIndex(patch.target, sections.length);
      const blockIndex = requireBlockIndex(patch.target, sections[sectionIndex].blocks);
      const block = requireBlock(sections[sectionIndex].blocks, blockIndex);
      if (block.type !== 'table') throw new StructuredDocumentToolError('unsupported_operation', 'Target block is not a table');
      const header = [...block.header, requirePatchValue(patch)];
      const rows = block.rows.map((row) => [...row, '']);
      sections[sectionIndex].blocks[blockIndex] = { ...block, header, rows };
      mark(sectionIndex, blockIndex);
      break;
    }
    case 'replace_page_layout': {
      if (document.kind !== 'ppt') throw new StructuredDocumentToolError('kind_mismatch', 'Page layout is only available for PPT');
      const sectionIndex = requirePageIndex(patch.target, sections.length);
      const pageKind = requirePageKind(requirePatchValue(patch));
      sections[sectionIndex] = { ...sections[sectionIndex], pageKind };
      mark(sectionIndex);
      break;
    }
    case 'create_chart': {
      const sectionIndex = requireSectionIndex(patch.target, sections.length);
      const section = sections[sectionIndex];
      const data = patch.data;
      if (!data) throw new StructuredDocumentToolError('invalid_patch', 'create_chart requires chart data');
      section.blocks.push({ type: 'chart', chartKind: data.chartKind, ...(data.title ? { title: data.title } : {}), data: data.points });
      mark(sectionIndex, section.blocks.length - 1);
      break;
    }
    case 'set_style':
      throw new StructuredDocumentToolError('unsupported_operation', 'Style changes require a format-specific renderer');
    default:
      throw new StructuredDocumentToolError('unsupported_operation', `${patch.operation} is not supported by the structured outline adapter`);
  }
  const next = parseDocumentOutline(JSON.stringify({ ...document, sections }));
  return {
    document: next,
    change: {
      operation: patch.operation,
      affectedSections: [...affectedSections].sort((a, b) => a - b),
      affectedBlocks,
      changed: affectedSections.size > 0
    }
  };
}

function parseTarget(value: unknown): DocumentPatchTarget {
  if (!isRecord(value)) throw new StructuredDocumentToolError('invalid_patch', 'Patch target must be an object');
  requireExactKeys(value, ['sectionIndex', 'blockIndex', 'itemIndex', 'rowIndex', 'columnIndex', 'pageNumber']);
  const target: DocumentPatchTarget = {};
  for (const key of ['sectionIndex', 'blockIndex', 'itemIndex', 'rowIndex', 'columnIndex', 'pageNumber'] as const) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new StructuredDocumentToolError('invalid_patch', `target.${key} must be a non-negative integer`);
      (target as Record<string, number>)[key] = Number(value[key]);
    }
  }
  return target;
}

function parseChartData(value: unknown): NonNullable<DocumentPatch['data']> {
  if (!isRecord(value) || (value.chartKind !== 'bar' && value.chartKind !== 'pie') || !Array.isArray(value.points) || value.points.length > 50) {
    throw new StructuredDocumentToolError('invalid_patch', 'Chart data is invalid');
  }
  requireExactKeys(value, ['chartKind', 'title', 'points']);
  return {
    chartKind: value.chartKind,
    ...(value.title !== undefined ? { title: requireSafeText(value.title, 'data.title') } : {}),
    points: value.points.map((point, index) => {
      if (!isRecord(point) || typeof point.label !== 'string' || point.label.trim().length === 0 || typeof point.value !== 'number' || !Number.isFinite(point.value)) {
        throw new StructuredDocumentToolError('invalid_patch', `data.points[${index}] is invalid`);
      }
      return { label: requireSafeText(point.label, `data.points[${index}].label`), value: point.value };
    })
  };
}

function requireSectionIndex(target: DocumentPatchTarget, count: number): number {
  if (target.sectionIndex === undefined || target.sectionIndex >= count) throw targetError('sectionIndex is outside the document');
  return target.sectionIndex;
}

function requirePageIndex(target: DocumentPatchTarget, count: number): number {
  if (target.pageNumber === undefined || target.pageNumber < 1 || target.pageNumber > count) throw targetError('pageNumber is outside the document');
  return target.pageNumber - 1;
}

function requireBlockIndex(target: DocumentPatchTarget, blocks: readonly DocumentOutlineBlock[]): number {
  if (target.blockIndex === undefined || target.blockIndex >= blocks.length) throw targetError('blockIndex is outside the section');
  return target.blockIndex;
}

function requireBlock(blocks: readonly DocumentOutlineBlock[], index: number): DocumentOutlineBlock {
  const block = blocks[index];
  if (!block) throw targetError('block does not exist');
  return block;
}

function requirePatchValue(patch: DocumentPatch): string {
  if (patch.value === undefined) throw new StructuredDocumentToolError('invalid_patch', `${patch.operation} requires value`);
  return patch.value;
}

function requirePageKind(value: string): PresentationPageKind {
  if (!presentationPageKinds.includes(value as PresentationPageKind)) throw new StructuredDocumentToolError('invalid_patch', 'page layout is invalid');
  return value as PresentationPageKind;
}

function blockItemCount(block: DocumentOutlineBlock): number {
  if (block.type === 'bullets' || block.type === 'numbered') return block.items.length;
  if (block.type === 'table') return block.rows.length;
  if (block.type === 'chart') return block.data.length;
  return 1;
}

function blockCharacters(block: DocumentOutlineBlock): number {
  if (block.type === 'paragraph' || block.type === 'quote') return block.text.length;
  if (block.type === 'bullets' || block.type === 'numbered') return block.items.join('').length;
  if (block.type === 'table') return [...block.header, ...block.rows.flat()].join('').length;
  return (block.title?.length ?? 0) + block.data.map((point) => point.label).join('').length;
}

function cloneBlock(block: DocumentOutlineBlock): DocumentOutlineBlock {
  if (block.type === 'table') return { ...block, header: [...block.header], rows: block.rows.map((row) => [...row]) };
  if (block.type === 'bullets' || block.type === 'numbered') return { ...block, items: [...block.items] };
  if (block.type === 'chart') return { ...block, data: block.data.map((point) => ({ ...point })) };
  return { ...block };
}

function requireSafeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000) throw new StructuredDocumentToolError('invalid_patch', `${label} must be a bounded non-blank string`);
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/i.test(value)) throw new StructuredDocumentToolError('invalid_patch', `${label} must not contain a path or URL`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new StructuredDocumentToolError('invalid_patch', `unsupported field: ${unsupported}`);
}

function targetError(message: string): StructuredDocumentToolError {
  return new StructuredDocumentToolError('target_not_found', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
