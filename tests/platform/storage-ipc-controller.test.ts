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
  JsonFileReferenceRepository,
  NodeProjectStorage,
  StorageIpcController
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2020-01-01T00:00:00.000Z');
const helloChecksum = createHash('sha256').update('hello').digest('hex');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ipc-'));
  roots.push(root);
  const projectId = toProjectId('project-ipc');
  const storage = new NodeProjectStorage(root);
  const fileRepository = new JsonFileReferenceRepository(storage, projectId);
  let selectedPath: string | undefined;
  let lastError: unknown;
  const controller = new StorageIpcController({
    getSession: () => ({ projectId, rootDirectory: root }),
    chooseRelinkFile: async () => selectedPath,
    onError: (error) => {
      lastError = error;
    }
  });

  return {
    controller,
    fileRepository,
    projectId,
    root,
    getLastError: () => lastError,
    setSelectedPath: (value: string | undefined) => {
      selectedPath = value;
    }
  };
}

describe('StorageIpcController', () => {
  it('rejects calls without an active project or valid file ID', async () => {
    const withoutProject = new StorageIpcController({
      getSession: () => undefined,
      chooseRelinkFile: async () => undefined
    });

    await expect(
      withoutProject.probeFile({ fileId: 'file-1' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });

    const fixture = await createFixture();
    await expect(fixture.controller.probeFile({ path: fixture.root })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
  });

  it('verifies by file ID and returns no path or raw checksum', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, 'hello.txt'), 'hello', 'utf8');
    const file = createFileReference({
      id: toFileReferenceId('file-ipc-verify'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'hello.txt' },
      checksumSha256: helloChecksum,
      createdAt: timestamp
    });
    await fixture.fileRepository.save(file);

    const result = await fixture.controller.verifyFile({ fileId: file.id });
    const serialized = JSON.stringify(result);

    if (!result.ok) {
      throw fixture.getLastError();
    }

    expect(result).toMatchObject({
      ok: true,
      value: {
        fileId: file.id,
        state: 'available',
        matchesExpected: true,
        sizeBytes: 5
      }
    });
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(helloChecksum);
  });

  it('uses the main-process chooser for relink and rebuilds the index', async () => {
    const fixture = await createFixture();
    const replacement = path.join(fixture.root, 'replacement.txt');
    await writeFile(replacement, 'hello', 'utf8');
    fixture.setSelectedPath(replacement);
    const file = createFileReference({
      id: toFileReferenceId('file-ipc-relink'),
      projectId: fixture.projectId,
      locator: { kind: 'project', relativePath: 'missing.txt' },
      checksumSha256: helloChecksum,
      createdAt: timestamp
    });
    await fixture.fileRepository.save(file);

    const relink = await fixture.controller.relinkFile({ fileId: file.id });
    const rebuild = await fixture.controller.rebuildIndex();
    const stored = await fixture.fileRepository.get(file.id);

    expect(relink).toMatchObject({
      ok: true,
      value: { cancelled: false, file: { state: 'available' } }
    });
    expect(rebuild).toMatchObject({
      ok: true,
      value: { sourceFileCount: 1, indexedFileCount: 0 }
    });
    expect(stored?.locator.kind).toBe('external');
    expect(JSON.stringify(relink)).not.toContain(replacement);
  });
});
