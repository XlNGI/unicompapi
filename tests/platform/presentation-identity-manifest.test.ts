import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import {
  applyPresentationTextPatch,
  buildPresentationIdentityManifest,
  carryForwardPresentationIdentityManifest,
  readIdentityElementText,
  readIdentityElementTexts,
  parsePresentationIdentityManifest,
  verifyPresentationIdentityManifest,
  applyPresentationMutationPatch,
  carryForwardPresentationIdentityManifestForPatch
} from '../../src/platform/documents/presentation-identity-manifest';
import { addSlidePatch, addTextPatch, deleteElementPatch, updateTextPatch } from '../../src/domain/entities/document-ir-patch';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('presentation identity manifest', () => {
  it('round-trips one of two duplicate text elements without selecting the other', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-identity-spike-'));
    roots.push(root);
    const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '身份回环', sections: [{ heading: '重复文本页', level: 1,
      blocks: [{ type: 'paragraph', text: '重复文本' }, { type: 'paragraph', text: '重复文本' }] }] }));
    const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root,
      now: '2026-09-28T12:00:00.000Z', presentationTemplate: 'business_minimal' });
    const original = await readFile(generated.temporaryPath);
    const manifest = await buildPresentationIdentityManifest({ buffer: original, documentLineageId: 'lineage-spike', workId: 'work-spike-1', fileId: 'file-spike-1', sourceExecutionId: 'execution-spike-1', revision: 1 });
    const duplicate = manifest.elements.filter(element => element.text === '重复文本');
    expect(duplicate.length).toBeGreaterThanOrEqual(2);
    const target = duplicate[1];
    const untouched = duplicate[0];
    expect(await readIdentityElementText(original, manifest, target.elementId)).toBe('重复文本');
    const candidate = await applyPresentationTextPatch({ buffer: original, manifest,
      patch: updateTextPatch(target.elementId, '只改第二个') });
    const next = await carryForwardPresentationIdentityManifest({ previous: manifest, buffer: candidate,
      revision: 2, targetElementId: target.elementId, targetText: '只改第二个' });
    expect(await readIdentityElementText(candidate, next, target.elementId)).toBe('只改第二个');
    expect(await readIdentityElementText(candidate, next, untouched.elementId)).toBe('重复文本');
    expect(next.elements.find(element => element.elementId === target.elementId)?.elementId).toBe(target.elementId);
    expect(next.elements.find(element => element.elementId === untouched.elementId)?.elementId).toBe(untouched.elementId);
  });

  it('fails closed when a pinned artifact or locator does not match', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-identity-pin-'));
    roots.push(root);
    const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '身份校验', sections: [{ heading: '目标', level: 1,
      blocks: [{ type: 'paragraph', text: '原文' }] }] }));
    const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root, now: '2026-09-28T12:00:00.000Z' });
    const original = await readFile(generated.temporaryPath);
    const manifest = await buildPresentationIdentityManifest({ buffer: original, documentLineageId: 'lineage-pin', workId: 'work-pin-1', fileId: 'file-pin-1', sourceExecutionId: 'execution-pin-1', revision: 1 });
    const target = manifest.elements.find(element => element.text === '原文')!;
    await expect(readIdentityElementText(Buffer.from('not a pptx'), manifest, target.elementId)).rejects.toMatchObject({ code: 'identity_pin_mismatch' });
  });

  it('preserves exact whitespace, unchanged identities and page fingerprints across two updates', async () => {
    const { buffer, manifest, target } = await identityFixture();
    const texts = await readIdentityElementTexts(buffer, manifest);
    const updated = await applyPresentationTextPatch({ buffer, manifest, patch: updateTextPatch(target.elementId, '  A  B\n尾部  ') });
    const second = await carryForwardPresentationIdentityManifest({ previous: manifest, buffer: updated, revision: 2,
      targetElementId: target.elementId, targetText: '  A  B\n尾部  ' });
    expect(await readIdentityElementText(updated, second, target.elementId)).toBe('  A  B\n尾部  ');
    expect(second.pages.find(page => page.pageId === target.pageId)!.fingerprint).not.toBe(manifest.pages.find(page => page.pageId === target.pageId)!.fingerprint);
    expect(second.elements.map(element => element.elementId)).toEqual(manifest.elements.map(element => element.elementId));
    const again = await applyPresentationTextPatch({ buffer: updated, manifest: second, patch: updateTextPatch(target.elementId, '再次修改') });
    const third = await carryForwardPresentationIdentityManifest({ previous: second, buffer: again, revision: 3,
      targetElementId: target.elementId, targetText: '再次修改' });
    const read = await readIdentityElementTexts(again, third);
    expect(read.get(target.elementId)).toBe('再次修改');
    for (const [id, text] of texts) if (id !== target.elementId) expect(read.get(id)).toBe(text);
  });

  it('rejects forged fingerprints, duplicate physical locators and open manifest fields', async () => {
    const { buffer, manifest } = await identityFixture();
    const bad = structuredClone(manifest);
    expect(() => parsePresentationIdentityManifest({ ...bad, rootDirectory: 'forbidden' })).toThrow('invalid_identity_manifest');
    expect(() => parsePresentationIdentityManifest({ ...bad, pages: [{ ...bad.pages[0], extra: true }, ...bad.pages.slice(1)] })).toThrow('invalid_identity_manifest');
    expect(() => parsePresentationIdentityManifest({ ...bad, elements: [...bad.elements, { ...bad.elements[0], elementId: 'element-other' }] })).toThrow('invalid_identity_manifest');
    await expect(verifyPresentationIdentityManifest(buffer, { ...bad, elements: bad.elements.map((element, index) => index ? element : { ...element, sourceFingerprint: '0'.repeat(64) }) })).rejects.toMatchObject({ code: 'identity_ambiguous' });
    await expect(verifyPresentationIdentityManifest(buffer, { ...bad, pages: bad.pages.map((page, index) => index ? page : { ...page, fingerprint: '0'.repeat(64) }) })).rejects.toMatchObject({ code: 'identity_ambiguous' });
    const immutable = parsePresentationIdentityManifest(bad);
    expect(Object.isFrozen(immutable.elements[0].physicalLocator)).toBe(true);
  });

  it('rejects duplicate shape IDs instead of selecting the first object', async () => {
    const { buffer, manifest, target } = await identityFixture();
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file(target.physicalLocator.slidePart)!.async('string');
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="([^"]+)"/gu)];
    const other = ids.find(match => match[1] !== target.physicalLocator.shapeId)!;
    zip.file(target.physicalLocator.slidePart, xml.replace(other[0], other[0].replace(`id="${other[1]}"`, `id="${target.physicalLocator.shapeId}"`)));
    await expect(buildPresentationIdentityManifest({ buffer: await zip.generateAsync({ type: 'nodebuffer' }),
      documentLineageId: manifest.documentLineageId, workId: manifest.workId, fileId: manifest.fileId,
      sourceExecutionId: manifest.sourceExecutionId, revision: 1 })).rejects.toMatchObject({ code: 'identity_ambiguous' });
  });

  it('adds a host-generated text identity and reads it back from the real PPTX', async () => {
    const { buffer, manifest, target } = await identityFixture();
    const page = manifest.pages.find(item => item.pageId === target.pageId)!;
    const patch = addTextPatch(page.pageId, 'element-host-generated', '重复目标');
    const candidate = await (await import('../../src/platform/documents/presentation-identity-manifest')).applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await (await import('../../src/platform/documents/presentation-identity-manifest')).carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate, revision: 2, patch });
    expect(next.elements.filter(element => element.text === '重复目标')).toHaveLength(3);
    expect(new Set(next.elements.filter(element => element.text === '重复目标').map(element => element.elementId)).size).toBe(3);
    expect(await readIdentityElementText(candidate, next, 'element-host-generated')).toBe('重复目标');
    await expect(verifyPresentationIdentityManifest(candidate, next)).resolves.toBeDefined();
  });

  it('deletes exactly the requested identity and keeps a tombstone for old revision audit', async () => {
    const { buffer, manifest, target } = await identityFixture();
    const patch = deleteElementPatch(target.elementId);
    const candidate = await (await import('../../src/platform/documents/presentation-identity-manifest')).applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await (await import('../../src/platform/documents/presentation-identity-manifest')).carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate, revision: 2, patch });
    expect(next.elements.some(element => element.elementId === target.elementId)).toBe(false);
    expect(next.tombstones).toContainEqual({ elementId: target.elementId, pageId: target.pageId, revision: 2 });
    await expect(readIdentityElementText(candidate, next, target.elementId)).rejects.toMatchObject({ code: 'identity_unresolved' });
    expect(next.elements.filter(element => element.text === target.text)).toHaveLength(manifest.elements.filter(element => element.text === target.text).length - 1);
    await expect(verifyPresentationIdentityManifest(candidate, next)).resolves.toBeDefined();
  });

  it('inserts a host-identified slide and preserves later page identities after real-file read-back', async () => {
    const { buffer, manifest } = await identityFixture();
    const reference = manifest.pages[0]!;
    const originalIds = manifest.pages.map(page => page.pageId);
    const patch = addSlidePatch({ pageId: 'page-host-generated', mode: 'after', referencePageId: reference.pageId,
      title: '新增页面', titleElementId: 'element-title-host-generated' });
    const candidate = await applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate,
      revision: 2, patch });
    expect(next.pages.map(page => page.pageId)).toEqual([originalIds[0], 'page-host-generated', ...originalIds.slice(1)]);
    expect(next.pages.slice(2).map(page => page.physicalPageNumber)).toEqual(originalIds.slice(1).map((_, index) => index + 3));
    expect(next.elements.find(element => element.elementId === 'element-title-host-generated')).toMatchObject({
      pageId: 'page-host-generated', text: '新增页面'
    });
    const realPages = await readPptxDocument(candidate);
    expect(realPages).toHaveLength(manifest.pages.length + 1);
    expect(realPages[1]?.contentText).toContain('新增页面');
    await expect(verifyPresentationIdentityManifest(candidate, next)).resolves.toBeDefined();
  });

  it('places end additions before a recognizable closing page', async () => {
    const { buffer, manifest } = await identityFixture();
    const closing = manifest.pages.at(-1)!;
    const patch = addSlidePatch({ pageId: 'page-p4-end-generated', mode: 'end', title: '新增末页', titleElementId: 'element-p4-end-title' });
    const candidate = await applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate, revision: 2, patch });
    expect(next.pages.at(-1)?.pageId).toBe(closing.pageId);
    expect(next.pages.at(-2)?.pageId).toBe('page-p4-end-generated');
    expect((await readPptxDocument(candidate)).at(-2)?.contentText).toContain('新增末页');
  });

  it('inserts before an exact page identity without changing later identities', async () => {
    const { buffer, manifest } = await identityFixture();
    const reference = manifest.pages[1]!;
    const originalIds = manifest.pages.map(page => page.pageId);
    const patch = addSlidePatch({ pageId: 'page-p4-before-generated', mode: 'before', referencePageId: reference.pageId });
    const candidate = await applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate, revision: 2, patch });
    expect(next.pages.map(page => page.pageId)).toEqual([originalIds[0], 'page-p4-before-generated', ...originalIds.slice(1)]);
    expect(next.pages.find(page => page.pageId === originalIds[2])?.physicalPageNumber).toBe(4);
    await expect(verifyPresentationIdentityManifest(candidate, next)).resolves.toBeDefined();
  });

  it('appends at end when the document has no recognizable closing page', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-identity-no-closing-'));
    roots.push(root);
    const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '无结束页', sections: [] }));
    const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root,
      now: '2026-09-28T12:00:00.000Z', presentationTemplate: 'business_minimal' });
    const buffer = await readFile(generated.temporaryPath);
    const manifest = await buildPresentationIdentityManifest({ buffer, documentLineageId: 'lineage-no-closing', workId: 'work-no-closing',
      fileId: 'file-no-closing', sourceExecutionId: 'execution-no-closing', revision: 1 });
    const patch = addSlidePatch({ pageId: 'page-p4-append-generated', mode: 'end' });
    const candidate = await applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate, revision: 2, patch });
    expect(next.pages.at(-1)?.pageId).toBe('page-p4-append-generated');
    expect((await readPptxDocument(candidate)).at(-1)?.contentText).toBe('');
    await expect(verifyPresentationIdentityManifest(candidate, next)).resolves.toBeDefined();
  });

  it('uses pageId rather than duplicate page titles when choosing the insertion target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-identity-duplicate-pages-'));
    roots.push(root);
    const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '重复页面标题', sections: [
      { heading: '市场分析', level: 1, blocks: [{ type: 'paragraph', text: '第一份分析' }] },
      { heading: '市场分析', level: 1, blocks: [{ type: 'paragraph', text: '第二份分析' }] }
    ] }));
    const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root,
      now: '2026-09-28T12:00:00.000Z', presentationTemplate: 'business_minimal' });
    const buffer = await readFile(generated.temporaryPath);
    const manifest = await buildPresentationIdentityManifest({ buffer, documentLineageId: 'lineage-duplicate-pages', workId: 'work-duplicate-pages',
      fileId: 'file-duplicate-pages', sourceExecutionId: 'execution-duplicate-pages', revision: 1 });
    const duplicateTitlePages = manifest.pages.filter(page => page.physicalPageNumber === 2 || page.physicalPageNumber === 3);
    expect(duplicateTitlePages).toHaveLength(2);
    const originalIds = manifest.pages.map(page => page.pageId);
    const patch = addSlidePatch({ pageId: 'page-p4-duplicate-target', mode: 'after', referencePageId: duplicateTitlePages[1]!.pageId, title: '定向插入', titleElementId: 'element-p4-duplicate-title' });
    const candidate = await applyPresentationMutationPatch({ buffer, manifest, patch });
    const next = await carryForwardPresentationIdentityManifestForPatch({ previous: manifest, buffer: candidate, revision: 2, patch });
    expect(next.pages.map(page => page.pageId)).toEqual([originalIds[0], originalIds[1], originalIds[2], 'page-p4-duplicate-target', ...originalIds.slice(3)]);
    expect(next.pages[1]?.pageId).toBe(duplicateTitlePages[0]!.pageId);
    expect(next.pages[2]?.pageId).toBe(duplicateTitlePages[1]!.pageId);
    await expect(verifyPresentationIdentityManifest(candidate, next)).resolves.toBeDefined();
  });

  it.each(['rich_text', 'field'])('refuses %s mutation without flattening the object', async variant => {
    const { buffer, manifest, target } = await identityFixture();
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file(target.physicalLocator.slidePart)!.async('string');
    const shape = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].find(match => match[0].includes(`id="${target.physicalLocator.shapeId}"`))![0];
    const replacement = variant === 'rich_text' ? shape.replace('</a:r>', '</a:r><a:r><a:t>额外文本</a:t></a:r>')
      : shape.replace('</a:p>', '<a:fld id="field-1" type="datetime"><a:t>日期</a:t></a:fld></a:p>');
    zip.file(target.physicalLocator.slidePart, xml.replace(shape, replacement));
    const complex = await zip.generateAsync({ type: 'nodebuffer' });
    const identity = await buildPresentationIdentityManifest({ buffer: complex, documentLineageId: manifest.documentLineageId,
      workId: manifest.workId, fileId: manifest.fileId, sourceExecutionId: manifest.sourceExecutionId, revision: 1 });
    const selected = identity.elements.find(element => element.physicalLocator.slidePart === target.physicalLocator.slidePart && element.physicalLocator.shapeId === target.physicalLocator.shapeId)!;
    await expect(applyPresentationTextPatch({ buffer: complex, manifest: identity, patch: updateTextPatch(selected.elementId, '禁止扁平化') })).rejects.toMatchObject({ code: 'identity_unresolved' });
  });
});

async function identityFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-identity-exact-'));
  roots.push(root);
  const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '身份校验', sections: [{ heading: '目标页', level: 1,
    blocks: [{ type: 'paragraph', text: '重复目标' }, { type: 'paragraph', text: '重复目标' }] }] }));
  const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root, now: '2026-09-28T12:00:00.000Z', presentationTemplate: 'business_minimal' });
  const buffer = await readFile(generated.temporaryPath);
  const manifest = await buildPresentationIdentityManifest({ buffer, documentLineageId: 'lineage-exact', workId: 'work-exact', fileId: 'file-exact', sourceExecutionId: 'execution-exact', revision: 1 });
  return { buffer, manifest, target: manifest.elements.find(element => element.text === '重复目标')! };
}
