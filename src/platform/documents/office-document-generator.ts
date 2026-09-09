import { randomUUID } from 'node:crypto';
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
import {
  presentationOutlineLimits,
  type DocumentOutline,
  type DocumentOutlineBlock,
  type DocumentOutlineSection
} from './document-outline-parser';
import {
  choosePresentationComposition,
  choosePresentationLayout,
  resolvePresentationTemplate,
  type PresentationCompositionKind,
  type PresentationLayout,
  type PresentationTemplate,
  type PresentationTemplateId
} from './presentation-template';

export interface GeneratedDocumentFile {
  readonly fileName: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

export interface GeneratedTemporaryDocumentFile {
  readonly fileName: string;
  readonly temporaryPath: string;
  readonly finalPath: string;
  readonly sizeBytes: number;
}

export interface GenerateDocumentFileInput {
  readonly kind: DocumentWorkspaceKind;
  readonly outline: DocumentOutline;
  readonly outputDirectory: string;
  readonly now: string;
  readonly theme?: DocumentThemeId;
  readonly presentationTemplate?: PresentationTemplateId;
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
  const { fileName, buffer } = await buildDocumentOutput(input);
  const absolutePath = path.join(input.outputDirectory, fileName);
  await writeFile(absolutePath, buffer);
  const fileStat = await stat(absolutePath);
  return { fileName, absolutePath, sizeBytes: fileStat.size };
}

export async function generateTemporaryDocumentFile(
  input: GenerateDocumentFileInput
): Promise<GeneratedTemporaryDocumentFile> {
  await mkdir(input.outputDirectory, { recursive: true });
  const { fileName: baseFileName, buffer } = await buildDocumentOutput(input);
  const extension = path.extname(baseFileName);
  const fileName = `${baseFileName.slice(0, -extension.length)}-${randomUUID()}${extension}`;
  const finalPath = path.join(input.outputDirectory, fileName);
  const temporaryPath = path.join(
    input.outputDirectory,
    `.${fileName}.${randomUUID()}.tmp`
  );
  await writeFile(temporaryPath, buffer, { flag: 'wx' });
  const fileStat = await stat(temporaryPath);
  return { fileName, temporaryPath, finalPath, sizeBytes: fileStat.size };
}

async function buildDocumentOutput(
  input: GenerateDocumentFileInput
): Promise<{ readonly fileName: string; readonly buffer: Buffer }> {
  const extension = documentWorkspaceKindExtensions[input.kind];
  const fileName = `${sanitizeFileName(input.outline.title)}-${timestampSuffix(
    input.now
  )}${extension}`;
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
            resolvePresentationTemplate(
              input.presentationTemplate ??
                (input.theme === 'financing' ? 'financing' : 'work_report')
            ),
            input.images ?? []
          );
  return { fileName, buffer };
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

type PresentationImage = NonNullable<GenerateDocumentFileInput['images']>[number];
type PresentationTableBlock = Extract<DocumentOutlineBlock, { type: 'table' }>;
type PresentationChartBlock = Extract<DocumentOutlineBlock, { type: 'chart' }>;

interface PresentationTextUnit {
  readonly type: 'text';
  readonly role: 'takeaway' | 'body' | 'action';
  readonly text: string;
  readonly numbered?: boolean;
  readonly quote?: boolean;
}

interface PresentationTableUnit {
  readonly type: 'table';
  readonly block: PresentationTableBlock;
}

interface PresentationChartUnit {
  readonly type: 'chart';
  readonly block: PresentationChartBlock;
}

type PresentationUnit =
  | PresentationTextUnit
  | PresentationTableUnit
  | PresentationChartUnit;

interface ExpandedPresentationPage {
  readonly heading: string;
  readonly layout: PresentationLayout;
  readonly composition: PresentationCompositionKind;
  readonly units: readonly PresentationUnit[];
  readonly image?: PresentationImage;
  readonly continuationIndex: number;
}

type UncomposedPresentationPage = Omit<
  ExpandedPresentationPage,
  'composition'
>;

export class PresentationLayoutError extends Error {
  readonly code = 'document_layout_overflow' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PresentationLayoutError';
  }
}

