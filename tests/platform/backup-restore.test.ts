import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  type FileReference
} from '../../src/domain';
import {
  NodeBackupRestoreExecutor
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2020-01-01T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-backup-restore-'));
  roots.push(root);
  return root;
}

function fileReference(
  id: string,
  locator: FileReference['locator'],
  checksumSha256?: string
): FileReference {
  return {
    schemaVersion: 1,
    id: toFileReferenceId(id),
    projectId: toProjectId('backup-project'),
    locator,
    state: 'missing',
    checksumSha256,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

describe('NodeBackupRestoreExecutor', () => {
  it('restores a verified backup into a project-managed target', async () => {
    const root = await createRoot();
    const backupPath = path.join(root, 'backup.bin');
    const content = 'verified backup bytes';
    await writeFile(backupPath, content);
    const executor = new NodeBackupRestoreExecutor(root);

    const result = await executor.restore({
      confirmed: true,
      target: fileReference(
        'target',
        { kind: 'project', relativePath: 'files/restored.bin' },
        sha256(content)
      ),
      backup: fileReference('backup', {
        kind: 'external',
        absolutePath: backupPath
      })
    });

    await expect(
      readFile(path.join(root, 'files', 'restored.bin'), 'utf8')
    ).resolves.toBe(content);
    expect(result.verification.matchesExpected).toBe(true);
  });

  it('does not replace the target when backup verification fails', async () => {
    const root = await createRoot();
    const backupPath = path.join(root, 'backup.bin');
    const targetPath = path.join(root, 'target.bin');
    await writeFile(backupPath, 'wrong backup');
    await writeFile(targetPath, 'existing target');
    const executor = new NodeBackupRestoreExecutor(root);

    await expect(
      executor.restore({
        confirmed: true,
        target: fileReference(
          'target',
          { kind: 'project', relativePath: 'target.bin' },
          sha256('expected backup')
        ),
        backup: fileReference('backup', {
          kind: 'external',
          absolutePath: backupPath
        })
      })
    ).rejects.toMatchObject({
      code: 'backup_verification_failed'
    });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('existing target');
  });

  it('requires confirmation, checksum evidence, and a project target', async () => {
    const root = await createRoot();
    const backup = fileReference('backup', {
      kind: 'external',
      absolutePath: path.join(root, 'backup.bin')
    });
    const executor = new NodeBackupRestoreExecutor(root);

    await expect(
      executor.restore({
        confirmed: false,
        target: fileReference('target', {
          kind: 'project',
          relativePath: 'target.bin'
        }),
        backup
      })
    ).rejects.toMatchObject({ code: 'confirmation_required' });

    await expect(
      executor.restore({
        confirmed: true,
        target: fileReference('target', {
          kind: 'external',
          absolutePath: path.join(root, 'target.bin')
        }),
        backup
      })
    ).rejects.toMatchObject({ code: 'project_target_required' });

    await expect(
      executor.restore({
        confirmed: true,
        target: fileReference('target', {
          kind: 'project',
          relativePath: 'target.bin'
        }),
        backup
      })
    ).rejects.toMatchObject({ code: 'checksum_required' });
  });
});
