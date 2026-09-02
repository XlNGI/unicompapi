import { access, mkdir, mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DocumentRenderAdapter, DocumentRenderResult } from './temporary-document-workflow';

export interface OfficeRenderCommandConfig {
  readonly officeExecutable: string;
  readonly pdfToPngExecutable: string;
  readonly timeoutMs?: number;
}

export function createConfiguredOfficeRenderAdapter(
  environment: Readonly<Record<string, string | undefined>> = process.env
): DocumentRenderAdapter | undefined {
  const officeExecutable = environment.UNICOMP_OFFICE_RENDERER?.trim();
  const pdfToPngExecutable = environment.UNICOMP_PDF_RENDERER?.trim();
  if (!officeExecutable || !pdfToPngExecutable) return undefined;
  return createOfficeRenderAdapter({ officeExecutable, pdfToPngExecutable });
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
      const diagnostics = await inspectRenderedOutput(
        pdfPath,
        pngFiles.map((file) => path.join(workDirectory, file)),
        input.kind
      );
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
  readonly code: 'font_missing' | 'empty_page' | 'invalid_image' | 'page_count_mismatch' | 'text_overflow' | 'overlap';
  readonly severity: 'error' | 'warning';
  readonly scope: string;
  readonly message: string;
}[]> {
  const diagnostics: Array<{
    readonly code: 'font_missing' | 'empty_page' | 'invalid_image' | 'page_count_mismatch' | 'text_overflow' | 'overlap';
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
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)) }).promise;
    if (document.numPages !== pngPaths.length) {
      diagnostics.push({ code: 'page_count_mismatch', severity: 'error', scope: 'document', message: 'PDF page count does not match rendered image count' });
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => 'str' in item) as Array<{ str: string; transform: number[]; width: number; height: number; fontName?: string }>;
      if (items.every((item) => item.str.trim().length === 0)) {
        diagnostics.push({ code: 'empty_page', severity: 'warning', scope: `page:${pageNumber}`, message: `${kind} page contains no extractable text; verify intentional blank pages` });
      }
      const viewport = page.getViewport({ scale: 1 });
      const boxes = items.filter((item) => item.str.trim()).map((item) => {
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        return { left: x, right: x + Math.abs(item.width), top: y, bottom: y + Math.abs(item.height) };
      });
      if (boxes.some((box) => box.left < -1 || box.right > viewport.width + 1 || box.top < -1 || box.bottom > viewport.height + 1)) {
        diagnostics.push({ code: 'text_overflow', severity: 'warning', scope: `page:${pageNumber}`, message: 'Text bounding box extends outside the PDF page bounds' });
      }
      for (let index = 0; index < boxes.length; index += 1) {
        for (let next = index + 1; next < boxes.length; next += 1) {
          const overlapWidth = Math.min(boxes[index].right, boxes[next].right) - Math.max(boxes[index].left, boxes[next].left);
          const overlapHeight = Math.min(boxes[index].bottom, boxes[next].bottom) - Math.max(boxes[index].top, boxes[next].top);
          if (overlapWidth > 2 && overlapHeight > 2) {
            diagnostics.push({ code: 'overlap', severity: 'warning', scope: `page:${pageNumber}`, message: 'Text bounding boxes overlap; verify intentional layering' });
            index = boxes.length;
            break;
          }
        }
      }
    }
    document.cleanup();
  } catch {
    diagnostics.push({ code: 'font_missing', severity: 'warning', scope: 'document', message: 'PDF text/font inspection was unavailable; visual review is required' });
  }
  return diagnostics;
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
