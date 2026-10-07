import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toExecutionId, toFileReferenceId, toIsoTimestamp, toProjectId, toTaskId, toWorkId, type Work } from '../../src/domain';
import { hasControlledDocumentVersionEvidence } from '../../src/platform/documents/document-controlled-version-evidence';
import { DocumentMutationHeadStore } from '../../src/platform/documents/document-mutation-head-store';
import { NodeProjectStorage, toProjectRelativePath } from '../../src/platform/storage';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-version-evidence-'));
  roots.push(rootDirectory);
  const projectId = toProjectId('project-evidence');
  const work: Work = { schemaVersion: 1, id: toWorkId('work-evidence'), projectId,
    fileId: toFileReferenceId('file-evidence'), sourceTaskId: toTaskId('task-evidence'),
    sourceExecutionId: toExecutionId('execution-evidence'), mediaKind: 'document', name: '版本测试',
    createdAt: toIsoTimestamp('2026-10-06T12:00:00.000Z') };
  return { rootDirectory, projectId, work, storage: new NodeProjectStorage(rootDirectory) };
}
const pin = { documentLineageId: 'lineage-evidence', headWorkId: 'work-evidence', fileId: 'file-evidence',
  sourceExecutionId: 'execution-evidence', checksumSha256: 'a'.repeat(64), runtimeRevision: 1, identityIndexVersion: 1 };

describe('missing document identity admission evidence', () => {
  it('does not infer controlled lineage from an ordinary parent Work alone', async () => {
    const data = await fixture();
    expect(await hasControlledDocumentVersionEvidence({ ...data, work: { ...data.work, parentWorkId: toWorkId('work-parent') } })).toBe(false);
  });

  it('recognizes a persisted head without restoring or updating it', async () => {
    const data = await fixture();
    const heads = new DocumentMutationHeadStore(data.storage);
    await heads.save(pin);
    expect(await hasControlledDocumentVersionEvidence(data)).toBe(true);
    expect(await heads.get(pin.documentLineageId)).toEqual(pin);
  });

  it('recognizes a historical mutation base even after the head advances to another Work', async () => {
    const data = await fixture();
    await new DocumentMutationHeadStore(data.storage).save({ ...pin, headWorkId: 'work-next', fileId: 'file-next', runtimeRevision: 2 });
    await data.storage.writeJsonAtomically(toProjectRelativePath(`entities/document-mutations/call-${'b'.repeat(64)}.json`), {
      schemaVersion: 1, idempotencyKey: 'call-evidence', state: 'session_refreshed', basePin: pin,
      candidatePin: { ...pin, headWorkId: 'work-next', fileId: 'file-next', runtimeRevision: 2 }
    });
    expect(await hasControlledDocumentVersionEvidence(data)).toBe(true);
  });

  it('treats an identity backup as read-only evidence and never recreates its primary', async () => {
    const data = await fixture();
    const relative = `entities/presentation-identity-index/work-${createHash('sha256').update(data.work.id).digest('hex')}.json`;
    const backup = toProjectRelativePath(relative + '.bak');
    await data.storage.writeJsonAtomically(backup, { schemaVersion: 1, documentLineageId: pin.documentLineageId,
      workId: data.work.id, fileId: data.work.fileId, sourceExecutionId: data.work.sourceExecutionId,
      identityIndexVersion: 1, revision: 2, artifactChecksumSha256: pin.checksumSha256,
      pages: [{ pageId: 'page-evidence', physicalPageNumber: 1, slidePart: 'ppt/slides/slide1.xml', fingerprint: 'c'.repeat(64) }],
      elements: [], tombstones: [{ elementId: 'element-deleted', pageId: 'page-evidence', revision: 2 }] });
    const before = await readFile(path.join(data.rootDirectory, backup));
    expect(await hasControlledDocumentVersionEvidence(data)).toBe(true);
    expect(await data.storage.readJson(toProjectRelativePath(relative))).toBeUndefined();
    expect(await readFile(path.join(data.rootDirectory, backup))).toEqual(before);
  });

  it('does not interpret unreadable version evidence as permission to seed new identity', async () => {
    const data = await fixture();
    await data.storage.writeJsonAtomically(toProjectRelativePath(`entities/document-mutation-head/${'a'.repeat(64)}.json`), { broken: true });
    await expect(hasControlledDocumentVersionEvidence(data)).rejects.toMatchObject({ code: 'identity_unresolved' });
  });
});
