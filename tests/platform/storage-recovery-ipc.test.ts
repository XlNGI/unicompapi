import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileReference,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  NodeProjectStorage,
  StorageRecoveryIpcError,
  createStorageRecoveryApi
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T03:00:00.000Z');
const checksum = createHash('sha256').update('hello').digest('hex');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture(candidate?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ipc-'));
  roots.push(root);
  const projectId = toProjectId('project-ipc');
  const storage = new NodeProjectStorage(root);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const index = new JsonFileIndexRepository(storage, projectId);
  const api = createStorageRecoveryApi({
    getProjectRoot: (requestedProjectId) => {
      expect(requestedProjectId).toBe(projectId);
      return root;
    },
    selectRelinkCandidate: async () => candidate
  });

  return { api, files, index, projectId, root };
}

describe('storage recovery IPC', () => {
  it('probes and persists verification without accepting a project root', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, 'hello.txt'), 'hello', 'utf8');
    const file = createFileReference({
      id: toFileReferenceId('file-ipc'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'hello.txt' },
      checksumSha256: checksum,
      createdAt: timestamp
    });
    await fixture.files.save(file);

    await expect(
      fixture.api.probeFile({ projectId: file.projectId, fileId: file.id })
    ).resolves.toMatchObject({
      result: { recommendedState: 'available', issues: [] },
      recovery: { actions: [] }
    });

    const verified = await fixture.api.verifyFile({
      projectId: file.projectId,
      fileId: file.id
    });
    expect(verified.state).toBe('available');
    await expect(fixture.index.get(file.id)).resolves.toMatchObject({
      checksumSha256: checksum,
      state: 'available'
    });

    await expect(
      fixture.api.probeFile({
        projectId: file.projectId,
        fileId: file.id,
        projectRoot: 'C:\\untrusted'
      } as never)
    ).rejects.toBeInstanceOf(StorageRecoveryIpcError);
  });

  it('relinks only to the file selected by the main process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ipc-candidate-'));
    roots.push(root);
    const candidate = path.join(root, 'replacement.txt');
    await writeFile(candidate, 'hello', 'utf8');
    const fixture = await createFixture(candidate);
    const file = createFileReference({
      id: toFileReferenceId('file-relink'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'missing.txt' },
      checksumSha256: checksum,
      createdAt: timestamp
    });
    await fixture.files.save(file);

    const relinked = await fixture.api.relinkFile({
      projectId: file.projectId,
      fileId: file.id,
      confirmedByUser: true
    });

    expect(relinked).toMatchObject({
      locator: { kind: 'external', absolutePath: candidate },
      state: 'available'
    });
  });

  it('rebuilds the derived index from project file references', async () => {
    const fixture = await createFixture();
    const file = createFileReference({
      id: toFileReferenceId('file-index'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'files/result.png' },
      createdAt: timestamp
    });
    await fixture.files.save(file);

    await expect(
      fixture.api.rebuildFileIndex({ projectId: fixture.projectId })
    ).resolves.toEqual({
      sourceFileCount: 1,
      indexedFileCount: 1,
      skippedExternalFileCount: 0
    });
    await expect(fixture.index.get(file.id)).resolves.toBeDefined();
  });
});
