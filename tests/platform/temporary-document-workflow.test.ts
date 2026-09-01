import { describe, expect, it } from 'vitest';
import {
  prepareTemporaryDocumentVersion,
  type TemporaryDocumentWorkflowInput
} from '../../src/platform/documents';

const outline = {
  kind: 'ppt' as const,
  title: '季度汇报',
  sections: [{
    heading: '结论',
    level: 1 as const,
    blocks: [{ type: 'paragraph' as const, text: '增长稳定' }]
  }]
};

describe('temporary document workflow', () => {
  it('applies a patch and returns a structure-only result without publishing a Work', async () => {
    const result = await prepareTemporaryDocumentVersion({
      outline,
      patch: {
        operation: 'replace_text',
        target: { sectionIndex: 0, blockIndex: 0 },
        value: '增长加速'
      }
    });
    expect(result.status).toBe('ready');
    expect(result.outline.sections[0].blocks[0]).toMatchObject({ text: '增长加速' });
    expect(result.temporary).toBeUndefined();
  });

  it('writes a temporary version and renders it through an injected adapter', async () => {
    let renderedPath = '';
    const input: TemporaryDocumentWorkflowInput = {
      outline,
      outputDirectory: 'project-documents',
      generateTemporaryFile: async () => ({
        fileName: '季度汇报.pptx',
        temporaryPath: 'temporary-file-that-is-not-published.pptx',
        finalPath: 'not-published.pptx',
        sizeBytes: 128
      }),
      render: async (temporaryPath) => {
        renderedPath = temporaryPath;
        return { previewCount: 3, warnings: ['font fallback'] };
      }
    };
    const result = await prepareTemporaryDocumentVersion(input);
    expect(result.status).toBe('ready');
    expect(renderedPath).toContain('temporary-file');
    expect(result.temporary).toMatchObject({ fileName: '季度汇报.pptx', rendered: true });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'render_warning', severity: 'warning' })
    ]));
  });

  it('rejects deterministic capacity failures before generating a temporary file', async () => {
    let generated = false;
    const result = await prepareTemporaryDocumentVersion({
      outline: {
        ...outline,
        sections: [{
          ...outline.sections[0],
          blocks: [{ type: 'paragraph', text: 'x'.repeat(1_200) }]
        }]
      },
      generateTemporaryFile: async () => {
        generated = true;
        throw new Error('must not generate');
      }
    });
    expect(result.status).toBe('rejected');
    expect(generated).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'capacity_exceeded', severity: 'error' })
    ]));
  });

  it('does not publish when rendering fails or cancellation arrives', async () => {
    const failed = await prepareTemporaryDocumentVersion({
      outline,
      generateTemporaryFile: async () => ({
        fileName: 'draft.pptx',
        temporaryPath: 'draft.tmp',
        finalPath: 'draft.pptx',
        sizeBytes: 1
      }),
      render: async () => { throw new Error('renderer unavailable'); }
    });
    expect(failed.status).toBe('failed');
    expect(failed.temporary).toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await prepareTemporaryDocumentVersion({ outline, signal: controller.signal });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.temporary).toBeUndefined();
  });
});
