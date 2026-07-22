import type { FileReference, IsoTimestamp } from '../../domain';

export type FileVerificationErrorCode =
  | 'not_found'
  | 'not_regular_file'
  | 'permission_denied'
  | 'aborted'
  | 'invalid_expected_checksum'
  | 'read_failed';

export class FileVerificationError extends Error {
  constructor(
    readonly code: FileVerificationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FileVerificationError';
  }
}

export interface FileVerificationRequest {
  readonly file: FileReference;
  readonly expectedChecksum?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (processedBytes: number, totalBytes: number) => void;
}

export interface FileVerificationResult {
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly matchesExpected: boolean | undefined;
  readonly verifiedAt: IsoTimestamp;
}

export interface FileVerifier {
  verify(request: FileVerificationRequest): Promise<FileVerificationResult>;
}
