import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileReference,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  FileExtractionService,
  JsonFileReferenceRepository,
  NodeProjectStorage,
  generateDocumentFile,
  parseDocumentOutline,
  toProjectRelativePath
} from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-extract-'));
  temporaryRoots.push(root);
  const projectId = toProjectId('extract-project');
  await mkdir(path.join(root, 'files', 'attachments'), { recursive: true });
  return { root, projectId };
}

async function registerFile(
  root: string,
  projectId: ReturnType<typeof toProjectId>,
  fileName: string,
  content: Buffer | string
) {
  await writeFile(path.join(root, 'files', 'attachments', fileName), content);
  const storage = new NodeProjectStorage(root);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const file = createFileReference({
    id: toFileReferenceId(`fixture-${fileName}`),
    projectId,
    locator: {
      kind: 'project',
      relativePath: toProjectRelativePath(`files/attachments/${fileName}`)
    },
    createdAt: toIsoTimestamp('2026-08-22T00:00:00.000Z')
  });
  await files.save(file);
  return file.id;
}

function createMinimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
  ];
  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];
  let offset = Buffer.byteLength(header, 'latin1');
  objects.forEach((object, index) => {
    offsets.push(offset);
    const part = `${index + 1} 0 obj\n${object}\nendobj\n`;
    body += part;
    offset += Buffer.byteLength(part, 'latin1');
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, 'latin1');
}

async function generatedOutline(kind: 'word' | 'excel' | 'ppt') {
  return parseDocumentOutline(
    JSON.stringify({
      kind,
      title: '季度销售复盘',
      sections: [
        {
          heading: '业绩概览',
          level: 1,
          blocks: [
            { type: 'bullets', items: ['营收 1200 万'] },
            { type: 'table', header: ['目标', '团队'], rows: [['3000 万', '华东']] }
          ]
        }
      ]
    })
  );
}

describe('file extraction service', () => {
  it('extracts plain text files', async () => {
    const { root, projectId } = await createProject();
    const fileId = await registerFile(root, projectId, 'notes.txt', '第一行\n第二行');
    const service = new FileExtractionService({ rootDirectory: root, projectId });
    const result = await service.extract(fileId);
    expect(result.status).toBe('extracted');
    expect(result.format).toBe('txt');
    expect(result.preview).toContain('第一行');
    expect(result.stats.characters).toBeGreaterThan(0);
    expect(result.stats.paragraphs).toBe(2);
  });

  it('extracts CSV as a table', async () => {
    const { root, projectId } = await createProject();
    const fileId = await registerFile(root, projectId, 'data.csv', '名称,数量\n苹果,3\n香蕉,5');
    const service = new FileExtractionService({ rootDirectory: root, projectId });
    const result = await service.extract(fileId);
    expect(result.status).toBe('extracted');
    expect(result.stats.tables).toBe(1);
    expect(result.preview).toContain('苹果');
  });

  it('extracts generated Word, Excel and PowerPoint files', async () => {
    const { root, projectId } = await createProject();
    const service = new FileExtractionService({ rootDirectory: root, projectId });
    for (const kind of ['word', 'excel', 'ppt'] as const) {
      const outline = await generatedOutline(kind);
      const generated = await generateDocumentFile({
        kind,
        outline,
        outputDirectory: path.join(root, 'files', 'attachments'),
        now: '2026-08-22T10:00:00.000Z'
      });
      const fileId = await registerFile(
        root,
        projectId,
        path.basename(generated.absolutePath),
        await readFile(generated.absolutePath)
      );
      const result = await service.extract(fileId);
      expect(result.status).toBe('extracted');
      if (kind === 'excel') {
        expect(result.preview).toContain('目标');
      } else {
        expect(result.preview).toContain('业绩概览');
      }
    }
  });

  it('extracts text from a real PDF', async () => {
    const { root, projectId } = await createProject();
    const fileId = await registerFile(root, projectId, 'report.pdf', createMinimalPdf('Hello PDF'));
    const service = new FileExtractionService({ rootDirectory: root, projectId });
    const result = await service.extract(fileId);
    expect(result.status).toBe('extracted');
    expect(result.preview).toContain('Hello PDF');
    expect(result.stats.pages).toBe(1);
  });

  it('rejects files whose extension does not match their content', async () => {
    const { root, projectId } = await createProject();
    const fileId = await registerFile(root, projectId, 'fake.docx', 'not a zip file');
    const service = new FileExtractionService({ rootDirectory: root, projectId });
    const result = await service.extract(fileId);
    expect(result.status).toBe('unsupported');
  });

  it('returns too_large for oversized files', async () => {
    const { root, projectId } = await createProject();
    const fileId = await registerFile(root, projectId, 'big.txt', 'x'.repeat(1024));
    const service = new FileExtractionService({
      rootDirectory: root,
      projectId,
      limits: { maxFileBytes: 100 }
    });
    const result = await service.extract(fileId);
    expect(result.status).toBe('too_large');
  });

  it('rejects zip packages with too many entries', async () => {
    const { root, projectId } = await createProject();
    const zip = new JSZip();
    for (let index = 0; index < 501; index += 1) {
      zip.file(`slide${index}.xml`, '<p/>');
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const fileId = await registerFile(root, projectId, 'bomb.pptx', Buffer.from(buffer));
    const service = new FileExtractionService({ rootDirectory: root, projectId });
    const result = await service.extract(fileId);
    expect(result.status).toBe('too_large');
  });
});
