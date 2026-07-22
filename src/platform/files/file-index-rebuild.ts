import type {
  FileReferenceRepository,
  ProjectId
} from '../../domain';
import {
  createEmptyProjectFileIndex,
  toProjectRelativePath,
  upsertFileIndexEntry,
  type FileIndexEntry
} from '../storage';
import type { JsonFileIndexRepository } from '../repositories';

export type FileIndexRebuildErrorCode =
  | 'invalid_project_path'
  | 'duplicate_project_path';

export class FileIndexRebuildError extends Error {
  constructor(
    readonly code: FileIndexRebuildErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FileIndexRebuildError';
  }
}

export interface FileIndexRebuildReport {
  readonly sourceFileCount: number;
  readonly indexedFileCount: number;
  readonly skippedExternalFileCount: number;
}

export class FileIndexRebuildService {
  constructor(
    private readonly projectId: ProjectId,
    private readonly fileRepository: FileReferenceRepository,
    private readonly indexRepository: JsonFileIndexRepository
  ) {}

  async rebuild(): Promise<FileIndexRebuildReport> {
    const files = await this.fileRepository.list(this.projectId);
    let index = createEmptyProjectFileIndex(this.projectId);
    let skippedExternalFileCount = 0;

    for (const file of files) {
      if (file.locator.kind === 'external') {
        skippedExternalFileCount += 1;
        continue;
      }

      let entry: FileIndexEntry;

      try {
        entry = {
          fileId: file.id,
          relativePath: toProjectRelativePath(file.locator.relativePath),
          state: file.state,
          sizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256,
          updatedAt: file.updatedAt
        };
      } catch {
        throw new FileIndexRebuildError(
          'invalid_project_path',
          `File ${file.id} has an invalid project-relative path`
        );
      }

      try {
        index = upsertFileIndexEntry(index, entry);
      } catch {
        throw new FileIndexRebuildError(
          'duplicate_project_path',
          'Multiple file references claim the same project-relative path'
        );
      }
    }

    await this.indexRepository.replace(index.entries);

    return {
      sourceFileCount: files.length,
      indexedFileCount: index.entries.length,
      skippedExternalFileCount
    };
  }
}
