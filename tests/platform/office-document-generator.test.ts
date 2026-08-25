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

function readChartFrameExtents(xml: string): { x: number; y: number; w: number; h: number }[] {
  return [...xml.matchAll(/<p:graphicFrame>([\s\S]*?<c:chart[\s\S]*?)<\/p:graphicFrame>/g)]
    .map((match) => {
      const transform = match[1].match(
        /<p:xfrm>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/
      );
      if (!transform) throw new Error('Chart frame has no transform');
      return {
        x: Number(transform[1]),
        y: Number(transform[2]),
        w: Number(transform[3]),
        h: Number(transform[4])
      };
    });
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

  it('renders normalized Word content with editable report styling', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'word',
        title: '智能客服 Agent 系统设计文档',
        sections: [
          {
            heading: '一、系统概述',
            level: 1,
            blocks: [
              { type: 'paragraph', text: '系统说明。' },
              { type: 'paragraph', text: '表 1-1 系统核心能力' },
              {
                type: 'table',
                header: ['能力', '说明'],
                rows: [['意图识别', '识别用户咨询']]
              }
            ]
          },
          {
            heading: '二、核心流程',
            level: 1,
            blocks: [
              {
                type: 'numbered',
                items: ['接收请求', '检索资料', '输出答案']
              }
            ]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'word',
      outline,
      outputDirectory,
      now: '2026-08-24T10:00:00.000Z',
      theme: 'blueprint'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const xml = zip.readAsText('word/document.xml');
    expect(xml).toContain('智能客服 Agent 系统设计文档');
    expect(xml).toContain('系统说明。');
    expect(xml).toContain('表 1-1 系统核心能力');
    expect(xml).toContain('意图识别');
    expect(xml).toContain('接收请求');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('1F5FBF');
    expect(xml).toContain('<w:shd w:fill="1F5FBF"');
    expect(xml).toContain('<w:b/>');
    expect(xml).not.toContain('&quot;title&quot;');
    expect(xml).not.toContain('&quot;sections&quot;');
    expect(xml).not.toContain('ordered_list');
    expect((xml.match(/接收请求/g) ?? []).length).toBe(1);
    expect((xml.match(/检索资料/g) ?? []).length).toBe(1);
    expect((xml.match(/输出答案/g) ?? []).length).toBe(1);
  });

  it('starts each numbered block with its own numbering instance', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'word',
        title: '独立步骤',
        sections: [
          {
            heading: '第一部分',
            level: 1,
            blocks: [{ type: 'numbered', items: ['甲', '乙'] }]
          },
          {
            heading: '第二部分',
            level: 1,
            blocks: [{ type: 'numbered', items: ['丙', '丁'] }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'word',
      outline,
      outputDirectory,
      now: '2026-08-24T10:00:00.000Z',
      theme: 'blueprint'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const xml = zip.readAsText('word/document.xml');
    const ids = [...xml.matchAll(/<w:numPr>[\s\S]*?<w:numId w:val="(\d+)"/g)].map(
      (match) => match[1]
    );
    expect(new Set(ids).size).toBe(2);
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

  it('keeps chart frames inside the slide when paired with an image and many labels', async () => {
    const outputDirectory = await createOutputDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const imagePath = path.join(outputDirectory, 'chart-reference.png');
    await writeFixture(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '图表边界验收',
      sections: [{
        heading: '经营数据',
        level: 1,
        blocks: [{
          type: 'chart',
          chartKind: 'bar',
          title: '年度收入',
          data: [
            { label: '2021 年', value: 10 },
            { label: '2022 年', value: 20 },
            { label: '2023 年', value: 30 },
            { label: '2024 年', value: 40 },
            { label: '2025 年', value: 50 },
            { label: '2026 年', value: 60 },
            { label: '2027 年', value: 70 }
          ]
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-24T10:00:00.000Z',
      images: [{ absolutePath: imagePath, caption: '参考图' }]
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const chartFrames = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .flatMap((entry) => readChartFrameExtents(zip.readAsText(entry.entryName)));
    const emuPerInch = 914400;
    expect(chartFrames).toHaveLength(1);
    expect(chartFrames[0].x + chartFrames[0].w).toBeLessThanOrEqual(13.333 * emuPerInch);
    expect(chartFrames[0].y + chartFrames[0].h).toBeLessThanOrEqual(7.5 * emuPerInch);
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

  it('renders the financing presentation template with editable theme bands', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '融资演讲稿',
        sections: [
          {
            heading: '市场概览',
            level: 1,
            blocks: [{ type: 'bullets', items: ['机会清晰', '成本可控'] }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-23T10:00:00.000Z',
      theme: 'financing'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const titleXml = zip.readAsText('ppt/slides/slide1.xml');
    const contentXml = zip.readAsText('ppt/slides/slide2.xml');
    const closingXml = zip.readAsText('ppt/slides/slide3.xml');
    expect(titleXml).toContain('202020');
    expect(titleXml).toContain('078AA3');
    expect(contentXml).toContain('市场概览');
    expect(contentXml).toContain('F3F4F4');
    expect(closingXml).toContain('谢谢观看');
  });

  it('renders the university classroom template with editable color cards', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '数据科学导论',
      sections: [{
        heading: '核心概念',
        level: 1,
        blocks: [{
          type: 'bullets',
          items: ['数据采集', '模型训练', '结果评估', '负责任使用']
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-24T12:00:00.000Z',
      theme: 'university'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const titleXml = zip.readAsText('ppt/slides/slide1.xml');
    const contentXml = zip.readAsText('ppt/slides/slide2.xml');
    expect(titleXml).toContain('UNDERSTANDING AI');
    expect(titleXml).toContain('109B91');
    expect(contentXml).toContain('核心概念');
    expect(contentXml).toContain('E0F6F2');
    expect(contentXml).toContain('4084CC');
    expect(contentXml).toContain('EB8E41');
    expect(contentXml).toContain('CD5454');
    expect(contentXml).toContain('大学课堂汇报');
  });

  it('keeps all university template content by splitting long sections across slides', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '课堂内容完整性',
      sections: [{
        heading: '知识梳理',
        level: 1,
        blocks: [
          { type: 'paragraph', text: '第一段说明' },
          { type: 'paragraph', text: '第二段说明' },
          {
            type: 'bullets',
            items: ['要点一', '要点二', '要点三', '要点四', '要点五', '要点六']
          },
          {
            type: 'table',
            header: ['序号', '内容'],
            rows: [
              ['1', '表格一'], ['2', '表格二'], ['3', '表格三'], ['4', '表格四'],
              ['5', '表格五'], ['6', '表格六'], ['7', '表格七']
            ]
          }
        ]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-24T12:00:00.000Z',
      theme: 'university'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slidesXml = zip.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry));
    const allSlideText = slidesXml.join('');
    expect(slidesXml).toHaveLength(6);
    [
      '第一段说明', '第二段说明', '要点一', '要点六', '表格一', '表格七'
    ].forEach((text) => expect(allSlideText).toContain(text));
  });

  it('renders semantic comparison sections with a two-column component', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '方式对比',
      sections: [{
        heading: '传统方式与现在方式的区别',
        level: 1,
        blocks: [{
          type: 'bullets',
          items: ['传统方式：人工处理', '现在方式：模型辅助']
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-25T12:00:00.000Z',
      theme: 'university'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slidesXml = zip.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry));
    const allSlideText = slidesXml.join('');
    expect(allSlideText).toContain('对比分析');
    expect(allSlideText).toContain('传统方式：人工处理');
    expect(allSlideText).toContain('现在方式：模型辅助');
    expect(allSlideText).toContain('4084CC');
    expect(allSlideText).toContain('EB8E41');
  });

  it('renders evaluation sections with a metrics component instead of cards', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '结果评估',
      sections: [{
        heading: '结果评估',
        level: 1,
        blocks: [{
          type: 'bullets',
          items: ['划分测试集验证', '关注准确率召回率', '对比基准模型']
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-25T12:00:00.000Z',
      theme: 'university'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const allSlideText = zip.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry))
      .join('');
    expect(allSlideText).toContain('结果评估');
    expect(allSlideText).toContain('结果评估');
    expect(allSlideText).toContain('D5DEE8');
  });

  it('rotates ordinary university layouts while preserving semantic components', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '组件轮换验收',
      sections: [
        { heading: '基础概念', level: 1, blocks: [{ type: 'bullets', items: ['概念一', '概念二'] }] },
        { heading: '应用场景', level: 1, blocks: [{ type: 'bullets', items: ['场景一', '场景二'] }] },
        { heading: '学习方法', level: 1, blocks: [{ type: 'bullets', items: ['方法一', '方法二'] }] },
        { heading: '结果评估', level: 1, blocks: [{ type: 'bullets', items: ['准确率', '召回率'] }] }
      ]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-25T12:00:00.000Z',
      theme: 'university'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slides = zip.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry));
    expect(slides.join('')).toContain('准确率');
    expect(slides.join('')).toContain('召回率');
    expect(slides.some((xml) => xml.includes('• 场景一'))).toBe(true);
    expect(slides.some((xml) => xml.includes('E0F6F2'))).toBe(true);
  });

  it('falls back from the reference master when a later chapter needs a semantic component', async () => {
    const outputDirectory = await createOutputDirectory();
    const sections = [
      '基础概念',
      '发展脉络',
      '工作原理',
      '核心技术',
      '结果评估',
      '应用场景',
      '生成式 AI',
      '风险意识',
      '负责任行动'
    ].map((heading, index) => ({
      heading,
      level: 1 as const,
      blocks: [{
        type: 'bullets' as const,
        items: index === 4
          ? ['划分测试集验证', '关注准确率召回率', '对比基准模型']
          : [`${heading}要点一`, `${heading}要点二`]
      }]
    }));
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '大学课堂组件验收',
      sections
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-25T12:00:00.000Z',
      theme: 'university'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const allSlideText = slideEntries.map((entry) => zip.readAsText(entry)).join('');
    expect(slideEntries.length).toBeGreaterThan(10);
    expect(allSlideText).toContain('结果评估');
    expect(allSlideText).toContain('划分测试集验证');
    expect(allSlideText).toContain('D5DEE8');
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('汇报: 2026? 报告*')).toBe('汇报 2026 报告');
    expect(sanitizeFileName('   ')).toBe('文档');
  });
});
