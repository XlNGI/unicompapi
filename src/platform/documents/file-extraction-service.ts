import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import type * as PdfJs from 'pdfjs-dist';
import type {
  DocumentAttachmentFormat,
  DocumentExtractionDto,
  DocumentExtractionStats
} from '../../shared/document-attachment-ipc';
import { JsonFileReferenceRepository } from '../repositories';
import type { FileReference, ProjectId } from '../../domain';
import { NodeProjectStorage } from '../storage';
import { resolveFileReferencePathSafely } from '../files';

export interface FileExtractionLimits {
  readonly maxFileBytes: number;
  readonly maxPdfPages: number;
  readonly maxXlsxRows: number;
  readonly maxPptxSlides: number;
  readonly maxZipEntries: number;
  readonly maxPptxSlideXmlBytes: number;
  readonly maxAssembledCharacters: number;
  readonly maxPreviewCharacters: number;
}

export const defaultFileExtractionLimits: FileExtractionLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 300,
  maxXlsxRows: 50_000,
  maxPptxSlides: 100,
  maxZipEntries: 500,
  maxPptxSlideXmlBytes: 10 * 1024 * 1024,
  maxAssembledCharacters: 2_000_000,
  maxPreviewCharacters: 4_000
};

export class FileExtractionError extends Error {
  constructor(
    readonly code: 'storage_error' | 'source_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'FileExtractionError';
  }
}

interface ExtractionOutcome {
  readonly status: DocumentExtractionDto['status'];
  readonly text: string;
  readonly stats: DocumentExtractionStats;
  readonly warnings: readonly string[];
}

export class FileExtractionService {
  private readonly limits: FileExtractionLimits;
  private readonly storage: NodeProjectStorage;
  private readonly files: JsonFileReferenceRepository;

  constructor(
    private readonly options: {
      readonly rootDirectory: string;
      readonly projectId: ProjectId;
      readonly limits?: Partial<FileExtractionLimits>;
    }
  ) {
    this.limits = { ...defaultFileExtractionLimits, ...options.limits };
    this.storage = new NodeProjectStorage(options.rootDirectory);
    this.files = new JsonFileReferenceRepository(
      this.storage,
      options.projectId
    );
  }

  async extract(fileId: FileReference['id']): Promise<DocumentExtractionDto> {
    const file = await this.files.get(fileId);
    if (!file) {
      throw new FileExtractionError(
        'storage_error',
        'Attachment file reference does not exist'
      );
    }
    const absolutePath = await resolveFileReferencePathSafely(
      this.options.rootDirectory,
      file
    );
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new FileExtractionError(
        'source_unavailable',
        'Attachment source file is unavailable'
      );
    }
    if (fileStat.size > this.limits.maxFileBytes) {
      return this.outcomeDto(fileId, 'txt', 'too_large', '', { characters: 0 }, [
        `文件超过 ${this.limits.maxFileBytes} 字节上限`
      ]);
    }
    const binaryHead = await readHeadBytes(absolutePath);
    const fileName = file.locator.kind === 'project'
      ? path.basename(file.locator.relativePath)
      : path.basename(file.locator.absolutePath);
    const format = detectDocumentFormat(fileName, binaryHead);
    if (!format) {
      return this.outcomeDto(fileId, 'txt', 'unsupported', '', { characters: 0 }, [
        '不支持的文件格式或扩展名与内容不符'
      ]);
    }
    try {
      const outcome = await extractByFormat(absolutePath, format, this.limits);
      return this.outcomeDto(
        fileId,
        format,
        outcome.status,
        outcome.text,
        outcome.stats,
        outcome.warnings
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /password|encrypt/i.test(error.message)
      ) {
        return this.outcomeDto(
          fileId,
          format,
          'encrypted',
          '',
          { characters: 0 },
          [
          '文档已加密，无法提取内容'
          ]
        );
      }
      return this.outcomeDto(
        fileId,
        format,
        'failed',
        '',
        { characters: 0 },
        [
        error instanceof Error ? error.message : '文件内容提取失败'
        ]
      );
    }
  }

  async extractFullText(
    fileId: FileReference['id']
  ): Promise<string | undefined> {
    const file = await this.files.get(fileId);
    if (!file) {
      throw new FileExtractionError(
        'storage_error',
        'Attachment file reference does not exist'
      );
    }
    const absolutePath = await resolveFileReferencePathSafely(
      this.options.rootDirectory,
      file
    );
    const head = await readHeadBytes(absolutePath);
    const format = detectDocumentFormat(
      file.locator.kind === 'project'
        ? path.basename(file.locator.relativePath)
        : path.basename(file.locator.absolutePath),
      head
    );
    if (!format) return undefined;
    const outcome = await extractByFormat(absolutePath, format, this.limits);
    return outcome.status === 'extracted' ? outcome.text : undefined;
  }

  private outcomeDto(
    fileId: string,
    format: DocumentAttachmentFormat,
    status: DocumentExtractionDto['status'],
    text: string,
    stats: DocumentExtractionStats,
    warnings: readonly string[]
  ): DocumentExtractionDto {
    const preview = text.slice(0, this.limits.maxPreviewCharacters);
    const extraWarnings: string[] = [...warnings];
    if (text.length > this.limits.maxPreviewCharacters) {
      extraWarnings.push('预览已截断，完整内容仅用于生成上下文');
    }
    return {
      fileId,
      format,
      status,
      stats,
      preview,
      warnings: extraWarnings
    };
  }
}

