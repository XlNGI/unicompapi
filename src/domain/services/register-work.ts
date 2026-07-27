import { WorkRegistrationRejectedError } from '../errors';
import type { FileReference } from '../entities/file-reference';
import type { Execution } from '../entities/execution';
import type { Task } from '../entities/task';
import type { Work } from '../entities/work';
import type { WorkId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';
import type { MediaKind } from '../entities/asset';

export interface RegisterWorkInput {
  readonly id: WorkId;
  readonly task: Task;
  readonly execution: Execution;
  readonly file: FileReference;
  readonly mediaKind: MediaKind;
  readonly name: string;
  readonly parentWorkId?: WorkId;
  readonly createdAt: IsoTimestamp;
}

export function registerWork(input: RegisterWorkInput): Work {
  if (input.execution.taskId !== input.task.id) {
    throw new WorkRegistrationRejectedError(
      'execution does not belong to source task'
    );
  }

  if (!input.task.executionIds.includes(input.execution.id)) {
    throw new WorkRegistrationRejectedError(
      'execution is not linked to source task'
    );
  }

  if (
    input.execution.state !== 'completed' &&
    input.execution.state !== 'registering_work'
  ) {
    throw new WorkRegistrationRejectedError(
      'execution is not ready for local work registration'
    );
  }

  if (
    input.execution.state === 'registering_work' &&
    (!input.execution.exportPlanId || input.execution.outputFileId !== input.file.id)
  ) {
    throw new WorkRegistrationRejectedError(
      'local export execution has not linked its verified output'
    );
  }

  if (
    input.file.state !== 'available' ||
    !input.file.checksumSha256 ||
    input.file.sizeBytes === undefined
  ) {
    throw new WorkRegistrationRejectedError(
      'file has not completed local verification'
    );
  }

  if (input.file.projectId !== input.task.projectId) {
    throw new WorkRegistrationRejectedError(
      'file belongs to another project'
    );
  }

  if (input.file.sourceExecutionId !== input.execution.id) {
    throw new WorkRegistrationRejectedError(
      'file is not produced by source execution'
    );
  }

  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.task.projectId,
    sourceTaskId: input.task.id,
    sourceExecutionId: input.execution.id,
    fileId: input.file.id,
    mediaKind: input.mediaKind,
    name: requireNonBlank(input.name, 'work.name'),
    parentWorkId: input.parentWorkId,
    createdAt: input.createdAt
  };
}
