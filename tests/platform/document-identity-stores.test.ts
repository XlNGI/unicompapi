import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProjectStorage } from '../../src/platform/storage';
import { DocumentIdentityIndexStore } from '../../src/platform/documents/document-identity-index-store';
import { DocumentMutationHeadStore } from '../../src/platform/documents/document-mutation-head-store';
import { parsePresentationIdentityManifest } from '../../src/platform/documents/presentation-identity-manifest';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-identity-store-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  return { identities: new DocumentIdentityIndexStore(storage), heads: new DocumentMutationHeadStore(storage) };
}
const manifest = () => parsePresentationIdentityManifest({ schemaVersion: 1, documentLineageId: 'lineage-store',
  workId: 'work-base', fileId: 'file-base', sourceExecutionId: 'execution-base', identityIndexVersion: 1,
  revision: 1, artifactChecksumSha256: 'a'.repeat(64),
  pages: [{ pageId: 'page-stable', physicalPageNumber: 1, slidePart: 'ppt/slides/slide1.xml', fingerprint: 'b'.repeat(64) }],
  elements: [{ elementId: 'element-stable', pageId: 'page-stable', kind: 'text', text: '原文', sourceFingerprint: 'c'.repeat(64),
    physicalLocator: { slidePart: 'ppt/slides/slide1.xml', shapeId: '2' } }] });
function basePin(): DocumentVersionPin {
  return { documentLineageId: 'lineage-store', headWorkId: 'work-base', fileId: 'file-base', sourceExecutionId: 'execution-base',
    checksumSha256: 'a'.repeat(64), runtimeRevision: 1, identityIndexVersion: 1 };
}
function candidatePin(): DocumentVersionPin {
  return { ...basePin(), headWorkId: 'work-next', fileId: 'file-next', sourceExecutionId: 'execution-next', checksumSha256: 'd'.repeat(64), runtimeRevision: 2 };
}

describe('immutable identity versions and authoritative head CAS', () => {
  it('seeds once under concurrent admission and never lets a candidate overwrite the lineage seed', async () => {
    const { identities } = await fixture();
    const build = vi.fn(async () => manifest());
    const results = await Promise.all(Array.from({ length: 8 }, () => identities.ensureForWork({ workId: 'work-base', build })));
    expect(build).toHaveBeenCalledOnce();
    expect(results.every(result => result.elements[0].elementId === 'element-stable')).toBe(true);
    const next = parsePresentationIdentityManifest({ ...manifest(), workId: 'work-next', fileId: 'file-next', sourceExecutionId: 'execution-next', revision: 2, artifactChecksumSha256: 'd'.repeat(64) });
    await identities.save(next);
    expect((await identities.get('lineage-store'))?.workId).toBe('work-base');
    expect((await identities.getForWork('work-next'))?.workId).toBe('work-next');
    await expect(identities.save({ ...next, revision: 3 })).rejects.toThrow('identity_stale');
  });

  it('rejects mismatched seed work and does not create identity metadata', async () => {
    const { identities } = await fixture();
    await expect(identities.ensureForWork({ workId: 'work-other', build: async () => manifest() })).rejects.toThrow('identity_stale');
    expect(await identities.getForWork('work-other')).toBeUndefined();
  });

  it('fails closed for an absent head and protects the existing head from save overwrites', async () => {
    const { heads } = await fixture();
    expect(await heads.compareAndSwap(basePin(), candidatePin())).toBe(false);
    expect(await heads.get('lineage-store')).toBeUndefined();
    await heads.save(basePin());
    await heads.save(basePin());
    await expect(heads.save(candidatePin())).rejects.toThrow('revision_conflict');
    expect(await heads.get('lineage-store')).toEqual(basePin());
  });

  it('runs final authorization and byte revalidation inside CAS and accepts only one concurrent writer', async () => {
    const { heads } = await fixture();
    await heads.save(basePin());
    const revalidate = vi.fn(async () => false);
    expect(await heads.compareAndSwap(basePin(), candidatePin(), { revalidate })).toBe(false);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(await heads.get('lineage-store')).toEqual(basePin());
    const outcomes = await Promise.all([
      heads.compareAndSwap(basePin(), candidatePin(), { revalidate: async () => true }),
      heads.compareAndSwap(basePin(), { ...candidatePin(), headWorkId: 'work-racer', fileId: 'file-racer' }, { revalidate: async () => true })
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await heads.get('lineage-store'))?.runtimeRevision).toBe(2);
  });

  it('rejects other lineage and non-incrementing revision without executing the callback', async () => {
    const { heads } = await fixture();
    await heads.save(basePin());
    const revalidate = vi.fn(async () => true);
    expect(await heads.compareAndSwap(basePin(), { ...candidatePin(), documentLineageId: 'lineage-other' }, { revalidate })).toBe(false);
    expect(await heads.compareAndSwap(basePin(), { ...candidatePin(), runtimeRevision: 1 }, { revalidate })).toBe(false);
    expect(revalidate).not.toHaveBeenCalled();
  });
});