async function buildPptBuffer(
  outline: DocumentOutline,
  template: PresentationTemplate,
  images: readonly PresentationImage[]
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = outline.title;

  const pages = expandPresentationSections(outline, template, images);
  const totalPages =
    1 + pages.length + (outline.sections.length > 0 ? 1 : 0);
  if (totalPages > presentationOutlineLimits.maxEstimatedPages) {
    throw new PresentationLayoutError(
      `PPT 分页结果超过 ${presentationOutlineLimits.maxEstimatedPages} 页上限`
    );
  }

  renderPresentationCover(pptx, outline, template);
  pages.forEach((page, index) => {
    renderPresentationPage(pptx, page, template, index + 2);
  });
  if (outline.sections.length > 0) {
    renderPresentationClosing(pptx, outline, template);
  }
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

function expandPresentationSections(
  outline: DocumentOutline,
  template: PresentationTemplate,
  images: readonly PresentationImage[]
): ExpandedPresentationPage[] {
  const pages = outline.sections.flatMap((section, sectionIndex) =>
    expandPresentationSection(section, template, images[sectionIndex])
  );
  let previous: PresentationCompositionKind | undefined;
  return pages.map((page, pageIndex) => {
    const textUnits = page.units.filter(
      (unit): unit is PresentationTextUnit => unit.type === 'text'
    );
    const composition = choosePresentationComposition(template, {
      layoutKind: page.layout.kind,
      textGroupCount: textUnits.filter((unit) => unit.role === 'body').length,
      totalCharacters: textUnits.reduce(
        (total, unit) => total + unit.text.length,
        0
      ),
      pageIndex,
      previous
    });
    previous = composition;
    return { ...page, composition };
  });
}

function expandPresentationSection(
  section: DocumentOutlineSection,
  template: PresentationTemplate,
  image: PresentationImage | undefined
): UncomposedPresentationPage[] {
  const preferredLayout = choosePresentationLayout(template, section);
  const pages: Omit<UncomposedPresentationPage, 'continuationIndex'>[] = [];
  const takeawayParts = section.takeaway
    ? splitTextByCapacity(section.takeaway, 90)
    : [];
  let pendingText: PresentationTextUnit[] = takeawayParts
    .slice(1)
    .map((text) => textUnit('body', text));
  let pendingTakeaway = takeawayParts[0]
    ? textUnit('takeaway', takeawayParts[0])
    : undefined;
  let imagePending = image;

  const appendTextPages = (): void => {
    const units = [
      ...(pendingTakeaway ? [pendingTakeaway] : []),
      ...pendingText
    ];
    if (units.length === 0) return;
    const expanded = paginateTextUnits(
      section,
      units,
      template,
      pages.length === 0 ? preferredLayout : template.layouts.insight,
      imagePending
    );
    pages.push(...expanded);
    pendingText = [];
    pendingTakeaway = undefined;
    imagePending = undefined;
  };

  for (const block of section.blocks) {
    if (block.type !== 'table' && block.type !== 'chart') {
      pendingText.push(...textUnitsFromBlock(block));
      continue;
    }

    const dataUnits =
      block.type === 'table'
        ? splitTableUnits(section, block, template.layouts.data)
        : [chartUnit(section, block, template.layouts.data)];
    for (const dataUnit of dataUnits) {
      const prefix = [
        ...(pendingTakeaway ? [pendingTakeaway] : []),
        ...pendingText
      ];
      if (
        prefix.length > 0 &&
        unitsFitLayout([...prefix, dataUnit], template.layouts.data)
      ) {
        pages.push({
          heading: section.heading,
          layout: template.layouts.data,
          units: [...prefix, dataUnit]
        });
        pendingText = [];
        pendingTakeaway = undefined;
      } else {
        appendTextPages();
        pages.push({
          heading: section.heading,
          layout: template.layouts.data,
          units: [dataUnit]
        });
      }
    }
  }

  appendTextPages();
  if (pages.length === 0) {
    pages.push({
      heading: section.heading,
      layout: imagePending ? template.layouts.image_text : preferredLayout,
      units: pendingTakeaway ? [pendingTakeaway] : [],
      ...(imagePending ? { image: imagePending } : {})
    });
    pendingTakeaway = undefined;
    imagePending = undefined;
  } else if (imagePending) {
    pages.unshift({
      heading: section.heading,
      layout: template.layouts.image_text,
      units: pendingTakeaway ? [pendingTakeaway] : [],
      image: imagePending
    });
  }

  if (section.action) {
    const lastIndex = pages.length - 1;
    const lastPage = pages[lastIndex];
    if (section.action.length <= 90) {
      const action = textUnit('action', section.action);
      pages[lastIndex] = { ...lastPage, units: [...lastPage.units, action] };
    } else {
      for (const actionText of splitTextByCapacity(section.action, 240)) {
        pages.push({
          heading: `${section.heading}｜行动安排`,
          layout: template.layouts.insight,
          units: [textUnit('action', actionText)]
        });
      }
    }
  }

  return pages.map((page, index) => ({
    ...page,
    continuationIndex: index + 1
  }));
}

function paginateTextUnits(
  section: DocumentOutlineSection,
  units: readonly PresentationTextUnit[],
  template: PresentationTemplate,
  firstLayout: PresentationLayout,
  image: PresentationImage | undefined
): Omit<UncomposedPresentationPage, 'continuationIndex'>[] {
  const pages: Omit<UncomposedPresentationPage, 'continuationIndex'>[] = [];
  const expandedUnits = units.flatMap((unit) =>
    unit.role === 'body'
      ? splitTextByCapacity(
          unit.text,
          Math.min(
            firstLayout.maxBodyCharacters,
            template.layouts.insight.maxBodyCharacters
          )
        ).map((text) => ({ ...unit, text }))
      : [unit]
  );
  let index = 0;
  while (index < expandedUnits.length) {
    const layout =
      pages.length === 0
        ? image
          ? template.layouts.image_text
          : firstLayout.maxContentGroups > 0
            ? firstLayout
            : template.layouts.insight
        : firstLayout.supportsContinuation
          ? firstLayout
          : template.layouts.insight;
    const pageUnits: PresentationTextUnit[] = [];
    while (
      index < expandedUnits.length &&
      unitsFitLayout([...pageUnits, expandedUnits[index]], layout)
    ) {
      pageUnits.push(expandedUnits[index]);
      index += 1;
    }
    if (pageUnits.length === 0) {
      assertUnitFits(section, expandedUnits[index], layout);
    }
    pages.push({
      heading: section.heading,
      layout,
      units: pageUnits,
      ...(pages.length === 0 && image ? { image } : {})
    });
  }
  return rebalanceTextPages(pages);
}

function rebalanceTextPages(
  pages: readonly Omit<UncomposedPresentationPage, 'continuationIndex'>[]
): Omit<UncomposedPresentationPage, 'continuationIndex'>[] {
  if (pages.length < 2) return [...pages];
  const previousIndex = pages.length - 2;
  const lastIndex = pages.length - 1;
  const previous = pages[previousIndex];
  const last = pages[lastIndex];
  const previousBodyIndexes = previous.units.flatMap((unit, index) =>
    unit.type === 'text' && unit.role === 'body' ? [index] : []
  );
  const lastBodyCount = last.units.filter(
    (unit) => unit.type === 'text' && unit.role === 'body'
  ).length;
  if (lastBodyCount !== 1 || previousBodyIndexes.length < 3) return [...pages];

  const moveIndex = previousBodyIndexes[previousBodyIndexes.length - 1];
  const moved = previous.units[moveIndex];
  const previousUnits = previous.units.filter((_, index) => index !== moveIndex);
  const lastUnits = [moved, ...last.units];
  if (
    !unitsFitLayout(previousUnits, previous.layout) ||
    !unitsFitLayout(lastUnits, last.layout)
  ) {
    return [...pages];
  }
  return pages.map((page, index) => {
    if (index === previousIndex) return { ...page, units: previousUnits };
    if (index === lastIndex) return { ...page, units: lastUnits };
    return page;
  });
}

function splitTextByCapacity(text: string, maximumLength: number): string[] {
  if (text.length <= maximumLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maximumLength) {
    const minimumBreak = Math.floor(maximumLength * 0.55);
    let breakAt = -1;
    for (let index = maximumLength; index >= minimumBreak; index -= 1) {
      if (/[。！？；;,.，、：:\s]/.test(remaining[index - 1])) {
        breakAt = index;
        break;
      }
    }
    if (breakAt < 1) breakAt = maximumLength;
    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function textUnitsFromBlock(
  block: Exclude<DocumentOutlineBlock, PresentationTableBlock | PresentationChartBlock>
): PresentationTextUnit[] {
  if (block.type === 'bullets' || block.type === 'numbered') {
    return block.items.map((item) => ({
      ...textUnit('body', item),
      ...(block.type === 'numbered' ? { numbered: true } : {})
    }));
  }
  return [
    {
      ...textUnit('body', block.text),
      ...(block.type === 'quote' ? { quote: true } : {})
    }
  ];
}

function textUnit(
  role: PresentationTextUnit['role'],
  text: string
): PresentationTextUnit {
  return { type: 'text', role, text };
}

function splitTableUnits(
  section: DocumentOutlineSection,
  block: PresentationTableBlock,
  layout: PresentationLayout
): PresentationTableUnit[] {
  return splitTableColumns(block, layout.maxTableColumns).flatMap((columnGroup) =>
    splitTableRows(section, columnGroup, layout)
  );
}

function splitTableColumns(
  block: PresentationTableBlock,
  maxColumns: number
): PresentationTableBlock[] {
  if (block.header.length <= maxColumns) return [block];

  const groups: PresentationTableBlock[] = [];
  for (let start = 0; start < block.header.length;) {
    const end = Math.min(
      block.header.length,
      start + (start === 0 ? maxColumns : maxColumns - 1)
    );
    const indexes =
      start === 0
        ? Array.from({ length: end - start }, (_, index) => start + index)
        : [0, ...Array.from({ length: end - start }, (_, index) => start + index)];
    groups.push({
      ...block,
      header: indexes.map((index) => block.header[index]),
      rows: block.rows.map((row) => indexes.map((index) => row[index]))
    });
    start = end;
  }
  return groups;
}

function splitTableRows(
  section: DocumentOutlineSection,
  block: PresentationTableBlock,
  layout: PresentationLayout
): PresentationTableUnit[] {
  const headerCharacters = block.header.reduce(
    (total, cell) => total + cell.length,
    0
  );
  if (headerCharacters > layout.maxBodyCharacters) {
    throwLayoutOverflow(section, '表头');
  }
  if (block.rows.length === 0) return [{ type: 'table', block }];

  const units: PresentationTableUnit[] = [];
  let rows: PresentationTableBlock['rows'][number][] = [];
  let characters = headerCharacters;
  for (const row of block.rows) {
    const rowCharacters = row.reduce((total, cell) => total + cell.length, 0);
    if (headerCharacters + rowCharacters > layout.maxBodyCharacters) {
      throwLayoutOverflow(section, '表格行');
    }
    if (
      rows.length > 0 &&
      (rows.length >= 7 || characters + rowCharacters > layout.maxBodyCharacters)
    ) {
      units.push({ type: 'table', block: { ...block, rows } });
      rows = [];
      characters = headerCharacters;
    }
    rows.push(row);
    characters += rowCharacters;
  }
  units.push({ type: 'table', block: { ...block, rows } });
  return units;
}

function chartUnit(
  section: DocumentOutlineSection,
  block: PresentationChartBlock,
  layout: PresentationLayout
): PresentationChartUnit {
  const unit: PresentationChartUnit = { type: 'chart', block };
  assertUnitFits(section, unit, layout);
  return unit;
}

function assertUnitFits(
  section: DocumentOutlineSection,
  unit: PresentationUnit,
  layout: PresentationLayout
): void {
  if (!unitsFitLayout([unit], layout)) {
    throwLayoutOverflow(section, '内容组');
  }
}

function throwLayoutOverflow(
  section: DocumentOutlineSection,
  contentType: string
): never {
  throw new PresentationLayoutError(
    `${contentType}无法在可读字号下放入“${section.heading}”页面`
  );
}

function unitsFitLayout(
  units: readonly PresentationUnit[],
  layout: PresentationLayout
): boolean {
  const bodyUnits = units.filter(
    (unit) => unit.type !== 'text' || unit.role === 'body'
  );
  return (
    bodyUnits.length <= layout.maxContentGroups &&
    bodyUnits.reduce((total, unit) => total + unitCharacterCount(unit), 0) <=
      layout.maxBodyCharacters
  );
}

function unitCharacterCount(unit: PresentationUnit): number {
  if (unit.type === 'text') return unit.text.length;
  if (unit.type === 'table') {
    return [...unit.block.header, ...unit.block.rows.flat()].reduce(
      (total, value) => total + value.length,
      0
    );
  }
  return (
    (unit.block.title?.length ?? 0) +
    unit.block.data.reduce((total, item) => total + item.label.length, 0)
  );
}

function renderPresentationCover(
  pptx: PptxGenJS,
  outline: DocumentOutline,
  template: PresentationTemplate
): void {
  const slide = pptx.addSlide();
  addPresentationFrame(slide, template, 'cover');
  const align = template.id === 'financing' ? 'left' : 'center';
  const x = align === 'left' ? 1.05 : 0.8;
  const width = align === 'left' ? 9.4 : 11.73;
  slide.addText(outline.title, {
    x,
    y: align === 'left' ? 2.05 : 2.15,
    w: width,
    h: 1.65,
    fontSize: coverTitleFontSize(outline.title),
    bold: true,
    color: template.tokens.text,
    align,
    valign: 'middle',
    margin: 0,
    wrap: true
  });
  if (outline.sections.length > 0) {
    slide.addText(outline.sections[0].heading, {
      x,
      y: 4.15,
      w: width,
      h: 0.82,
      fontSize: 20,
      color: template.tokens.muted,
      align,
      margin: 0,
      wrap: true
    });
  }
}

function renderPresentationPage(
  pptx: PptxGenJS,
  page: ExpandedPresentationPage,
  template: PresentationTemplate,
  pageNumber: number
): void {
  const slide = pptx.addSlide();
  addPresentationFrame(slide, template, 'content');
  const hasData = page.units.some(
    (unit) => unit.type === 'table' || unit.type === 'chart'
  );
  const title =
    page.continuationIndex > 1 && hasData
      ? `${page.heading}（续 ${page.continuationIndex}）`
      : page.heading;
  if (page.layout.kind === 'section') {
    renderPresentationSectionPage(slide, page, template);
  } else if (page.layout.kind === 'closing') {
    renderPresentationDecisionPage(slide, page, template);
  } else {
    slide.addText(title, {
      x: 0.76,
      y: 0.24,
      w: 10.8,
      h: 0.86,
      fontSize: contentTitleFontSize(title),
      bold: true,
      color: template.tokens.text,
      margin: 0,
      wrap: true
    });
    if (hasData) {
      renderDataPage(slide, page, template);
    } else {
      renderTextPage(slide, page, template);
    }
  }
  slide.addText(String(pageNumber), {
    x: 12.25,
    y: 7.04,
    w: 0.45,
    h: 0.2,
    fontSize: 10,
    color: template.tokens.muted,
    align: 'right',
    margin: 0
  });
}

function renderPresentationSectionPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const takeaway = page.units.find(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'takeaway'
  );
  const action = page.units.find(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'action'
  );
  const body = page.units.filter(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'body'
  );
  slide.addText('本节重点', {
    x: 0.78,
    y: 0.78,
    w: 1.2,
    h: 0.28,
    fontSize: 14,
    bold: true,
    color: template.tokens.secondaryAccent,
    margin: 0,
    wrap: false
  });
  slide.addText(page.heading, {
    x: 0.78,
    y: 1.16,
    w: 11.78,
    h: 0.86,
    fontSize: contentTitleFontSize(page.heading),
    bold: true,
    color: template.tokens.text,
    margin: 0,
    wrap: true
  });
  let top = 2.18;
  if (takeaway) {
    slide.addText(takeaway.text, {
      x: 0.78,
      y: top,
      w: 11.78,
      h: 0.72,
      fontSize: 20,
      bold: true,
      color: template.tokens.text,
      margin: 0,
      wrap: true
    });
    top += 0.9;
  }
  const bottom = action ? 5.92 : 6.55;
  if (action) drawAction(slide, action.text, template);
  drawContentUnits(slide, body, template, page.layout, 0.78, top, 11.78, bottom - top);
}

function renderPresentationDecisionPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const takeaway = page.units.find(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'takeaway'
  );
  const action = page.units.find(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'action'
  );
  const body = page.units.filter(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'body'
  );
  slide.addText('决策确认', {
    x: 0.78,
    y: 0.78,
    w: 1.2,
    h: 0.28,
    fontSize: 14,
    bold: true,
    color: template.tokens.secondaryAccent,
    margin: 0,
    wrap: false
  });
  slide.addText(page.heading, {
    x: 0.78,
    y: 1.16,
    w: 11.78,
    h: 0.86,
    fontSize: contentTitleFontSize(page.heading),
    bold: true,
    color: template.tokens.text,
    margin: 0,
    wrap: true
  });
  let top = 2.18;
  if (takeaway) {
    slide.addShape('rect', {
      x: 0.78,
      y: top,
      w: 11.78,
      h: 0.72,
      fill: { color: template.tokens.surface },
      line: { color: template.tokens.accent, width: 0.8 }
    });
    slide.addText(takeaway.text, {
      x: 1.02,
      y: top + 0.16,
      w: 11.3,
      h: 0.52,
      fontSize: 18,
      bold: true,
      color: template.tokens.text,
      margin: 0,
      wrap: true
    });
    top += 0.92;
  }
  const bottom = action ? 5.92 : 6.55;
  if (action) drawAction(slide, action.text, template);
  drawContentUnits(slide, body, template, page.layout, 0.78, top, 11.78, bottom - top);
}

function renderTextPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  if (page.composition === 'editorial') {
    renderEditorialTextPage(slide, page, template);
    return;
  }
  if (page.composition === 'split') {
    renderSplitTextPage(slide, page, template);
    return;
  }
  if (page.composition === 'timeline') {
    renderTimelineTextPage(slide, page, template);
    return;
  }
  renderCardTextPage(slide, page, template);
}

function renderCardTextPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const { takeaway, action, body } = presentationTextPageParts(page);
  const top = takeaway ? drawTakeaway(slide, takeaway.text, template) : 1.35;
  const bottom = action ? 5.92 : 6.55;
  if (body.length === 0 && action && !takeaway && !page.image) {
    drawFocusedAction(slide, action.text, template);
    return;
  }
  if (action) drawAction(slide, action.text, template);

  const bodyX = 0.78;
  let bodyWidth = 11.78;
  if (page.image) {
    bodyWidth = 7.25;
    slide.addImage({
      path: page.image.absolutePath,
      x: 8.55,
      y: top,
      w: 4.0,
      h: Math.max(2.8, bottom - top - 0.4),
      sizing: {
        type: 'contain',
        w: 4.0,
        h: Math.max(2.8, bottom - top - 0.4)
      }
    });
    if (page.image.caption) {
      slide.addText(page.image.caption, {
        x: 8.55,
        y: bottom - 0.25,
        w: 4.0,
        h: 0.28,
        fontSize: 11,
        color: template.tokens.muted,
        align: 'center',
        margin: 0
      });
    }
  }
  drawContentUnits(
    slide,
    body,
    template,
    page.layout,
    bodyX,
    top,
    bodyWidth,
    bottom - top
  );
}

function renderEditorialTextPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const { takeaway, action, body } = presentationTextPageParts(page);
  const bottom = action ? 5.92 : 6.55;
  if (body.length === 0 && action && !takeaway) {
    drawFocusedAction(slide, action.text, template);
    return;
  }
  if (action) drawAction(slide, action.text, template);
  let top = 1.32;
  if (takeaway) {
    slide.addShape('line', {
      x: 0.82,
      y: 1.38,
      w: 0,
      h: 1.02,
      line: { color: template.tokens.secondaryAccent, width: 4 }
    });
    slide.addText('核心判断', {
      x: 1.05,
      y: 1.28,
      w: 1.2,
      h: 0.28,
      fontSize: 12,
      bold: true,
      color: template.tokens.secondaryAccent,
      margin: 0,
      wrap: false
    });
    slide.addText(takeaway.text, {
      x: 1.05,
      y: 1.63,
      w: 10.95,
      h: 0.9,
      fontSize: 25,
      bold: true,
      color: template.tokens.text,
      margin: 0,
      wrap: true
    });
    top = 2.72;
  }
  drawContentUnits(
    slide,
    body,
    template,
    page.layout,
    0.82,
    top,
    11.65,
    bottom - top
  );
}

function renderSplitTextPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const { takeaway, action, body } = presentationTextPageParts(page);
  const bottom = action ? 5.92 : 6.55;
  if (body.length === 0 && action && !takeaway) {
    drawFocusedAction(slide, action.text, template);
    return;
  }
  if (action) drawAction(slide, action.text, template);
  slide.addShape('line', {
    x: 4.72,
    y: 1.42,
    w: 0,
    h: bottom - 1.42,
    line: { color: tintColor(template.tokens.accent, 0.48), width: 1.2 }
  });
  slide.addText('结论', {
    x: 0.84,
    y: 1.5,
    w: 0.8,
    h: 0.3,
    fontSize: 13,
    bold: true,
    color: template.tokens.secondaryAccent,
    margin: 0,
    wrap: false
  });
  slide.addText(takeaway?.text ?? page.heading, {
    x: 0.84,
    y: 1.94,
    w: 3.4,
    h: Math.max(2.0, bottom - 2.3),
    fontSize: 27,
    bold: true,
    color: template.tokens.text,
    margin: 0,
    valign: 'middle',
    wrap: true
  });
  drawContentUnits(
    slide,
    body,
    template,
    page.layout,
    5.18,
    1.42,
    7.2,
    bottom - 1.42
  );
}

function renderTimelineTextPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const { takeaway, action, body } = presentationTextPageParts(page);
  const top = takeaway ? drawTakeaway(slide, takeaway.text, template) : 1.38;
  const bottom = action ? 5.92 : 6.55;
  if (body.length === 0 && action && !takeaway) {
    drawFocusedAction(slide, action.text, template);
    return;
  }
  if (action) drawAction(slide, action.text, template);
  drawTimelineUnits(slide, body, template, page.layout, top, bottom - top);
}

function presentationTextPageParts(page: ExpandedPresentationPage): {
  readonly takeaway?: PresentationTextUnit;
  readonly action?: PresentationTextUnit;
  readonly body: readonly PresentationTextUnit[];
} {
  return {
    takeaway: page.units.find(
      (unit): unit is PresentationTextUnit =>
        unit.type === 'text' && unit.role === 'takeaway'
    ),
    action: page.units.find(
      (unit): unit is PresentationTextUnit =>
        unit.type === 'text' && unit.role === 'action'
    ),
    body: page.units.filter(
      (unit): unit is PresentationTextUnit =>
        unit.type === 'text' && unit.role === 'body'
    )
  };
}

function renderDataPage(
  slide: PptxGenJS.Slide,
  page: ExpandedPresentationPage,
  template: PresentationTemplate
): void {
  const takeaway = page.units.find(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'takeaway'
  );
  const action = page.units.find(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'action'
  );
  const body = page.units.filter(
    (unit): unit is PresentationTextUnit =>
      unit.type === 'text' && unit.role === 'body'
  );
  const data = page.units.find(
    (unit): unit is PresentationTableUnit | PresentationChartUnit =>
      unit.type === 'table' || unit.type === 'chart'
  );
  let top = takeaway ? drawTakeaway(slide, takeaway.text, template) : 1.35;
  const bottom = action ? 5.92 : 6.6;
  if (action) drawAction(slide, action.text, template);
  if (body.length > 0) {
    const summaryHeight = Math.min(1.7, Math.max(0.85, body.length * 0.8));
    drawContentUnits(
      slide,
      body,
      template,
      page.layout,
      0.78,
      top,
      11.78,
      summaryHeight
    );
    top += summaryHeight + 0.15;
  }
  if (!data) return;

  if (data.type === 'table') {
    const rows = [
      data.block.header.map((cell) => ({
        text: cell,
        options: {
          bold: true,
          color: contrastingText(template.tokens.accent),
          fill: { color: template.tokens.accent }
        }
      })),
      ...data.block.rows.map((row) =>
        row.map((cell) => ({
          text: cell,
          options: {
            color: template.tokens.text,
            fill: { color: template.tokens.surface }
          }
        }))
      )
    ];
    slide.addTable(rows, {
      x: 0.78,
      y: top,
      w: 11.78,
      h: Math.max(2.4, bottom - top),
      fontSize: page.layout.minBodyFontSize,
      color: template.tokens.text,
      border: { pt: 0.6, color: tintColor(template.tokens.accent, 0.62) },
      margin: 0.08,
      valign: 'middle'
    });
    return;
  }

  slide.addChart(
    pptxChartType(data.block.chartKind),
    [
      {
        name: data.block.title ?? '数据',
        labels: data.block.data.map((item) => item.label),
        values: data.block.data.map((item) => item.value)
      }
    ],
    {
      x: 0.78,
      y: top,
      w: 11.78,
      h: Math.max(2.8, bottom - top),
      showTitle: Boolean(data.block.title),
      title: data.block.title ?? '',
      titleColor: template.tokens.text,
      showLegend: true,
      legendColor: template.tokens.text,
      showValue: true,
      catAxisLabelColor: template.tokens.muted,
      valAxisLabelColor: template.tokens.muted,
      chartColors: chartPalette(template)
    }
  );
}

