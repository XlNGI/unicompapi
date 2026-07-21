import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectStorageAdapter } from './storage-adapter';
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
      const content = await readFile(this.resolve(relativePath), 'utf8');
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

    await mkdir(parent, { recursive: true });

    try {
      const handle = await open(temporary, 'wx');

      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(relativePath: ProjectRelativePath): Promise<void> {
    await rm(this.resolve(relativePath), { force: true });
  }

  async ensureDirectory(relativePath: ProjectRelativePath): Promise<void> {
    await mkdir(this.resolve(relativePath), { recursive: true });
  }

  private resolve(relativePath: ProjectRelativePath): string {
    const normalizedRelativePath = toProjectRelativePath(relativePath);
    const root = path.resolve(this.rootDirectory);
    const target = path.resolve(root, normalizedRelativePath);
    const rootPrefix = `${root}${path.sep}`;

    if (target !== root && !target.startsWith(rootPrefix)) {
      throw new TypeError('Storage path resolves outside project root');
    }

    return target;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
