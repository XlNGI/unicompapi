import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAsset,
  createFileReference,
  toAssetId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  transitionFile,
  type FileReference
} from '../../src/domain';
import {
  JsonAssetRepository,
  JsonFileReferenceRepository,
  NodeProjectStorage,
  ProjectImageMaterialResolver
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-29T01:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ProjectImageMaterialResolver', () => {
  it('resolves only a revalidated project image and returns no path or hash', async () => {
    const fixture = await createFixture();
    const resolver = new ProjectImageMaterialResolver({
      getSession: () => fixture.session
    });

    const result = await resolver.resolve({
      projectId: fixture.projectId,
      assetId: fixture.assetId
    });

    expect(result).toEqual({
      assetId: fixture.assetId,
      mimeType: 'image/png',
      width: 2,
      height: 3,
      sizeBytes: fixture.bytes.byteLength,
      base64: fixture.bytes.toString('base64')
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(fixture.checksum);
  });

  it('rejects changed bytes and persists the truthful file state', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.absolutePath, pngBytes(4, 5));
    const resolver = new ProjectImageMaterialResolver({
      getSession: () => fixture.session
    });

    await expect(
      resolver.resolve({
        projectId: fixture.projectId,
        assetId: fixture.assetId
      })
    ).rejects.toMatchObject({ code: 'material_changed' });
    const stored = await new JsonFileReferenceRepository(
      fixture.storage,
      fixture.projectId
    ).get(fixture.file.id);
    expect(stored?.state).toBe('corrupted');
  });

  it('rejects cross-project access and oversized controlled materials', async () => {
    const fixture = await createFixture();
    const resolver = new ProjectImageMaterialResolver({
      getSession: () => fixture.session,
      maximumInputBytes: fixture.bytes.byteLength - 1
    });

    await expect(
      resolver.resolve({
        projectId: toProjectId('project-other'),
        assetId: fixture.assetId
      })
    ).rejects.toMatchObject({ code: 'project_unavailable' });
    await expect(
      resolver.resolve({
        projectId: fixture.projectId,
        assetId: fixture.assetId
      })
    ).rejects.toMatchObject({ code: 'material_too_large' });
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-material-secret-'));
  roots.push(root);
  const projectId = toProjectId('project-controlled-material');
  const assetId = toAssetId('asset-controlled-material');
  const storage = new NodeProjectStorage(root);
  const relativePath = 'files/input.png';
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const bytes = pngBytes(2, 3);
  await writeFile(absolutePath, bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const pending = createFileReference({
    id: toFileReferenceId('file-controlled-material'),
    projectId,
    locator: { kind: 'project', relativePath },
    createdAt: timestamp
  });
  const verifying = transitionFile(pending, 'verifying', timestamp);
  const available = transitionFile(verifying, 'available', timestamp, {
    sizeBytes: bytes.byteLength,
    checksumSha256: checksum
  });
  const file: FileReference = {
    ...available,
    lastVerification: {
      sizeBytes: bytes.byteLength,
      checksumSha256: checksum,
      matchesExpected: true,
      verifiedAt: timestamp
    }
  };
  await new JsonFileReferenceRepository(storage, projectId).save(file);
  await new JsonAssetRepository(storage, projectId).save(createAsset({
    id: assetId,
    projectId,
    fileId: file.id,
    name: 'input.png',
    mediaKind: 'image',
    origin: 'imported',
    imageMetadata: {
      mimeType: 'image/png',
      width: 2,
      height: 3
    },
    createdAt: timestamp
  }));
  return {
    root,
    projectId,
    assetId,
    storage,
    file,
    bytes,
    checksum,
    absolutePath,
    session: {
      projectId,
      projectName: 'Controlled material project',
      rootDirectory: root
    }
  };
}

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
