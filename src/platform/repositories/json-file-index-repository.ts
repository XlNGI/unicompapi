import {
  fileStates,
  toIsoTimestamp,
  type FileReferenceId,
  type ProjectId
} from '../../domain';
import {
  createEmptyProjectFileIndex,
  findFileIndexEntry,
  projectStoragePaths,
  toProjectRelativePath,
  upsertFileIndexEntry,
  type FileIndexEntry,
  type ProjectFileIndex,
  type ProjectStorageAdapter
} from '../storage';
import { RepositoryDataError } from './repository-data-error';

export class JsonFileIndexRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ProjectStorageAdapter,
    private readonly projectId: ProjectId
  ) {}

  async load(): Promise<ProjectFileIndex> {
    await this.writeQueue;
    return this.read();
  }

  async get(fileId: FileReferenceId): Promise<FileIndexEntry | undefined> {
    return findFileIndexEntry(await this.load(), fileId);
  }

  async upsert(entry: FileIndexEntry): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const index = await this.read();
      const updated = upsertFileIndexEntry(index, entry);
      await this.storage.writeJsonAtomically(projectStoragePaths.index, updated);
    });

    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<ProjectFileIndex> {
    const value = await this.storage.readJson<unknown>(projectStoragePaths.index);

    if (value === undefined) {
      return createEmptyProjectFileIndex(this.projectId);
    }

    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.projectId !== this.projectId ||
      !Array.isArray(value.entries)
    ) {
      throw new RepositoryDataError(
        projectStoragePaths.index,
        'expected a version 1 file index for this project'
      );
    }

    const ids = new Set<string>();
    const paths = new Set<string>();

    for (const entry of value.entries) {
      if (!isFileIndexEntry(entry)) {
        throw new RepositoryDataError(
          projectStoragePaths.index,
          'contains an invalid file index entry'
        );
      }

      if (ids.has(entry.fileId) || paths.has(entry.relativePath)) {
        throw new RepositoryDataError(
          projectStoragePaths.index,
          'contains duplicate file IDs or paths'
        );
      }

      ids.add(entry.fileId);
      paths.add(entry.relativePath);
    }

    return value as unknown as ProjectFileIndex;
  }
}

function isFileIndexEntry(value: unknown): value is FileIndexEntry {
  if (
    !isRecord(value) ||
    typeof value.fileId !== 'string' ||
    value.fileId.trim().length === 0 ||
    typeof value.relativePath !== 'string' ||
    !fileStates.includes(value.state as (typeof fileStates)[number]) ||
    (value.sizeBytes !== undefined &&
      (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0)) ||
    (value.checksumSha256 !== undefined &&
      (typeof value.checksumSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.checksumSha256))) ||
    typeof value.updatedAt !== 'string'
  ) {
    return false;
  }

  try {
    toProjectRelativePath(value.relativePath);
    toIsoTimestamp(value.updatedAt);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