async function readHeadBytes(absolutePath: string): Promise<Uint8Array> {
  const buffer = Buffer.alloc(8);
  const file = await open(absolutePath, 'r');
  try {
    await file.read(buffer, 0, 8, 0);
  } finally {
    await file.close();
  }
  return new Uint8Array(buffer);
}

export function detectDocumentFormat(
  fileName: string,
  head: Uint8Array
): DocumentAttachmentFormat | undefined {
  const extension = path.extname(fileName).toLowerCase();
  const headString = Buffer.from(head).toString('latin1');
  switch (extension) {
    case '.docx':
    case '.xlsx':
    case '.pptx':
    case '.epub':
      return headString.startsWith('PK\u0003\u0004') || headString.startsWith('PK\u0005\u0006')
        ? (extension.slice(1) as DocumentAttachmentFormat)
        : undefined;
    case '.pdf':
      return headString.startsWith('%PDF') ? 'pdf' : undefined;
    case '.txt':
    case '.md':
      return hasNoNulBytes(head)
        ? (extension.slice(1) as DocumentAttachmentFormat)
        : undefined;
    case '.csv':
      return hasNoNulBytes(head) ? 'csv' : undefined;
    default:
      return undefined;
  }
}

function hasNoNulBytes(head: Uint8Array): boolean {
  return !Array.from(head).some((byte) => byte === 0);
}

async function extractByFormat(
  absolutePath: string,
  format: DocumentAttachmentFormat,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  switch (format) {
    case 'txt':
    case 'md':
      return extractPlainText(absolutePath, limits);
    case 'csv':
      return extractCsv(absolutePath, limits);
    case 'docx':
      return extractDocx(absolutePath, limits);
    case 'pdf':
      return extractPdf(absolutePath, limits);
    case 'xlsx':
      return extractXlsx(absolutePath, limits);
    case 'pptx':
      return extractPptx(absolutePath, limits);
    case 'epub':
      return extractEpub(absolutePath, limits);
  }
}

async function extractPlainText(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const text = await readUtf8(absolutePath, limits);
  return {
    status: 'extracted',
    text,
    stats: { characters: text.length, paragraphs: countParagraphs(text) },
    warnings: []
  };
}

async function extractCsv(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const text = await readUtf8(absolutePath, limits);
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows = lines.slice(0, limits.maxXlsxRows).map(parseCsvLine);
  const assembled = rows.map((row) => row.join('\t')).join('\n');
  const warnings: string[] = [];
  if (lines.length > limits.maxXlsxRows) {
    warnings.push(`CSV 超过 ${limits.maxXlsxRows} 行，已截断`);
  }
  return {
    status: 'extracted',
    text: assembled,
    stats: { characters: assembled.length, tables: 1, paragraphs: rows.length },
    warnings
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

async function extractDocx(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const result = await mammoth.extractRawText({ path: absolutePath });
  const text = result.value.slice(0, limits.maxAssembledCharacters);
  return {
    status: 'extracted',
    text,
    stats: { characters: text.length, paragraphs: countParagraphs(text) },
    warnings: result.messages.map((message) => message.message)
  };
}

async function extractPdf(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const pdfjs = (await import(
    'pdfjs-dist/legacy/build/pdf.mjs'
  )) as unknown as typeof PdfJs;
  const data = await readFile(absolutePath);
  const document = await pdfjs.getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    useSystemFonts: true
  }).promise;
  const pages = Math.min(document.numPages, limits.maxPdfPages);
  const pageTexts: string[] = [];
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
      .trim();
    if (pageText) {
      pageTexts.push(`[第 ${pageNumber} 页]\n${pageText}`);
    }
    page.cleanup();
  }
  const warnings: string[] = [];
  if (pageTexts.length === 0) {
    return {
      status: 'scanned_pdf',
      text: '',
      stats: { characters: 0, pages: document.numPages },
      warnings: ['PDF 无可提取文本层，扫描件需 OCR，当前不支持']
    };
  }
  if (document.numPages > limits.maxPdfPages) {
    warnings.push(`PDF 超过 ${limits.maxPdfPages} 页，已截断`);
  }
  const text = pageTexts.join('\n\n').slice(0, limits.maxAssembledCharacters);
  return {
    status: 'extracted',
    text,
    stats: { characters: text.length, pages: pageTexts.length },
    warnings
  };
}

