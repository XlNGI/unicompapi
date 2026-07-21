import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NodeProjectStorage,
  projectStoragePaths,
  toProjectRelativePath
} from '../../src/platform/storage';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createStorage() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-storage-'));
  temporaryRoots.push(root);
  return { root, storage: new NodeProjectStorage(root) };
}

describe('NodeProjectStorage', () => {
  it('writes, replaces and reads JSON inside the project root', async () => {
    const { storage } = await createStorage();

    await storage.writeJsonAtomically(projectStoragePaths.manifest, {
      schemaVersion: 1,
      name: 'first'
    });
    await storage.writeJsonAtomically(projectStoragePaths.manifest, {
      schemaVersion: 1,
      name: 'second'
    });

    await expect(
      storage.readJson<{ name: string }>(projectStoragePaths.manifest)
    ).resolves.toEqual({ schemaVersion: 1, name: 'second' });
  });

  it('creates nested directories and removes files idempotently', async () => {
    const { storage } = await createStorage();
    const nestedPath = toProjectRelativePath('entities/drafts.json');

    await storage.ensureDirectory(toProjectRelativePath('entities'));
    await storage.writeJsonAtomically(nestedPath, { drafts: [] });
    await storage.remove(nestedPath);
    await storage.remove(nestedPath);

    await expect(storage.readJson(nestedPath)).resolves.toBeUndefined();
  });

  it('does not expose temporary files after replacement', async () => {
    const { root, storage } = await createStorage();

    await storage.writeJsonAtomically(projectStoragePaths.manifest, {
      schemaVersion: 1
    });

    await expect(readdir(root)).resolves.toEqual(['project.json']);
  });
});
