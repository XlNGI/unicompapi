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
  FileRecoveryPersistenceError,
  FileVerificationPersistenceService,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  NodeFileStatusProbe,
  NodeProjectStorage
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-07-22T01:00:00.000Z');
const helloChecksum = createHash('sha256').update('hello').digest('hex');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-persistence-'));
  roots.push(root);
  const projectId = toProjectId('project-persistence');
  const storage = new NodeProjectStorage(root);
  const fileRepository = new JsonFileReferenceRepository(storage, projectId);
  const indexRepository = new JsonFileIndexRepository(storage, projectId);
  const probe = new NodeFileStatusProbe(root);
  const service = new FileVerificationPersistenceService(
    fileRepository,
    indexRepository,
    probe,
    () => timestamp
  );

  return {
    fileRepository,
    indexRepository,
    projectId,
    root,
    service,
    probe
  };
}

function createFile(
  projectId: ReturnType<typeof toProjectId>,
  relativePath: string,
  checksumSha256?: string
) {
  return createFileReference({
    id: toFileReferenceId('file-persistence'),
    projectId,
    locator: { kind: 'project', relativePath },
    checksumSha256,
    createdAt: timestamp
  });
}

describe('file verification persistence', () => {
  it('persists matching verification evidence to the file and index', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, 'hello.txt'), 'hello', 'utf8');
    const file = createFile(fixture.projectId, 'hello.txt', helloChecksum);
    const result = await fixture.probe.inspect(file);

    const updated = await fixture.service.persistProbeResult(file, result);

    expect(updated.state).toBe('available');
    expect(updated.checksumSha256).toBe(helloChecksum);
    expect(updated.lastVerification?.matchesExpected).toBe(true);
    await expect(fixture.fileRepository.get(file.id)).resolves.toEqual(updated);
    await expect(fixture.indexRepository.get(file.id)).resolves.toMatchObject({
      state: 'available',
      checksumSha256: helloChecksum,
      sizeBytes: 5
    });
  });

  it('preserves baseline evidence when the observed checksum mismatches', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, 'changed.txt'), 'changed', 'utf8');
    const file = createFile(fixture.projectId, 'changed.txt', helloChecksum);
    const result = await fixture.probe.inspect(file);

    const updated = await fixture.service.persistProbeResult(file, result);

    expect(updated.state).toBe('corrupted');
    expect(updated.checksumSha256).toBe(helloChecksum);
    expect(updated.lastVerification?.matchesExpected).toBe(false);
    expect(updated.lastVerification?.checksumSha256).not.toBe(helloChecksum);
    await expect(fixture.indexRepository.get(file.id)).resolves.toMatchObject({
      state: 'corrupted',
      checksumSha256: helloChecksum
    });
  });

  it('continues from changed content to a later missing state', async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.root, 'changed-then-missing.txt');
    await writeFile(target, 'changed', 'utf8');
    const file = createFile(
      fixture.projectId,
      'changed-then-missing.txt',
      helloChecksum
    );
    const changed = await fixture.service.persistProbeResult(
      file,
      await fixture.probe.inspect(file)
    );
    expect(changed.state).toBe('corrupted');

    await rm(target);
    const missing = await fixture.service.persistProbeResult(
      changed,
      await fixture.probe.inspect(changed)
    );
    expect(missing.state).toBe('missing');
    expect(missing.checksumSha256).toBe(helloChecksum);
  });

  it('relinks only after confirmation and matching local verification', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, 'replacement.txt'), 'hello', 'utf8');
    const original = createFile(
      fixture.projectId,
      'missing.txt',
      helloChecksum
    );
    await fixture.fileRepository.save(original);

    await expect(
      fixture.service.relink({
        file: original,
        locator: { kind: 'project', relativePath: 'replacement.txt' },
        confirmedByUser: false
      })
    ).rejects.toMatchObject({ code: 'user_confirmation_required' });

    const relinked = await fixture.service.relink({
      file: original,
      locator: { kind: 'project', relativePath: 'replacement.txt' },
      confirmedByUser: true
    });

    expect(relinked.locator).toEqual({
      kind: 'project',
      relativePath: 'replacement.txt'
    });
    expect(relinked.state).toBe('available');
    await expect(fixture.fileRepository.get(original.id)).resolves.toEqual(
      relinked
    );
  });

  it('rejects a mismatched relink candidate without changing the record', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, 'wrong.txt'), 'wrong', 'utf8');
    const original = createFile(
      fixture.projectId,
      'missing.txt',
      helloChecksum
    );
    await fixture.fileRepository.save(original);

    await expect(
      fixture.service.relink({
        file: original,
        locator: { kind: 'project', relativePath: 'wrong.txt' },
        confirmedByUser: true
      })
    ).rejects.toBeInstanceOf(FileRecoveryPersistenceError);
    await expect(fixture.fileRepository.get(original.id)).resolves.toEqual(
      original
    );
  });
});
