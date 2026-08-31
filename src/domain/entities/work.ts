import type {
  ExecutionId,
  FileReferenceId,
  ProjectId,
  TaskId,
  WorkId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import type { MediaKind } from './asset';

export interface Work {
  readonly schemaVersion: 1;
  readonly id: WorkId;
  readonly projectId: ProjectId;
  readonly sourceTaskId: TaskId;
  readonly sourceExecutionId: ExecutionId;
  readonly fileId: FileReferenceId;
  readonly mediaKind: MediaKind;
  readonly name: string;
  readonly parentWorkId?: WorkId;
  readonly createdAt: IsoTimestamp;
}
