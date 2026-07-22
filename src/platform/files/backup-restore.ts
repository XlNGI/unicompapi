import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FileReference } from '../../domain';
import { resolveFileReferencePath } from './file-paths';
import { NodeSha256FileVerifier } from './node-sha256-verifier';
import type { FileVerificationResult } from './file-verifier';

export type BackupRestoreErrorCode =
  | 'confirmation_required'
  | 'project_target_required'
  | 'checksum_required'
  | 'backup_verification_failed'
  | 'restore_failed';

export class BackupRestoreError extends Error {
  constructor(
    readonly code: BackupRestoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BackupRestoreError';
  }
}

export interface BackupRestoreRequest {
  readonly target: FileReference;
  readonly backup: FileReference;
  readonly confirmed: boolean;
}

export interface BackupRestoreResult {
  readonly verification: FileVerificationResult;
}

export class NodeBackupRestoreExecutor {
  constructor(private readonly projectRoot: string) {}

  async restore(request: BackupRestoreRequest): Promise<BackupRestoreResult> {
    if (!request.confirmed) {
      throw new BackupRestoreError(
        'confirmation_required',
        'Backup restore requires explicit user confirmation'
      );
    }

    if (request.target.locator.kind !== 'project') {
      throw new BackupRestoreError(
        'project_target_required',
        'Backup restore can only replace project-managed files'
      );
    }

    const expectedChecksum = request.target.checksumSha256;
    if (!expectedChecksum) {
      throw new BackupRestoreError(
        'checksum_required',
        'Backup restore requires recorded SHA-256 evidence'
      );
    }

    const source = resolveFileReferencePath(this.projectRoot, request.backup);
    const target = resolveFileReferencePath(this.projectRoot, request.target);
    const parent = path.dirname(target);
    const temporary = path.join(
      parent,
      `.${path.basename(target)}.${randomUUID()}.restore.tmp`
    );

    await mkdir(parent, { recursive: true });

    try {
      await copyFile(source, temporary);
      await syncFile(temporary);

      const verification = await new NodeSha256FileVerifier(
        this.projectRoot
      ).verify({
        file: {
          ...request.backup,
          locator: { kind: 'external', absolutePath: temporary }
        },
        expectedChecksum
      });

      if (!verification.matchesExpected) {
        throw new BackupRestoreError(
          'backup_verification_failed',
          'Backup does not match the recorded SHA-256 evidence'
        );
      }

      await rename(temporary, target);
      return { verification };
    } catch (error) {
      if (error instanceof BackupRestoreError) {
        throw error;
      }

      throw new BackupRestoreError(
        'restore_failed',
        'Backup could not be restored safely'
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
