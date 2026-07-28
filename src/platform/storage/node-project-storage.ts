import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectStorageAdapter } from './storage-adapter';
import {
  assertNoSymbolicLinkTraversal,
  resolveInsideRoot
} from './path-security';
import {
  toProjectRelativePath,
  type ProjectRelativePath
} from './project-paths';

export class NodeProjectStorage implements ProjectStorageAdapter {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    const normalizedRoot = rootDirectory.trim();

    if (normalizedRoot.length === 0) {
      throw new TypeError('Project storage root cannot be empty');
    }

    this.rootDirectory = path.resolve(normalizedRoot);
  }

  async readJson<T>(relativePath: ProjectRelativePath): Promise<T | undefined> {
    try {
      const target = this.resolve(relativePath);
      await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
      const content = await readFile(target, 'utf8');
      return JSON.parse(content) as T;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  async writeJsonAtomically<T>(
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

      await rename(temporary, target);
      await syncDirectoryBestEffort(parent);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(relativePath: ProjectRelativePath): Promise<void> {
    const target = this.resolve(relativePath);
    await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
    await rm(target, { force: true });
  }

  async ensureDirectory(relativePath: ProjectRelativePath): Promise<void> {
    const target = this.resolve(relativePath);
    await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
    await mkdir(target, { recursive: true });
    await assertNoSymbolicLinkTraversal(this.rootDirectory, target);
  }

  private resolve(relativePath: ProjectRelativePath): string {
    const normalizedRelativePath = toProjectRelativePath(relativePath);
    return resolveInsideRoot(this.rootDirectory, normalizedRelativePath);
  }
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
