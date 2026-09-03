import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import type {
  DocumentOutline,
  DocumentOutlineBlock,
  DocumentOutlineSection,
  DocumentWorkspaceKind
} from '../../domain';
import {
  readStructuredDocument,
  type DocumentPatch,
  type DocumentStructureSnapshot
} from './structured-document-tools';

const maximumOfficeBytes = 64 * 1024 * 1024;

export class OfficeDocumentToolError extends Error {
  constructor(
    readonly code:
      | 'invalid_path'
      | 'unsupported_format'
      | 'file_unavailable'
      | 'invalid_package'
      | 'target_not_found'
      | 'write_failed',
    message: string
  ) {
    super(message);
    this.name = 'OfficeDocumentToolError';
  }
}

export interface OfficeDocumentToolInput {
  readonly rootDirectory: string;
  /** Project-relative path; never an absolute path or an LLM-provided value. */
  readonly relativePath: string;
  readonly kind: DocumentWorkspaceKind;
}

export interface OfficeDocumentPatchInput extends OfficeDocumentToolInput {
  readonly patch: DocumentPatch;
  /** Project-relative temporary destination. The source is never overwritten. */
  readonly outputRelativePath: string;
}

export async function readOfficeDocumentStructure(
  input: OfficeDocumentToolInput
): Promise<DocumentStructureSnapshot> {
  const absolutePath = await resolveOfficePath(input);
  const buffer = await readOfficeBytes(absolutePath, input.kind);
  const outline = await parseOfficeOutline(buffer, input.kind, input.relativePath);
  return readStructuredDocument(outline);
}

/**
 * Applies the E7 deterministic clear-section operation to a real Office
 * package. The caller must provide a temporary destination inside the same
 * project; the source package is read-only and is never replaced.
 */
export async function applyOfficeDocumentPatch(
  input: OfficeDocumentPatchInput
): Promise<{ readonly outputRelativePath: string; readonly structure: DocumentStructureSnapshot }> {
  if (
    input.patch.operation !== 'clear_section' &&
    input.patch.operation !== 'replace_section' &&
    input.patch.operation !== 'replace_text' &&
    input.patch.operation !== 'update_cells'
  ) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'The Office file executor only accepts bounded section revisions'
    );
  }
  const sectionIndex = input.patch.target.sectionIndex;
  if (
    typeof sectionIndex !== 'number' ||
    !Number.isSafeInteger(sectionIndex) ||
    sectionIndex < 0
  ) {
    throw new OfficeDocumentToolError('target_not_found', 'Section target is invalid');
  }
  const sourcePath = await resolveOfficePath(input);
  const outputPath = await resolveOfficePath({
    rootDirectory: input.rootDirectory,
    relativePath: input.outputRelativePath,
    kind: input.kind
  });
  if (sourcePath === outputPath) {
    throw new OfficeDocumentToolError(
      'invalid_path',
      'Temporary output must differ from the source document'
    );
  }
  const source = await readOfficeBytes(sourcePath, input.kind);
  const output = await applyOfficeDocumentPatchToBuffer(
    source,
    input.kind,
    input.patch
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, output, { flag: 'wx' });
  } catch (error) {
    throw new OfficeDocumentToolError(
      'write_failed',
      error instanceof Error ? error.message : 'Temporary Office output could not be written'
    );
  }
  const structure = await readOfficeDocumentStructure({
    rootDirectory: input.rootDirectory,
    relativePath: input.outputRelativePath,
    kind: input.kind
  });
  return { outputRelativePath: input.outputRelativePath, structure };
}

export async function readOfficeDocumentStructureFromBuffer(input: {
  readonly buffer: Uint8Array;
  readonly kind: DocumentWorkspaceKind;
  readonly displayName: string;
}): Promise<DocumentStructureSnapshot> {
  if (
    input.buffer.length <= 0 ||
    input.buffer.length > maximumOfficeBytes ||
    input.buffer[0] !== 0x50 ||
    input.buffer[1] !== 0x4b
  ) {
    throw new OfficeDocumentToolError(
      'invalid_package',
      `${input.kind} source is not an OOXML package`
    );
  }
  return readStructuredDocument(
    await parseOfficeOutline(input.buffer, input.kind, input.displayName)
  );
}

