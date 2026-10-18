import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { afterEach, describe, expect, it, vi } from 'vitest';


import { mappedPresentationTarget } from '../../src/application/presentation-revision-map';
import { toProjectId, type DocumentOutline } from '../../src/domain';
import { NodeProjectStorage } from '../../src/platform/storage';

import { JsonWorkRepository, JsonExecutionRepository, JsonTaskRepository } from '../../src/platform/repositories/json-repositories';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { readPptxDocument, readPptxPage } from '../../src/platform/documents/pptx-page-reader';
import { RegisteredPresentationReader, buildPresentationRevisionMap } from '../../src/platform/documents/registered-presentation-reader';








const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const now = () => '2026-09-09T12:00:00.000Z';
const baseOutline: DocumentOutline = { kind: 'ppt', title: '十三页章节验收', sections: Array.from({ length: 8 }, (_, index) => ({
  heading: `第${index + 1}章标题`, level: 1, blocks: [{ type: 'paragraph', text: `第${index + 1}章正文` }]
})) };

async function fixture(reorder = false) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-revision-map-')); roots.push(rootDirectory);
  const projectId = toProjectId('project-revision-map');
  const storage = new NodeProjectStorage(rootDirectory);
  const presentation = new PptxGenJS();
  const sections = [-1, 0, 1, 1, 2, 2, 3, 4, 5, 6, 6, 7, -2];
  sections.forEach((section, index) => {
    const slide = presentation.addSlide();
    const heading = section === -1 ? baseOutline.title : section === -2 ? '谢谢' : baseOutline.sections[section].heading;
    slide.addText(index === 10 ? `${heading}（续2）` : heading, { x: 1, y: 0.4, w: 8, h: 0.5 });
    if (section >= 0) slide.addText(`实际第${index + 1}页独有正文`, { x: 1, y: 2, w: 8, h: 1 });
    if (index === 10) slide.addText('11', { x: 1, y: 4, w: 1, h: 0.5 });
  });
  let bytes = await presentation.write({ outputType: 'nodebuffer' }) as Buffer;
  if (reorder) {
    const zip = await JSZip.loadAsync(bytes);
    const name = 'ppt/_rels/presentation.xml.rels';
    const xml = await zip.file(name)!.async('string');
    zip.file(name, xml.replace('slides/slide7.xml', 'slides/swap.xml').replace('slides/slide8.xml', 'slides/slide7.xml').replace('slides/swap.xml', 'slides/slide8.xml'));
    bytes = await zip.generateAsync({ type: 'nodebuffer' });
  }
  const generator = vi.fn(async (input: Parameters<typeof generateTemporaryDocumentFile>[0]) => {
    const result = await generateTemporaryDocumentFile(input);
    if (!input.revisionSourceBuffer) {
      await writeFile(result.temporaryPath, bytes);
      return { ...result, sizeBytes: bytes.length };
    }
    return result;
  });
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId, now, generateTemporaryFile: generator });
  const base = await runner.run({ kind: 'ppt', title: baseOutline.title, outline: baseOutline,
    contentFingerprint: hash(bytes), draftRevision: 1, sourceDraftId: 'base-presentation' });
  const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
  return { rootDirectory, projectId, storage, runner, base, reader, generator, bytes };
}

async function clear(f: Awaited<ReturnType<typeof fixture>>, unit: 'page' | 'section', ordinal: number, work = f.base.work, outline = baseOutline) {
  const source = await f.reader.read(work.id, outline);
  const target = mappedPresentationTarget(source.map!, { unit, ordinal });
  const next = { ...outline, sections: outline.sections.map((section, index) => index === target.sectionIndex ? { ...section, blocks: [] } : section) };
  return f.runner.run({ kind: 'ppt', title: next.title, outline: next,
    contentFingerprint: hash(`${work.id}:${unit}:${ordinal}`), draftRevision: 1, sourceDraftId: `${work.id}-${unit}-${ordinal}`,
    parentWorkId: work.id, sourceChecksumSha256: source.map!.checksumSha256,
    revisionPatch: { operation: 'clear_section', target } });
}

async function assertOnlySlidesChanged(before: Uint8Array, after: Uint8Array, allowed: readonly string[]) {
  const a = await JSZip.loadAsync(before); const b = await JSZip.loadAsync(after);
  expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
  for (const name of Object.keys(a.files)) {
    if (a.files[name].dir) continue;
    const same = (await a.file(name)!.async('nodebuffer')).equals(await b.file(name)!.async('nodebuffer'));
    expect(same, name).toBe(!allowed.includes(name));
  }
}