function drawTakeaway(
  slide: PptxGenJS.Slide,
  text: string,
  template: PresentationTemplate
): number {
  slide.addShape('rect', {
    x: 0.78,
    y: 1.15,
    w: 11.78,
    h: 1.08,
    fill: { color: template.tokens.surface },
    line: { color: template.tokens.accent, width: 1.2 }
  });
  slide.addShape('rect', {
    x: 0.78,
    y: 1.15,
    w: 0.12,
    h: 1.08,
    fill: { color: template.tokens.accent },
    line: { color: template.tokens.accent }
  });
  slide.addText('核心结论', {
    x: 1.04,
    y: 1.48,
    w: 1.05,
    h: 0.3,
    fontSize: 13,
    bold: true,
    color: template.tokens.accent,
    margin: 0,
    wrap: true
  });
  slide.addText(text, {
    x: 2.12,
    y: 1.28,
    w: 10.05,
    h: 0.72,
    fontSize: 18,
    bold: true,
    color: template.tokens.text,
    margin: 0.02,
    valign: 'middle',
    wrap: true
  });
  return 2.45;
}

function drawAction(
  slide: PptxGenJS.Slide,
  text: string,
  template: PresentationTemplate
): void {
  slide.addShape('rect', {
    x: 0.78,
    y: 6.04,
    w: 11.78,
    h: 0.86,
    fill: { color: template.tokens.accent },
    line: { color: template.tokens.accent }
  });
  slide.addText(`下一步：${text}`, {
    x: 1.02,
    y: 6.13,
    w: 11.25,
    h: 0.64,
    fontSize: 14,
    bold: true,
    color: contrastingText(template.tokens.accent),
    margin: 0,
    wrap: true
  });
}

