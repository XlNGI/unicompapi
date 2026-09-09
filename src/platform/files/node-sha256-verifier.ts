import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { toIsoTimestamp } from '../../domain';
import { resolveFileReferencePathSafely } from './file-paths';
import {
  FileVerificationError,
  type FileVerificationRequest,
  type FileVerificationResult,
  type FileVerifier
} from './file-verifier';

export class NodeSha256FileVerifier implements FileVerifier {
  constructor(private readonly projectRoot: string) {}

  async verify(
    request: FileVerificationRequest
  ): Promise<FileVerificationResult> {
    let target: string;
    try {
      target = await resolveFileReferencePathSafely(this.projectRoot, request.file);
    } catch {
      throw new FileVerificationError('read_failed', 'Referenced file path is not safe');
    }
    const expectedChecksum = request.expectedChecksum ?? request.file.checksumSha256;

    if (expectedChecksum !== undefined && !/^[a-f0-9]{64}$/i.test(expectedChecksum)) {
      throw new FileVerificationError(
        'invalid_expected_checksum',
        'Expected checksum must be a SHA-256 hex digest'
      );
    }

    const metadata = await this.readFileMetadata(target);

    if (request.signal?.aborted) {
      throw new FileVerificationError('aborted', 'File verification was cancelled');
    }

    const hash = createHash('sha256');
    let processedBytes = 0;
    const stream = createReadStream(target, {
      signal: request.signal
    });

    try {
      for await (const chunk of stream) {
        if (request.signal?.aborted) {
          throw new FileVerificationError(
            'aborted',
            'File verification was cancelled'
          );
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        processedBytes += buffer.length;
        request.onProgress?.(processedBytes, metadata.sizeBytes);
      }
    } catch (error) {
      if (error instanceof FileVerificationError) {
        throw error;
      }

      throw mapFileError(error);
    }

    const checksumSha256 = hash.digest('hex');

    return {
      sizeBytes: metadata.sizeBytes,
      checksumSha256,
      matchesExpected: expectedChecksum
        ? checksumSha256 === expectedChecksum.toLowerCase()
        : undefined,
      verifiedAt: toIsoTimestamp(new Date().toISOString())
    };
  }

  private async readFileMetadata(target: string): Promise<{ sizeBytes: number }> {
    try {
      const metadata = await stat(target);

      if (!metadata.isFile()) {
        throw new FileVerificationError(
          'not_regular_file',
          'Referenced path is not a regular file'
        );
      }

      return { sizeBytes: metadata.size };
    } catch (error) {
      if (error instanceof FileVerificationError) {
        throw error;
      }

      throw mapFileError(error);
    }
  }
}

function mapFileError(error: unknown): FileVerificationError {
  if (error instanceof FileVerificationError) {
    return error;
  }

  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return new FileVerificationError('not_found', 'Referenced file was not found');
    }

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return new FileVerificationError(
        'permission_denied',
        'Referenced file cannot be read'
      );
    }
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new FileVerificationError('aborted', 'File verification was cancelled');
  }

  return new FileVerificationError('read_failed', 'File could not be verified');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
