import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import {
  documentWorkspaceKindExtensions,
  type DocumentWorkspaceKind
} from '../../domain';
import {
  resolveDocumentTheme,
  type DocumentTheme,
  type DocumentThemeId
} from './document-theme';
import type { ExtractedThemeColors } from './pptx-theme-extractor';
import type {
  DocumentOutline,
  DocumentOutlineBlock,
  DocumentOutlineSection
} from './document-outline-parser';

export interface GeneratedDocumentFile {
  readonly fileName: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

export interface GenerateDocumentFileInput {
  readonly kind: DocumentWorkspaceKind;
  readonly outline: DocumentOutline;
  readonly outputDirectory: string;
  readonly now: string;
  readonly theme?: DocumentThemeId;
  readonly customTheme?: ExtractedThemeColors;
  readonly images?: readonly {
    readonly absolutePath: string;
    readonly caption?: string;
  }[];
}

export async function generateDocumentFile(
  input: GenerateDocumentFileInput
): Promise<GeneratedDocumentFile> {
  await mkdir(input.outputDirectory, { recursive: true });
  const extension = documentWorkspaceKindExtensions[input.kind];
  const fileName = `${sanitizeFileName(input.outline.title)}-${timestampSuffix(
    input.now
  )}${extension}`;
  const absolutePath = path.join(input.outputDirectory, fileName);
  const buffer =
    input.kind === 'word'
      ? await buildWordBuffer(
          input.outline,
          resolveGenerationTheme(input.theme, input.customTheme)
        )
      : input.kind === 'excel'
        ? await buildExcelBuffer(input.outline)
        : await buildPptBuffer(
            input.outline,
            resolveGenerationTheme(input.theme, input.customTheme),
            input.images ?? []
          );
  await writeFile(absolutePath, buffer);
  const fileStat = await stat(absolutePath);
  return { fileName, absolutePath, sizeBytes: fileStat.size };
}

function resolveGenerationTheme(
  themeId: DocumentThemeId | undefined,
  customTheme: ExtractedThemeColors | undefined
): DocumentTheme {
  if (customTheme) {
    return {
      id: 'custom',
      name: '自定义模板',
      ...customTheme
    };
  }
  return resolveDocumentTheme(themeId);
}

export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : '文档';
}

function timestampSuffix(now: string): string {
  const digits = now.replace(/\D/g, '').slice(0, 14);
  return digits.length === 14 ? digits : new Date().toISOString().replace(/\D/g, '').slice(0, 14);
}

async function buildWordBuffer(
  outline: DocumentOutline,
  theme: DocumentTheme
): Promise<Buffer> {
  const numberedBlockCount = outline.sections.reduce(
    (count, section) => count + section.blocks.filter((block) => block.type === 'numbered').length,
    0
  );
  const doc = new Document({
    styles: {
      default: {
        document: {
          paragraph: { spacing: { after: 160, line: 360 } },
          run: {
            font: {
              ascii: 'Aptos',
              hAnsi: 'Aptos',
              eastAsia: 'Microsoft YaHei'
            },
            size: 22,
            color: theme.text
          }
        },
        heading1: {
          paragraph: { keepNext: true, spacing: { before: 320, after: 160 } },
          run: { bold: true, color: theme.accent, size: 30 }
        },
        heading2: {
          paragraph: { keepNext: true, spacing: { before: 280, after: 140 } },
          run: { bold: true, color: theme.accent, size: 27 }
        },
        heading3: {
          paragraph: { keepNext: true, spacing: { before: 240, after: 120 } },
          run: { bold: true, color: theme.accent, size: 24 }
        }
      }
    },
    numbering: {
      config: Array.from({ length: Math.max(1, numberedBlockCount) }, (_, index) => ({
        reference: `document-numbering-${index}`,
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START
        }]
      }))
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1080,
              right: 1260,
              bottom: 1080,
              left: 1260
            }
          }
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 360 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: theme.muted
              }
            },
            children: [
              new TextRun({
                text: outline.title,
                color: theme.accent,
                bold: true,
                size: 36
              })
            ]
          }),
          ...(() => {
            let numberedIndex = 0;
            return outline.sections.flatMap((section) => [
              new Paragraph({
                heading: headingLevel(section.level),
                children: [
                  new TextRun({ text: section.heading, color: theme.accent })
                ]
              }),
              ...section.blocks.flatMap((block) => {
                const reference = `document-numbering-${numberedIndex}`;
                if (block.type === 'numbered') numberedIndex += 1;
                return wordBlock(block, theme, reference);
              })
            ]);
          })()
        ]
      }
    ]
  });
  return Packer.toBuffer(doc);
}

