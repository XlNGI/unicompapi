import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile as writeFixture
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateDocumentFile,
  parseDocumentOutline,
  sanitizeFileName
} from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createOutputDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-documents-'));
  temporaryRoots.push(root);
  return path.join(root, 'out');
}

const outlineText = JSON.stringify({
  kind: 'word',
  title: '季度销售复盘',
  sections: [
    {
      heading: '业绩概览',
      level: 1,
      blocks: [
        { type: 'bullets', items: ['营收 1200 万', '同比增长 18%'] },
        {
          type: 'table',
          header: ['目标', '负责团队'],
          rows: [['3000 万', '华东']]
        }
      ]
    },
    {
      heading: '下季度计划',
      level: 2,
      blocks: [{ type: 'paragraph', text: '聚焦重点市场。' }]
    }
  ]
});

describe('office document generator', () => {
  it('generates a real Word document', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(outlineText);
    const result = await generateDocumentFile({
      kind: 'word',
      outline,
      outputDirectory,
      now: '2026-08-22T10:00:00.000Z'
    });
    expect(result.fileName.endsWith('.docx')).toBe(true);
    expect(result.fileName).toContain('季度销售复盘');
    expect(result.sizeBytes).toBeGreaterThan(0);
    const fileStat = await stat(result.absolutePath);
    expect(fileStat.size).toBe(result.sizeBytes);
    const buffer = await readFile(result.absolutePath);
    const zip = new AdmZip(Buffer.from(buffer));
    expect(zip.getEntry('word/document.xml')).toBeTruthy();
    const xml = zip.readAsText('word/document.xml');
    expect(xml).toContain('季度销售复盘');
    expect(xml).toContain('业绩概览');
    expect(xml).toContain('w:tbl');
  });

  it('generates a real Excel workbook', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(outlineText);
    const result = await generateDocumentFile({
      kind: 'excel',
      outline,
      outputDirectory,
      now: '2026-08-22T10:00:00.000Z'
    });
    expect(result.fileName.endsWith('.xlsx')).toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.absolutePath);
    const sheet = workbook.getWorksheet('业绩概览');
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell('A1').value).toBe('目标');
    expect(sheet!.getCell('A2').value).toBe('3000 万');
  });

  it('generates a real PowerPoint deck', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(outlineText);
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-22T10:00:00.000Z'
    });
    expect(result.fileName.endsWith('.pptx')).toBe(true);
    const buffer = await readFile(result.absolutePath);
    const zip = new AdmZip(Buffer.from(buffer));
    expect(zip.getEntry('ppt/presentation.xml')).toBeTruthy();
    expect(zip.getEntry('ppt/slides/slide1.xml')).toBeTruthy();
    expect(zip.getEntry('ppt/slides/slide2.xml')).toBeTruthy();
    expect(zip.getEntry('ppt/slides/slide4.xml')).toBeTruthy();
    const firstSlide = zip.readAsText('ppt/slides/slide1.xml');
    expect(firstSlide).toContain('季度销售复盘');
    const secondSlide = zip.readAsText('ppt/slides/slide2.xml');
    expect(secondSlide).toContain('业绩概览');
    const closingSlide = zip.readAsText('ppt/slides/slide4.xml');
    expect(closingSlide).toContain('谢谢观看');
  });

  it('renders chart blocks as native pptx charts', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '数据看板',
        sections: [
          {
            heading: '月度趋势',
            level: 1,
            blocks: [
              {
                type: 'chart',
                chartKind: 'bar',
                title: '月度趋势',
                data: [
                  { label: '一月', value: 10 },
                  { label: '二月', value: 22 }
                ]
              }
            ]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-22T10:00:00.000Z'
    });
    const buffer = await readFile(result.absolutePath);
    const zip = new AdmZip(Buffer.from(buffer));
    expect(
      zip.getEntries().some((entry) =>
        entry.entryName.startsWith('ppt/charts/chart')
      )
    ).toBe(true);
  });

  it('embeds local images into slides', async () => {
    const outputDirectory = await createOutputDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const imagePath = path.join(outputDirectory, 'pixel.png');
    const pixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    await writeFixture(imagePath, pixelPng);
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '图文汇报',
        sections: [
          {
            heading: '现场情况',
            level: 1,
            blocks: [{ type: 'bullets', items: ['图片说明'] }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-22T10:00:00.000Z',
      images: [{ absolutePath: imagePath, caption: '现场照片' }]
    });
    const buffer = await readFile(result.absolutePath);
    const zip = new AdmZip(Buffer.from(buffer));
    expect(
      zip.getEntries().some((entry) => entry.entryName.startsWith('ppt/media/'))
    ).toBe(true);
  });

  it('applies themed accents and card styling to slides', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '主题验收',
        sections: [
          {
            heading: '要点页',
            level: 1,
            blocks: [{ type: 'bullets', items: ['要点一', '要点二'] }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-22T10:00:00.000Z',
      theme: 'forest'
    });
    const buffer = await readFile(result.absolutePath);
    const zip = new AdmZip(Buffer.from(buffer));
    const slideXml = zip.readAsText('ppt/slides/slide2.xml');
    expect(slideXml).toContain('2E7D5B');
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('汇报: 2026? 报告*')).toBe('汇报 2026 报告');
    expect(sanitizeFileName('   ')).toBe('文档');
  });
});