export async function applyOfficeDocumentPatchToBuffer(
  source: Uint8Array,
  kind: DocumentWorkspaceKind,
  patch: DocumentPatch
): Promise<Uint8Array> {
  if (
    patch.operation !== 'clear_section' &&
    patch.operation !== 'replace_section' &&
    patch.operation !== 'replace_text' &&
    patch.operation !== 'update_cells'
  ) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'The Office file executor only accepts bounded section revisions'
    );
  }
  if (
    (patch.operation === 'replace_text' && kind !== 'word') ||
    (patch.operation === 'update_cells' && kind !== 'excel')
  ) {
    throw new OfficeDocumentToolError('target_not_found', 'Fine-grained operation does not match the Office format');
  }
  const sectionIndex = patch.target.sectionIndex;
  if (
    typeof sectionIndex !== 'number' ||
    !Number.isSafeInteger(sectionIndex) ||
    sectionIndex < 0
  ) {
    throw new OfficeDocumentToolError('target_not_found', 'Section target is invalid');
  }
  const sourceOutline = await parseOfficeOutline(source, kind, 'revision-source');
  const sourceSection = sourceOutline.sections[sectionIndex];
  const headingMatches = patch.target.sectionHeading === undefined
    ? []
    : sourceOutline.sections.filter(
        (section) =>
          section.heading === patch.target.sectionHeading ||
          section.heading.startsWith(`${patch.target.sectionHeading}（续`)
      );
  if (
    (kind === 'ppt' && patch.target.sectionHeading !== undefined
      ? headingMatches.length === 0
      : sourceSection === undefined)
  ) {
    throw new OfficeDocumentToolError('target_not_found', 'Section target does not exist');
  }
  if (
    kind !== 'ppt' &&
    patch.target.sectionHeading !== undefined &&
    sourceSection?.heading !== patch.target.sectionHeading
  ) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'Section target heading does not match the source document'
    );
  }
  if (kind === 'excel') {
    if (patch.operation === 'update_cells') {
      return updateExcelCell(source, patch);
    }
    return patch.operation === 'clear_section'
      ? clearExcelSection(source, sectionIndex)
      : replaceExcelSection(source, sectionIndex, requireReplacement(patch));
  }
  const zip = await loadZip(source);
  if (kind === 'word') {
    if (patch.operation === 'replace_text') {
      return replaceWordText(zip, patch);
    }
    return patch.operation === 'clear_section'
      ? clearWordSection(zip, sectionIndex)
      : replaceWordSection(zip, sectionIndex, requireReplacement(patch));
  }
  return patch.operation === 'clear_section'
    ? clearPptSection(
        zip,
        sectionIndex,
        patch.target.sectionHeading,
        patch.target.pageNumber
      )
    : replacePptSection(
        zip,
        sectionIndex,
        patch.target.sectionHeading,
        patch.target.pageNumber,
        requireReplacement(patch)
      );
}

export async function applyOfficeDocumentPatchesToBuffer(
  source: Uint8Array,
  kind: DocumentWorkspaceKind,
  patches: readonly DocumentPatch[]
): Promise<Uint8Array> {
  if (patches.length < 1 || patches.length > 8) {
    throw new OfficeDocumentToolError('target_not_found', 'The Office patch batch must contain one to eight patches');
  }
  const targets = new Set(patches.map((patch) =>
    `${patch.operation}:${patch.target.sectionIndex}:${patch.target.blockIndex ?? ''}:${patch.target.rowIndex ?? ''}:${patch.target.columnIndex ?? ''}`
  ));
  if (targets.size !== patches.length) {
    throw new OfficeDocumentToolError('target_not_found', 'The Office patch batch contains duplicate targets');
  }
  let current: Uint8Array = Uint8Array.from(source);
  for (const patch of patches) {
    current = await applyOfficeDocumentPatchToBuffer(current, kind, patch);
  }
  return current;
}

