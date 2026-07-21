import type { ProjectRelativePath } from './project-paths';

export interface ProjectStorageAdapter {
  readJson<T>(path: ProjectRelativePath): Promise<T | undefined>;
  writeJsonAtomically<T>(path: ProjectRelativePath, value: T): Promise<void>;
  remove(path: ProjectRelativePath): Promise<void>;
  ensureDirectory(path: ProjectRelativePath): Promise<void>;
}
