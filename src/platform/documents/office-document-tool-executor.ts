import { readFile, stat, writeFile } from 'node:fs/promises';
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
  if (input.patch.operation !== 'clear_section') {
    throw new OfficeDocumentToolError(
      'target_not_found',
      'Only clear_section is available in the first Office file executor increment'
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
  let output: Uint8Array;
  if (input.kind === 'excel') {
    output = await clearExcelSection(source, sectionIndex);
  } else {
    const zip = await loadZip(source);
    if (input.kind === 'word') {
      output = await clearWordSection(zip, sectionIndex);
    } else {
      output = await clearPptSection(zip, sectionIndex);
    }
  }
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
    heading: /w:pStyle\b[^>]*w:val=["']Heading([1-3])["']/iu.exec(match[1])
  })).filter((paragraph) => paragraph.text.trim().length > 0);
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

async function clearPptSection(zip: JSZip, sectionIndex: number): Promise<Uint8Array> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(/slide(\d+)/u.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/u.exec(b)?.[1] ?? 0));
  const name = names[sectionIndex];
  if (!name) throw new OfficeDocumentToolError('target_not_found', 'PPT page does not exist');
  const xml = await zip.file(name)!.async('string');
  let textIndex = 0;
  const patched = xml.replace(/(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/gu, (match, open: string, close: string) => {
    return textIndex++ === 0 ? match : `${open}${close}`;
  });
  zip.file(name, patched);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function clearExcelSection(buffer: Uint8Array, sectionIndex: number): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.worksheets[sectionIndex];
  if (!worksheet) throw new OfficeDocumentToolError('target_not_found', 'XLSX worksheet does not exist');
  if (worksheet.rowCount > 1) worksheet.spliceRows(2, worksheet.rowCount - 1);
  return (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
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