async function replaceWordText(
  zip: JSZip,
  patch: DocumentPatch
): Promise<Uint8Array> {
  const value = requirePatchTextValue(patch);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new OfficeDocumentToolError('invalid_package', 'DOCX document.xml is missing');
  const xml = await entry.async('string');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu)];
  const paragraphTexts = paragraphs.map((match) => decodeXml(
    [...match[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
      .map((item) => item[1])
      .join('')
  ));
  const titleParagraphs = paragraphs.map((match) =>
    /w:pStyle\b[^>]*w:val=["']Title["']/iu.test(match[0])
  );
  const headings = paragraphs
    .map((match, index) => /w:pStyle\b[^>]*w:val=["']Heading[1-3]["']/iu.test(match[0]) ? index : -1)
    .filter((index) => index >= 0);
  const sectionIndex = requirePatchIndex(patch.target.sectionIndex, 'sectionIndex');
  const blockIndex = requirePatchIndex(patch.target.blockIndex, 'blockIndex');
  const start = headings[sectionIndex];
  const end = headings[sectionIndex + 1] ?? paragraphs.length;
  const sectionParagraphIndexes: number[] = [];
  const sectionStart = start === undefined ? paragraphs.length : start + 1;
  const sectionEnd = headings[sectionIndex + 1] ?? paragraphs.length;
  if (sectionIndex === 0) {
    for (let index = 0; index < (headings[0] ?? 0); index += 1) {
      if (paragraphTexts[index]?.trim() && !titleParagraphs[index]) {
        sectionParagraphIndexes.push(index);
      }
    }
  }
  for (let index = sectionStart; index < sectionEnd; index += 1) {
    if (paragraphTexts[index]?.trim()) sectionParagraphIndexes.push(index);
  }
  const paragraphIndex = sectionParagraphIndexes[blockIndex] ?? -1;
  if (paragraphIndex < 0 || paragraphIndex >= end) {
    throw new OfficeDocumentToolError('target_not_found', 'DOCX text target does not exist');
  }
  let index = 0;
  const patched = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu, (paragraph) => {
    if (index++ !== paragraphIndex) return paragraph;
    if (!/<w:t\b/iu.test(paragraph)) throw new OfficeDocumentToolError('target_not_found', 'DOCX text target is not editable');
    let first = true;
    return paragraph.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/gu, (_match, open: string, close: string) => {
      if (!first) return `${open}${close}`;
      first = false;
      return `${open}${escapeXml(value)}${close}`;
    });
  });
  return zip.file('word/document.xml', patched).generateAsync({ type: 'nodebuffer' });
}

async function updateExcelCell(
  buffer: Uint8Array,
  patch: DocumentPatch
): Promise<Uint8Array> {
  const value = requirePatchTextValue(patch);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sectionIndex = requirePatchIndex(patch.target.sectionIndex, 'sectionIndex');
  const blockIndex = requirePatchIndex(patch.target.blockIndex, 'blockIndex');
  const rowIndex = requirePatchIndex(patch.target.rowIndex, 'rowIndex');
  const columnIndex = requirePatchIndex(patch.target.columnIndex, 'columnIndex');
  const worksheet = workbook.worksheets[sectionIndex];
  if (!worksheet) throw new OfficeDocumentToolError('target_not_found', 'XLSX worksheet does not exist');
  if (blockIndex !== 0) throw new OfficeDocumentToolError('target_not_found', 'XLSX table block does not exist');
  const populatedRows: number[] = [];
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1);
    if (values.some((value) => value !== null && value !== undefined && String(value).trim().length > 0)) {
      populatedRows.push(rowNumber);
    }
  });
  const headerRowNumber = populatedRows[0];
  const targetRowNumber = populatedRows[rowIndex + 1];
  if (headerRowNumber === undefined || targetRowNumber === undefined) {
    throw new OfficeDocumentToolError('target_not_found', 'XLSX cell target does not exist');
  }
  const headerValues = (worksheet.getRow(headerRowNumber).values as unknown[]).slice(1);
  if (columnIndex >= headerValues.length) {
    throw new OfficeDocumentToolError('target_not_found', 'XLSX cell target does not exist');
  }
  const cell = worksheet.getRow(targetRowNumber).getCell(columnIndex + 1);
  cell.value = value;
  return (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
}

function requirePatchIndex(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new OfficeDocumentToolError('target_not_found', `${label} target is invalid`);
  }
  return value;
}

