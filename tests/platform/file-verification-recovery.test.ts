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
  NodeFileStatusProbe,
  NodeSha256FileVerifier,
  planFileRecovery
} from '../../src/platform/files';

const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');
const helloChecksum = createHash('sha256').update('hello').digest('hex');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createProjectRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-verification-'));
  roots.push(root);
  return root;
}

function createProjectFile(relativePath: string, checksumSha256?: string) {
  return createFileReference({
    id: toFileReferenceId(`file-${relativePath.replace(/[^a-z0-9]/gi, '-')}`),
    projectId: toProjectId('project-verification'),
    locator: { kind: 'project', relativePath },
    checksumSha256,
    createdAt: timestamp
  });
}

describe('SHA-256 verification', () => {
  it('streams a file and reports a matching checksum with byte progress', async () => {
    const root = await createProjectRoot();
    await writeFile(path.join(root, 'hello.txt'), 'hello', 'utf8');
    const progress: Array<[number, number]> = [];
    const verifier = new NodeSha256FileVerifier(root);

    const result = await verifier.verify({
      file: createProjectFile('hello.txt', helloChecksum),
      onProgress: (processed, total) => progress.push([processed, total])
    });

    expect(result.checksumSha256).toBe(helloChecksum);
    expect(result.matchesExpected).toBe(true);
    expect(result.sizeBytes).toBe(5);
    expect(progress[progress.length - 1]).toEqual([5, 5]);
  });

  it('reports mismatch without changing the file', async () => {
    const root = await createProjectRoot();
    const filePath = path.join(root, 'hello.txt');
    await writeFile(filePath, 'hello', 'utf8');
    const verifier = new NodeSha256FileVerifier(root);

    const result = await verifier.verify({
      file: createProjectFile('hello.txt', 'a'.repeat(64))
    });

    expect(result.matchesExpected).toBe(false);
    await expect(verifier.verify({
      file: createProjectFile('missing.txt')
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('supports cancellation and rejects malformed expected checksums', async () => {
    const root = await createProjectRoot();
    await writeFile(path.join(root, 'hello.txt'), 'hello', 'utf8');
    const verifier = new NodeSha256FileVerifier(root);
    const controller = new AbortController();
    controller.abort();

    await expect(verifier.verify({
      file: createProjectFile('hello.txt'),
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'aborted' });

    await expect(verifier.verify({
      file: createProjectFile('hello.txt'),
      expectedChecksum: 'invalid'
    })).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_expected_checksum'
      })
    );
  });
});

describe('file status probe and recovery planner', () => {
  it('returns available for a readable file with matching evidence', async () => {
    const root = await createProjectRoot();
    await writeFile(path.join(root, 'hello.txt'), 'hello', 'utf8');
    const probe = new NodeFileStatusProbe(root);

    const result = await probe.inspect(
      createProjectFile('hello.txt', helloChecksum)
    );

    expect(result.recommendedState).toBe('available');
    expect(result.issues).toEqual([]);
    expect(result.verification?.matchesExpected).toBe(true);
    expect(planFileRecovery(result).actions).toEqual([]);
  });

  it('maps missing and checksum mismatch to explicit recovery actions', async () => {
    const root = await createProjectRoot();
    const probe = new NodeFileStatusProbe(root);

    const missing = await probe.inspect(createProjectFile('missing.txt'));
    const missingPlan = planFileRecovery(missing);
    expect(missing.recommendedState).toBe('missing');
    expect(missingPlan.actions).toEqual(['relink_file', 'restore_backup']);

    await writeFile(path.join(root, 'changed.txt'), 'changed', 'utf8');
    const corrupted = await probe.inspect(
      createProjectFile('changed.txt', helloChecksum)
    );
    const corruptedPlan = planFileRecovery(corrupted);
    expect(corrupted.recommendedState).toBe('corrupted');
    expect(corruptedPlan.actions).toEqual(['restore_backup', 'redownload']);
  });
});
