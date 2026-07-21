import type { FileState } from '../../domain/states/file-state';
import type {
  FileReferenceId,
  ProjectId
} from '../../domain/ids';
import type { IsoTimestamp } from '../../domain/timestamps';
import { InvariantViolationError } from '../../domain/errors';
import {
  toProjectRelativePath,
  type ProjectRelativePath
} from './project-paths';

export interface FileIndexEntry {
  readonly fileId: FileReferenceId;
  readonly relativePath: ProjectRelativePath;
  readonly state: FileState;
  readonly sizeBytes?: number;
  readonly checksumSha256?: string;
  readonly updatedAt: IsoTimestamp;
}

export interface ProjectFileIndex {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly entries: readonly FileIndexEntry[];
}

export function createEmptyProjectFileIndex(
  projectId: ProjectId
): ProjectFileIndex {
  return {
    schemaVersion: 1,
    projectId,
    entries: []
  };
}

export function upsertFileIndexEntry(
  index: ProjectFileIndex,
  entry: FileIndexEntry
): ProjectFileIndex {
  const duplicatePath = index.entries.find(
    (current) =>
      current.relativePath === entry.relativePath && current.fileId !== entry.fileId
  );

  if (duplicatePath) {
    throw new InvariantViolationError(
      `file path is already indexed by ${duplicatePath.fileId}`
    );
  }

  const entries = index.entries.filter((current) => current.fileId !== entry.fileId);

  return {
    ...index,
    entries: [...entries, {
      ...entry,
      relativePath: toProjectRelativePath(entry.relativePath)
    }]
  };
}

export function removeFileIndexEntry(
  index: ProjectFileIndex,
  fileId: FileReferenceId
): ProjectFileIndex {
  return {
    ...index,
    entries: index.entries.filter((entry) => entry.fileId !== fileId)
  };
}

export function findFileIndexEntry(
  index: ProjectFileIndex,
  fileId: FileReferenceId
): FileIndexEntry | undefined {
  return index.entries.find((entry) => entry.fileId === fileId);
}
