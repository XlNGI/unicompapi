import { access, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
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

  it('normalizes Unicode and accepts spaces and long portable paths', () => {
    expect(toProjectRelativePath('files/Project Assets/Cafe\u0301 image.png')).toBe(
      'files/Project Assets/Café image.png'
    );
    const longPath = `files/${'nested-folder/'.repeat(20)}result.json`;
    expect(toProjectRelativePath(longPath)).toBe(longPath);
  });

  it('rejects Windows reserved names and non-portable segments on every platform', () => {
    for (const candidate of [
      'files/CON.json',
      'files/trailing-dot./item.json',
      'files/trailing-space /item.json',
      'files/invalid:name.json'
    ]) {
      expect(() => toProjectRelativePath(candidate)).toThrow('not portable');
    }
  });

  it('rejects a directory junction that would escape the project root', async () => {
    const { root, storage } = await createStorage();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'unicomp-storage-outside-'));
    temporaryRoots.push(outside);
    await symlink(outside, path.join(root, 'linked-outside'), 'junction');

    await expect(storage.writeJsonAtomically(
      toProjectRelativePath('linked-outside/escaped.json'),
      { escaped: true }
    )).rejects.toMatchObject({ code: 'symbolic_link_rejected' });
    await expect(access(path.join(outside, 'escaped.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});
