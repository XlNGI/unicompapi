import { describe, expect, it } from 'vitest';
import { toDocumentGenerationLogError } from '../../electron/ipc/document-generation-logging';

describe('document generation logging', () => {
  it('omits document content and absolute paths from persisted error metadata', () => {
    const error = Object.assign(
      new Error('无法写入 D:\\客户资料\\保密汇报.pptx：包含机密项目进展'),
      { code: 'storage_error' }
    );

    const logged = toDocumentGenerationLogError(error);

    expect(logged).toEqual({
      category: 'document_generation',
      code: 'storage_error'
    });
    expect(JSON.stringify(logged)).not.toContain('客户资料');
    expect(JSON.stringify(logged)).not.toContain('保密汇报');
    expect(JSON.stringify(logged)).not.toContain('机密项目进展');
    expect(JSON.stringify(logged)).not.toContain('D:');
  });

  it('records a safe reason when PPT visual QA renderer is missing', () => {
    const error = Object.assign(
      new Error('PPT visual QA renderer is unavailable; the file was not published'),
      { code: 'verification_failed' }
    );
    expect(toDocumentGenerationLogError(error)).toEqual({
      category: 'document_generation',
      code: 'verification_failed',
      reason: 'renderer_unavailable'
    });
  });

  it('records a safe reason when PPT visual diagnostics fail', () => {
    const error = Object.assign(
      new Error('Rendered document failed visual diagnostics'),
      { code: 'verification_failed' }
    );
    expect(toDocumentGenerationLogError(error)).toEqual({
      category: 'document_generation',
      code: 'verification_failed',
      reason: 'visual_diagnostics'
    });
  });
});
