import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConfiguredOfficeRenderAdapter,
  createOfficeRenderAdapter,
  createOfficeRenderAdapterFromEnv,
  inspectPptxGeometry,
  OfficeRenderUnavailableError
} from '../../src/platform/documents/office-render-adapter';
import {
  generateTemporaryDocumentFile,
  parseDocumentOutline
} from '../../src/platform/documents';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('office render adapter', () => {
  it('requires explicit renderer configuration', () => {
    expect(createConfiguredOfficeRenderAdapter({})).toBeUndefined();
    expect(createConfiguredOfficeRenderAdapter({
      UNICOMP_OFFICE_RENDERER: 'soffice',
      UNICOMP_PDF_RENDERER: 'pdftoppm'
    })).toBeDefined();
  });
  it('uses fallback renderer paths when process env is empty', () => {
    expect(createOfficeRenderAdapterFromEnv({})).toBeUndefined();
    expect(createOfficeRenderAdapterFromEnv({}, {
      UNICOMP_OFFICE_RENDERER: 'soffice',
      UNICOMP_PDF_RENDERER: 'pdftoppm'
    })).toBeDefined();
  });

  it('fails closed when configured renderers are unavailable', async () => {
    const render = createOfficeRenderAdapter({
      officeExecutable: 'E:/does-not-exist/soffice.exe',
      pdfToPngExecutable: 'E:/does-not-exist/pdftoppm.exe'
    });
    await expect(render('E:/controlled/temp.docx', {
      kind: 'word',
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(OfficeRenderUnavailableError);
  });

  it('honours cancellation before launching a renderer', async () => {
    const controller = new AbortController();
    controller.abort();
    const render = createOfficeRenderAdapter({
      officeExecutable: 'E:/does-not-exist/soffice.exe',
      pdfToPngExecutable: 'E:/does-not-exist/pdftoppm.exe'
    });
    await expect(render('E:/controlled/temp.docx', {
      kind: 'word',
      signal: controller.signal
    })).rejects.toThrow('cancelled');
  });

  it('does not treat in-bounds PPT connector lines as overflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ppt-geometry-'));
    temporaryRoots.push(root);
    const generated = await generateTemporaryDocumentFile({
      kind: 'ppt',
      outline: parseDocumentOutline(JSON.stringify({
        kind: 'ppt',
        title: '季度工作汇报',
        sections: [
          { heading: '目标回顾', level: 1, blocks: [{ type: 'paragraph', text: '本季度完成重点工作。' }, { type: 'bullets', items: ['完成验收', '补齐稳定性'] }] },
          { heading: '关键进展', level: 1, blocks: [{ type: 'numbered', items: ['需求澄清', '方案评审', '联调验收'] }] },
          { heading: '问题与风险', level: 1, blocks: [{ type: 'bullets', items: ['几何误报', '装饰线'] }] }
        ]
      })),
      presentationTemplate: 'work_report',
      outputDirectory: root,
      now: '20260924020000'
    });
    await expect(inspectPptxGeometry(generated.temporaryPath)).resolves.toEqual([]);
  });

  it('still reports a PPT shape that extends past the slide edge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ppt-overflow-'));
    temporaryRoots.push(root);
    const generated = await generateTemporaryDocumentFile({
      kind: 'ppt',
      outline: parseDocumentOutline(JSON.stringify({
        kind: 'ppt',
        title: '越界检查',
        sections: [{ heading: '结论', level: 1, blocks: [{ type: 'paragraph', text: '用于验证真实越界仍会失败。' }] }]
      })),
      presentationTemplate: 'work_report',
      outputDirectory: root,
      now: '20260924020000'
    });
    const zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
    const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
    zip.file('ppt/presentation.xml', presentationXml.replace(/<p:sldSz\b[^>]*>/u, '<p:sldSz cx="1000" cy="1000"/>'));
    const overflowPath = path.join(root, 'overflow.pptx');
    await writeFile(overflowPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const diagnostics = await inspectPptxGeometry(overflowPath);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((item) => item.code === 'element_overflow' || item.code === 'text_overflow')).toBe(true);
  });
});
