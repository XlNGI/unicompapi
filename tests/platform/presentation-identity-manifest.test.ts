import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import {
  applyPresentationTextPatch,
  buildPresentationIdentityManifest,
  carryForwardPresentationIdentityManifest,
  readIdentityElementText
} from '../../src/platform/documents/presentation-identity-manifest';
import { updateTextPatch } from '../../src/domain/entities/document-ir-patch';

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
    const manifest = await buildPresentationIdentityManifest({ buffer: original, documentLineageId: 'lineage-spike', workId: 'work-spike-1', revision: 1 });
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
    const manifest = await buildPresentationIdentityManifest({ buffer: original, documentLineageId: 'lineage-pin', workId: 'work-pin-1', revision: 1 });
    const target = manifest.elements.find(element => element.text === '原文')!;
    await expect(readIdentityElementText(Buffer.from('not a pptx'), manifest, target.elementId)).rejects.toMatchObject({ code: 'identity_pin_mismatch' });
  });
});
