import { describe, expect, it } from 'vitest';
import { createConfiguredOfficeRenderAdapter, createOfficeRenderAdapter, OfficeRenderUnavailableError } from '../../src/platform/documents/office-render-adapter';

describe('office render adapter', () => {
  it('requires explicit renderer configuration', () => {
    expect(createConfiguredOfficeRenderAdapter({})).toBeUndefined();
    expect(createConfiguredOfficeRenderAdapter({
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
});
