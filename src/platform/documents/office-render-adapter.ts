import { access, mkdir, mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import JSZip from 'jszip';
import type { DocumentRenderAdapter, DocumentRenderResult } from './temporary-document-workflow';

export interface OfficeRenderCommandConfig {
  readonly officeExecutable: string;
  readonly pdfToPngExecutable: string;
  readonly timeoutMs?: number;
}

export function createConfiguredOfficeRenderAdapter(
  environment?: Readonly<Record<string, string | undefined>>
): DocumentRenderAdapter | undefined {
  return createOfficeRenderAdapterFromEnv(
    environment ?? process.env,
    environment === undefined ? readWindowsPersistentRendererEnv() : undefined
  );
}

export function createOfficeRenderAdapterFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  fallback?: Readonly<Record<string, string | undefined>>
): DocumentRenderAdapter | undefined {
  const officeExecutable = firstNonEmpty(
    environment.UNICOMP_OFFICE_RENDERER,
    fallback?.UNICOMP_OFFICE_RENDERER
  );
  const pdfToPngExecutable = firstNonEmpty(
    environment.UNICOMP_PDF_RENDERER,
    fallback?.UNICOMP_PDF_RENDERER
  );
  if (!officeExecutable || !pdfToPngExecutable) return undefined;
  return createOfficeRenderAdapter({ officeExecutable, pdfToPngExecutable });
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function readWindowsPersistentRendererEnv(): Readonly<Record<string, string | undefined>> {
  return {
    UNICOMP_OFFICE_RENDERER: readWindowsPersistentEnv('UNICOMP_OFFICE_RENDERER'),
    UNICOMP_PDF_RENDERER: readWindowsPersistentEnv('UNICOMP_PDF_RENDERER')
  };
}

function readWindowsPersistentEnv(name: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  for (const key of [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  ]) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = /REG_(?:EXPAND_)?SZ\s+(\S.*)$/m.exec(output);
      const value = match?.[1]?.trim();
      if (value) return value;
    } catch {
      // Persistent user/machine environment is optional.
    }
  }
  return undefined;
}

export class OfficeRenderUnavailableError extends Error {
  constructor(message = 'A local Office/PDF renderer is unavailable') {
    super(message);
    this.name = 'OfficeRenderUnavailableError';
  }
}

/**
 * Runs only explicitly configured local binaries. Executable paths are
 * application configuration, never model-controlled input.
 */