async function extractXlsx(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absolutePath);
  const blocks: string[] = [];
  let rowCount = 0;
  const warnings: string[] = [];
  for (const worksheet of workbook.worksheets) {
    const rows: string[] = [];
    worksheet.eachRow((row) => {
      if (rowCount >= limits.maxXlsxRows) {
        warnings.push(`xlsx 超过 ${limits.maxXlsxRows} 行，已截断`);
        return;
      }
      rowCount += 1;
      const values = row.values as unknown as readonly unknown[];
      rows.push(
        values
          .slice(1)
          .map((value) => (value === undefined || value === null ? '' : String(value)))
          .join('\t')
      );
    });
    blocks.push(`[工作表：${worksheet.name}]\n${rows.join('\n')}`);
  }
  const text = blocks.join('\n\n').slice(0, limits.maxAssembledCharacters);
  return {
    status: 'extracted',
    text,
    stats: {
      characters: text.length,
      tables: workbook.worksheets.length,
      paragraphs: rowCount
    },
    warnings
  };
}

async function extractPptx(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const buffer = await readFile(absolutePath);
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const warnings: string[] = [];
  if (Object.keys(zip.files).length > limits.maxZipEntries) {
    warnings.push('压缩包条目过多，已拒绝解析');
    return {
      status: 'too_large',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  if (slideNames.length > limits.maxPptxSlides) {
    warnings.push(`pptx 超过 ${limits.maxPptxSlides} 页，已截断`);
  }
  const blocks: string[] = [];
  for (const name of slideNames.slice(0, limits.maxPptxSlides)) {
    const xml = await zip.files[name].async('string');
    if (xml.length > limits.maxPptxSlideXmlBytes) {
      warnings.push(`${name} 内容过大，已跳过`);
      continue;
    }
    const texts: string[] = [];
    const regex = /<a:t>([^<]*)<\/a:t>/g;
    let match = regex.exec(xml);
    while (match) {
      texts.push(decodeXmlText(match[1]));
      match = regex.exec(xml);
    }
    if (texts.length > 0) {
      blocks.push(`[第 ${slideNumber(name)} 页]\n${texts.join('\n')}`);
    }
  }
  const text = blocks.join('\n\n').slice(0, limits.maxAssembledCharacters);
  return {
    status: 'extracted',
    text,
    stats: { characters: text.length, pages: blocks.length },
    warnings
  };
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

async function extractEpub(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<ExtractionOutcome> {
  const buffer = await readFile(absolutePath);
  const zip = await JSZip.loadAsync(buffer);
  const warnings: string[] = [];
  if (Object.keys(zip.files).length > limits.maxZipEntries) {
    warnings.push('压缩包条目过多，已拒绝解析');
    return {
      status: 'too_large',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const mimetypeEntry = zip.file('mimetype');
  if (!mimetypeEntry) {
    warnings.push('EPUB 缺少 mimetype 文件，无法识别为有效电子书');
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const mimetype = (await mimetypeEntry.async('string')).trim();
  if (!mimetype.startsWith('application/epub+zip')) {
    warnings.push('mimetype 不是 application/epub+zip，文件可能不是有效 EPUB');
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) {
    warnings.push('EPUB 缺少 META-INF/container.xml');
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const containerXml = await containerEntry.async('string');
  const opfPathMatch = /full-path\s*=\s*["']([^"']+)["']/i.exec(containerXml);
  if (!opfPathMatch) {
    warnings.push('EPUB container.xml 未声明包文档路径');
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const opfPath = normalizeZipPath(opfPathMatch[1]);
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) {
    warnings.push(`EPUB 包文档不存在：${opfPath}`);
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const opfXml = await opfEntry.async('string');
  const manifest = parseEpubManifest(opfXml);
  const spineIds = parseEpubSpine(opfXml);
  if (spineIds.length === 0) {
    warnings.push('EPUB 没有可读取的正文章节');
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const opfDirectory = path.posix.dirname(opfPath);
  const blocks: string[] = [];
  for (let index = 0; index < spineIds.length; index += 1) {
    const href = manifest.get(spineIds[index]);
    if (!href) continue;
    const contentPath = normalizeZipPath(
      opfDirectory === '.' ? href : `${opfDirectory}/${href}`
    );
    const contentEntry = zip.file(contentPath);
    if (!contentEntry) continue;
    let html: string;
    try {
      html = await contentEntry.async('string');
    } catch {
      warnings.push(`章节内容读取失败：${contentPath}`);
      continue;
    }
    if (html.length > limits.maxPptxSlideXmlBytes) {
      warnings.push(`${contentPath} 内容过大，已跳过`);
      continue;
    }
    const paragraphs = extractEpubChapterParagraphs(html);
    if (paragraphs.length === 0) continue;
    const heading = extractEpubHeading(html) ?? `章节 ${index + 1}`;
    blocks.push(`【${heading}】\n${paragraphs.join('\n')}`);
  }
  if (blocks.length === 0) {
    warnings.push('EPUB 未提取到可读正文');
    return {
      status: 'failed',
      text: '',
      stats: { characters: 0 },
      warnings
    };
  }
  const text = blocks.join('\n\n').slice(0, limits.maxAssembledCharacters);
  return {
    status: 'extracted',
    text,
    stats: {
      characters: text.length,
      paragraphs: countParagraphs(text),
      pages: blocks.length
    },
    warnings
  };
}

function parseEpubManifest(opfXml: string): Map<string, string> {
  const items = new Map<string, string>();
  const tagRegex = /<item\b[^>]*>/gi;
  let match = tagRegex.exec(opfXml);
  while (match) {
    const id = /(?:\s|^)id\s*=\s*["']([^"']+)["']/i.exec(match[0]);
    const href = /(?:\s|^)href\s*=\s*["']([^"']+)["']/i.exec(match[0]);
    if (id && href) items.set(id[1], href[1]);
    match = tagRegex.exec(opfXml);
  }
  return items;
}

function parseEpubSpine(opfXml: string): string[] {
  const ids: string[] = [];
  const tagRegex = /<itemref\b[^>]*>/gi;
  let match = tagRegex.exec(opfXml);
  while (match) {
    const idref = /(?:\s|^)idref\s*=\s*["']([^"']+)["']/i.exec(match[0]);
    if (idref) ids.push(idref[1]);
    match = tagRegex.exec(opfXml);
  }
  return ids;
}

function normalizeZipPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function extractEpubHeading(html: string): string | undefined {
  const headingRegex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i;
  const headingMatch = headingRegex.exec(html);
  if (headingMatch) {
    const text = decodeHtmlText(stripHtmlTags(headingMatch[2]))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  const titleRegex = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
  const titleMatch = titleRegex.exec(html);
  if (titleMatch) {
    const text = decodeHtmlText(stripHtmlTags(titleMatch[1]))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function extractEpubChapterParagraphs(html: string): string[] {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t');
  const text = decodeHtmlText(stripHtmlTags(withBreaks));
  return text
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

function decodeHtmlText(value: string): string {
  return decodeXmlText(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0x10ffff ? '' : String.fromCodePoint(code);
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return code > 0x10ffff ? '' : String.fromCodePoint(code);
    });
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

async function readUtf8(
  absolutePath: string,
  limits: FileExtractionLimits
): Promise<string> {
  const buffer = await readFile(absolutePath);
  const text = buffer.toString('utf8');
  if (text.includes('\u0000')) {
    throw new FileExtractionError('source_unavailable', 'File is not plain text');
  }
  return text.slice(0, limits.maxAssembledCharacters);
}

function countParagraphs(text: string): number {
  return text.split(/\r?\n+/).filter((line) => line.trim().length > 0).length;
}
