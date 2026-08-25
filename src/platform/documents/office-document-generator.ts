import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
import JSZip from 'jszip';
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
import {
  planDocumentComponents,
  selectSectionComponent,
  type DocumentComponentSelection
} from './document-components';

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
  const componentPlan = planDocumentComponents(outline.sections, { images });
  if (theme.presentationStyle === 'university') {
    const templateBuffer = await buildUniversityTemplateBuffer(outline, images, componentPlan);
    if (templateBuffer) return templateBuffer;
  }
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = outline.title;
  const financing = theme.presentationStyle === 'financing';
  const university = theme.presentationStyle === 'university';
  const titleSlide = pptx.addSlide();
  titleSlide.background = {
    color: financing ? '202020' : university ? theme.background : theme.background
  };
  titleSlide.addShape('rect', {
    x: university ? 0 : 0,
    y: 0,
    w: university ? 0.18 : 13.33,
    h: university ? 7.5 : 0.18,
    fill: { color: theme.accent }
  });
  titleSlide.addShape('rect', {
    x: 0,
    y: university ? 7.16 : 7.2,
    w: university ? 4.0 : 2.2,
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
  if (university) {
    titleSlide.addText('UNDERSTANDING AI', {
      x: 0.78,
      y: 0.82,
      w: 3.8,
      h: 0.3,
      fontSize: 13,
      bold: true,
      charSpacing: 1.5,
      color: theme.accent
    });
    const coverTokens = [
      { label: '数据', color: theme.accent, x: 8.8, y: 1.42 },
      { label: '算法', color: '4084CC', x: 10.05, y: 2.12 },
      { label: '算力', color: 'EB8E41', x: 11.3, y: 2.82 }
    ];
    coverTokens.forEach((token) => {
      titleSlide.addShape('ellipse', {
        x: token.x,
        y: token.y,
        w: 0.76,
        h: 0.76,
        fill: { color: token.color },
        line: { color: token.color }
      });
      titleSlide.addText(token.label, {
        x: token.x,
        y: token.y + 0.23,
        w: 0.76,
        h: 0.2,
        fontSize: 11,
        bold: true,
        color: 'FFFFFF',
        align: 'center'
      });
    });
  }
  titleSlide.addText(outline.title, {
    x: financing ? 1.02 : university ? 0.78 : 0.6,
    y: financing ? 4.95 : university ? 1.55 : 2.0,
    w: financing ? 8.6 : university ? 7.4 : 12.3,
    h: university ? 0.9 : 1.2,
    fontSize: university ? 30 : 32,
    bold: true,
    color: financing ? 'FFFFFF' : theme.text,
    align: financing || university ? 'left' : 'center'
  });
  if (outline.sections.length > 0) {
    titleSlide.addText(outline.sections[0].heading, {
      x: financing ? 1.02 : university ? 0.82 : 0.6,
      y: financing ? 6.0 : university ? 2.72 : 3.3,
      w: financing ? 8.6 : university ? 7.4 : 12.3,
      h: 0.8,
      fontSize: university ? 16 : 18,
      align: financing || university ? 'left' : 'center',
      color: financing ? 'FFFFFF' : theme.muted
    });
  }
  if (university) {
    titleSlide.addText('大学课堂汇报 · 可编辑演示模板', {
      x: 0.82,
      y: 6.68,
      w: 4.2,
      h: 0.25,
      fontSize: 10,
      color: theme.muted
    });
  }
  outline.sections.forEach((section, sectionIndex) => {
    if (university) {
      addUniversitySectionSlides(
        pptx,
        section,
        sectionIndex,
        theme,
        images[sectionIndex],
        componentPlan[sectionIndex]
      );
      return;
    }
    const chartBlocks = section.blocks.filter(
      (block): block is Extract<DocumentOutlineBlock, { readonly type: 'chart' }> =>
        block.type === 'chart'
    );
    const nonChartBlocks = section.blocks.filter((block) => block.type !== 'chart');
    if (chartBlocks.length > 0 && nonChartBlocks.length === 0) {
      chartBlocks.forEach((block) => {
        addPptChartSlide(pptx, block, section.heading, theme, financing, images[sectionIndex]);
      });
      return;
    }
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
        addPptChartSlide(pptx, block, section.heading, theme, financing);
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

const UNIVERSITY_TEMPLATE_FILE = 'university-classroom.pptx';

async function buildUniversityTemplateBuffer(
  outline: DocumentOutline,
  images: readonly { readonly absolutePath: string; readonly caption?: string }[],
  componentPlan: readonly DocumentComponentSelection[]
): Promise<Buffer | undefined> {
  if (!universityTemplateSupportsOutline(outline, images, componentPlan)) {
    return undefined;
  }

  const template = await readUniversityTemplate();
  if (!template) return undefined;
  const zip = await JSZip.loadAsync(template);
  const firstSection = outline.sections[0];
  const firstNarrative = firstSection ? sectionNarrative(firstSection)[0] : undefined;
  const titleReplacements = new Map<number, string>([
    [1, outline.title],
    ...(firstSection ? [[2, firstSection.heading] as const] : []),
    [3, firstNarrative ?? '']
  ]);
  await replaceSlideText(zip, 1, titleReplacements);

  await Promise.all(
    outline.sections.map((section, sectionIndex) =>
      replaceUniversitySectionSlide(zip, sectionIndex + 2, section, sectionIndex)
    )
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const UNIVERSITY_TEMPLATE_ITEM_CAPACITIES = [4, 4, 5, 3, 5, 7, 4, 4, 3] as const;

function universityTemplateSupportsOutline(
  outline: DocumentOutline,
  images: readonly { readonly absolutePath: string; readonly caption?: string }[],
  componentPlan: readonly DocumentComponentSelection[]
): boolean {
  if (outline.sections.length !== UNIVERSITY_TEMPLATE_ITEM_CAPACITIES.length || images.length > 0) {
    return false;
  }
  return outline.sections.every((section, index) => {
    if (section.blocks.some((block) => block.type === 'chart' || block.type === 'table')) {
      return false;
    }
    // The reference deck has fixed card-oriented middle pages. Any other
    // semantic component must use the component renderer so its layout is not
    // silently forced into a card slot.
    if (componentPlan[index]?.id !== 'cards') {
      return false;
    }
    const narrative = sectionNarrative(section);
    const items = sectionItems(section);
    if (narrative.length > 1 || items.length > UNIVERSITY_TEMPLATE_ITEM_CAPACITIES[index]) {
      return false;
    }
    if (section.heading.length > 48 || narrative.some((text) => text.length > 130)) {
      return false;
    }
    return items.every((item) => item.length <= 130);
  });
}

async function readUniversityTemplate(): Promise<Buffer | undefined> {
  const candidates = [
    path.join(__dirname, 'templates', UNIVERSITY_TEMPLATE_FILE),
    path.resolve('src/platform/documents/templates', UNIVERSITY_TEMPLATE_FILE),
    path.resolve('dist-electron/src/platform/documents/templates', UNIVERSITY_TEMPLATE_FILE)
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch {
      // Try the next runtime location; the hand-drawn fallback remains available.
    }
  }
  return undefined;
}

async function replaceUniversitySectionSlide(
  zip: JSZip,
  slideNumber: number,
  section: DocumentOutlineSection,
  sectionIndex: number
): Promise<void> {
  const replacements = universitySectionReplacements(section, sectionIndex);
  await replaceSlideText(zip, slideNumber, replacements);
}

async function replaceSlideText(
  zip: JSZip,
  slideNumber: number,
  replacements: ReadonlyMap<number, string>
): Promise<void> {
  const entryName = `ppt/slides/slide${slideNumber}.xml`;
  const entry = zip.file(entryName);
  if (!entry) return;
  const xml = await entry.async('string');
  let textIndex = 0;
  const replaced = xml.replace(
    /<a:t(\s[^>]*)?>([\s\S]*?)<\/a:t>/g,
    (full, attributes: string | undefined) => {
      const value = replacements.get(textIndex);
      textIndex += 1;
      return value === undefined
        ? full
        : `<a:t${attributes ?? ''}>${escapeXml(value)}</a:t>`;
    }
  );
  zip.file(entryName, replaced);
}

function universitySectionReplacements(
  section: DocumentOutlineSection,
  sectionIndex: number
): ReadonlyMap<number, string> {
  const replacements = new Map<number, string>();
  const narrative = sectionNarrative(section);
  const items = sectionItems(section);
  const label = `${String(sectionIndex + 1).padStart(2, '0')} / ${truncateText(section.heading, 28)}`;
  const pageNumber = String(sectionIndex + 2).padStart(2, '0');
  replacements.set(0, label);
  replacements.set(1, truncateText(section.heading, 48));
  replacements.set(2, pageNumber);
  replacements.set(3, narrative[0] ? truncateText(narrative[0], 130) : '');

  if (sectionIndex === 0) {
    clearSlots(replacements, [4, 5, 6, 7, 8, 9, 10, 11]);
    const cards = buildTemplateCards(items, 4);
    cards.forEach(([heading, detail], index) => {
      replacements.set(4 + index * 2, heading);
      replacements.set(5 + index * 2, detail);
    });
  } else if (sectionIndex === 1) {
    clearSlots(replacements, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    buildTemplateCards(items, 4).forEach(([heading, detail], index) => {
      const base = 4 + index * 3;
      replacements.set(base, `阶段 ${index + 1}`);
      replacements.set(base + 1, heading);
      replacements.set(base + 2, detail);
    });
    replacements.set(16, items.length > 0
      ? `本节要点：${truncateText(items.slice(0, 4).join(' → '), 80)}`
      : '');
  } else if (sectionIndex === 2) {
    clearSlots(replacements, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    buildTemplateCards(items, 3).forEach(([heading, detail], index) => {
      replacements.set(4 + index * 2, heading);
      replacements.set(5 + index * 2, detail);
    });
    const process = items.slice(3, 5);
    replacements.set(10, process[0] ? '训练' : '');
    replacements.set(11, process[0] ? truncateText(process[0], 100) : '');
    replacements.set(12, process[1] ? '推理' : '');
    replacements.set(13, process[1] ? truncateText(process[1], 100) : '');
    replacements.set(14, items.length > 0 ? `关键区别：${truncateText(items[0], 70)}` : '');
  } else if (sectionIndex === 3) {
    clearSlots(replacements, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    buildTemplateCards(items, 3).forEach(([heading, detail], index) => {
      const base = 3 + index * 3;
      replacements.set(base, heading);
      replacements.set(base + 1, detail);
      replacements.set(base + 2, String(index + 1).padStart(2, '0'));
    });
    replacements.set(12, narrative[0] ? truncateText(narrative[0], 120) : '');
  } else if (sectionIndex === 4) {
    clearSlots(replacements, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    buildTemplateCards(items, 5).forEach(([heading, detail], index) => {
      const base = 3 + index * 2;
      replacements.set(base, heading);
      replacements.set(base + 1, detail);
    });
    replacements.set(13, narrative[0] ? truncateText(narrative[0], 120) : '');
  } else if (sectionIndex === 5) {
    clearSlots(replacements, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    buildTemplateCards(items, 3).forEach(([heading, detail], index) => {
      replacements.set(4 + index * 2, heading);
      replacements.set(5 + index * 2, detail);
    });
    const extras = items.slice(3, 7);
    extras.forEach((item, index) => replacements.set(10 + index, truncateText(item, 45)));
  } else if (sectionIndex === 6) {
    clearSlots(replacements, [3, 4, 5, 6, 7, 8, 9, 10, 11]);
    buildTemplateCards(items, 4).forEach(([heading, detail], index) => {
      const base = 3 + index * 2;
      replacements.set(base, heading);
      replacements.set(base + 1, detail);
    });
    replacements.set(11, narrative[0] ? truncateText(narrative[0], 120) : '');
  } else if (sectionIndex === 7) {
    clearSlots(replacements, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    buildTemplateCards(items, 4).forEach(([heading, detail], index) => {
      const base = 4 + index * 3;
      replacements.set(base, String(index + 1));
      replacements.set(base + 1, heading);
      replacements.set(base + 2, detail);
    });
    replacements.set(16, narrative[0] ? truncateText(narrative[0], 120) : '');
  } else if (sectionIndex === 8) {
    clearSlots(replacements, [4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const cards = buildTemplateCards(items, 3);
    cards.forEach(([heading, detail], index) => {
      const base = 4 + index * 3;
      replacements.set(base, String(index + 1).padStart(2, '0'));
      replacements.set(base + 1, heading);
      replacements.set(base + 2, detail);
    });
    replacements.set(12, narrative[0] ? truncateText(narrative[0], 120) : '');
  }
  const footerIndex = [17, 17, 15, 13, 14, 19, 12, 17, undefined][sectionIndex];
  if (footerIndex !== undefined) {
    replacements.set(footerIndex, '大学课堂汇报 · 可编辑演示模板');
  }
  return replacements;
}

function clearSlots(replacements: Map<number, string>, slots: readonly number[]): void {
  slots.forEach((slot) => replacements.set(slot, ''));
}

function sectionNarrative(section: DocumentOutlineSection): string[] {
  return section.blocks
    .filter((block) => block.type === 'paragraph' || block.type === 'quote')
    .map((block) => block.text);
}

function sectionItems(section: DocumentOutlineSection): string[] {
  return section.blocks.flatMap((block) => {
    if (block.type === 'bullets' || block.type === 'numbered') return [...block.items];
    return [];
  });
}

function buildTemplateCards(items: readonly string[], count: number): [string, string][] {
  return items.slice(0, count).map((item, index) => {
    const lines = item.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] ?? `要点 ${index + 1}`;
    const separator = firstLine.search(/[:：]/);
    const heading = truncateText(
      separator > 0 ? firstLine.slice(0, separator) : firstLine,
      32
    );
    const detail = truncateText(
      [separator > 0 ? firstLine.slice(separator + 1) : '', ...lines.slice(1)]
        .filter(Boolean)
        .join(' ') || `围绕“${heading}”展开学习与实践`,
      90
    );
    return [heading, detail];
  });
}

function truncateText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function addUniversitySectionSlides(
  pptx: PptxGenJS,
  section: DocumentOutlineSection,
  sectionIndex: number,
  theme: DocumentTheme,
  image?: { readonly absolutePath: string; readonly caption?: string },
  plannedComponent?: DocumentComponentSelection
): void {
  const chartBlocks = section.blocks.filter(
    (block): block is Extract<DocumentOutlineBlock, { readonly type: 'chart' }> =>
      block.type === 'chart'
  );
  const contentBlocks = section.blocks.filter((block) => block.type !== 'chart');
  const paragraphs = contentBlocks
    .filter((block) => block.type === 'paragraph' || block.type === 'quote')
    .map((block) => block.text);
  const listItems = contentBlocks.flatMap((block) =>
    block.type === 'bullets' || block.type === 'numbered' ? block.items : []
  );
  const tables = contentBlocks.filter(
    (block): block is Extract<DocumentOutlineBlock, { readonly type: 'table' }> =>
      block.type === 'table'
  );
  const component = plannedComponent ?? selectSectionComponent(section, { hasImage: Boolean(image) });
  if (component.id === 'comparison') {
    addUniversityComparisonSlide(pptx, {
      heading: section.heading,
      sectionIndex,
      theme,
      items: listItems.slice(0, 2),
      image
    });
    return;
  }
  if (component.id === 'metrics') {
    addUniversityMetricsSlide(pptx, {
      heading: section.heading,
      sectionIndex,
      theme,
      items: listItems,
      image
    });
    return;
  }
  if (component.id === 'callout') {
    addUniversityCalloutSlide(pptx, {
      heading: section.heading,
      sectionIndex,
      theme,
      items: listItems,
      image
    });
    return;
  }
  const itemCapacity = component.id === 'timeline' ? 5 : 4;
  const cardGroups = chunkItems(listItems, itemCapacity);
  const narrativePageCount = Math.max(paragraphs.length, cardGroups.length);

  for (let pageIndex = 0; pageIndex < narrativePageCount; pageIndex += 1) {
    addUniversityContentSlide(pptx, {
      heading: section.heading,
      sectionIndex,
      theme,
      paragraph: paragraphs[pageIndex],
      cards: cardGroups[pageIndex] ?? [],
      component,
      image: pageIndex === 0 ? image : undefined
    });
  }

  tables.forEach((table) => {
    chunkItems(table.rows, 6).forEach((rows) => {
      addUniversityContentSlide(pptx, {
        heading: section.heading,
        sectionIndex,
        theme,
        table: { header: table.header, rows }
      });
    });
  });
  chartBlocks.forEach((block) => {
    addPptChartSlide(pptx, block, section.heading, theme, false, undefined, true);
  });
}

function addUniversityComparisonSlide(
  pptx: PptxGenJS,
  input: {
    readonly heading: string;
    readonly sectionIndex: number;
    readonly theme: DocumentTheme;
    readonly items: readonly string[];
    readonly image?: { readonly absolutePath: string; readonly caption?: string };
  }
): void {
  const slide = pptx.addSlide();
  const { heading, sectionIndex, theme, items, image } = input;
  slide.background = { color: theme.background };
  slide.addText(`${String(sectionIndex + 1).padStart(2, '0')} / 对比分析`, {
    x: 0.65,
    y: 0.38,
    w: 3.2,
    h: 0.24,
    fontSize: 11,
    bold: true,
    color: theme.accent
  });
  slide.addText(heading, {
    x: 0.65,
    y: 0.7,
    w: 10.8,
    h: 0.6,
    fontSize: 27,
    bold: true,
    color: theme.text,
    fit: 'shrink'
  });
  slide.addShape('line', {
    x: 0.65,
    y: 1.42,
    w: 12,
    h: 0,
    line: { color: 'D5DEE8', width: 0.75 }
  });
  const availableWidth = image ? 7.55 : 11.7;
  const gap = 0.32;
  const cardWidth = (availableWidth - gap) / 2;
  const colors = ['E8F1FB', 'FFF0E4'];
  const bars = ['4084CC', 'EB8E41'];
  items.forEach((item, index) => {
    const x = 0.8 + index * (cardWidth + gap);
    slide.addShape('roundRect', {
      x,
      y: 1.9,
      w: cardWidth,
      h: 3.25,
      rectRadius: 0.06,
      fill: { color: colors[index] },
      line: { color: colors[index] }
    });
    slide.addShape('rect', {
      x,
      y: 1.9,
      w: 0.1,
      h: 3.25,
      fill: { color: bars[index] },
      line: { color: bars[index] }
    });
    slide.addText(index === 0 ? 'A' : 'B', {
      x: x + 0.3,
      y: 2.25,
      w: 0.5,
      h: 0.3,
      fontSize: 16,
      bold: true,
      color: bars[index]
    });
    slide.addText(item, {
      x: x + 0.3,
      y: 2.85,
      w: cardWidth - 0.6,
      h: 1.65,
      fontSize: 17,
      bold: true,
      color: theme.text,
      fit: 'shrink',
      valign: 'middle'
    });
  });
  if (image) {
    slide.addImage({
      path: image.absolutePath,
      x: 8.75,
      y: 1.75,
      w: 3.35,
      h: 3.95,
      sizing: { type: 'contain', w: 3.35, h: 3.95 }
    });
    if (image.caption) {
      slide.addText(image.caption, {
        x: 8.75,
        y: 5.85,
        w: 3.35,
        h: 0.25,
        fontSize: 9,
        color: theme.muted,
        align: 'center'
      });
    }
  }
  slide.addText('大学课堂汇报 · 可编辑演示模板', {
    x: 0.65,
    y: 7.12,
    w: 4.3,
    h: 0.18,
    fontSize: 8,
    color: theme.muted
  });
}

function addUniversityMetricsSlide(
  pptx: PptxGenJS,
  input: {
    readonly heading: string;
    readonly sectionIndex: number;
    readonly theme: DocumentTheme;
    readonly items: readonly string[];
    readonly image?: { readonly absolutePath: string; readonly caption?: string };
  }
): void {
  const slide = pptx.addSlide();
  const { heading, sectionIndex, theme, items, image } = input;
  slide.background = { color: theme.background };
  addUniversitySectionHeader(slide, heading, sectionIndex, theme, '结果评估');
  const availableWidth = image ? 7.55 : 11.7;
  const gap = 0.24;
  const count = Math.min(4, Math.max(1, items.length));
  const cardWidth = (availableWidth - gap * (count - 1)) / count;
  const metricColors = ['109B91', '4084CC', 'EB8E41', 'CD5454'];
  items.slice(0, count).forEach((item, index) => {
    const x = 0.8 + index * (cardWidth + gap);
    const [label, detail] = splitComponentItem(item);
    slide.addShape('rect', {
      x,
      y: 1.9,
      w: cardWidth,
      h: 2.85,
      fill: { color: 'FFFFFF' },
      line: { color: 'D5DEE8', width: 0.8 }
    });
    slide.addShape('rect', {
      x,
      y: 1.9,
      w: cardWidth,
      h: 0.1,
      fill: { color: metricColors[index] },
      line: { color: metricColors[index] }
    });
    slide.addText(String(index + 1).padStart(2, '0'), {
      x: x + 0.25,
      y: 2.25,
      w: cardWidth - 0.5,
      h: 0.28,
      fontSize: 11,
      bold: true,
      color: metricColors[index]
    });
    slide.addText(label, {
      x: x + 0.25,
      y: 2.8,
      w: cardWidth - 0.5,
      h: 0.55,
      fontSize: 18,
      bold: true,
      color: theme.text,
      fit: 'shrink'
    });
    if (detail) {
      slide.addText(detail, {
        x: x + 0.25,
        y: 3.55,
        w: cardWidth - 0.5,
        h: 0.7,
        fontSize: 12,
        color: theme.muted,
        fit: 'shrink'
      });
    }
  });
  addUniversityFooter(slide, theme);
}

function addUniversityCalloutSlide(
  pptx: PptxGenJS,
  input: {
    readonly heading: string;
    readonly sectionIndex: number;
    readonly theme: DocumentTheme;
    readonly items: readonly string[];
    readonly image?: { readonly absolutePath: string; readonly caption?: string };
  }
): void {
  const slide = pptx.addSlide();
  const { heading, sectionIndex, theme, items, image } = input;
  slide.background = { color: theme.background };
  addUniversitySectionHeader(slide, heading, sectionIndex, theme, '重点提醒');
  const width = image ? 7.55 : 11.7;
  slide.addShape('roundRect', {
    x: 0.8,
    y: 1.85,
    w: width,
    h: 3.25,
    rectRadius: 0.06,
    fill: { color: 'FFF4E9' },
    line: { color: 'F2C59A', width: 0.8 }
  });
  slide.addShape('ellipse', {
    x: 1.2,
    y: 2.35,
    w: 0.55,
    h: 0.55,
    fill: { color: 'EB8E41' },
    line: { color: 'EB8E41' }
  });
  slide.addText('!', {
    x: 1.2,
    y: 2.45,
    w: 0.55,
    h: 0.24,
    fontSize: 16,
    bold: true,
    color: 'FFFFFF',
    align: 'center'
  });
  slide.addText(items.map((item) => `• ${item}`).join('\n'), {
    x: 2.05,
    y: 2.25,
    w: width - 2.45,
    h: 2.2,
    fontSize: 18,
    color: theme.text,
    breakLine: false,
    fit: 'shrink',
    valign: 'middle'
  });
  if (image) {
    slide.addImage({
      path: image.absolutePath,
      x: 8.75,
      y: 1.75,
      w: 3.35,
      h: 3.95,
      sizing: { type: 'contain', w: 3.35, h: 3.95 }
    });
  }
  addUniversityFooter(slide, theme);
}

function addUniversitySectionHeader(
  slide: PptxGenJS.Slide,
  heading: string,
  sectionIndex: number,
  theme: DocumentTheme,
  label: string
): void {
  slide.addText(`${String(sectionIndex + 1).padStart(2, '0')} / ${label}`, {
    x: 0.65,
    y: 0.38,
    w: 3.2,
    h: 0.24,
    fontSize: 11,
    bold: true,
    color: theme.accent
  });
  slide.addText(heading, {
    x: 0.65,
    y: 0.7,
    w: 10.8,
    h: 0.6,
    fontSize: 27,
    bold: true,
    color: theme.text,
    fit: 'shrink'
  });
  slide.addText(String(sectionIndex + 2).padStart(2, '0'), {
    x: 12.0,
    y: 0.42,
    w: 0.6,
    h: 0.24,
    fontSize: 12,
    color: theme.muted,
    align: 'right'
  });
  slide.addShape('line', {
    x: 0.65,
    y: 1.42,
    w: 12.0,
    h: 0,
    line: { color: 'D5DEE8', width: 0.75 }
  });
}

function addUniversityFooter(slide: PptxGenJS.Slide, theme: DocumentTheme): void {
  slide.addText('大学课堂汇报 · 可编辑演示模板', {
    x: 0.65,
    y: 7.12,
    w: 4.3,
    h: 0.18,
    fontSize: 8,
    color: theme.muted
  });
}

function splitComponentItem(value: string): [string, string] {
  const separator = value.search(/[:：]/);
  if (separator <= 0) return [value, ''];
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function addUniversityContentSlide(
  pptx: PptxGenJS,
  input: {
    readonly heading: string;
    readonly sectionIndex: number;
    readonly theme: DocumentTheme;
    readonly paragraph?: string;
    readonly cards?: readonly string[];
    readonly component?: DocumentComponentSelection;
    readonly table?: {
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };
    readonly image?: { readonly absolutePath: string; readonly caption?: string };
  }
): void {
  const {
    heading,
    sectionIndex,
    theme,
    paragraph,
    cards = [],
    component,
    table,
    image
  } = input;
  const slide = pptx.addSlide();
  slide.background = { color: theme.background };
  slide.addText(`${String(sectionIndex + 1).padStart(2, '0')} / 课堂汇报`, {
    x: 0.65,
    y: 0.38,
    w: 3.2,
    h: 0.24,
    fontSize: 11,
    bold: true,
    color: theme.accent
  });
  slide.addText(heading, {
    x: 0.65,
    y: 0.7,
    w: 10.8,
    h: 0.6,
    fontSize: 27,
    bold: true,
    color: theme.text
  });
  slide.addText(String(sectionIndex + 2).padStart(2, '0'), {
    x: 12.0,
    y: 0.42,
    w: 0.6,
    h: 0.24,
    fontSize: 12,
    color: theme.muted,
    align: 'right'
  });
  slide.addShape('line', {
    x: 0.65,
    y: 1.42,
    w: 12.0,
    h: 0,
    line: { color: 'D5DEE8', width: 0.75 }
  });

  let y = 1.68;
  if (paragraph) {
    slide.addText(paragraph, {
      x: 0.8,
      y,
      w: image ? 7.5 : 11.5,
      h: 0.72,
      fontSize: 15,
      color: theme.muted,
      fit: 'shrink'
    });
    y += 0.96;
  }
  if (cards.length > 0 && component?.id === 'timeline') {
    addUniversityTimeline(slide, cards, y, image, theme);
  } else if (cards.length > 0 && component?.id === 'body') {
    slide.addText(cards.map((item) => `• ${item}`).join('\n'), {
      x: 0.9,
      y,
      w: image ? 7.15 : 11.25,
      h: 2.7,
      fontSize: 20,
      color: theme.text,
      breakLine: false,
      fit: 'shrink',
      valign: 'middle'
    });
  } else if (cards.length > 0) {
    const gap = 0.22;
    const availableWidth = image ? 7.55 : 11.7;
    const cardWidth = (availableWidth - gap * (cards.length - 1)) / cards.length;
    const cardColors = ['E0F6F2', 'E8F1FB', 'FFF0E4', 'FBE8E8'];
    const barColors = [theme.accent, '4084CC', 'EB8E41', 'CD5454'];
    cards.forEach((item, index) => {
      const x = 0.8 + index * (cardWidth + gap);
      slide.addShape('roundRect', {
        x,
        y,
        w: cardWidth,
        h: 2.25,
        rectRadius: 0.06,
        fill: { color: cardColors[index] },
        line: { color: cardColors[index] }
      });
      slide.addShape('rect', {
        x,
        y,
        w: 0.08,
        h: 2.25,
        fill: { color: barColors[index] },
        line: { color: barColors[index] }
      });
      slide.addText(String(index + 1).padStart(2, '0'), {
        x: x + 0.25,
        y: y + 0.27,
        w: cardWidth - 0.45,
        h: 0.25,
        fontSize: 11,
        bold: true,
        color: barColors[index]
      });
      slide.addText(item, {
        x: x + 0.25,
        y: y + 0.72,
        w: cardWidth - 0.45,
        h: 1.1,
        fontSize: 16,
        bold: true,
        color: theme.text,
        fit: 'shrink',
        valign: 'middle'
      });
    });
  }
  if (table) {
    const rows = [table.header, ...table.rows].map((row) => row.map((text) => ({ text })));
    slide.addTable(rows, {
      x: 0.8,
      y,
      w: image ? 7.55 : 11.7,
      fontSize: 12,
      color: theme.text,
      border: { pt: 0.5, color: 'C8D6D8' },
      rowH: rows.map(() => 0.42)
    });
  }
  if (image) {
    slide.addImage({
      path: image.absolutePath,
      x: 8.75,
      y: 1.75,
      w: 3.35,
      h: 3.95,
      sizing: { type: 'contain', w: 3.35, h: 3.95 }
    });
    if (image.caption) {
      slide.addText(image.caption, {
        x: 8.75,
        y: 5.85,
        w: 3.35,
        h: 0.25,
        fontSize: 9,
        color: theme.muted,
        align: 'center'
      });
    }
  }
  slide.addText('大学课堂汇报 · 可编辑演示模板', {
    x: 0.65,
    y: 7.12,
    w: 4.3,
    h: 0.18,
    fontSize: 8,
    color: theme.muted
  });
}

function addUniversityTimeline(
  slide: PptxGenJS.Slide,
  items: readonly string[],
  y: number,
  image: { readonly absolutePath: string; readonly caption?: string } | undefined,
  theme: DocumentTheme
): void {
  const gap = 0.2;
  const availableWidth = image ? 7.55 : 11.7;
  const xStart = 0.8;
  const itemWidth = (availableWidth - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length);
  const centerY = y + 0.45;
  if (items.length > 1) {
    slide.addShape('line', {
      x: xStart + itemWidth / 2,
      y: centerY,
      w: availableWidth - itemWidth,
      h: 0,
      line: { color: 'C8D6D8', width: 1.2 }
    });
  }
  items.forEach((item, index) => {
    const x = xStart + index * (itemWidth + gap);
    slide.addShape('ellipse', {
      x: x + itemWidth / 2 - 0.18,
      y: centerY - 0.18,
      w: 0.36,
      h: 0.36,
      fill: { color: theme.accent },
      line: { color: theme.accent }
    });
    slide.addText(String(index + 1).padStart(2, '0'), {
      x,
      y: centerY + 0.42,
      w: itemWidth,
      h: 0.24,
      fontSize: 10,
      bold: true,
      color: theme.accent,
      align: 'center'
    });
    slide.addText(item, {
      x: x + 0.08,
      y: centerY + 0.78,
      w: itemWidth - 0.16,
      h: 1.05,
      fontSize: 14,
      bold: true,
      color: theme.text,
      fit: 'shrink',
      valign: 'middle',
      align: 'center'
    });
  });
}

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push([...items.slice(index, index + size)]);
  }
  return groups;
}

function addPptChartSlide(
  pptx: PptxGenJS,
  block: Extract<DocumentOutlineBlock, { readonly type: 'chart' }>,
  heading: string,
  theme: DocumentTheme,
  financing: boolean,
  image?: { readonly absolutePath: string; readonly caption?: string },
  university = false
): void {
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
  if (university) {
    slide.addText('数据图表 / 课堂汇报', {
      x: 0.65,
      y: 0.38,
      w: 3.2,
      h: 0.24,
      fontSize: 11,
      bold: true,
      color: theme.accent
    });
  }
  const withImage = Boolean(image);
  const chartX = withImage ? 0.65 : 0.75;
  const chartY = 1.55;
  const chartW = withImage ? 7.55 : 11.8;
  const chartH = 4.75;
  slide.addShape('rect', {
    x: 0.5,
    y: 0.42,
    w: 0.09,
    h: 0.5,
    fill: { color: theme.accent }
  });
  slide.addText(heading, {
    x: university ? 0.65 : 0.72,
    y: university ? 0.7 : 0.35,
    w: withImage ? 8.2 : 12.5,
    h: 0.8,
    fontSize: university ? 27 : 26,
    bold: true,
    color: financing ? 'FFFFFF' : university ? theme.text : theme.accent
  });
  slide.addChart(
    pptx.ChartType[block.chartKind === 'bar' ? 'bar' : 'pie'],
    [{
      name: block.title ?? '数据',
      labels: block.data.map((item) => item.label),
      values: block.data.map((item) => item.value)
    }],
    {
      x: chartX,
      y: university ? 1.62 : chartY,
      w: chartW,
      h: chartH,
      showTitle: Boolean(block.title),
      title: block.title ?? '',
      showLegend: true,
      showValue: true,
      chartColors: chartPalette(theme.accent),
      catAxisLabelFontSize: block.data.length > 6 ? 9 : 12,
      valAxisLabelFontSize: 10
    }
  );
  if (image) {
    slide.addImage({
      path: image.absolutePath,
      x: 8.65,
      y: 1.55,
      w: 3.9,
      h: 4.35,
      sizing: { type: 'contain', w: 3.9, h: 4.35 }
    });
    if (image.caption) {
      slide.addText(image.caption, {
        x: 8.7,
        y: 6.02,
        w: 3.8,
        h: 0.35,
        fontSize: 10,
        color: theme.muted,
        align: 'center'
      });
    }
  }
  slide.addText(university ? '大学课堂汇报 · 可编辑演示模板' : '图表页', {
    x: 0.75,
    y: 6.95,
    w: 1.2,
    h: 0.25,
    fontSize: 9,
    color: theme.muted
  });
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
