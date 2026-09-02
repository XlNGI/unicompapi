import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  applyOfficeDocumentPatch,
  applyOfficeDocumentPatchToBuffer,
  applyOfficeDocumentPatchesToBuffer,
  readOfficeDocumentStructure,
  readOfficeDocumentStructureFromBuffer
} from '../../src/platform/documents';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
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
  it('applies multiple bounded patches atomically in order', async () => {
    const source = await generateDocumentFile({
      kind: 'word',
      outline,
      outputDirectory: await mkdtemp(path.join(process.cwd(), '.e7-office-batch-')),
      now: '2026-09-01T00:00:00.000Z'
    });
    const sourceBytes = await readFile(source.absolutePath);
    const output = await applyOfficeDocumentPatchesToBuffer(sourceBytes, 'word', [
      { operation: 'clear_section', target: { sectionIndex: 0, sectionHeading: '第一章' } },
      { operation: 'clear_section', target: { sectionIndex: 1, sectionHeading: '第二章' } }
    ]);
    const structure = await readOfficeDocumentStructureFromBuffer({
      buffer: output,
      kind: 'word',
      displayName: 'batch.docx'
    });
    expect(structure.sections.map((section) => section.blockCount)).toEqual([0, 0]);
  });
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

  it('replaces a bounded DOCX section in a separate output file', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.e7-office-replace-'));
    try {
      await mkdir(path.join(root, 'files'), { recursive: true });
      const generated = await generateDocumentFile({
        kind: 'word',
        outline: {
          ...outline,
          sections: [
            { heading: '第一章', level: 1, blocks: [{ type: 'paragraph', text: '甲' }] },
            { heading: '第二章', level: 1, blocks: [{ type: 'paragraph', text: '乙' }] }
          ]
        },
        outputDirectory: path.join(root, 'files'),
        now: '2026-09-01T00:00:00.000Z'
      });
      const result = await applyOfficeDocumentPatch({
        rootDirectory: root,
        relativePath: `files/${generated.fileName}`,
        kind: 'word',
        outputRelativePath: 'files/revision.docx',
        patch: {
          operation: 'replace_section',
          target: { sectionIndex: 1, sectionHeading: '第二章' },
          replacement: {
            heading: 'ignored',
            level: 1,
            blocks: [{ type: 'paragraph', text: '新内容' }]
          }
        }
      });
      expect(result.structure.sections[0].contentHash).not.toBe(
        result.structure.sections[1].contentHash
      );
      expect(result.structure.sections[1].blockCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces one real DOCX paragraph without changing the section heading', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.e7-office-text-'));
    try {
      await mkdir(path.join(root, 'files'), { recursive: true });
      const generated = await generateDocumentFile({
        kind: 'word',
        outline,
        outputDirectory: path.join(root, 'files'),
        now: '2026-09-01T00:00:00.000Z'
      });
      const result = await applyOfficeDocumentPatch({
        rootDirectory: root,
        relativePath: `files/${generated.fileName}`,
        kind: 'word',
        outputRelativePath: 'files/text-revision.docx',
        patch: {
          operation: 'replace_text',
          target: { sectionIndex: 1, sectionHeading: '第二章', blockIndex: 0 },
          value: '段落级新内容'
        }
      });
      expect(result.structure.sections.map((section) => section.heading)).toEqual(['第一章', '第二章']);
      expect(result.structure.sections[0].contentHash).not.toBe(result.structure.sections[1].contentHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the first Word section block after a preamble paragraph', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.e7-office-preamble-'));
    try {
      await mkdir(path.join(root, 'files'), { recursive: true });
      const generated = await generateDocumentFile({
        kind: 'word',
        outline: {
          kind: 'word',
          title: '前置段落定位',
          sections: [{ heading: '第一章', level: 1, blocks: [{ type: 'paragraph', text: '章节内容' }] }]
        },
        outputDirectory: path.join(root, 'files'),
        now: '2026-09-01T00:00:00.000Z'
      });
      const result = await applyOfficeDocumentPatch({
        rootDirectory: root,
        relativePath: `files/${generated.fileName}`,
        kind: 'word',
        outputRelativePath: 'files/preamble-revision.docx',
        patch: {
          operation: 'replace_text',
          target: { sectionIndex: 0, sectionHeading: '第一章', blockIndex: 0 },
          value: '章节新内容'
        }
      });
      expect(result.structure.sections[0].heading).toBe('第一章');
      expect(result.structure.sections[0].contentHash).not.toBe(
        (await readOfficeDocumentStructure({ rootDirectory: root, relativePath: `files/${generated.fileName}`, kind: 'word' })).sections[0].contentHash
      );
      const revised = await JSZip.loadAsync(
        await readFile(path.join(root, 'files/preamble-revision.docx'))
      );
      const xml = await revised.file('word/document.xml')!.async('string');
      expect(xml).toContain('前置段落定位');
      expect(xml).toContain('章节新内容');
      expect(xml).not.toContain('>章节内容<');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears a real XLSX worksheet and PPT page without touching other sections', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.e7-office-three-format-'));
    try {
      await mkdir(path.join(root, 'files'), { recursive: true });
      const cases = [
        {
          kind: 'excel' as const,
          outline: {
            kind: 'excel' as const,
            title: '三格式',
            sections: [
              { heading: '表一', level: 1 as const, blocks: [{ type: 'table' as const, header: ['A'], rows: [['保留']] }] },
              { heading: '表二', level: 1 as const, blocks: [{ type: 'table' as const, header: ['B'], rows: [['清空']] }] }
            ]
          }
        },
        {
          kind: 'ppt' as const,
          outline: {
            kind: 'ppt' as const,
            title: '三格式',
            sections: [
              { heading: '第一页', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'paragraph' as const, text: '保留' }] },
              { heading: '第二页', level: 1 as const, pageKind: 'insight' as const, blocks: [{ type: 'paragraph' as const, text: '清空' }] }
            ]
          }
        }
      ];
      for (const item of cases) {
        const generated = await generateDocumentFile({
          kind: item.kind,
          outline: item.outline,
          outputDirectory: path.join(root, 'files'),
          now: '2026-09-01T00:00:00.000Z'
        });
        const result = await applyOfficeDocumentPatch({
          rootDirectory: root,
          relativePath: `files/${generated.fileName}`,
          kind: item.kind,
          outputRelativePath: `files/${item.kind}-revision${item.kind === 'excel' ? '.xlsx' : '.pptx'}`,
          patch: {
            operation: 'clear_section',
            target: { sectionIndex: 1, sectionHeading: item.outline.sections[1].heading }
          }
        });
        const target = result.structure.sections.find(
          (section) => section.heading === item.outline.sections[1].heading
        );
        expect(target).toBeDefined();
        if (item.kind === 'excel') {
          expect(target?.blocks[0].itemCount).toBe(0);
        } else {
          expect(target?.blockCount).toBe(0);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates one real XLSX data cell with bounded coordinates', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.e7-office-cell-'));
    try {
      await mkdir(path.join(root, 'files'), { recursive: true });
      const generated = await generateDocumentFile({
        kind: 'excel',
        outline: {
          kind: 'excel',
          title: '单元格修改',
          sections: [
            { heading: '工资表', level: 1, blocks: [{ type: 'table', header: ['姓名', '金额'], rows: [['甲', '10']] }] }
          ]
        },
        outputDirectory: path.join(root, 'files'),
        now: '2026-09-01T00:00:00.000Z'
      });
      const result = await applyOfficeDocumentPatch({
        rootDirectory: root,
        relativePath: `files/${generated.fileName}`,
        kind: 'excel',
        outputRelativePath: 'files/cell-revision.xlsx',
        patch: {
          operation: 'update_cells',
          target: { sectionIndex: 0, sectionHeading: '工资表', blockIndex: 0, rowIndex: 0, columnIndex: 1 },
          value: '12'
        }
      });
      expect(result.structure.sections[0].blocks[0].itemCount).toBe(1);
      expect(result.structure.sections[0].contentHash).not.toBe(
        (await readOfficeDocumentStructure({ rootDirectory: root, relativePath: `files/${generated.fileName}`, kind: 'excel' })).sections[0].contentHash
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for fine-grained operations sent to the wrong Office format', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>章</w:t></w:r></w:p><w:p><w:r><w:t>文</w:t></w:r></w:p></w:body></w:document>');
    const source = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(applyOfficeDocumentPatchToBuffer(source, 'word', {
      operation: 'update_cells',
      target: { sectionIndex: 0, blockIndex: 0, rowIndex: 0, columnIndex: 0 },
      value: 'x'
    })).rejects.toMatchObject({ code: 'target_not_found' });
  });

  it('maps Excel logical data rows across blank rows and rejects non-table blocks', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('工资表');
    sheet.addRow(['姓名', '金额']);
    sheet.addRow([]);
    sheet.addRow(['甲', '']);
    sheet.addRow(['乙', '20']);
    const source = await workbook.xlsx.writeBuffer() as unknown as Uint8Array;
    const revised = await applyOfficeDocumentPatchToBuffer(source, 'excel', {
      operation: 'update_cells',
      target: { sectionIndex: 0, blockIndex: 0, rowIndex: 0, columnIndex: 1 },
      value: '12'
    });
    const checked = new ExcelJS.Workbook();
    await checked.xlsx.load(revised as never);
    expect(checked.worksheets[0].getCell(3, 2).value).toBe('12');
    expect(checked.worksheets[0].getCell(4, 2).value).toBe('20');
    await expect(applyOfficeDocumentPatchToBuffer(source, 'excel', {
      operation: 'update_cells',
      target: { sectionIndex: 0, blockIndex: 1, rowIndex: 0, columnIndex: 1 },
      value: '12'
    })).rejects.toMatchObject({ code: 'target_not_found' });
  });

  it('fails closed when fine-grained patches omit a bounded replacement value', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>章</w:t></w:r></w:p><w:p><w:r><w:t>文</w:t></w:r></w:p></w:body></w:document>');
    const source = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(applyOfficeDocumentPatchToBuffer(source, 'word', {
      operation: 'replace_text',
      target: { sectionIndex: 0, blockIndex: 0 },
    })).rejects.toMatchObject({ code: 'target_not_found' });
  });

  it('maps duplicate PPT headings by ordinal and carries the selected continuation pages', async () => {
    const slide = (heading: string, body: string) =>
      `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>${heading}</a:t><a:t>${body}</a:t></p:sld>`;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slide('封面', '封面内容'));
    zip.file('ppt/slides/slide2.xml', slide('重复章节', '第一处内容'));
    zip.file('ppt/slides/slide3.xml', slide('重复章节', '第二处内容'));
    zip.file('ppt/slides/slide4.xml', slide('重复章节（续 2）', '第二处续页'));
    const source = await zip.generateAsync({ type: 'nodebuffer' });
    const revised = await applyOfficeDocumentPatchToBuffer(source, 'ppt', {
      operation: 'clear_section',
      target: { sectionIndex: 1, sectionHeading: '重复章节', pageNumber: 3 }
    });
    const result = await JSZip.loadAsync(revised);
    expect(await result.file('ppt/slides/slide1.xml')!.async('string')).toContain('封面内容');
    expect(await result.file('ppt/slides/slide2.xml')!.async('string')).toContain('第一处内容');
    expect(await result.file('ppt/slides/slide3.xml')!.async('string')).not.toContain('第二处内容');
    expect(await result.file('ppt/slides/slide4.xml')!.async('string')).not.toContain('第二处续页');
  });

  it('rejects ambiguous PPT headings when no exact page target is supplied', async () => {
    const slide = (heading: string, body: string) =>
      `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>${heading}</a:t><a:t>${body}</a:t></p:sld>`;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slide('重复章节', '第一处内容'));
    zip.file('ppt/slides/slide2.xml', slide('重复章节', '第二处内容'));
    const source = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(applyOfficeDocumentPatchToBuffer(source, 'ppt', {
      operation: 'clear_section',
      target: { sectionIndex: 0, sectionHeading: '重复章节' }
    })).rejects.toMatchObject({ code: 'target_not_found' });
  });
});
