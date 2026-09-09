import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createProject, toIsoTimestamp, toProjectId, type ProjectId } from '../../domain';
import type { StorageProjectSummaryDto } from '../../shared/storage-ipc';

export interface ProjectCatalogEntry {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly rootDirectory: string;
  readonly lastOpenedAt: string;
}

export interface ProjectCatalogStore {
  load(): Promise<readonly ProjectCatalogEntry[]>;
  save(entries: readonly ProjectCatalogEntry[]): Promise<void>;
}

export class JsonProjectCatalogStore implements ProjectCatalogStore {
  constructor(private readonly catalogPath: string) {}

  async load(): Promise<readonly ProjectCatalogEntry[]> {
    try {
      const content = await readFile(this.catalogPath, 'utf8');
      const value: unknown = JSON.parse(content);
      return parseCatalog(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async save(entries: readonly ProjectCatalogEntry[]): Promise<void> {
    const parent = path.dirname(this.catalogPath);
    const temporary = path.join(
      parent,
      `.${path.basename(this.catalogPath)}.${randomUUID()}.tmp`
    );
    await mkdir(parent, { recursive: true });

    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(
          `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
          'utf8'
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.catalogPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class InMemoryProjectCatalogStore implements ProjectCatalogStore {
  private entries: readonly ProjectCatalogEntry[] = [];

  async load(): Promise<readonly ProjectCatalogEntry[]> {
    return this.entries;
  }

  async save(entries: readonly ProjectCatalogEntry[]): Promise<void> {
    this.entries = entries;
  }
}

export class ProjectCatalogService {
  constructor(
    private readonly store: ProjectCatalogStore,
    private readonly now: () => string = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async list(): Promise<readonly StorageProjectSummaryDto[]> {
    const entries = await this.store.load();
    return Promise.all(
      entries.map(async (entry) => ({
        projectId: entry.projectId,
        projectName: entry.projectName,
        availability: (await isDirectory(entry.rootDirectory))
          ? ('available' as const)
          : ('unavailable' as const),
        lastOpenedAt: entry.lastOpenedAt
      }))
    );
  }

  async getEntries(): Promise<readonly ProjectCatalogEntry[]> {
    return this.store.load();
  }

  async remember(entry: Omit<ProjectCatalogEntry, 'lastOpenedAt'>): Promise<void> {
    const entries = await this.store.load();
    const updated: ProjectCatalogEntry = {
      ...entry,
      lastOpenedAt: this.now()
    };
    const remaining = entries.filter(
      (current) => current.projectId !== updated.projectId
    );
    await this.store.save([updated, ...remaining].slice(0, 50));
  }

  async remove(projectId: string): Promise<void> {
    const entries = await this.store.load();
    await this.store.save(entries.filter((entry) => entry.projectId !== projectId));
  }
}

export function createProjectId(): ProjectId {
  return toProjectId(`project-${randomUUID()}`);
}

export function createProjectManifest(
  projectId: ProjectId,
  name: string,
  now: string
) {
  const timestamp = toIsoTimestamp(now);
  return createProject({
    id: projectId,
    name,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

function parseCatalog(value: unknown): readonly ProjectCatalogEntry[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new TypeError('Project catalog has an unsupported schema');
  }

  return value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.projectId !== 'string' ||
      entry.projectId.trim().length === 0 ||
      typeof entry.projectName !== 'string' ||
      entry.projectName.trim().length === 0 ||
      typeof entry.rootDirectory !== 'string' ||
      !path.isAbsolute(entry.rootDirectory) ||
      typeof entry.lastOpenedAt !== 'string'
    ) {
      throw new TypeError('Project catalog contains an invalid entry');
    }

    toIsoTimestamp(entry.lastOpenedAt);
    return {
      projectId: toProjectId(entry.projectId),
      projectName: entry.projectName,
      rootDirectory: path.resolve(entry.rootDirectory),
      lastOpenedAt: entry.lastOpenedAt
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