function requirePatchTextValue(patch: DocumentPatch): string {
  if (
    typeof patch.value !== 'string' ||
    patch.value.trim().length === 0 ||
    patch.value.length > 2_000
  ) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      `${patch.operation} requires a bounded non-blank value`
    );
  }
  return patch.value;
}

async function resolveOfficePath(input: OfficeDocumentToolInput): Promise<string> {
  if (
    !input.relativePath ||
    path.isAbsolute(input.relativePath) ||
    input.relativePath.includes('\\') ||
    input.relativePath.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new OfficeDocumentToolError('invalid_path', 'Office path must be a project-relative POSIX path');
  }
  const extension = path.posix.extname(input.relativePath).toLowerCase();
  const expected = { word: '.docx', excel: '.xlsx', ppt: '.pptx' }[input.kind];
  if (extension !== expected) {
    throw new OfficeDocumentToolError('unsupported_format', 'Office path extension does not match document kind');
  }
  const root = path.resolve(input.rootDirectory);
  const absolute = path.resolve(root, ...input.relativePath.split('/'));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new OfficeDocumentToolError('invalid_path', 'Office path escapes the project directory');
  }
  return absolute;
}

async function readOfficeBytes(absolutePath: string, kind: DocumentWorkspaceKind): Promise<Uint8Array> {
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch {
    throw new OfficeDocumentToolError('file_unavailable', 'Office source file is unavailable');
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumOfficeBytes) {
    throw new OfficeDocumentToolError('invalid_package', 'Office source file size is invalid');
  }
  let buffer: Uint8Array;
  try {
    buffer = await readFile(absolutePath);
  } catch {
    throw new OfficeDocumentToolError('file_unavailable', 'Office source file could not be read');
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new OfficeDocumentToolError('invalid_package', `${kind} source is not an OOXML package`);
  }
  return buffer;
}

async function parseOfficeOutline(
  buffer: Uint8Array,
  kind: DocumentWorkspaceKind,
  relativePath: string
): Promise<DocumentOutline> {
  if (kind === 'excel') return parseExcelOutline(buffer, relativePath);
  const zip = await loadZip(buffer);
  return kind === 'word'
    ? parseWordOutline(zip, relativePath)
    : parsePptOutline(zip, relativePath);
}

async function loadZip(buffer: Uint8Array): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    throw new OfficeDocumentToolError('invalid_package', 'Office package is not a valid ZIP');
  }
}

