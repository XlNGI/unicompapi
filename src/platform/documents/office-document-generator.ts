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
import type {
  DocumentOutline,
  DocumentOutlineBlock
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
      ? await buildWordBuffer(input.outline)
      : input.kind === 'excel'
        ? await buildExcelBuffer(input.outline)
        : await buildPptBuffer(input.outline);
  await writeFile(absolutePath, buffer);
  const fileStat = await stat(absolutePath);
  return { fileName, absolutePath, sizeBytes: fileStat.size };
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

async function buildWordBuffer(outline: DocumentOutline): Promise<Buffer> {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'document-numbering',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START
            }
          ]
        }
      ]
    },
    sections: [
      {
        children: [
          new Paragraph({
            text: outline.title,
            heading: HeadingLevel.TITLE
          }),
          ...outline.sections.flatMap((section) => [
            new Paragraph({
              text: section.heading,
              heading: headingLevel(section.level)
            }),
            ...section.blocks.map((block) => wordBlock(block))
          ])
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

function wordBlock(block: DocumentOutlineBlock): Paragraph | Table {
  switch (block.type) {
    case 'paragraph':
      return new Paragraph({ children: [new TextRun(block.text)] });
    case 'quote':
      return new Paragraph({
        children: [new TextRun({ text: block.text, italics: true })],
        indent: { left: 720 },
        border: {
          left: {
            style: BorderStyle.SINGLE,
            size: 12,
            color: '999999'
          }
        }
      });
    case 'bullets':
      return new Paragraph({
        children: block.items.map((item) => new TextRun(item)),
        bullet: { level: 0 }
      });
    case 'numbered':
      return new Paragraph({
        children: block.items.map((item) => new TextRun(item)),
        numbering: { reference: 'document-numbering', level: 0 }
      });
    case 'table': {
      const columnCount = Math.max(
        block.header.length,
        ...block.rows.map((row) => row.length)
      );
      const cells = (row: readonly string[]) =>
        Array.from({ length: columnCount }, (_, index) =>
          new TableCell({
            children: [new Paragraph(row[index] ?? '')]
          })
        );
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: Array.from({ length: columnCount }, () => 1),
        rows: [
          new TableRow({ children: cells(block.header) }),
          ...block.rows.map((row) => new TableRow({ children: cells(row) }))
        ]
      });
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

async function buildPptBuffer(outline: DocumentOutline): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = outline.title;
  const titleSlide = pptx.addSlide();
  titleSlide.addText(outline.title, {
    x: 0.6,
    y: 2.0,
    w: 12.3,
    h: 1.2,
    fontSize: 32,
    bold: true,
    align: 'center'
  });
  if (outline.sections.length > 0) {
    titleSlide.addText(outline.sections[0].heading, {
      x: 0.6,
      y: 3.3,
      w: 12.3,
      h: 0.8,
      fontSize: 18,
      align: 'center',
      color: '666666'
    });
  }
  outline.sections.forEach((section) => {
    const slide = pptx.addSlide();
    slide.addText(section.heading, {
      x: 0.5,
      y: 0.35,
      w: 12.5,
      h: 0.8,
      fontSize: 26,
      bold: true
    });
    let y = 1.35;
    const textLines: string[] = [];
    for (const block of section.blocks) {
      if (block.type === 'table') {
        if (textLines.length > 0) {
          slide.addText(pptTextLines(textLines), {
            x: 0.6,
            y,
            w: 12.3,
            h: Math.max(0.6, textLines.length * 0.45),
            fontSize: 16
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
          w: 12.3,
          fontSize: 13,
          border: { pt: 0.5, color: 'CCCCCC' }
        });
        y += rows.length * 0.4 + 0.4;
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
      slide.addText(pptTextLines(textLines), {
        x: 0.6,
        y,
        w: 12.3,
        h: Math.max(0.6, textLines.length * 0.45),
        fontSize: 16
      });
    }
  });
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

function pptTextLines(
  lines: readonly string[]
): { readonly text: string; readonly options: Record<string, unknown> }[] {
  return lines.map((line) => ({
    text: line,
    options: { bullet: { code: '2022' }, paraSpaceAfter: 6 }
  }));
}
