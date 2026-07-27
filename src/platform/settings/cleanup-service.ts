import { lstat, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CleanupScope } from '../../shared/settings-ipc';
import type { DirectoryRegistry } from './directory-registry';
import { StorageOperationError } from './directory-migration';

interface CleanupFile {
  readonly target: string;
  readonly root: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

export interface CleanupPlan {
  readonly scopes: readonly CleanupScope[];
  readonly fileCount: number;
  readonly bytes: number;
  readonly files: readonly CleanupFile[];
}

export interface CleanupExecutionResult {
  readonly deletedFileCount: number;
  readonly deletedBytes: number;
}

const cleanupScopes: readonly CleanupScope[] = [
  'caches',
  'preview_proxies',
  'temporary_exports',
  'eligible_logs'
];

export class CleanupService {
  constructor(
    private readonly userDataPath: string,
    private readonly registry: DirectoryRegistry,
    private readonly maximumFileCount = 100_000
  ) {}

  async plan(
    scopes: readonly CleanupScope[],
    options: { readonly logRetentionDays: number; readonly nowMs: number }
  ): Promise<CleanupPlan> {
    const uniqueScopes = [...new Set(scopes)];
    if (
      uniqueScopes.length === 0 ||
      uniqueScopes.some((scope) => !cleanupScopes.includes(scope))
    ) {
      throw new TypeError('Cleanup scopes are invalid');
    }
    const roots = await this.resolveRoots(uniqueScopes);
    const files = new Map<string, CleanupFile>();
    for (const root of roots) {
      const scanned = await scanCleanupRoot(
        root.path,
        this.maximumFileCount - files.size,
        root.scope === 'eligible_logs'
          ? options.nowMs - options.logRetentionDays * 24 * 60 * 60 * 1000
          : undefined
      );
      for (const file of scanned) files.set(normalizeKey(file.target), file);
    }
    const list = [...files.values()].sort((left, right) =>
      left.target.localeCompare(right.target)
    );
    return Object.freeze({
      scopes: Object.freeze(uniqueScopes),
      fileCount: list.length,
      bytes: list.reduce((total, file) => total + file.bytes, 0),
      files: Object.freeze(list.map((file) => Object.freeze(file)))
    });
  }

  async execute(plan: CleanupPlan): Promise<CleanupExecutionResult> {
    let deletedFileCount = 0;
    let deletedBytes = 0;
    for (const file of plan.files) {
      try {
        const metadata = await lstat(file.target);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.size !== file.bytes ||
          metadata.mtimeMs !== file.modifiedMs ||
          !isInside(file.root, file.target)
        ) {
          throw new StorageOperationError(
            'cleanup_target_changed',
            'A cleanup target changed after planning'
          );
        }
        await rm(file.target, { force: true });
        deletedFileCount += 1;
        deletedBytes += file.bytes;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue;
        throw error instanceof StorageOperationError
          ? error
          : new StorageOperationError('cleanup_partial', 'Cleanup stopped after a file error', error);
      }
    }
    return { deletedFileCount, deletedBytes };
  }

  private async resolveRoots(
    scopes: readonly CleanupScope[]
  ): Promise<readonly { readonly scope: CleanupScope; readonly path: string }[]> {
    const result: { scope: CleanupScope; path: string }[] = [];
    const registrations = await this.registry.list();
    const protectedRoots = registrations
      .filter((entry) => !['cache', 'projects'].includes(entry.purpose))
      .map((entry) => entry.directoryPath);
    const cacheRoots = registrations
      .filter((entry) => entry.purpose === 'cache')
      .map((entry) => entry.directoryPath)
      .filter((root) => isSafeManagedRoot(root))
      .filter((root) => !protectedRoots.some((protectedRoot) => overlaps(root, protectedRoot)));
    const projectRoots = registrations
      .filter((entry) => entry.purpose === 'projects')
      .map((entry) => entry.directoryPath)
      .filter((root) => isSafeManagedRoot(root));

    if (scopes.includes('caches')) {
      result.push({ scope: 'caches', path: path.join(this.userDataPath, 'cache') });
      result.push(...cacheRoots.map((root) => ({ scope: 'caches' as const, path: root })));
    }
    if (scopes.includes('preview_proxies')) {
      result.push({
        scope: 'preview_proxies',
        path: path.join(this.userDataPath, 'cache', 'video-editor-preview')
      });
      result.push(...cacheRoots.map((root) => ({
        scope: 'preview_proxies' as const,
        path: path.join(root, 'video-editor-preview')
      })));
      result.push(...await projectManagedRoots(projectRoots, 'cache/video-editor-preview', 'preview_proxies'));
    }
    if (scopes.includes('temporary_exports')) {
      result.push({
        scope: 'temporary_exports',
        path: path.join(this.userDataPath, 'tmp', 'exports')
      });
      result.push(...await projectManagedRoots(projectRoots, 'tmp/editor', 'temporary_exports'));
    }
    if (scopes.includes('eligible_logs')) {
      result.push({ scope: 'eligible_logs', path: path.join(this.userDataPath, 'logs') });
    }
    return result.filter((root) =>
      isSafeManagedRoot(root.path) &&
      !protectedRoots.some((protectedRoot) => overlaps(root.path, protectedRoot))
    );
  }
}

async function projectManagedRoots(
  projectRoots: readonly string[],
  relativeManagedPath: string,
  scope: CleanupScope
): Promise<readonly { readonly scope: CleanupScope; readonly path: string }[]> {
  const result: { scope: CleanupScope; path: string }[] = [];
  for (const root of projectRoots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        result.push({ scope, path: path.join(root, entry.name, relativeManagedPath) });
      }
    }
  }
  return result;
}

async function scanCleanupRoot(
  root: string,
  maximumFileCount: number,
  modifiedBeforeMs?: number
): Promise<readonly CleanupFile[]> {
  if (maximumFileCount <= 0) {
    throw new StorageOperationError('scan_limit_exceeded', 'Cleanup scan limit exceeded');
  }
  try {
    if (!(await stat(root)).isDirectory()) return [];
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    return [];
  }
  const files: CleanupFile[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() ?? root;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (!isInside(root, target)) {
        throw new StorageOperationError('cleanup_boundary_violation', 'Cleanup boundary violation');
      }
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maximumFileCount) {
        throw new StorageOperationError('scan_limit_exceeded', 'Cleanup scan limit exceeded');
      }
      const metadata = await lstat(target);
      if (modifiedBeforeMs !== undefined && metadata.mtimeMs >= modifiedBeforeMs) continue;
      files.push({ target, root, bytes: metadata.size, modifiedMs: metadata.mtimeMs });
    }
  }
  return files;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSafeManagedRoot(target: string): boolean {
  const resolved = path.resolve(target);
  return !samePath(resolved, path.parse(resolved).root) && !samePath(resolved, os.homedir());
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = path.relative(path.resolve(left), path.resolve(right));
  const rightToLeft = path.relative(path.resolve(right), path.resolve(left));
  return leftToRight === '' ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