function headingLevel(level: 1 | 2 | 3) {
  return level === 1
    ? HeadingLevel.HEADING_1
    : level === 2
      ? HeadingLevel.HEADING_2
      : HeadingLevel.HEADING_3;
}

function wordBlock(
  block: DocumentOutlineBlock,
  theme: DocumentTheme,
  numberingReference: string
): readonly (Paragraph | Table)[] {
  switch (block.type) {
    case 'paragraph':
      return [new Paragraph({ children: [new TextRun(block.text)] })];
    case 'quote':
      return [new Paragraph({
        children: [new TextRun({ text: block.text, italics: true })],
        indent: { left: 720 },
        border: {
          left: {
            style: BorderStyle.SINGLE,
            size: 12,
            color: '999999'
          }
        }
      })];
    case 'chart':
      return [new Paragraph({
        children: [
          new TextRun({
            text: `图表（${block.chartKind === 'bar' ? '柱状' : '饼图'}）${
              block.title ? `：${block.title}` : ''
            }：${block.data
              .map((item) => `${item.label} ${item.value}`)
              .join('；')}`,
            italics: true
          })
        ]
      })];
    case 'bullets':
      return block.items.map(
        (item) =>
          new Paragraph({
            children: [new TextRun(item)],
            bullet: { level: 0 },
            spacing: { after: 80 }
          })
      );
    case 'numbered':
      return block.items.map(
        (item) =>
          new Paragraph({
            children: [new TextRun(item)],
            numbering: { reference: numberingReference, level: 0 },
            spacing: { after: 80 }
          })
      );
    case 'table': {
      const columnCount = Math.max(
        block.header.length,
        ...block.rows.map((row) => row.length)
      );
      const bodyCells = (row: readonly string[]) =>
        Array.from({ length: columnCount }, (_, index) =>
          new TableCell({
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun(row[index] ?? '')] })]
          })
        );
      const headerCells = Array.from({ length: columnCount }, (_, index) =>
        new TableCell({
          shading: { fill: theme.accent },
          margins: { top: 100, bottom: 100, left: 120, right: 120 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: block.header[index] ?? '',
                  color: 'FFFFFF',
                  bold: true
                })
              ]
            })
          ]
        })
      );
      const border = {
        style: BorderStyle.SINGLE,
        size: 4,
        color: theme.muted
      } as const;
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: border,
          bottom: border,
          left: border,
          right: border,
          insideHorizontal: border,
          insideVertical: border
        },
        rows: [
          new TableRow({ children: headerCells, tableHeader: true }),
          ...block.rows.map((row) => new TableRow({ children: bodyCells(row) }))
        ]
      })];
    }
  }
}

async function buildExcelBuffer(outline: DocumentOutline): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const workbookTitle = sanitizeSheetName(outline.title);
  const tableBlocks = outline.sections.filter((section) =>
    section.blocks.some((block) => block.type === 'table')
  );
  if (tableBlocks.length === 0) {
    const sheet = workbook.addWorksheet(sanitizeSheetName(workbookTitle) || '内容');
    for (const section of outline.sections) {
      sheet.addRow([section.heading]);
      for (const block of section.blocks) {
        if (block.type === 'bullets' || block.type === 'numbered') {
          block.items.forEach((item) => sheet.addRow([item]));
        } else if (block.type === 'paragraph' || block.type === 'quote') {
          sheet.addRow([block.text]);
        }
      }
    }
  } else {
    const usedNames = new Set<string>();
    tableBlocks.forEach((section) => {
      section.blocks.forEach((block) => {
        if (block.type !== 'table') return;
        let name = sanitizeSheetName(section.heading);
        if (!name || usedNames.has(name)) {
          name = `表${usedNames.size + 1}`;
        }
        usedNames.add(name);
        const sheet = workbook.addWorksheet(name.slice(0, 31));
        sheet.addRow([...block.header]);
        block.rows.forEach((row) => sheet.addRow([...row]));
      });
    });
  }
  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

