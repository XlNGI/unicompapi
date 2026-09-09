import path from 'node:path';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { FileReference } from '../../domain';
import { resolveFileReferencePathSafely } from './file-paths';
import {
  FileVerificationError,
  type FileVerificationRequest
} from './file-verifier';
import { NodeSha256FileVerifier } from './node-sha256-verifier';
import type {
  FileProbeIssue,
  FileStatusProbe,
  FileStatusProbeResult
} from './file-status-probe';

export class NodeFileStatusProbe implements FileStatusProbe {
  private readonly verifier: NodeSha256FileVerifier;

  constructor(private readonly projectRoot: string) {
    this.verifier = new NodeSha256FileVerifier(projectRoot);
  }

  async inspect(
    file: FileReference,
    request: Omit<FileVerificationRequest, 'file'> = {}
  ): Promise<FileStatusProbeResult> {
    let target: string;

    try {
      target = await resolveFileReferencePathSafely(this.projectRoot, file);
    } catch {
      return {
        recommendedState: 'missing',
        issues: ['invalid_path']
      };
    }

    if (await this.isDisconnected(target, file)) {
      return {
        recommendedState: 'disconnected',
        issues: ['storage_disconnected']
      };
    }

    try {
      const metadata = await stat(target);

      if (!metadata.isFile()) {
        return {
          recommendedState: 'corrupted',
          issues: ['not_a_regular_file']
        };
      }

      try {
        await access(target, constants.R_OK);
      } catch {
        return {
          recommendedState: 'read_only',
          issues: ['permission_denied']
        };
      }

      const issues: FileProbeIssue[] = [];

      if (file.locator.kind === 'project') {
        try {
          await access(path.dirname(target), constants.W_OK);
        } catch {
          issues.push('project_directory_read_only');
        }
      }

      let verification: FileStatusProbeResult['verification'];

      try {
        verification = await this.verifier.verify({
          ...request,
          file
        });
      } catch (error) {
        if (
          error instanceof FileVerificationError &&
          error.code === 'permission_denied'
        ) {
          return {
            recommendedState: 'read_only',
            issues: ['permission_denied']
          };
        }

        throw error;
      }

      if (verification.matchesExpected === false) {
        issues.push('checksum_mismatch');
      }

      return {
        recommendedState: issues.includes('checksum_mismatch')
          ? 'corrupted'
          : issues.includes('project_directory_read_only')
            ? 'read_only'
            : 'available',
        issues,
        verification
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          recommendedState: 'missing',
          issues: ['not_found']
        };
      }

      if (
        error instanceof FileVerificationError &&
        error.code === 'not_found'
      ) {
        return {
          recommendedState: 'missing',
          issues: ['not_found']
        };
      }

      throw error;
    }
  }

  private async isDisconnected(
    target: string,
    file: FileReference
  ): Promise<boolean> {
    if (file.locator.kind !== 'external') {
      return false;
    }

    try {
      await stat(path.parse(target).root);
      return false;
    } catch {
      return true;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
