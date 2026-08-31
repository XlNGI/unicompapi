import type { ProjectRelativePath } from './project-paths';

export interface JsonStorageLoadResult<T> {
  readonly value: T;
  readonly source: 'primary' | 'backup';
}

export interface AtomicJsonWriteOptions {
  readonly backup?: boolean;
}

export interface ProjectStorageAdapter {
  readJson<T>(path: ProjectRelativePath): Promise<T | undefined>;
  readJsonWithBackup<T>(
    path: ProjectRelativePath,
    parse: (value: unknown) => T
  ): Promise<JsonStorageLoadResult<T> | undefined>;
  writeJsonAtomically<T>(
    path: ProjectRelativePath,
    value: T,
    options?: AtomicJsonWriteOptions
  ): Promise<void>;
  mutateJsonAtomically<T>(
    path: ProjectRelativePath,
    mutate: (current: unknown | undefined) => T | Promise<T>,
    options?: AtomicJsonWriteOptions
  ): Promise<T>;
  withExclusiveAccess<T>(
    paths: readonly ProjectRelativePath[],
    operation: () => Promise<T>
  ): Promise<T>;
  remove(path: ProjectRelativePath): Promise<void>;
  ensureDirectory(path: ProjectRelativePath): Promise<void>;
}
