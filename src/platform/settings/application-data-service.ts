import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LocalApplicationDataScope } from '../../shared/settings-ipc';

export interface ApplicationDataFile {
  readonly target: string;
  readonly root: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

export interface ApplicationDataPlan {
  readonly scopes: readonly LocalApplicationDataScope[];
  readonly files: readonly ApplicationDataFile[];
  readonly fileCount: number;
  readonly bytes: number;
  readonly projectsExcluded: true;
  readonly externalFilesExcluded: true;
}

export interface ApplicationDataExecutionResult {
  readonly deletedFileCount: number;
  readonly deletedBytes: number;
}

export class ApplicationDataOperationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ApplicationDataOperationError';
  }
}

export class ApplicationDataService {
  constructor(private readonly userDataPath: string, private readonly maximumFileCount = 100_000) {}

  async plan(scopes: readonly LocalApplicationDataScope[]): Promise<ApplicationDataPlan> {
    const unique = [...new Set(scopes)];
    if (unique.length === 0) throw new TypeError('Application data scopes are empty');
    const roots = rootsFor(this.userDataPath, unique);
    const files: ApplicationDataFile[] = [];
    for (const root of roots) await visit(root, root, files, this.maximumFileCount);
    return {
      scopes: unique,
      files: files.sort((left, right) => left.target.localeCompare(right.target)),
      fileCount: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      projectsExcluded: true,
      externalFilesExcluded: true
    };
  }

  async execute(plan: ApplicationDataPlan): Promise<ApplicationDataExecutionResult> {
    let deletedFileCount = 0;
    let deletedBytes = 0;
    for (const file of plan.files) {
      let metadata;
      try {
        metadata = await lstat(file.target);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue;
        throw new ApplicationDataOperationError('Application data could not be cleared', error);
      }
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes ||
        metadata.mtimeMs !== file.modifiedMs || !isInside(file.root, file.target)) {
        throw new ApplicationDataOperationError('Application data target changed after planning');
      }
      try {
        await rm(file.target, { force: true });
      } catch (error) {
        throw new ApplicationDataOperationError('Application data cleanup stopped after a file error', error);
      }
      deletedFileCount += 1;
      deletedBytes += file.bytes;
    }
    return { deletedFileCount, deletedBytes };
  }
}

function rootsFor(userDataPath: string, scopes: readonly LocalApplicationDataScope[]): string[] {
  const roots: string[] = [];
  const add = (...relative: string[]) => roots.push(...relative.map((item) => path.join(userDataPath, item)));
  if (scopes.includes('settings')) add('settings/settings.json.bak');
  if (scopes.includes('directory_authorizations')) add('settings/directories.json');
  if (scopes.includes('provider_registry')) add('provider-registry.json');
  if (scopes.includes('local_credentials')) add('secure-credentials.json', 'settings/proxy-credentials.json');
  if (scopes.includes('project_catalog')) add('project-catalog.json');
  if (scopes.includes('logs')) add('logs');
  if (scopes.includes('caches')) add('cache', 'tmp');
  return roots;
}

async function visit(root: string, current: string, result: ApplicationDataFile[], maximum: number): Promise<void> {
  if (result.length >= maximum) throw new Error('Application data file count exceeds limit');
  let metadata;
  try {
    metadata = await lstat(current);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    result.push({ target: current, root, bytes: metadata.size, modifiedMs: metadata.mtimeMs });
    return;
  }
  if (!metadata.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    await visit(root, path.join(current, entry.name), result, maximum);
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
