import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  applyOfficeDocumentPatch,
  readOfficeDocumentStructure
} from '../../src/platform/documents';
import { generateDocumentFile } from '../../src/platform/documents/office-document-generator';

const outline = {
  kind: 'word' as const,
  title: 'E7 测试文档',
  sections: [
    { heading: '第一章', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '保留内容' }] },
    { heading: '第二章', level: 1 as const, blocks: [{ type: 'paragraph' as const, text: '清空内容' }] }
  ]
};

describe('Office document file executor', () => {
  it('reads and clears one real DOCX section into a separate output file', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.e7-office-tool-'));
    try {
      await mkdir(path.join(root, 'files'), { recursive: true });
      const generated = await generateDocumentFile({
        kind: 'word',
        outline,
        outputDirectory: path.join(root, 'files'),
        now: '2026-09-01T00:00:00.000Z'
      });
      const relativePath = `files/${generated.fileName}`;
      const before = await readOfficeDocumentStructure({ rootDirectory: root, relativePath, kind: 'word' });
      expect(before.sectionCount).toBe(2);
      const outputRelativePath = 'files/revision.docx';
      const result = await applyOfficeDocumentPatch({
        rootDirectory: root,
        relativePath,
        kind: 'word',
        outputRelativePath,
        patch: { operation: 'clear_section', target: { sectionIndex: 1 } }
      });
      expect(result.structure.sections[1].heading).toBe('第二章');
      expect(result.structure.sections[1].blockCount).toBe(0);
      expect(await readFile(path.join(root, outputRelativePath))).not.toEqual(
        await readFile(generated.absolutePath)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects absolute, traversing and mismatched paths before file access', async () => {
    await expect(readOfficeDocumentStructure({
      rootDirectory: process.cwd(),
      relativePath: 'C:/private/file.docx',
      kind: 'word'
    })).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(readOfficeDocumentStructure({
      rootDirectory: process.cwd(),
      relativePath: 'files/../secret.docx',
      kind: 'word'
    })).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(readOfficeDocumentStructure({
      rootDirectory: process.cwd(),
      relativePath: 'files/document.xlsx',
      kind: 'word'
    })).rejects.toMatchObject({ code: 'unsupported_format' });
  });
});