async function parseWordOutline(zip: JSZip, relativePath: string): Promise<DocumentOutline> {
  const entry = zip.file('word/document.xml');
  if (!entry) throw new OfficeDocumentToolError('invalid_package', 'DOCX document.xml is missing');
  const xml = await entry.async('string');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)].map((match) => ({
    text: decodeXml([...match[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((item) => item[1]).join('')),
    heading: /w:pStyle\b[^>]*w:val=["']Heading([1-3])["']/iu.exec(match[1]),
    title: /w:pStyle\b[^>]*w:val=["']Title["']/iu.test(match[1])
  })).filter((paragraph) => paragraph.text.trim().length > 0 && !paragraph.title);
  const sections: Array<{ heading: string; level: 1 | 2 | 3; blocks: DocumentOutlineBlock[] }> = [];
  const preamble: string[] = [];
  for (const paragraph of paragraphs) {
    const headingLevel = paragraph.heading ? Number(paragraph.heading[1]) as 1 | 2 | 3 : undefined;
    if (headingLevel !== undefined) {
      sections.push({ heading: paragraph.text, level: headingLevel, blocks: [] });
    } else if (sections.length === 0) {
      preamble.push(paragraph.text);
    } else {
      const section = sections.at(-1)!;
      section.blocks = [...section.blocks, { type: 'paragraph', text: paragraph.text }];
    }
  }
  if (sections.length > 0 && preamble.length > 0) {
    sections[0].blocks = [
      ...preamble.map((text): DocumentOutlineBlock => ({ type: 'paragraph', text })),
      ...sections[0].blocks
    ];
  }
  return {
    kind: 'word',
    title: path.posix.basename(relativePath, '.docx'),
    sections: sections.length > 0 ? sections : [{ heading: '正文', level: 1, blocks: [] }]
  };
}

async function parseExcelOutline(buffer: Uint8Array, relativePath: string): Promise<DocumentOutline> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    throw new OfficeDocumentToolError('invalid_package', 'XLSX package could not be opened');
  }
  const sections: DocumentOutlineSection[] = workbook.worksheets.map((worksheet) => {
    const rows: string[][] = [];
    worksheet.eachRow((row) => {
      const values = (row.values as unknown[]).slice(1).map((value) => value == null ? '' : String(value));
      if (values.some((value) => value.trim().length > 0)) rows.push(values);
    });
    const header = rows[0] ?? ['数据'];
    return {
      heading: worksheet.name || '工作表',
      level: 1,
      blocks: [{ type: 'table', header, rows: rows.slice(1) }]
    };
  });
  return {
    kind: 'excel',
    title: path.posix.basename(relativePath, '.xlsx'),
    sections: sections.length > 0 ? sections : [{ heading: '工作表', level: 1, blocks: [] }]
  };
}

async function parsePptOutline(zip: JSZip, relativePath: string): Promise<DocumentOutline> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(/slide(\d+)/u.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/u.exec(b)?.[1] ?? 0));
  const sections: DocumentOutlineSection[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async('string');
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => decodeXml(match[1]))
      .filter((text) => text.trim().length > 0);
    if (texts.length === 0) continue;
    sections.push({
      heading: texts[0],
      level: 1,
      pageKind: 'insight',
      blocks: texts.slice(1).map((text): DocumentOutlineBlock => ({ type: 'paragraph', text }))
    });
  }
  return {
    kind: 'ppt',
    title: path.posix.basename(relativePath, '.pptx'),
    sections
  };
}