export function createOfficeRenderAdapter(
  config: OfficeRenderCommandConfig
): DocumentRenderAdapter {
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 120_000, 1_000), 900_000);
  return async (temporaryPath, input): Promise<DocumentRenderResult> => {
    if (input.signal.aborted) throw new OfficeRenderUnavailableError('Rendering was cancelled');
    const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-render-'));
    try {
      const pdfDirectory = path.join(workDirectory, 'pdf');
      const pngPrefix = path.join(workDirectory, 'page');
      await mkdir(pdfDirectory, { recursive: true });
      await run(config.officeExecutable, [
        '--headless', '--convert-to', 'pdf', '--outdir', pdfDirectory, temporaryPath
      ], input.signal, timeoutMs);
      const pdfFiles = (await readdir(pdfDirectory)).filter((file) => /\.pdf$/iu.test(file));
      if (pdfFiles.length !== 1) throw new OfficeRenderUnavailableError('Office renderer did not produce one PDF');
      const pdfPath = path.join(pdfDirectory, pdfFiles[0]);
      await run(config.pdfToPngExecutable, ['-png', pdfPath, pngPrefix], input.signal, timeoutMs);
      const pngFiles = (await readdir(workDirectory)).filter((file) => /^page-\d+\.png$/iu.test(file));
      if (pngFiles.length < 1) throw new OfficeRenderUnavailableError('PDF renderer did not produce page images');
      const geometryDiagnostics = input.kind === 'ppt'
        ? await inspectPptxGeometry(temporaryPath)
        : [];
      const diagnostics = [...geometryDiagnostics, ...await inspectRenderedOutput(
        pdfPath,
        pngFiles.map((file) => path.join(workDirectory, file)),
        input.kind
      )];
      return {
        previewCount: pngFiles.length,
        warnings: input.kind === 'ppt' && pngFiles.length < 1 ? ['No presentation pages were rendered'] : [],
        ...(diagnostics.length > 0 ? { diagnostics } : {})
      };
    } finally {
      await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

async function inspectRenderedOutput(
  pdfPath: string,
  pngPaths: readonly string[],
  kind: 'word' | 'excel' | 'ppt'
): Promise<readonly {
  readonly code: 'font_missing' | 'empty_page' | 'invalid_image' | 'page_count_mismatch' | 'text_overflow' | 'overlap' | 'element_overflow';
  readonly severity: 'error' | 'warning';
  readonly scope: string;
  readonly message: string;
}[]> {
  const diagnostics: Array<{
    readonly code: 'font_missing' | 'empty_page' | 'invalid_image' | 'page_count_mismatch' | 'text_overflow' | 'overlap' | 'element_overflow';
    readonly severity: 'error' | 'warning';
    readonly scope: string;
    readonly message: string;
  }> = [];
  for (const [index, pngPath] of pngPaths.entries()) {
    const bytes = await readFile(pngPath);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      diagnostics.push({ code: 'invalid_image', severity: 'error', scope: `page:${index + 1}`, message: 'Rendered page is not a valid PNG image' });
      continue;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 16 || height < 16 || width > 20_000 || height > 20_000) {
      diagnostics.push({ code: 'invalid_image', severity: 'error', scope: `page:${index + 1}`, message: 'Rendered page has invalid dimensions' });
    }
  }
  try {
    // TypeScript emits CommonJS for the Electron main process. A direct
    // `import()` expression is therefore rewritten to `require()` and fails
    // for pdfjs-dist's ESM-only entry point. Keep this loader native so the
    // same renderer works in both Node tests and the packaged Electron host.
    const pdfjs = await importEsm('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)) }).promise;
    if (document.numPages !== pngPaths.length) {
      diagnostics.push({ code: 'page_count_mismatch', severity: 'error', scope: 'document', message: 'PDF page count does not match rendered image count' });
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => 'str' in item) as Array<{ str: string; transform: number[]; width: number; height: number; fontName?: string }>;
      if (items.every((item) => item.str.trim().length === 0)) {
        diagnostics.push({ code: 'empty_page', severity: kind === 'ppt' ? 'error' : 'warning', scope: `page:${pageNumber}`, message: kind === 'ppt' ? 'Presentation page contains no extractable text' : `${kind} page contains no extractable text; verify intentional blank pages` });
      }
      const viewport = page.getViewport({ scale: 1 });
      const boxes = items.filter((item) => item.str.trim()).map((item) => {
        // PDF coordinates use a bottom-left origin. Keep both corners and
        // normalize them before comparing against the page bounds; treating
        // the baseline as the top edge causes negative/rotated text to be
        // missed or reported as overflow in the wrong direction.
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        const right = x + Math.abs(item.width);
        const top = y + Math.abs(item.height);
        return {
          left: Math.min(x, right),
          right: Math.max(x, right),
          bottom: Math.min(y, top),
          top: Math.max(y, top)
        };
      });
      if (boxes.some((box) => box.left < -1 || box.right > viewport.width + 1 || box.top < -1 || box.bottom > viewport.height + 1)) {
        diagnostics.push({ code: 'text_overflow', severity: 'error', scope: `page:${pageNumber}`, message: 'Text bounding box extends outside the PDF page bounds' });
      }
      const strictVisualQa = kind === 'ppt';
      for (let index = 0; index < boxes.length; index += 1) {
        for (let next = index + 1; next < boxes.length; next += 1) {
          const overlapWidth = Math.min(boxes[index].right, boxes[next].right) - Math.max(boxes[index].left, boxes[next].left);
          const overlapHeight = Math.min(boxes[index].bottom, boxes[next].bottom) - Math.max(boxes[index].top, boxes[next].top);
          if (overlapWidth > 2 && overlapHeight > 2) {
            diagnostics.push({ code: 'overlap', severity: strictVisualQa ? 'error' : 'warning', scope: `page:${pageNumber}`, message: strictVisualQa ? 'Text bounding boxes overlap' : 'Text bounding boxes overlap; verify intentional layering' });
            index = boxes.length;
            break;
          }
        }
      }
    }
    document.cleanup();
  } catch {
    diagnostics.push({ code: 'font_missing', severity: kind === 'ppt' ? 'error' : 'warning', scope: 'document', message: kind === 'ppt' ? 'PDF text/font inspection was unavailable; visual QA could not be completed' : 'PDF text/font inspection was unavailable; visual review is required' });
  }
  return diagnostics;
}

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const importEsm = new Function(
  'specifier',
  'return import(specifier);'
) as (specifier: string) => Promise<PdfJsModule>;

export async function inspectPptxGeometry(
  filePath: string
): Promise<readonly {
  readonly code: 'element_overflow' | 'text_overflow';
  readonly severity: 'error';
  readonly scope: string;
  readonly message: string;
}[]> {
  const buffer = await readFile(filePath);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new OfficeRenderUnavailableError('PPTX geometry inspection could not open the package');
  }
  const presentation = zip.file('ppt/presentation.xml');
  const presentationXml = presentation ? await presentation.async('string') : undefined;
  const sizeTag = presentationXml && /<p:sldSz\b[^>]*>/u.exec(presentationXml)?.[0];
  const slideWidth = sizeTag ? xmlIntegerAttribute(sizeTag, 'cx') : undefined;
  const slideHeight = sizeTag ? xmlIntegerAttribute(sizeTag, 'cy') : undefined;
  if (slideWidth === undefined || slideHeight === undefined || slideWidth <= 0 || slideHeight <= 0) {
    throw new OfficeRenderUnavailableError('PPTX slide size is unavailable');
  }
  const diagnostics: Array<{
    readonly code: 'element_overflow' | 'text_overflow';
    readonly severity: 'error';
    readonly scope: string;
    readonly message: string;
  }> = [];
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  for (const slideName of slideNames) {
    const xml = await zip.files[slideName].async('string');
    const shapes = xml.match(/<p:(?:sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:(?:sp|pic|graphicFrame|cxnSp)>/gu) ?? [];
    for (const [index, shape] of shapes.entries()) {
      const transform = /<(?:a:xfrm|p:xfrm)\b[\s\S]*?<\/(?:a:xfrm|p:xfrm)>/u.exec(shape)?.[0];
      const origin = transform ?? shape;
      const offTag = /<a:off\b[^>]*>/u.exec(origin)?.[0];
      const extTag = /<a:ext\b[^>]*>/u.exec(origin)?.[0];
      const x = offTag ? xmlIntegerAttribute(offTag, 'x') : undefined;
      const y = offTag ? xmlIntegerAttribute(offTag, 'y') : undefined;
      const width = extTag ? xmlIntegerAttribute(extTag, 'cx') : undefined;
      const height = extTag ? xmlIntegerAttribute(extTag, 'cy') : undefined;
      if (x === undefined || y === undefined || width === undefined || height === undefined) continue;
      if (shapeFitsSlide(x, y, width, height, slideWidth, slideHeight)) continue;
      const scope = `slide:${slideNumber(slideName)}:element:${index + 1}`;
      const hasText = /<a:t\b[^>]*>/u.test(shape);
      diagnostics.push({
        code: hasText ? 'text_overflow' : 'element_overflow',
        severity: 'error',
        scope,
        message: hasText ? 'PPT text shape exceeds the slide bounds' : 'PPT element exceeds the slide bounds'
      });
    }
  }
  return diagnostics;
}


function shapeFitsSlide(
  x: number,
  y: number,
  width: number,
  height: number,
  slideWidth: number,
  slideHeight: number
): boolean {
  if (width < 0 || height < 0 || (width === 0 && height === 0)) return false;
  return x >= 0 && y >= 0 && x + width <= slideWidth && y + height <= slideHeight;
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/u.exec(name)?.[1] ?? 0);
}

function xmlIntegerAttribute(tag: string, name: string): number | undefined {
  const value = new RegExp(`\\b${name}="(-?\\d+)"`, 'u').exec(tag)?.[1];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function run(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  if (!executable || path.isAbsolute(executable) === false && /[\\/]/u.test(executable)) {
    throw new OfficeRenderUnavailableError('Renderer executable configuration is invalid');
  }
  try {
    await access(executable);
  } catch {
    throw new OfficeRenderUnavailableError();
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      child.kill();
      finish(new OfficeRenderUnavailableError('Rendering was cancelled'));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new OfficeRenderUnavailableError('Rendering timed out'));
    }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(new OfficeRenderUnavailableError()));
    child.once('exit', (code) => code === 0 ? finish() : finish(new OfficeRenderUnavailableError('Renderer exited unsuccessfully')));
  });
}
