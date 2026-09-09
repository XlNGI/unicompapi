import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { toWorkId } from '../../domain';
import type {
  StorageIpcResult,
  StorageLocalMediaHandleDto
} from '../../shared/storage-ipc';
import { resolveFileReferencePathSafely } from '../files';
import {
  JsonFileReferenceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { ProjectCatalogService } from './project-catalog';

interface MediaHandleEntry {
  readonly target: string;
  readonly mimeType?: string;
  readonly expiresAtMs: number;
}

export class LocalMediaHandleRegistry {
  private readonly handles = new Map<string, MediaHandleEntry>();
  private readonly reusableHandles = new Map<string, string>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 5 * 60 * 1000
  ) {}

  create(
    target: string,
    mimeType?: string,
    reuseKey?: string
  ): { readonly url: string; readonly expiresAt: string } {
    this.removeExpired();
    const reusableToken = reuseKey ? this.reusableHandles.get(reuseKey) : undefined;
    const reusable = reusableToken ? this.resolveEntry(reusableToken) : undefined;
    if (reusableToken && reusable?.target === target && reusable.mimeType === mimeType) {
      return {
        url: `unicomp-media://local/${reusableToken}`,
        expiresAt: new Date(reusable.expiresAtMs).toISOString()
      };
    }
    if (reuseKey) this.reusableHandles.delete(reuseKey);
    const token = randomUUID();
    const expiresAtMs = this.now() + this.ttlMs;
    this.handles.set(token, { target, mimeType, expiresAtMs });
    if (reuseKey) this.reusableHandles.set(reuseKey, token);
    return {
      url: `unicomp-media://local/${token}`,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  resolve(token: string): string | undefined {
    return this.resolveEntry(token)?.target;
  }

  resolveEntry(token: string): MediaHandleEntry | undefined {
    const entry = this.handles.get(token);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      this.handles.delete(token);
      return undefined;
    }
    return entry;
  }

  clear(): void {
    this.handles.clear();
    this.reusableHandles.clear();
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.handles) {
      if (entry.expiresAtMs <= now) this.handles.delete(token);
    }
    for (const [key, token] of this.reusableHandles) {
      if (!this.handles.has(token)) this.reusableHandles.delete(key);
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
      const parsed = parseWorkRequest(request);
      const resolved = await this.resolveWorkFile(parsed.workId, parsed.projectId);
      if (!['image', 'video', 'audio'].includes(resolved.mediaKind)) {
        throw new LocalMediaError('media_unavailable');
      }
      const handle = this.dependencies.handles.create(
        resolved.target,
        undefined,
        `${resolved.projectId}:${parsed.workId}`
      );
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
      const parsed = parseWorkRequest(request);
      const resolved = await this.resolveWorkFile(parsed.workId, parsed.projectId);
      this.dependencies.revealFile(resolved.target);
      return { ok: true, value: { revealed: true } };
    } catch (error) {
      return mapError(error);
    }
  }

  private async resolveWorkFile(workId: string, projectId?: string) {
    const entries = await this.dependencies.catalog.getEntries();
    for (const entry of projectId
      ? entries.filter((candidate) => candidate.projectId === projectId)
      : entries) {
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
        const target = await resolveFileReferencePathSafely(entry.rootDirectory, file);
        const metadata = await stat(target);
        if (!metadata.isFile()) {
          throw new LocalMediaError('media_unavailable');
        }
        return { target, mediaKind: work.mediaKind, projectId: entry.projectId };
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

function parseWorkRequest(request: unknown): {
  readonly workId: string;
  readonly projectId?: string;
} {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('workId' in request) ||
    typeof request.workId !== 'string' ||
    request.workId.trim().length === 0
  ) {
    throw new LocalMediaError('work_not_found');
  }
  const projectId = 'projectId' in request ? request.projectId : undefined;
  if (projectId !== undefined && (
    typeof projectId !== 'string' || projectId.trim().length === 0
  )) throw new LocalMediaError('work_not_found');
  return {
    workId: request.workId.trim(),
    ...(typeof projectId === 'string' ? { projectId: projectId.trim() } : {})
  };
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