async function clearWordSection(zip: JSZip, sectionIndex: number): Promise<Uint8Array> {
  const entry = zip.file('word/document.xml');
  if (!entry) throw new OfficeDocumentToolError('invalid_package', 'DOCX document.xml is missing');
  const xml = await entry.async('string');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu)];
  const headings = paragraphs
    .map((match, index) => /w:pStyle\b[^>]*w:val=["']Heading[1-3]["']/iu.test(match[0]) ? index : -1)
    .filter((index) => index >= 0);
  const start = headings[sectionIndex];
  if (start === undefined) throw new OfficeDocumentToolError('target_not_found', 'DOCX section does not exist');
  const end = headings[sectionIndex + 1] ?? paragraphs.length;
  const targetParagraphs = new Set(paragraphs.slice(start + 1, end).map((match) => match[0]));
  let index = 0;
  const patched = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu, (paragraph) => {
    const current = index++;
    if (current <= start || current >= end || !targetParagraphs.has(paragraph)) return paragraph;
    return paragraph.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/gu, '$1$2');
  });
  zip.file('word/document.xml', patched);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function replaceWordSection(
  zip: JSZip,
  sectionIndex: number,
  replacement: DocumentOutlineSection
): Promise<Uint8Array> {
  const entry = zip.file('word/document.xml');
  if (!entry) throw new OfficeDocumentToolError('invalid_package', 'DOCX document.xml is missing');
  const xml = await entry.async('string');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu)];
  const headings = paragraphs
    .map((match, index) => /w:pStyle\b[^>]*w:val=["']Heading[1-3]["']/iu.test(match[0]) ? index : -1)
    .filter((index) => index >= 0);
  const start = headings[sectionIndex];
  if (start === undefined) throw new OfficeDocumentToolError('target_not_found', 'DOCX section does not exist');
  const end = headings[sectionIndex + 1] ?? paragraphs.length;
  const bodyIndexes = new Set<number>();
  for (let index = start + 1; index < end; index += 1) bodyIndexes.add(index);
  const values = replacementTextValues(replacement);
  if (values.length > bodyIndexes.size) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'DOCX replacement exceeds the existing bounded section structure'
    );
  }
  let paragraphIndex = 0;
  let valueIndex = 0;
  const patched = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu, (paragraph) => {
    const current = paragraphIndex++;
    if (!bodyIndexes.has(current)) return paragraph;
    const value = values[valueIndex++] ?? '';
    let first = true;
    return paragraph.replace(
      /(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/gu,
      (_match, open: string, close: string) => {
        if (!first) return `${open}${close}`;
        first = false;
        return `${open}${escapeXml(value)}${close}`;
      }
    );
  });
  zip.file('word/document.xml', patched);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function clearPptSection(
  zip: JSZip,
  sectionIndex: number,
  sectionHeading?: string,
  pageNumber?: number
): Promise<Uint8Array> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(/slide(\d+)/u.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/u.exec(b)?.[1] ?? 0));
  const targets = await resolvePptTargetNames(
    zip,
    names,
    sectionIndex,
    sectionHeading,
    pageNumber
  );
  for (const name of targets) {
    const xml = await zip.file(name)!.async('string');
    let headingPreserved = false;
    const patched = xml.replace(
      /(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/gu,
      (match, open: string, text: string, close: string) => {
        const decoded = decodeXml(text);
        if (
          !headingPreserved &&
          (sectionHeading === undefined ||
            decoded === sectionHeading ||
            decoded.startsWith(`${sectionHeading}（续`))
        ) {
          headingPreserved = true;
          return match;
        }
        return `${open}${close}`;
      }
    );
    zip.file(name, patched);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function replacePptSection(
  zip: JSZip,
  sectionIndex: number,
  sectionHeading: string | undefined,
  pageNumber: number | undefined,
  replacement: DocumentOutlineSection
): Promise<Uint8Array> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(/slide(\d+)/u.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/u.exec(b)?.[1] ?? 0));
  const targets = await resolvePptTargetNames(
    zip,
    names,
    sectionIndex,
    sectionHeading,
    pageNumber
  );
  const xmlByName = await Promise.all(
    targets.map(async (name) => ({ name, xml: await zip.file(name)!.async('string') }))
  );
  const bodyCapacity = xmlByName.reduce((total, item) => {
    const texts = [...item.xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => decodeXml(match[1]));
    const headingIndex = texts.findIndex((text) =>
      sectionHeading === undefined ||
      text === sectionHeading ||
      text.startsWith(`${sectionHeading}（续`)
    );
    const pageNumberIndex = texts.length > 1 && /^\d+$/u.test(texts.at(-1) ?? '')
      ? texts.length - 1
      : -1;
    return total + texts.filter((_text, index) => index !== headingIndex && index !== pageNumberIndex).length;
  }, 0);
  const values = replacementTextValues(replacement);
  if (values.length > bodyCapacity) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'PPT replacement exceeds the existing bounded page structure'
    );
  }
  let valueIndex = 0;
  for (const item of xmlByName) {
    const originalTexts = [...item.xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => decodeXml(match[1]));
    const headingIndex = originalTexts.findIndex((text) =>
      sectionHeading === undefined ||
      text === sectionHeading ||
      text.startsWith(`${sectionHeading}（续`)
    );
    const pageNumberIndex = originalTexts.length > 1 && /^\d+$/u.test(originalTexts.at(-1) ?? '')
      ? originalTexts.length - 1
      : -1;
    let runIndex = 0;
    const patched = item.xml.replace(
      /(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/gu,
      (match, open: string, close: string) => {
        const current = runIndex++;
        if (current === headingIndex || current === pageNumberIndex) return match;
        const value = values[valueIndex++] ?? '';
        return `${open}${escapeXml(value)}${close}`;
      }
    );
    zip.file(item.name, patched);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function resolvePptTargetNames(
  zip: JSZip,
  names: readonly string[],
  sectionIndex: number,
  sectionHeading?: string,
  pageNumber?: number
): Promise<readonly string[]> {
  const isTargetSlideHeading = (text: string): boolean =>
    sectionHeading !== undefined &&
    (text === sectionHeading || text.startsWith(`${sectionHeading}（续`));
  if (sectionHeading) {
    const targetIndex = pageNumber === undefined ? sectionIndex : pageNumber - 1;
    const ordinalName = names[targetIndex];
    if (ordinalName) {
      const ordinalXml = await zip.file(ordinalName)!.async('string');
      const ordinalTexts = [...ordinalXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
        .map((match) => decodeXml(match[1]));
      const ordinalIsTarget = ordinalTexts.some(isTargetSlideHeading);
      const duplicateHeading = pageNumber === undefined
        ? await hasMultiplePptHeadings(zip, names, sectionHeading)
        : false;
      if (ordinalIsTarget && !duplicateHeading) {
        const targets = [ordinalName];
        for (let index = targetIndex + 1; index < names.length; index += 1) {
          const xml = await zip.file(names[index])!.async('string');
          const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
            .map((match) => decodeXml(match[1]));
          if (!texts.some(isTargetSlideHeading)) break;
          targets.push(names[index]);
        }
        return targets;
      }
    }
    const exactMatches: number[] = [];
    for (let index = 0; index < names.length; index += 1) {
      const xml = await zip.file(names[index])!.async('string');
      const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
        .map((match) => decodeXml(match[1]));
      if (texts.some((text) => text === sectionHeading)) exactMatches.push(index);
    }
    if (exactMatches.length === 1) {
      const start = exactMatches[0];
      const targets = [names[start]];
      for (let index = start + 1; index < names.length; index += 1) {
        const xml = await zip.file(names[index])!.async('string');
        const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
          .map((match) => decodeXml(match[1]));
        if (!texts.some(isTargetSlideHeading)) break;
        targets.push(names[index]);
      }
      return targets;
    }
    throw new OfficeDocumentToolError(
      'target_not_found',
      exactMatches.length > 1
        ? 'PPT section heading is ambiguous without an exact page target'
        : 'PPT section heading does not match the selected page'
    );
  }
  const fallback = names[sectionIndex];
  if (!fallback) throw new OfficeDocumentToolError('target_not_found', 'PPT page does not exist');
  return [fallback];
}

async function hasMultiplePptHeadings(
  zip: JSZip,
  names: readonly string[],
  heading: string
): Promise<boolean> {
  let count = 0;
  for (const name of names) {
    const xml = await zip.file(name)!.async('string');
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => decodeXml(match[1]));
    if (texts.some((text) => text === heading)) {
      count += 1;
      if (count > 1) return true;
    }
  }
  return false;
}

async function clearExcelSection(buffer: Uint8Array, sectionIndex: number): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.worksheets[sectionIndex];
  if (!worksheet) throw new OfficeDocumentToolError('target_not_found', 'XLSX worksheet does not exist');
  if (worksheet.rowCount > 1) worksheet.spliceRows(2, worksheet.rowCount - 1);
  return (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
}

async function replaceExcelSection(
  buffer: Uint8Array,
  sectionIndex: number,
  replacement: DocumentOutlineSection
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.worksheets[sectionIndex];
  if (!worksheet) throw new OfficeDocumentToolError('target_not_found', 'XLSX worksheet does not exist');
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.value = null;
    });
  });
  const table = replacement.blocks.find(
    (block): block is Extract<DocumentOutlineBlock, { readonly type: 'table' }> =>
      block.type === 'table'
  );
  const rows = table
    ? [table.header, ...table.rows]
    : replacementTextValues(replacement).map((value) => [value]);
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      worksheet.getCell(rowIndex + 1, columnIndex + 1).value = value;
    });
  });
  return (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
}

function requireReplacement(patch: DocumentPatch): DocumentOutlineSection {
  if (!patch.replacement) {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'Replacement content is required for replace_section'
    );
  }
  return patch.replacement;
}

function replacementTextValues(section: DocumentOutlineSection): string[] {
  const values: string[] = [];
  if (section.takeaway) values.push(section.takeaway);
  for (const block of section.blocks) {
    if (block.type === 'paragraph' || block.type === 'quote') {
      values.push(block.text);
    } else if (block.type === 'bullets' || block.type === 'numbered') {
      values.push(...block.items);
    } else if (block.type === 'table') {
      values.push(block.header.join(' | '), ...block.rows.map((row) => row.join(' | ')));
    } else {
      if (block.title) values.push(block.title);
      values.push(...block.data.map((point) => `${point.label}: ${point.value}`));
    }
  }
  if (section.action) values.push(section.action);
  return values;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2f;/gi, '/');
}
