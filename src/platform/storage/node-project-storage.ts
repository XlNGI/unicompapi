import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  AtomicJsonWriteOptions,
  JsonStorageLoadResult,
  ProjectStorageAdapter
} from './storage-adapter';
import { sharedFileWriteCoordinator } from './file-write-coordinator';
import {
  assertNoSymbolicLinkTraversal,
  resolveInsideRoot
} from './path-security';
import {
  toProjectRelativePath,
  type ProjectRelativePath
} from './project-paths';

export type AtomicJsonWriteStage =
  | 'temporary_synced'
  | 'before_replace'
  | 'after_replace'
  | 'directory_synced';

export interface AtomicJsonWriteEvent {
  readonly stage: AtomicJsonWriteStage;
  readonly targetPath: string;
}

export interface NodeProjectStorageOptions {
  readonly onAtomicWriteStage?: (
    event: AtomicJsonWriteEvent
  ) => void | Promise<void>;
}

export class JsonStorageDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'JsonStorageDataError';
  }
}

export class NodeProjectStorage implements ProjectStorageAdapter {
  private readonly rootDirectory: string;

  constructor(
    rootDirectory: string,
    private readonly options: NodeProjectStorageOptions = {}
  ) {
    const normalizedRoot = rootDirectory.trim();
    if (normalizedRoot.length === 0) {
      throw new TypeError('Project storage root cannot be empty');
    }
    this.rootDirectory = path.resolve(normalizedRoot);
  }

  async readJson<T>(relativePath: ProjectRelativePath): Promise<T | undefined> {
    return this.withExclusiveAccess([relativePath], () =>
      this.readJsonUnlocked<T>(relativePath)
    );
  }

  async readJsonWithBackup<T>(
    relativePath: ProjectRelativePath,
    parse: (value: unknown) => T
  ): Promise<JsonStorageLoadResult<T> | undefined> {
    const backupPath = backupRelativePath(relativePath);
    return this.withExclusiveAccess([relativePath, backupPath], async () => {
      let primaryError: unknown;
      try {
        const primary = await this.readJsonUnlocked<unknown>(relativePath);
        if (primary !== undefined) return { value: parse(primary), source: 'primary' };
      } catch (error) {
        primaryError = error;
      }

      try {
        const backup = await this.readJsonUnlocked<unknown>(backupPath);
        if (backup !== undefined) return { value: parse(backup), source: 'backup' };
      } catch (backupError) {
        throw new JsonStorageDataError(
          `${relativePath}: primary and backup JSON are invalid`,
          { primaryError, backupError }
        );
      }

      if (primaryError !== undefined) {
        throw primaryError;
      }
      return undefined;
    });
  }

  async writeJsonAtomically<T>(
    relativePath: ProjectRelativePath,
    value: T,
    options: AtomicJsonWriteOptions = {}
  ): Promise<void> {
    const paths = options.backup
      ? [relativePath, backupRelativePath(relativePath)]
      : [relativePath];
    await this.withExclusiveAccess(paths, async () => {
      await this.writeWithOptionalBackupUnlocked(relativePath, value, options);
    });
  }

  async mutateJsonAtomically<T>(
    relativePath: ProjectRelativePath,
    mutate: (current: unknown | undefined) => T | Promise<T>,
    options: AtomicJsonWriteOptions = {}
  ): Promise<T> {
    const paths = options.backup
      ? [relativePath, backupRelativePath(relativePath)]
      : [relativePath];
    return this.withExclusiveAccess(paths, async () => {
      const current = await this.readJsonUnlocked<unknown>(relativePath);
      const next = await mutate(current);
      await this.writeWithOptionalBackupUnlocked(relativePath, next, options, current);
      return next;
    });
  }

  async withExclusiveAccess<T>(
    relativePaths: readonly ProjectRelativePath[],
    operation: () => Promise<T>
  ): Promise<T> {
    const targets = relativePaths.map((relativePath) => this.resolve(relativePath));
    return sharedFileWriteCoordinator.runExclusiveMany(targets, operation);
  }

  async remove(relativePath: ProjectRelativePath): Promise<void> {
    await this.withExclusiveAccess([relativePath], async () => {
      const target = this.resolve(relativePath);
      await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
      await rm(target, { force: true });
    });
  }

  async ensureDirectory(relativePath: ProjectRelativePath): Promise<void> {
    await this.withExclusiveAccess([relativePath], async () => {
      const target = this.resolve(relativePath);
      await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
      await mkdir(target, { recursive: true });
      await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
    });
  }

  private async readJsonUnlocked<T>(
    relativePath: ProjectRelativePath
  ): Promise<T | undefined> {
    try {
      const target = this.resolve(relativePath);
      await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
      return JSON.parse(await readFile(target, 'utf8')) as T;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async writeWithOptionalBackupUnlocked<T>(
    relativePath: ProjectRelativePath,
    value: T,
    options: AtomicJsonWriteOptions,
    knownCurrent?: unknown
  ): Promise<void> {
    if (options.backup) {
      const current = knownCurrent ?? await this.readJsonUnlocked<unknown>(relativePath);
      if (current !== undefined) {
        await this.writeJsonUnlocked(backupRelativePath(relativePath), current);
      }
    }
    await this.writeJsonUnlocked(relativePath, value);
  }

  private async writeJsonUnlocked<T>(
    relativePath: ProjectRelativePath,
    value: T
  ): Promise<void> {
    const target = this.resolve(relativePath);
    const parent = path.dirname(target);
    const temporary = path.join(
      parent,
      `.${path.basename(target)}.${randomUUID()}.tmp`
    );

    await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
    await mkdir(parent, { recursive: true });
    await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.emitStage('temporary_synced', target);
      await this.emitStage('before_replace', target);
      await rename(temporary, target);
      await this.emitStage('after_replace', target);
      await syncDirectoryBestEffort(parent);
      await this.emitStage('directory_synced', target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private emitStage(stage: AtomicJsonWriteStage, targetPath: string): Promise<void> {
    return Promise.resolve(this.options.onAtomicWriteStage?.({ stage, targetPath }));
  }

  private resolve(relativePath: ProjectRelativePath): string {
    return resolveInsideRoot(
      this.rootDirectory,
      toProjectRelativePath(relativePath)
    );
  }
}

function backupRelativePath(relativePath: ProjectRelativePath): ProjectRelativePath {
  return toProjectRelativePath(`${relativePath}.bak`);
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