function sanitizeSheetName(value: string): string {
  const cleaned = value
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned;
}

async function buildPptBuffer(
  outline: DocumentOutline,
  theme: DocumentTheme,
  images: readonly {
    readonly absolutePath: string;
    readonly caption?: string;
  }[]
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = outline.title;
  const financing = theme.presentationStyle === 'financing';
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: financing ? '202020' : theme.background };
  titleSlide.addShape('rect', {
    x: 0,
    y: 0,
    w: 13.33,
    h: 0.18,
    fill: { color: theme.accent }
  });
  titleSlide.addShape('rect', {
    x: 0,
    y: 7.2,
    w: 2.2,
    h: 0.18,
    fill: { color: theme.accent }
  });
  if (financing) {
    titleSlide.addShape('rect', {
      x: 0,
      y: 4.58,
      w: 10.05,
      h: 0.18,
      fill: { color: theme.accent }
    });
  }
  titleSlide.addText(outline.title, {
    x: financing ? 1.02 : 0.6,
    y: financing ? 4.95 : 2.0,
    w: financing ? 8.6 : 12.3,
    h: 1.2,
    fontSize: 32,
    bold: true,
    color: financing ? 'FFFFFF' : theme.accent,
    align: financing ? 'left' : 'center'
  });
  if (outline.sections.length > 0) {
    titleSlide.addText(outline.sections[0].heading, {
      x: financing ? 1.02 : 0.6,
      y: financing ? 6.0 : 3.3,
      w: financing ? 8.6 : 12.3,
      h: 0.8,
      fontSize: 18,
      align: financing ? 'left' : 'center',
      color: financing ? 'FFFFFF' : theme.muted
    });
  }
  outline.sections.forEach((section, sectionIndex) => {
    const slide = pptx.addSlide();
    slide.background = { color: theme.background };
    if (financing) {
      slide.addShape('rect', {
        x: 0,
        y: 0,
        w: 13.33,
        h: 1.2,
        fill: { color: '202020' }
      });
      slide.addShape('rect', {
        x: 0,
        y: 1.08,
        w: 10.95,
        h: 0.16,
        fill: { color: theme.accent }
      });
    }
    const image = images[sectionIndex];
    const cardColor = tintColor(theme.accent, 0.93);
    const cardBorder = tintColor(theme.accent, 0.78);
    slide.addShape('rect', {
      x: 0.5,
      y: 0.42,
      w: 0.09,
      h: 0.5,
      fill: { color: theme.accent }
    });
    if (image) {
      slide.addImage({
        path: image.absolutePath,
        x: 9.05,
        y: 1.45,
        w: 3.6,
        h: 4.2,
        sizing: { type: 'contain', w: 3.6, h: 4.2 }
      });
      if (image.caption) {
        slide.addText(image.caption, {
          x: 9.1,
          y: 5.7,
          w: 3.6,
          h: 0.4,
          fontSize: 11,
          color: theme.muted,
          align: 'center'
        });
      }
    }
    const textWidth = image ? 8.1 : 12.3;
    slide.addText(section.heading, {
      x: 0.72,
      y: 0.35,
      w: image ? 8.2 : 12.5,
      h: 0.8,
      fontSize: 26,
      bold: true,
      color: financing ? 'FFFFFF' : theme.accent
    });
    let y = 1.35;
    const textLines: string[] = [];
    const cardHeight = image ? 4.3 : contentHeightEstimate(section);
    if (!image) {
      slide.addShape('rect', {
        x: 0.5,
        y: 1.3,
        w: 12.5,
        h: cardHeight,
        fill: { color: financing ? 'F3F4F4' : cardColor },
        line: { color: cardBorder, width: 0.75 },
        rectRadius: 0.08
      });
    }
    for (const block of section.blocks) {
      if (block.type === 'table') {
        if (textLines.length > 0) {
          slide.addText(pptTextLines(textLines, theme.accent), {
            x: 0.6,
            y,
            w: textWidth,
            h: Math.max(0.6, textLines.length * 0.45),
            fontSize: 16,
            color: theme.text
          });
          y += textLines.length * 0.45 + 0.3;
          textLines.length = 0;
        }
        const rows = [block.header, ...block.rows].map((row) =>
          row.map((cell) => ({ text: cell }))
        );
        slide.addTable(rows, {
          x: 0.6,
          y,
          w: textWidth,
          fontSize: 13,
          color: theme.text,
          border: { pt: 0.5, color: 'CCCCCC' }
        });
        y += rows.length * 0.4 + 0.4;
        continue;
      }
      if (block.type === 'chart') {
        if (textLines.length > 0) {
        slide.addText(pptTextLines(textLines, theme.accent), {
          x: 0.6,
          y,
            w: textWidth,
            h: Math.max(0.6, textLines.length * 0.45),
            fontSize: 16,
            color: theme.text
          });
          y += textLines.length * 0.45 + 0.3;
          textLines.length = 0;
        }
        slide.addChart(
          pptx.ChartType[block.chartKind === 'bar' ? 'bar' : 'pie'],
          [
            {
              name: block.title ?? '数据',
              labels: block.data.map((item) => item.label),
              values: block.data.map((item) => item.value)
            }
          ],
          {
            x: 0.6,
            y,
            w: 12.1,
            h: 4.8,
            showTitle: Boolean(block.title),
            title: block.title ?? '',
            showLegend: true,
            showValue: true,
            chartColors: chartPalette(theme.accent)
          }
        );
        y += 5.1;
        continue;
      }
      if (block.type === 'paragraph') {
        textLines.push(block.text);
      } else if (block.type === 'bullets' || block.type === 'numbered') {
        textLines.push(...block.items);
      } else {
        textLines.push(block.text);
      }
    }
    if (textLines.length > 0) {
      const maxLines = Math.max(1, Math.floor((cardHeight - 0.35) / 0.45));
      const cappedLines =
        textLines.length > maxLines ? textLines.slice(0, maxLines) : textLines;
      slide.addText(pptTextLines(cappedLines, theme.accent), {
        x: 0.6,
        y,
        w: textWidth,
        h: Math.max(0.6, cappedLines.length * 0.45),
        fontSize: 16,
        color: theme.text
      });
    }
    slide.addText(String(sectionIndex + 2), {
      x: 12.3,
      y: 7.05,
      w: 0.6,
      h: 0.3,
      fontSize: 10,
      color: theme.muted,
      align: 'right'
    });
  });
  if (outline.sections.length > 0) {
    const closing = pptx.addSlide();
    closing.background = { color: financing ? '202020' : theme.background };
    closing.addShape('rect', {
      x: 0,
      y: 0,
      w: 13.33,
      h: 0.18,
      fill: { color: theme.accent }
    });
    closing.addShape('rect', {
      x: 0,
      y: 7.2,
      w: 2.2,
      h: 0.18,
      fill: { color: theme.accent }
    });
    closing.addText('谢谢观看', {
      x: 0.6,
      y: 2.8,
      w: 12.13,
      h: 1.0,
      fontSize: 34,
      bold: true,
      color: financing ? 'FFFFFF' : theme.accent,
      align: 'center'
    });
    closing.addText(outline.title, {
      x: 0.6,
      y: 3.9,
      w: 12.13,
      h: 0.6,
      fontSize: 18,
      color: theme.muted,
      align: 'center'
    });
  }
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

function chartPalette(accent: string): string[] {
  return [
    accent,
    tintColor(accent, 0.62),
    tintColor(accent, 0.35),
    tintColor(accent, 0.18)
  ];
}

function tintColor(hex: string, ratio: number): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const mix = (channel: number): string =>
    Math.round(channel + (255 - channel) * ratio)
      .toString(16)
      .padStart(2, '0');
  return `${mix(r)}${mix(g)}${mix(b)}`.toUpperCase();
}

function contentHeightEstimate(section: DocumentOutlineSection): number {
  const lines = section.blocks.reduce((count, block) => {
    if (block.type === 'bullets' || block.type === 'numbered') {
      return count + block.items.length;
    }
    if (block.type === 'table') {
      return count + block.rows.length + 2;
    }
    if (block.type === 'chart') {
      return count + 10;
    }
    return count + 1;
  }, 0);
  return Math.min(5.8, Math.max(1.1, lines * 0.42 + 0.4));
}

function pptTextLines(
  lines: readonly string[],
  accent: string
): { readonly text: string; readonly options: Record<string, unknown> }[] {
  return lines.map((line) => ({
    text: line,
    options: {
      bullet: { code: '2022', color: accent },
      paraSpaceAfter: 6
    }
  }));
}
