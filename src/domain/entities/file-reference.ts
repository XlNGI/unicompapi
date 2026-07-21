import type { ExecutionId, FileReferenceId, ProjectId } from '../ids';
import type { FileState } from '../states/file-state';
import type { IsoTimestamp } from '../timestamps';

export type FileLocator =
  | {
      readonly kind: 'project';
      readonly relativePath: string;
    }
  | {
      readonly kind: 'external';
      readonly absolutePath: string;
    };

export interface FileReference {
  readonly schemaVersion: 1;
  readonly id: FileReferenceId;
  readonly projectId: ProjectId;
  readonly sourceExecutionId?: ExecutionId;
  readonly locator: FileLocator;
  readonly state: FileState;
  readonly sizeBytes?: number;
  readonly checksumSha256?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
