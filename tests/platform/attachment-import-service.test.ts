import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toFileReferenceId, toProjectId } from '../../src/domain';
import {
  AttachmentImportError,
  AttachmentImportService,
  JsonFileReferenceRepository,
  NodeProjectStorage
} from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createEnvironment() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-import-'));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-import-src-'));
  temporaryRoots.push(root, sourceRoot);
  return {
    root,
    sourceRoot,
    projectId: toProjectId('import-project')
  };
}

describe('attachment import service', () => {
  it('copies the file into the project and returns extraction', async () => {
    const { root, sourceRoot, projectId } = await createEnvironment();
    const sourcePath = path.join(sourceRoot, '需求说明.txt');
    await writeFile(sourcePath, '生成一份项目周报', 'utf8');
    const service = new AttachmentImportService({
      rootDirectory: root,
      projectId,
      now: () => '2026-08-22T10:00:00.000Z'
    });
    const result = await service.importAttachment({ sourcePath });
    expect(result.fileName).toBe('需求说明.txt');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.extraction.status).toBe('extracted');
    expect(result.extraction.preview).toContain('项目周报');

    const storage = new NodeProjectStorage(root);
    const files = new JsonFileReferenceRepository(storage, projectId);
    const file = await files.get(toFileReferenceId(result.fileId));
    expect(file?.state).toBe('available');
    expect(file?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects missing sources', async () => {
    const { root, sourceRoot, projectId } = await createEnvironment();
    const service = new AttachmentImportService({
      rootDirectory: root,
      projectId
    });
    await expect(
      service.importAttachment({
        sourcePath: path.join(sourceRoot, 'missing.txt')
      })
    ).rejects.toBeInstanceOf(AttachmentImportError);
  });

  it('rejects oversized sources', async () => {
    const { root, sourceRoot, projectId } = await createEnvironment();
    const sourcePath = path.join(sourceRoot, 'big.txt');
    await writeFile(sourcePath, 'x'.repeat(2048), 'utf8');
    const service = new AttachmentImportService({
      rootDirectory: root,
      projectId,
      limits: { maxFileBytes: 100 }
    });
    await expect(service.importAttachment({ sourcePath })).rejects.toThrow(
      AttachmentImportError
    );
  });
});
