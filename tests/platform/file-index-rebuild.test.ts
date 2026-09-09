import { mkdtemp, rm } from 'node:fs/promises';
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
  FileIndexRebuildError,
  FileIndexRebuildService,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  NodeProjectStorage,
  toProjectRelativePath
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T02:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-index-rebuild-'));
  roots.push(root);
  const projectId = toProjectId('project-index-rebuild');
  const storage = new NodeProjectStorage(root);
  const fileRepository = new JsonFileReferenceRepository(storage, projectId);
  const indexRepository = new JsonFileIndexRepository(storage, projectId);
  const service = new FileIndexRebuildService(
    projectId,
    fileRepository,
    indexRepository
  );

  return {
    fileRepository,
    indexRepository,
    projectId,
    root,
    service
  };
}

describe('FileIndexRebuildService', () => {
  it('replaces stale index data from project file references', async () => {
    const fixture = await createFixture();
    const projectFile = createFileReference({
      id: toFileReferenceId('file-project'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'files/project.png' },
      sizeBytes: 128,
      checksumSha256: 'a'.repeat(64),
      createdAt: timestamp
    });
    const externalFile = createFileReference({
      id: toFileReferenceId('file-external'),
      projectId: fixture.projectId,
      locator: {
        kind: 'external',
        absolutePath: path.join(fixture.root, 'external.png')
      },
      createdAt: timestamp
    });

    await fixture.fileRepository.save(projectFile);
    await fixture.fileRepository.save(externalFile);
    await fixture.indexRepository.upsert({
      fileId: toFileReferenceId('stale-file'),
      relativePath: toProjectRelativePath('files/stale.png'),
      state: 'missing',
      updatedAt: timestamp
    });

    const report = await fixture.service.rebuild();
    const index = await fixture.indexRepository.load();

    expect(report).toEqual({
      sourceFileCount: 2,
      indexedFileCount: 1,
      skippedExternalFileCount: 1
    });
    expect(index.entries).toEqual([
      expect.objectContaining({
        fileId: projectFile.id,
        relativePath: 'files/project.png',
        checksumSha256: 'a'.repeat(64)
      })
    ]);
  });

  it('does not replace the existing index when project paths conflict', async () => {
    const fixture = await createFixture();
    const first = createFileReference({
      id: toFileReferenceId('file-first'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'files/shared.png' },
      createdAt: timestamp
    });
    const second = createFileReference({
      id: toFileReferenceId('file-second'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'files/shared.png' },
      createdAt: timestamp
    });
    const existingFileId = toFileReferenceId('existing-index-entry');

    await fixture.fileRepository.save(first);
    await fixture.fileRepository.save(second);
    await fixture.indexRepository.upsert({
      fileId: existingFileId,
      relativePath: toProjectRelativePath('files/existing.png'),
      state: 'available',
      updatedAt: timestamp
    });

    await expect(fixture.service.rebuild()).rejects.toBeInstanceOf(
      FileIndexRebuildError
    );
    await expect(fixture.indexRepository.get(existingFileId)).resolves.toBeDefined();
  });
});
