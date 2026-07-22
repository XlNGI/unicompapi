import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { toWorkId } from '../../domain';
import type {
  StorageIpcResult,
  StorageLocalMediaHandleDto
} from '../../shared/storage-ipc';
import { resolveFileReferencePath } from '../files';
import {
  JsonFileReferenceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { ProjectCatalogService } from './project-catalog';

interface MediaHandleEntry {
  readonly target: string;
  readonly expiresAtMs: number;
}

export class LocalMediaHandleRegistry {
  private readonly handles = new Map<string, MediaHandleEntry>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 5 * 60 * 1000
  ) {}

  create(target: string): { readonly url: string; readonly expiresAt: string } {
    this.removeExpired();
    const token = randomUUID();
    const expiresAtMs = this.now() + this.ttlMs;
    this.handles.set(token, { target, expiresAtMs });
    return {
      url: `unicomp-media://local/${token}`,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  resolve(token: string): string | undefined {
    const entry = this.handles.get(token);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      this.handles.delete(token);
      return undefined;
    }
    return entry.target;
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.handles) {
      if (entry.expiresAtMs <= now) this.handles.delete(token);
    }
  }
}

export interface ControlledLocalMediaDependencies {
  readonly catalog: ProjectCatalogService;
  readonly handles: LocalMediaHandleRegistry;
  revealFile(target: string): void;
}

export class ControlledLocalMediaController {
  constructor(private readonly dependencies: ControlledLocalMediaDependencies) {}

  async createHandle(
    request: unknown
  ): Promise<StorageIpcResult<StorageLocalMediaHandleDto>> {
    try {
      const resolved = await this.resolveWorkFile(parseWorkId(request));
      if (!['image', 'video', 'audio'].includes(resolved.mediaKind)) {
        throw new LocalMediaError('media_unavailable');
      }
      const handle = this.dependencies.handles.create(resolved.target);
      return {
        ok: true,
        value: { ...handle, mediaKind: resolved.mediaKind }
      };
    } catch (error) {
      return mapError(error);
    }
  }

  async revealWorkFile(
    request: unknown
  ): Promise<StorageIpcResult<{ readonly revealed: true }>> {
    try {
      const resolved = await this.resolveWorkFile(parseWorkId(request));
      this.dependencies.revealFile(resolved.target);
      return { ok: true, value: { revealed: true } };
    } catch (error) {
      return mapError(error);
    }
  }

  private async resolveWorkFile(workId: string) {
    for (const entry of await this.dependencies.catalog.getEntries()) {
      let work;
      try {
        const storage = new NodeProjectStorage(entry.rootDirectory);
        work = await new JsonWorkRepository(
          storage,
          entry.projectId
        ).get(toWorkId(workId));
        if (!work) continue;
      } catch {
        continue;
      }

      try {
        const storage = new NodeProjectStorage(entry.rootDirectory);
        const file = await new JsonFileReferenceRepository(
          storage,
          entry.projectId
        ).get(work.fileId);
        if (!file || file.state !== 'available') {
          throw new LocalMediaError('media_unavailable');
        }
        const target = resolveFileReferencePath(entry.rootDirectory, file);
        const metadata = await stat(target);
        if (!metadata.isFile()) {
          throw new LocalMediaError('media_unavailable');
        }
        return { target, mediaKind: work.mediaKind };
      } catch (error) {
        if (error instanceof LocalMediaError) throw error;
        throw new LocalMediaError('media_unavailable');
      }
    }
    throw new LocalMediaError('work_not_found');
  }
}

class LocalMediaError extends Error {
  constructor(readonly code: 'work_not_found' | 'media_unavailable') {
    super(code);
    this.name = 'LocalMediaError';
  }
}

function parseWorkId(request: unknown): string {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('workId' in request) ||
    typeof request.workId !== 'string' ||
    request.workId.trim().length === 0
  ) {
    throw new LocalMediaError('work_not_found');
  }
  return request.workId.trim();
}

function mapError<T>(error: unknown): StorageIpcResult<T> {
  if (error instanceof LocalMediaError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.code === 'work_not_found'
          ? 'The requested work does not exist'
          : 'The local media file is not available'
      }
    };
  }
  return {
    ok: false,
    error: {
      code: 'media_unavailable',
      message: 'The local media operation failed'
    }
  };
}