describe('registered PPT revision and save recovery', () => {

  it('clears numeric body content equal to the page number instead of mistaking it for a footer', async () => {
    const f = await fixture(); const result = await clear(f, 'page', 11);
    const child = await f.reader.read(result.work.id);
    expect(child.pages[10].contentText.trim()).toBe('第7章标题（续2）');
    expect(result.validatedOutline?.sections[6].blocks).toEqual([{ type: 'paragraph', text: '实际第10页独有正文' }]);
  });

  it('maps chapter seven to slides ten and eleven and changes only those XML parts', async () => {
    const f = await fixture(); const source = await f.reader.read(f.base.work.id, baseOutline);
    expect(source.map?.totalPages).toBe(13);
    expect(mappedPresentationTarget(source.map!, { unit: 'section', ordinal: 7 }).pages).toEqual([10, 11]);
    expect((await readPptxPage(source.buffer, 7)).text).toContain('第4章标题');
    const result = await clear(f, 'section', 7);
    const child = await f.reader.read(result.work.id, result.validatedOutline);
    expect(child.pages[9].contentText.trim()).toBe('第7章标题');
    expect(child.pages[10].contentText.trim()).toBe('第7章标题（续2）');
    expect(result.validatedOutline?.sections[6].blocks).toEqual([]);
    expect(result.work.parentWorkId).toBe(f.base.work.id);
    await assertOnlySlidesChanged(source.buffer, child.buffer, ['ppt/slides/slide10.xml', 'ppt/slides/slide11.xml']);
    expect(hash((await f.reader.read(f.base.work.id)).buffer)).toBe(hash(source.buffer));
  });

  it('changes the actual seventh page after reordering without changing slide7.xml', async () => {
    const f = await fixture(true); const source = await f.reader.read(f.base.work.id, baseOutline);
    expect(source.pages[6]).toMatchObject({ partName: 'ppt/slides/slide8.xml', heading: '第5章标题' });
    const result = await clear(f, 'page', 7); const child = await f.reader.read(result.work.id);
    await assertOnlySlidesChanged(source.buffer, child.buffer, ['ppt/slides/slide8.xml']);
  });

  it('retains the unedited continuation and numeric body text in the next revision metadata', async () => {
    const f = await fixture(); const first = await clear(f, 'page', 10);
    expect(first.validatedOutline?.sections[6].blocks).toEqual([
      { type: 'paragraph', text: '实际第11页独有正文' }, { type: 'paragraph', text: '11' }
    ]);
    const second = await clear(f, 'section', 7, first.work, first.validatedOutline!);
    expect(second.validatedOutline?.sections[6].blocks).toEqual([]);
    expect(second.work.parentWorkId).toBe(first.work.id);
  });

  it('rejects ambiguous chapter headings and noncontiguous chapter pages', async () => {
    const f = await fixture(); const pages = await readPptxDocument(f.bytes);
    expect(() => buildPresentationRevisionMap(pages, { ...baseOutline, sections: [baseOutline.sections[0], baseOutline.sections[0]] }, hash(f.bytes))).toThrow();
    const changed = pages.map((page) => page.pageNumber === 8 ? { ...page, heading: baseOutline.sections[0].heading } : page);
    expect(() => buildPresentationRevisionMap(changed, baseOutline, hash(f.bytes))).toThrow();
  });

  it('refuses a changed registered file before generating a child Work', async () => {
    const f = await fixture();
    const filePath = path.join(f.rootDirectory, f.base.file.locator.kind === 'project' ? f.base.file.locator.relativePath : '');
    await writeFile(filePath, Buffer.concat([f.bytes, Buffer.from('changed')]));
    await expect(clear(f, 'section', 7)).rejects.toMatchObject({ code: 'revision_scope_violation' });
    expect(f.generator).toHaveBeenCalledTimes(1);
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });

  it.each(['write', 'registration'] as const)('records a recoverable %s failure and preserves the original Work', async (stage) => {
    const f = await fixture();
    const input = { kind: 'ppt' as const, title: baseOutline.title, outline: baseOutline, contentFingerprint: hash(stage), draftRevision: 1, sourceDraftId: `failure-${stage}` };
    const options = { rootDirectory: f.rootDirectory, projectId: f.projectId, now,
      ...(stage === 'write' ? { publishFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } : {}) };
    const saved = JsonWorkRepository.prototype.save;
    if (stage === 'registration') vi.spyOn(JsonWorkRepository.prototype, 'save').mockImplementationOnce(async () => { throw new Error('registration failure'); });
    await expect(new DocumentGenerationRunner(options).run(input)).rejects.toMatchObject({ code: stage === 'write' ? 'write_failed' : 'registration_failed' });
    vi.restoreAllMocks();
    expect(JsonWorkRepository.prototype.save).toBe(saved);
    const tasks = await new JsonTaskRepository(f.storage, f.projectId).list(f.projectId);
    const task = tasks.find((item) => item.sourceDraftId === input.sourceDraftId)!;
    expect((await new JsonExecutionRepository(f.storage).list(task.id))[0].failure?.retryability).toBe('retryable');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
    expect((await new DocumentGenerationRunner({ rootDirectory: f.rootDirectory, projectId: f.projectId, now }).run(input)).execution.state).toBe('completed');
  });
});