function drawFocusedAction(
  slide: PptxGenJS.Slide,
  text: string,
  template: PresentationTemplate
): void {
  slide.addText('下一步', {
    x: 1.15,
    y: 2.0,
    w: 11.03,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: template.tokens.secondaryAccent,
    align: 'center',
    margin: 0,
    wrap: true
  });
  slide.addText(text, {
    x: 1.15,
    y: 2.45,
    w: 11.03,
    h: 2.4,
    fontSize:
      text.length > 180 ? 22 : text.length > 120 ? 25 : text.length > 90 ? 28 : 34,
    bold: true,
    color: template.tokens.text,
    align: 'center',
    valign: 'middle',
    margin: 0,
    wrap: true,
    fit: 'shrink'
  });
}

function drawTimelineUnits(
  slide: PptxGenJS.Slide,
  units: readonly PresentationTextUnit[],
  template: PresentationTemplate,
  layout: PresentationLayout,
  y: number,
  height: number
): void {
  if (units.length === 0) return;
  const x = 0.84;
  const width = 11.58;
  const gap = 0.16;
  const itemWidth = (width - gap * (units.length - 1)) / units.length;
  const markerSize = 0.42;
  const markerY = y + 0.18;
  if (units.length > 1) {
    slide.addShape('line', {
      x: x + itemWidth / 2,
      y: markerY + markerSize / 2,
      w: width - itemWidth,
      h: 0,
      line: { color: tintColor(template.tokens.accent, 0.42), width: 1.4 }
    });
  }
  units.forEach((unit, index) => {
    const itemX = x + index * (itemWidth + gap);
    const markerX = itemX + itemWidth / 2 - markerSize / 2;
    slide.addShape('ellipse', {
      x: markerX,
      y: markerY,
      w: markerSize,
      h: markerSize,
      fill: { color: template.tokens.accent },
      line: { color: template.tokens.accent }
    });
    slide.addText(String(index + 1), {
      x: markerX,
      y: markerY + 0.05,
      w: markerSize,
      h: 0.22,
      fontSize: 10,
      bold: true,
      color: contrastingText(template.tokens.accent),
      align: 'center',
      margin: 0
    });
    const [label, explanation] = splitContentGroup(unit.text);
    if (label) {
      slide.addText(label, {
        x: itemX + 0.05,
        y: markerY + 0.58,
        w: itemWidth - 0.1,
        h: 0.45,
        fontSize: 18,
        bold: true,
        color: template.tokens.text,
        align: 'center',
        margin: 0,
        wrap: true
      });
    }
    slide.addText(explanation, {
      x: itemX + 0.08,
      y: markerY + (label ? 1.12 : 0.64),
      w: itemWidth - 0.16,
      h: Math.max(0.72, height - (label ? 1.38 : 0.9)),
      fontSize: layout.minBodyFontSize,
      color: template.tokens.text,
      italic: unit.quote,
      align: 'center',
      valign: 'top',
      margin: 0,
      fit: 'none'
    });
  });
}

function drawContentUnits(
  slide: PptxGenJS.Slide,
  units: readonly PresentationTextUnit[],
  template: PresentationTemplate,
  layout: PresentationLayout,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  if (units.length === 0) return;
  const columns =
    width > 9 && (layout.kind === 'comparison' || units.length >= 4) ? 2 : 1;
  const rows = Math.ceil(units.length / columns);
  const columnGap = columns === 2 ? 0.55 : 0;
  const rowGap = 0.18;
  const itemWidth = (width - columnGap * (columns - 1)) / columns;
  const itemHeight = (height - rowGap * (rows - 1)) / rows;

  units.forEach((unit, index) => {
    const column = columns === 1 ? 0 : index % columns;
    const row = columns === 1 ? index : Math.floor(index / columns);
    const itemX = x + column * (itemWidth + columnGap);
    const itemY = y + row * (itemHeight + rowGap);
    drawContentUnit(
      slide,
      unit,
      template,
      layout,
      itemX,
      itemY,
      itemWidth,
      itemHeight,
      index
    );
  });
}

function drawContentUnit(
  slide: PptxGenJS.Slide,
  unit: PresentationTextUnit,
  template: PresentationTemplate,
  layout: PresentationLayout,
  x: number,
  y: number,
  width: number,
  height: number,
  index: number
): void {
  slide.addShape('line', {
    x,
    y,
    w: 0,
    h: Math.max(0.45, height - 0.08),
    line: { color: template.tokens.accent, width: 2.2 }
  });
  slide.addText(String(index + 1).padStart(2, '0'), {
    x: x + 0.18,
    y: y + 0.02,
    w: 0.42,
    h: 0.28,
    fontSize: 12,
    bold: true,
    color: template.tokens.secondaryAccent,
    margin: 0
  });
  const [label, explanation] = splitContentGroup(unit.text);
  if (label) {
    slide.addText(label, {
      x: x + 0.68,
      y,
      w: width - 0.78,
      h: 0.34,
      fontSize: 19,
      bold: true,
      color: template.tokens.text,
      margin: 0,
      wrap: false
    });
  }
  slide.addText(explanation, {
    x: x + 0.68,
    y: y + (label ? 0.4 : 0.02),
    w: width - 0.78,
    h: Math.max(0.38, height - (label ? 0.48 : 0.1)),
    fontSize: layout.minBodyFontSize,
    color: template.tokens.text,
    italic: unit.quote,
    margin: 0,
    valign: 'top',
    fit: 'none'
  });
}

