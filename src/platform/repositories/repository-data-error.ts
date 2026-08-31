import type { ProjectRelativePath } from '../storage';

export class RepositoryDataError extends Error {
  constructor(
    readonly path: ProjectRelativePath,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = 'RepositoryDataError';
  }
}
