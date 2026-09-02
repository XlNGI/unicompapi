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
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateDocumentFile,
  applyLocalPptRevision,
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

function shapeXmlContaining(xml: string, text: string): string {
  const shape = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).find((item) =>
    item.includes(text)
  );
  if (!shape) throw new Error(`Missing PPT shape containing ${text}`);
  return shape;
}

function shapeOffsetContaining(xml: string, text: string): string {
  const shape = shapeXmlContaining(xml, text);
  const offset = shape.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
  if (!offset) throw new Error(`Missing PPT offset for ${text}`);
  return `${offset[1]}:${offset[2]}`;
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
  it('patches only the targeted PPT slide text on top of the parent package', async () => {
    const outputDirectory = await createOutputDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const sourcePath = path.join(outputDirectory, 'parent.pptx');
    const sourceZip = new JSZip();
    const generatedZip = new JSZip();
    const slide = (heading: string, value: string) =>
      `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>${heading}</a:t><a:t>${value}</a:t></p:sld>`;
    sourceZip.file('ppt/slides/slide1.xml', slide('核心价值', '原始内容'));
    sourceZip.file('ppt/slides/slide2.xml', slide('未修改章节', '未修改章节'));
    generatedZip.file('ppt/slides/slide1.xml', slide('核心价值', '管理者表达'));
    generatedZip.file('ppt/slides/slide2.xml', slide('未修改章节', '模型误改内容'));
    await writeFixture(sourcePath, await sourceZip.generateAsync({ type: 'nodebuffer' }));
    const patched = await applyLocalPptRevision(
      {
        kind: 'ppt',
        outline: parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '测试', sections: [] })),
        outputDirectory,
        now: '20260901160000',
        revisionSourcePath: sourcePath,
        revisionTargetSectionHeading: '核心价值'
      },
      await generatedZip.generateAsync({ type: 'nodebuffer' })
    );
    const resultZip = await JSZip.loadAsync(patched);
    expect(await resultZip.file('ppt/slides/slide1.xml')!.async('string')).toContain('管理者表达');
    expect(await resultZip.file('ppt/slides/slide2.xml')!.async('string')).toContain('未修改章节');
  });

  it('keeps the parent package when a revision removes target text runs', async () => {
    const outputDirectory = await createOutputDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const sourcePath = path.join(outputDirectory, 'parent-delete.pptx');
    const sourceZip = new JSZip();
    const generatedZip = new JSZip();
    sourceZip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>封面</a:t><a:t>不应变化</a:t></p:sld>'
    );
    sourceZip.file(
      'ppt/slides/slide2.xml',
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>第二章</a:t><a:t>旧标题</a:t><a:t>旧内容</a:t></p:sld>'
    );
    sourceZip.file(
      'ppt/slides/slide3.xml',
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>第二章（续 2）</a:t><a:t>旧续页内容</a:t></p:sld>'
    );
    generatedZip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>封面</a:t><a:t>模型误改</a:t></p:sld>'
    );
    generatedZip.file(
      'ppt/slides/slide2.xml',
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>第二章</a:t></p:sld>'
    );
    await writeFixture(
      sourcePath,
      await sourceZip.generateAsync({ type: 'nodebuffer' })
    );

    const patched = await applyLocalPptRevision(
      {
        kind: 'ppt',
        outline: parseDocumentOutline(
          JSON.stringify({ kind: 'ppt', title: '测试', sections: [] })
        ),
        outputDirectory,
        now: '20260901160000',
        revisionSourcePath: sourcePath,
        revisionTargetSectionHeading: '第二章'
      },
      await generatedZip.generateAsync({ type: 'nodebuffer' })
    );
    const resultZip = await JSZip.loadAsync(patched);
    const unchanged = await resultZip.file('ppt/slides/slide1.xml')!.async('string');
    const revised = await resultZip.file('ppt/slides/slide2.xml')!.async('string');
    const continuation = await resultZip.file('ppt/slides/slide3.xml')!.async('string');
    expect(unchanged).toContain('不应变化');
    expect(revised).toContain('第二章');
    expect(revised).not.toContain('旧标题');
    expect(revised).not.toContain('旧内容');
    expect(continuation).toContain('show="0"');
    expect(continuation).not.toContain('旧续页内容');
  });

  it('preserves non-target slides in a real generated PPT revision', async () => {
    const outputDirectory = await createOutputDirectory();
    const source = await generateDocumentFile({
      kind: 'ppt',
      outline: parseDocumentOutline(JSON.stringify({
        kind: 'ppt',
        title: '原始汇报',
        sections: [
          {
            heading: '第一章',
            level: 1,
            pageKind: 'insight',
            blocks: [{ type: 'bullets', items: ['第一章原始内容'] }]
          },
          {
            heading: '第二章',
            level: 1,
            pageKind: 'insight',
            blocks: [{ type: 'bullets', items: ['第二章原始内容'] }]
          }
        ]
      })),
      outputDirectory,
      now: '20260901160000'
    });
    const revised = await generateDocumentFile({
      kind: 'ppt',
      outline: parseDocumentOutline(JSON.stringify({
        kind: 'ppt',
        title: '新版汇报',
        sections: [
          {
            heading: '第一章',
            level: 1,
            pageKind: 'insight',
            blocks: [{ type: 'bullets', items: ['模型误改第一章'] }]
          },
          {
            heading: '第二章',
            level: 1,
            pageKind: 'insight',
            blocks: []
          }
        ]
      })),
      outputDirectory,
      now: '20260901160100',
      revisionSourcePath: source.absolutePath,
      revisionTargetSectionHeading: '第二章'
    });
    const resultZip = await JSZip.loadAsync(await readFile(revised.absolutePath));
    const slides = Object.keys(resultZip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
      .sort();
    const firstSlide = await resultZip.file(slides[1])!.async('string');
    const secondSlide = await resultZip.file(slides[2])!.async('string');
    expect(firstSlide).toContain('第一章原始内容');
    expect(firstSlide).not.toContain('模型误改第一章');
    expect(secondSlide).not.toContain('第二章原始内容');
  });

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

  it('turns payroll placeholders into an editable numeric template with formulas', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'excel',
      title: '部门员工工资表',
      sections: [{
        heading: '工资明细',
        level: 1,
        blocks: [{
          type: 'table',
          header: ['姓名', '部门', '基本工资', '绩效', '补贴', '扣款', '实发工资', '年龄', '性别'],
          rows: [
            ['示例姓名1', '示例部门1', '示例基本工资1', '示例绩效1', '示例补贴1', '示例扣款1', '示例实发工资1', '示例年龄1', '示例性别1'],
            ['合计', '待确认', '待确认', '待确认', '待确认', '待确认', '待确认', '待确认', '待确认']
          ]
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'excel',
      outline,
      outputDirectory,
      now: '2026-09-01T05:42:20.000Z'
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.absolutePath);
    const sheet = workbook.getWorksheet('工资明细');
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell('C2').value).toBeNull();
    expect(sheet!.getCell('G2').value).toMatchObject({
      formula: '=IF(COUNT(C2:F2)<4,"",C2+D2+E2-F2)'
    });
    expect(sheet!.getCell('G3').value).toMatchObject({
      formula: '=IF(COUNT(G2:G2)=0,"",SUM(G2:G2))'
    });
    expect(sheet!.getColumn(3).width).toBeGreaterThanOrEqual(12);
    expect(sheet!.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet!.autoFilter).toBeTruthy();
  });

  it('keeps payroll formulas when the model supplies numeric sample amounts', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'excel',
      title: '部门员工工资表（模板）',
      sections: [{
        heading: '工资明细',
        level: 1,
        blocks: [{
          type: 'table',
          header: ['姓名', '基本工资', '绩效', '补贴', '扣款', '实发工资'],
          rows: [['示例姓名1', 5000, 2000, 500, 300, 7200]]
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'excel',
      outline,
      outputDirectory,
      now: '2026-09-01T05:59:06.000Z'
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.absolutePath);
    const sheet = workbook.getWorksheet('工资明细');
    expect(sheet!.getCell('F2').value).toMatchObject({
      formula: '=IF(COUNT(B2:E2)<4,"",B2+C2+D2-E2)'
    });
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

  it('does not render model-supplied decorative cover or thank-you sections as content pages', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '管理层汇报',
      sections: [
        { heading: '封面', level: 1, pageKind: 'cover', blocks: [{ type: 'paragraph', text: '封面说明' }] },
        { heading: '核心判断', level: 1, pageKind: 'insight', blocks: [{ type: 'bullets', items: ['业务影响：提升效率'] }] },
        { heading: '谢谢', level: 1, pageKind: 'closing', blocks: [{ type: 'table', header: ['误放'], rows: [['不应分页']] }] }
      ]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-09-01T08:00:00.000Z'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slides = zip.getEntries().filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry.entryName));
    expect(slides).toHaveLength(3);
    const allText = slides.map((entry) => zip.readAsText(entry)).join('\n');
    expect(allText).toContain('核心判断');
    expect(allText).not.toContain('不应分页');
  });

  it('does not add sparse pptxgenjs continuation slides for application-paginated tables', async () => {
    const outputDirectory = await createOutputDirectory();
    const lineWrappedCell = Array.from({ length: 8 }, (_, index) => `绗${index + 1}琛?`).join('\\n');
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: '琛ㄦ牸缁х画椤甸洩鍥炲綊',
      sections: [
        {
          heading: '鍏抽敭鎸囨爣',
          level: 1,
          pageKind: 'data',
          blocks: [{
            type: 'table',
            header: ['鎸囨爣', '鏈湀', '澶囨敞'],
            rows: Array.from({ length: 7 }, (_, index) => [
              `鎸囨爣 ${index + 1}`,
              `${index + 1}00`,
              Array.from({ length: 18 }, () => 'x').join('\n')
            ])
          }]
        }
      ]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-09-01T08:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry.entryName));
    const slideTexts = slideEntries.map((entry) => zip.readAsText(entry));

    void lineWrappedCell;
    // One generated data page plus the system cover/closing is expected. A
    // second continuation page with only a "续" title indicates that the
    // underlying table renderer paginated a page already split by the app.
    expect(slideEntries).toHaveLength(3);
    expect(slideTexts.join('\\n')).not.toMatch(/续\\s*2/u);
    expect(slideTexts.some((text) => text.includes('鎸囨爣 7'))).toBe(true);
  });

  it('keeps a dense five-column table on the page units produced by the app', async () => {
    const outputDirectory = await createOutputDirectory();
    const cell = 'abcdefghijklmn';
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt',
      title: 'Table pagination regression',
      sections: [{
        heading: 'Key metrics',
        level: 1,
        pageKind: 'data',
        takeaway: 'Use the table to make one decision.',
        blocks: [{
          type: 'table',
          header: ['Metric', 'Jan', 'Feb', 'Mar', 'Owner'],
          rows: Array.from({ length: 7 }, (_, index) => [
            `${cell}${index}`,
            cell,
            cell,
            cell,
            cell
          ])
        }]
      }]
    }));
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-09-01T08:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry.entryName));
    const slideTexts = slideEntries.map((entry) => zip.readAsText(entry));

    expect(slideEntries).toHaveLength(3);
    expect(slideTexts.join('\n')).not.toMatch(/\(续\s*2\)/u);
    expect(slideTexts.join('\n')).toContain(`${cell}6`);

    // Guard the renderer contract directly: application-level table splitting
    // must never be delegated back to pptxgenjs.
    const generatorSource = await readFile(
      path.resolve('src/platform/documents/office-document-generator.ts'),
      'utf8'
    );
    expect(generatorSource).toMatch(
      /slide\.addTable\(rows,[\s\S]{0,1600}autoPage:\s*false/u
    );
  });

  it('keeps cover and section titles wrappable without automatic shrinking', async () => {
    const outputDirectory = await createOutputDirectory();
    const title = '项目季度工作汇报';
    const heading = '本周重点推进计划';
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title,
        sections: [
          {
            heading,
            level: 1,
            blocks: [{ type: 'paragraph', text: '本页内容用于验证固定标题排版。' }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const coverTitle = shapeXmlContaining(zip.readAsText('ppt/slides/slide1.xml'), title);
    const sectionTitle = shapeXmlContaining(zip.readAsText('ppt/slides/slide2.xml'), heading);

    for (const titleShape of [coverTitle, sectionTitle]) {
      expect(titleShape).toContain('wrap="square"');
      expect(titleShape).not.toContain('<a:normAutofit/>');
    }
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

  it('keeps every detailed content group by continuing onto additional slides', async () => {
    const outputDirectory = await createOutputDirectory();
    const detailedItems = Array.from({ length: 12 }, (_, index) =>
      `内容标记-${index + 1}：解释标记-${index + 1}，说明该项工作的依据、影响和下一步安排。`
    );
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '完整内容分页验证',
        sections: [
          {
            heading: '交付质量取决于完整的信息链路',
            level: 1,
            pageKind: 'insight',
            takeaway: '核心结论标记：内容必须完整保留并保持可读。',
            action: '行动标记：本周完成负责人和验收时间确认。',
            blocks: [{ type: 'bullets', items: detailedItems }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const slideXml = slideEntries.map((entry) => zip.readAsText(entry)).join('\n');

    expect(slideEntries.length).toBeGreaterThan(3);
    expect(slideXml).toContain('核心结论标记');
    expect(slideXml).toContain('行动标记');
    for (let index = 0; index < detailedItems.length; index += 1) {
      expect(slideXml).toContain(`内容标记-${index + 1}`);
      expect(slideXml).toContain(`解释标记-${index + 1}`);
    }
  });

  it('wraps long model titles, takeaways and actions without dropping content', async () => {
    const outputDirectory = await createOutputDirectory();
    const title = '人工智能智能体从对话到行动的企业级能力革命';
    const heading = '智能体正在从辅助问答工具升级为企业数字执行者';
    const takeaway =
      '企业需要的已经不只是回答问题的模型，而是能够理解目标、调用工具并交付结果的数字执行者。';
    const action =
      '选择一个高频、规则明确、结果可度量的业务场景启动试点，并在四周内评估效率、质量和风险。';
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title,
        sections: [
          {
            heading,
            level: 1,
            pageKind: 'insight',
            takeaway,
            action,
            blocks: [
              {
                type: 'bullets',
                items: [
                  '能力变化：从单轮问答升级为多步骤任务执行。',
                  '业务变化：从提供建议升级为直接推动流程完成。',
                  '组织变化：人负责目标和判断，智能体负责重复执行。'
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
      now: '2026-08-27T10:00:00.000Z',
      presentationTemplate: 'technology'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideXml = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry))
      .join('\n');

    for (const text of [title, heading, takeaway, action]) {
      expect(slideXml).toContain(text);
    }
    expect(shapeXmlContaining(zip.readAsText('ppt/slides/slide1.xml'), title))
      .toContain('wrap="square"');
    expect(shapeXmlContaining(slideXml, takeaway)).toContain('wrap="square"');
    expect(shapeXmlContaining(slideXml, action)).toContain('wrap="square"');
  });

  it('keeps an oversized action on one dense continuation page instead of sparse focused pages', async () => {
    const outputDirectory = await createOutputDirectory();
    const action =
      '建议先选择一个高频、边界清晰且结果可复核的办公流程，在保留人工确认、取消和失败回退的前提下完成两周小范围试点，再根据准确率、节省时间、人工修订量和异常处理成本决定是否扩展到相邻场景。';
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '长行动项密度验证',
        sections: [
          {
            heading: '先试点再扩展',
            level: 1,
            pageKind: 'insight',
            takeaway: '先验证完整闭环，再根据真实记录决定扩展。',
            action,
            blocks: [
              {
                type: 'bullets',
                items: [
                  '明确场景：选择高频、边界清晰且结果可复核的任务。',
                  '保留控制：人工确认、取消和失败回退均必须可用。'
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
      now: '2026-08-27T16:40:00.000Z',
      presentationTemplate: 'technology'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const actionSlide = zip.readAsText('ppt/slides/slide3.xml');

    expect(slideEntries).toHaveLength(4);
    expect(actionSlide).toContain('行动安排');
    expect(actionSlide).toContain('建议先选择一个高频');
    expect(actionSlide).toContain('人工修订量和异常处理成本');
  });

  it('splits one oversized paragraph across continuation slides at readable capacity', async () => {
    const outputDirectory = await createOutputDirectory();
    const longParagraph = [
      '长段开头标记。',
      ...Array.from(
        { length: 36 },
        (_, index) =>
          `第${index + 1}项说明用于解释业务背景、执行依据、影响范围和后续安排。`
      ),
      '长段结尾标记。'
    ].join('');
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '长段落自动续页验证',
        sections: [
          {
            heading: '完整内容必须通过续页保留',
            level: 1,
            blocks: [{ type: 'paragraph', text: longParagraph }]
          }
        ]
      })
    );

    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-27T10:05:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const slideXml = slideEntries.map((entry) => zip.readAsText(entry)).join('\n');

    expect(slideEntries.length).toBeGreaterThan(3);
    expect(slideXml).toContain('长段开头标记');
    expect(slideXml).toContain('第18项说明');
    expect(slideXml).toContain('长段结尾标记');
  });

  it('keeps conclusion, four concise groups, and action on one content slide', async () => {
    const outputDirectory = await createOutputDirectory();
    const contentGroups = [
      '目标聚焦：以客户续约和回款达成为本期优先事项。',
      '执行进展：重点客户方案已完成评审并进入协商阶段。',
      '风险控制：对延迟项目明确负责人和每周复盘机制。',
      '资源安排：销售、交付和财务按统一节奏协同推进。'
    ];
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '同页信息密度验证',
        sections: [
          {
            heading: '本周经营推进情况',
            level: 1,
            pageKind: 'insight',
            takeaway: '核心结论：经营目标保持可控，重点项目需要持续跟进。',
            action: '行动安排：周五前完成重点客户复盘和资源确认。',
            blocks: [{ type: 'bullets', items: contentGroups }]
          }
        ]
      })
    );

    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const contentSlide = zip.readAsText('ppt/slides/slide2.xml');

    expect(slideEntries).toHaveLength(3);
    expect(contentSlide).toContain('核心结论');
    expect(contentSlide).toContain('行动安排');
    for (const contentGroup of contentGroups) {
      expect(contentSlide).toContain(contentGroup.split('：')[0]);
    }
  });

  it('renders consecutive insight pages with visibly different geometric structures', async () => {
    const outputDirectory = await createOutputDirectory();
    const sections = Array.from({ length: 4 }, (_, sectionIndex) => ({
      heading: `第 ${sectionIndex + 1} 部分`,
      level: 1,
      pageKind: 'insight',
      takeaway: `第 ${sectionIndex + 1} 页结论：信息结构应随叙事节奏变化。`,
      blocks: [
        {
          type: 'bullets',
          items: Array.from(
            { length: 4 },
            (_, itemIndex) =>
              `页面${sectionIndex + 1}组${itemIndex + 1}：说明该页第 ${itemIndex + 1} 个依据和影响。`
          )
        }
      ]
    }));
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '多页结构差异验证',
        sections
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-27T18:30:00.000Z',
      presentationTemplate: 'technology'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const offsets = sections.map((_, index) =>
      shapeOffsetContaining(
        zip.readAsText(`ppt/slides/slide${index + 2}.xml`),
        `页面${index + 1}组1`
      )
    );

    expect(new Set(offsets).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps closing decisions and action on one content slide', async () => {
    const outputDirectory = await createOutputDirectory();
    const decisions = [
      '场景选择：确认首批试运行的办公任务和明确非目标。',
      '责任安排：确认业务负责人、技术负责人和问题升级路径。',
      '验收口径：确认必须通过的质量、安全和效率检查。'
    ];
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '决策收口同页验证',
        sections: [
          {
            heading: '需要管理层确认三项试运行决策',
            level: 1,
            pageKind: 'closing',
            takeaway: '明确场景、负责人和验收口径后，团队即可进入受控试运行。',
            action: '行动安排：决策确认后启动两周试运行并提交真实复盘。',
            blocks: [{ type: 'bullets', items: decisions }]
          }
        ]
      })
    );

    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const contentSlide = zip.readAsText('ppt/slides/slide2.xml');

    expect(slideEntries).toHaveLength(3);
    expect(contentSlide).toContain('明确场景');
    expect(contentSlide).toContain('行动安排');
    for (const decision of decisions) {
      expect(contentSlide).toContain(decision.split('：')[0]);
    }
  });

  it('renders all five presentation templates as fixed widescreen editable decks', async () => {
    const expectedTemplateMarkers = [
      ['work_report', '1F5FBF'],
      ['natural_minimal', '4E8B61'],
      ['business_minimal', '2D3A3E'],
      ['technology', '35D6C8'],
      ['financing', '00A9C0']
    ] as const;

    for (const [presentationTemplate, marker] of expectedTemplateMarkers) {
      const outputDirectory = await createOutputDirectory();
      const outline = parseDocumentOutline(
        JSON.stringify({
          kind: 'ppt',
          title: '五模板生成验证',
          sections: [
            {
              heading: '重点结论',
              level: 1,
              pageKind: 'insight',
              takeaway: '当前方案兼顾内容密度与阅读效率。',
              action: '下一步完成试运行并收集使用反馈。',
              blocks: [
                {
                  type: 'bullets',
                  items: [
                    '信息结构：每页先给结论，再提供解释。',
                    '执行安排：明确负责人、时间和验收条件。'
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
        now: '2026-08-26T10:00:00.000Z',
        presentationTemplate
      });
      const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
      const presentationXml = zip.readAsText('ppt/presentation.xml');
      const slideXml = zip
        .getEntries()
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
        .map((entry) => zip.readAsText(entry))
        .join('\n');

      expect(presentationXml).toContain('<p:sldSz cx="12192000" cy="6858000"');
      expect(slideXml).toContain(marker);
      expect(slideXml).toContain('五模板生成验证');
      expect(slideXml).toContain('重点结论');
      expect(slideXml).toContain('信息结构');
      expect(slideXml).toContain('执行安排');
    }
  });

  it('does not expose internal presentation template names in generated slides', async () => {
    const templateNames = ['工作汇报', '自然简约', '极简商务', '科技风', '融资演讲稿'];
    for (const presentationTemplate of [
      'work_report',
      'natural_minimal',
      'business_minimal',
      'technology',
      'financing'
    ] as const) {
      const outputDirectory = await createOutputDirectory();
      const outline = parseDocumentOutline(
        JSON.stringify({
          kind: 'ppt',
          title: '客户经营复盘',
          sections: [
            {
              heading: '关键进展',
              level: 1,
              blocks: [{ type: 'bullets', items: ['目标达成', '风险可控'] }]
            }
          ]
        })
      );
      const result = await generateDocumentFile({
        kind: 'ppt',
        outline,
        outputDirectory,
        now: '2026-08-28T10:00:00.000Z',
        presentationTemplate
      });
      const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
      const slideXml = zip
        .getEntries()
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
        .map((entry) => zip.readAsText(entry))
        .join('\n');

      for (const templateName of templateNames) {
        expect(slideXml).not.toContain(templateName);
      }
    }
  });

  it('rebalances a lone text group and avoids mechanical continuation titles', async () => {
    const outputDirectory = await createOutputDirectory();
    const items = Array.from(
      { length: 5 },
      (_, index) => `内容组${index + 1}：说明业务进展、影响和后续安排。`
    );
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '普通文本分页验证',
        sections: [
          {
            heading: '信息应在页面之间保持均衡',
            level: 1,
            pageKind: 'insight',
            blocks: [{ type: 'bullets', items }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-28T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const firstContentSlide = zip.readAsText('ppt/slides/slide2.xml');
    const secondContentSlide = zip.readAsText('ppt/slides/slide3.xml');

    expect(firstContentSlide).not.toContain('内容组4');
    expect(secondContentSlide).toContain('内容组4');
    expect(secondContentSlide).toContain('内容组5');
    expect(`${firstContentSlide}\n${secondContentSlide}`).not.toContain('（续 2）');
  });

  it('uses distinct native frame geometries for the three light presentation templates', async () => {
    const frameMarkers = [
      ['work_report', 'prst="roundRect"'],
      ['natural_minimal', 'prst="ellipse"'],
      ['business_minimal', 'prst="rtTriangle"']
    ] as const;

    for (const [presentationTemplate, frameMarker] of frameMarkers) {
      const outputDirectory = await createOutputDirectory();
      const outline = parseDocumentOutline(
        JSON.stringify({
          kind: 'ppt',
          title: '模板框架差异验证',
          sections: [
            {
              heading: '同一内容应呈现不同框架',
              level: 1,
              blocks: [{ type: 'bullets', items: ['确保模板不只替换颜色'] }]
            }
          ]
        })
      );
      const result = await generateDocumentFile({
        kind: 'ppt',
        outline,
        outputDirectory,
        now: '2026-08-26T10:00:00.000Z',
        presentationTemplate
      });
      const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
      const slideXml = zip
        .getEntries()
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
        .map((entry) => zip.readAsText(entry))
        .join('\n');

      expect(slideXml).toContain(frameMarker);
    }
  });

  it('continues wide tables onto readable column groups without omitting cells', async () => {
    const outputDirectory = await createOutputDirectory();
    const header = Array.from({ length: 8 }, (_, index) => `列标记-${index + 1}`);
    const rows = Array.from({ length: 2 }, (_, rowIndex) =>
      Array.from({ length: 8 }, (_, columnIndex) =>
        `单元格-${rowIndex + 1}-${columnIndex + 1}`
      )
    );
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '宽表分栏验证',
        sections: [
          {
            heading: '关键经营指标对照表',
            level: 1,
            pageKind: 'data',
            blocks: [{ type: 'table', header, rows }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const slideXml = slideEntries.map((entry) => zip.readAsText(entry)).join('\n');

    expect(slideEntries).toHaveLength(4);
    for (const value of [...header, ...rows.flat()]) {
      expect(slideXml).toContain(value);
    }
    for (const value of [
      ...header.slice(1),
      ...rows.flatMap((row) => row.slice(1))
    ]) {
      expect(slideXml.split(value)).toHaveLength(2);
    }
  });

  it('rejects tables whose row and column continuations exceed the PPT page budget', async () => {
    const outputDirectory = await createOutputDirectory();
    const header = Array.from({ length: 20 }, (_, index) => `列${index + 1}`);
    const rows = Array.from({ length: 80 }, () =>
      Array.from({ length: 20 }, () => '值')
    );
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '表格页数预算',
        sections: [
          {
            heading: '宽表与长表组合续页',
            level: 1,
            pageKind: 'data',
            blocks: [{ type: 'table', header, rows }]
          }
        ]
      })
    );

    await expect(
      generateDocumentFile({
        kind: 'ppt',
        outline,
        outputDirectory,
        now: '2026-08-26T10:00:00.000Z',
        presentationTemplate: 'work_report'
      })
    ).rejects.toMatchObject({ code: 'document_layout_overflow' });
  });

  it('renders section and closing page kinds with their own presentation semantics', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '语义页面验证',
        sections: [
          {
            heading: '第一阶段成果',
            level: 1,
            pageKind: 'section',
            takeaway: '先确认当前成果，再进入下一阶段。',
            blocks: [{ type: 'bullets', items: ['范围和负责人已经明确'] }]
          },
          {
            heading: '最终决策事项',
            level: 1,
            pageKind: 'closing',
            takeaway: '管理层确认后启动试运行。',
            action: '周五前完成决策确认。',
            blocks: [{ type: 'bullets', items: ['确认试运行范围'] }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideXml = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .map((entry) => zip.readAsText(entry))
      .join('\n');

    expect(slideXml).toContain('本节重点');
    expect(slideXml).toContain('决策确认');
  });

  it('uses full-width rows for three closing decisions instead of leaving a 2+1 grid gap', async () => {
    const outputDirectory = await createOutputDirectory();
    const decisions = [
      '场景选择：确认首批试运行任务和明确非目标。',
      '责任安排：确认业务负责人、技术负责人和问题升级路径。',
      '验收口径：确认质量、安全和效率检查。'
    ];
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '三项决策排版验证',
        sections: [
          {
            heading: '管理层需确认三项试运行决策',
            level: 1,
            pageKind: 'closing',
            takeaway: '明确场景、负责人和验收口径后启动试运行。',
            action: '决策确认后启动两周试运行。',
            blocks: [{ type: 'bullets', items: decisions }]
          }
        ]
      })
    );
    const result = await generateDocumentFile({
      kind: 'ppt',
      outline,
      outputDirectory,
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const contentSlide = zip.readAsText('ppt/slides/slide2.xml');
    const explanationFrames = decisions.map((decision) => {
      const explanation = decision.split('：')[1];
      const shape = contentSlide
        .match(/<p:sp>.*?<\/p:sp>/g)
        ?.find((candidate) => candidate.includes(explanation));
      expect(shape).toBeDefined();
      const frame = shape?.match(
        /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/
      );
      expect(frame).not.toBeNull();
      return {
        x: Number(frame?.[1]),
        width: Number(frame?.[3])
      };
    });

    expect(new Set(explanationFrames.map((frame) => frame.x)).size).toBe(1);
    for (const frame of explanationFrames) {
      expect(frame.width).toBeGreaterThan(9_000_000);
    }
  });

  it('splits a single oversized content group without shrinking or dropping it', async () => {
    const outputDirectory = await createOutputDirectory();
    const outline = parseDocumentOutline(
      JSON.stringify({
        kind: 'ppt',
        title: '超长内容验证',
        sections: [
          {
            heading: '单个内容组不可被静默缩小',
            level: 1,
            pageKind: 'insight',
            blocks: [
              {
                type: 'bullets',
                items: [`超长标记：${'需要保留可读字号。'.repeat(120)}`]
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
      now: '2026-08-26T10:00:00.000Z',
      presentationTemplate: 'work_report'
    });
    const zip = new AdmZip(Buffer.from(await readFile(result.absolutePath)));
    const slideEntries = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
    const slideXml = slideEntries.map((entry) => zip.readAsText(entry)).join('\n');

    expect(slideEntries.length).toBeGreaterThan(3);
    expect(slideXml.match(/需要保留可读字号/g)).toHaveLength(120);
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

  it('falls back to the work-report presentation template for legacy PPT requests', async () => {
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
    expect(slideXml).toContain('1F5FBF');
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
    expect(titleXml).toContain('171C26');
    expect(titleXml).toContain('00A9C0');
    expect(contentXml).toContain('市场概览');
    expect(contentXml).toContain('00A9C0');
    expect(closingXml).toContain('谢谢观看');
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('汇报: 2026? 报告*')).toBe('汇报 2026 报告');
    expect(sanitizeFileName('   ')).toBe('文档');
  });
});