function splitContentGroup(text: string): readonly [string | undefined, string] {
  const separatorIndex = text.search(/[：:]/);
  if (separatorIndex <= 0 || separatorIndex > 24) return [undefined, text];
  return [
    text.slice(0, separatorIndex).trim(),
    text.slice(separatorIndex + 1).trim()
  ];
}

function renderPresentationClosing(
  pptx: PptxGenJS,
  outline: DocumentOutline,
  template: PresentationTemplate
): void {
  const slide = pptx.addSlide();
  addPresentationFrame(slide, template, 'closing');
  const finalTakeaway = [...outline.sections]
    .reverse()
    .find((section) => section.takeaway)?.takeaway;
  slide.addText('谢谢观看', {
    x: 0.9,
    y: 1.45,
    w: 11.53,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: template.tokens.secondaryAccent,
    align: 'center',
    margin: 0,
    wrap: true
  });
  slide.addText(finalTakeaway ?? outline.title, {
    x: 1.15,
    y: 2.35,
    w: 11.03,
    h: 1.55,
    fontSize: 36,
    bold: true,
    color: template.tokens.text,
    align: 'center',
    valign: 'middle',
    margin: 0
  });
  slide.addText(outline.title, {
    x: 1.15,
    y: 4.45,
    w: 11.03,
    h: 0.45,
    fontSize: 18,
    color: template.tokens.muted,
    align: 'center',
    margin: 0,
    wrap: true
  });
}

function addPresentationFrame(
  slide: PptxGenJS.Slide,
  template: PresentationTemplate,
  variant: 'cover' | 'content' | 'closing'
): void {
  slide.background = { color: template.tokens.background };
  const topHeight = variant === 'content' ? 0.12 : 0.2;
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: 13.33,
    h: topHeight,
    fill: { color: template.tokens.accent },
    line: { color: template.tokens.accent }
  });

  switch (template.frameStyle) {
    case 'work_report':
      slide.addShape('roundRect', {
        x: 0.78,
        y: variant === 'content' ? 1.03 : 6.95,
        w: 2.15,
        h: 0.12,
        rectRadius: 0.05,
        fill: { color: template.tokens.secondaryAccent },
        line: { color: template.tokens.secondaryAccent }
      });
      return;
    case 'natural_minimal':
      slide.addShape('ellipse', {
        x: 10.65,
        y: variant === 'content' ? 1.08 : 0.72,
        w: 2.05,
        h: 2.05,
        fill: { color: template.tokens.surface },
        line: { color: template.tokens.accent, width: 0.65 }
      });
      slide.addShape('ellipse', {
        x: 11.55,
        y: variant === 'content' ? 1.92 : 1.55,
        w: 0.95,
        h: 0.95,
        fill: { color: template.tokens.background },
        line: { color: template.tokens.secondaryAccent, width: 0.85 }
      });
      return;
    case 'business_minimal':
      slide.addShape('rtTriangle', {
        x: 11.76,
        y: topHeight,
        w: 1.57,
        h: 1.57,
        fill: { color: template.tokens.secondaryAccent },
        line: { color: template.tokens.secondaryAccent }
      });
      slide.addShape('rect', {
        x: 12.93,
        y: 0,
        w: 0.4,
        h: 7.5,
        fill: { color: template.tokens.text },
        line: { color: template.tokens.text }
      });
      return;
    case 'technology':
      for (let x = 0.8; x < 13.3; x += 1.25) {
        slide.addShape('line', {
          x,
          y: 0,
          w: 0,
          h: 7.5,
          line: { color: template.tokens.surface, width: 0.4 }
        });
      }
      for (let y = 0.75; y < 7.5; y += 0.75) {
        slide.addShape('line', {
          x: 0,
          y,
          w: 13.33,
          h: 0,
          line: { color: template.tokens.surface, width: 0.4 }
        });
      }
      return;
    case 'financing':
      slide.addShape('rect', {
        x: 0,
        y: 0,
        w: 0.16,
        h: 7.5,
        fill: { color: template.tokens.secondaryAccent },
        line: { color: template.tokens.secondaryAccent }
      });
      return;
  }
}

function coverTitleFontSize(title: string): number {
  if (title.length <= 18) return 50;
  if (title.length <= 28) return 42;
  return 36;
}

function contentTitleFontSize(title: string): number {
  if (title.length <= 22) return 32;
  if (title.length <= 34) return 29;
  return 26;
}

function pptxChartType(kind: PresentationChartBlock['chartKind']) {
  const pptx = new PptxGenJS();
  return pptx.ChartType[kind === 'bar' ? 'bar' : 'pie'];
}

function chartPalette(template: PresentationTemplate): string[] {
  return [
    template.tokens.accent,
    template.tokens.secondaryAccent,
    tintColor(template.tokens.accent, 0.46),
    tintColor(template.tokens.secondaryAccent, 0.38)
  ];
}

function contrastingText(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r * 299 + g * 587 + b * 114 > 155_000 ? '17202C' : 'FFFFFF';
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
