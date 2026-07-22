import type { FileState } from '../../domain';
import type { FileVerificationResult } from './file-verifier';

export type FileProbeIssue =
  | 'not_found'
  | 'storage_disconnected'
  | 'permission_denied'
  | 'not_a_regular_file'
  | 'checksum_mismatch'
  | 'project_directory_read_only'
  | 'invalid_path';

export interface FileStatusProbeResult {
  readonly recommendedState: FileState;
  readonly issues: readonly FileProbeIssue[];
  readonly verification?: FileVerificationResult;
}
