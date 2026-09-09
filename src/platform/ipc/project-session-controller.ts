import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { toProjectId } from '../../domain';
import type {
  StorageCreateProjectDto,
  StorageIpcResult,
  StorageOpenProjectDto,
  StorageProjectSessionDto
} from '../../shared/storage-ipc';
import { JsonProjectRepository } from '../repositories';
import {
  NodeProjectStorage,
  projectStoragePaths,
  toProjectRelativePath
} from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';
import {
  createProjectId,
  createProjectManifest,
  type ProjectCatalogService
} from './project-catalog';
import type { StorageProjectSummaryDto } from '../../shared/storage-ipc';

export class StorageProjectSessionRegistry {
  private session: StorageProjectSession | undefined;

  get(): StorageProjectSession | undefined {
    return this.session;
  }

  set(session: StorageProjectSession): void {
    this.session = session;
  }

  clear(): void {
    this.session = undefined;
  }
}

export interface ProjectSessionControllerDependencies {
  readonly registry: StorageProjectSessionRegistry;
  chooseProjectDirectory(): Promise<string | undefined>;
  catalog?: ProjectCatalogService;
  beforeSessionChange?(): Promise<void>;
  afterSessionChange?(): Promise<void>;
  onError?(error: unknown): void;
}

export class ProjectSessionController {
  constructor(
    private readonly dependencies: ProjectSessionControllerDependencies
  ) {}

  openProject(): Promise<StorageIpcResult<StorageOpenProjectDto>> {
    return this.execute(async () => {
      const rootDirectory = await this.dependencies.chooseProjectDirectory();

      if (!rootDirectory) {
        return { cancelled: true };
      }

      return {
        cancelled: false,
        session: await this.openProjectDirectory(rootDirectory)
      };
    });
  }

  openRecentProject(
    request: unknown
  ): Promise<StorageIpcResult<StorageOpenProjectDto>> {
    return this.execute(async () => {
      const projectId = parseRecentProjectId(request);
      const entries = await this.dependencies.catalog?.getEntries();
      const entry = entries?.find((candidate) => candidate.projectId === projectId);

      if (!entry) {
        throw new ProjectSessionError(
          'project_open_failed',
          'The recent project could not be found'
        );
      }

      return {
        cancelled: false,
        session: await this.openProjectDirectory(entry.rootDirectory, projectId)
      };
    });
  }

  createProject(
    request: unknown
  ): Promise<StorageIpcResult<StorageCreateProjectDto>> {
    return this.executeCreate(async () => {
      const name = parseProjectName(request);
      const rootDirectory = await this.dependencies.chooseProjectDirectory();

      if (!rootDirectory) {
        return { cancelled: true };
      }

      if (!path.isAbsolute(rootDirectory)) {
        throw new ProjectSessionError(
          'invalid_project',
          'Selected project directory is invalid'
        );
      }

      const normalizedRoot = path.resolve(rootDirectory);
      const contents = await readdir(normalizedRoot);
      if (contents.length > 0) {
        throw new ProjectSessionError(
          'project_directory_not_empty',
          'Selected project directory is not empty'
        );
      }

      const projectId = createProjectId();
      const storage = new NodeProjectStorage(normalizedRoot);
      const manifest = createProjectManifest(
        projectId,
        name,
        new Date().toISOString()
      );
      await storage.writeJsonAtomically(projectStoragePaths.manifest, manifest);
      await Promise.all([
        storage.ensureDirectory(toProjectRelativePath('entities')),
        storage.ensureDirectory(toProjectRelativePath('index')),
        storage.ensureDirectory(projectStoragePaths.filesDirectory),
        storage.ensureDirectory(projectStoragePaths.temporaryDirectory)
      ]);

      const session: StorageProjectSession = {
        projectId,
        projectName: manifest.name,
        rootDirectory: normalizedRoot
      };
      await this.dependencies.beforeSessionChange?.();
      this.dependencies.registry.set(session);
      await this.dependencies.afterSessionChange?.();
      await this.dependencies.catalog?.remember({
        projectId: session.projectId,
        projectName: session.projectName,
        rootDirectory: session.rootDirectory
      });

      return {
        cancelled: false,
        session: toSessionDto(session)
      };
    });
  }

  async listProjects(): Promise<StorageIpcResult<readonly StorageProjectSummaryDto[]>> {
    try {
      return { ok: true, value: (await this.dependencies.catalog?.list()) ?? [] };
    } catch {
      return {
        ok: false,
        error: {
          code: 'project_open_failed',
          message: 'The project catalog could not be read'
        }
      };
    }
  }

  async closeProject(): Promise<StorageIpcResult<{ readonly closed: true }>> {
    await this.dependencies.beforeSessionChange?.();
    this.dependencies.registry.clear();
    return { ok: true, value: { closed: true } };
  }

  async getProjectSession(): Promise<
    StorageIpcResult<StorageProjectSessionDto | undefined>
  > {
    const session = this.dependencies.registry.get();
    return {
      ok: true,
      value: session ? toSessionDto(session) : undefined
    };
  }

  private async openProjectDirectory(
    rootDirectory: string,
    expectedProjectId?: string
  ): Promise<StorageProjectSessionDto> {
    if (!path.isAbsolute(rootDirectory)) {
      throw new ProjectSessionError(
        'invalid_project',
        'Selected project directory is invalid'
      );
    }

    const storage = new NodeProjectStorage(rootDirectory);
    const manifest = await storage.readJson<unknown>(projectStoragePaths.manifest);
    const projectId = readProjectId(manifest);
    if (expectedProjectId && projectId !== expectedProjectId) {
      throw new ProjectSessionError(
        'project_open_failed',
        'The recent project no longer matches its catalog entry'
      );
    }
    const repository = new JsonProjectRepository(storage, projectId);
    const project = await repository.load();

    if (!project) {
      throw new ProjectSessionError(
        'invalid_project',
        'Selected directory does not contain a project manifest'
      );
    }

    const session: StorageProjectSession = {
      projectId: project.id,
      projectName: project.name,
      rootDirectory: path.resolve(rootDirectory)
    };
    await this.dependencies.catalog?.remember({
      projectId: session.projectId,
      projectName: session.projectName,
      rootDirectory: session.rootDirectory
    });
    await this.dependencies.beforeSessionChange?.();
    this.dependencies.registry.set(session);
    await this.dependencies.afterSessionChange?.();

    return toSessionDto(session);
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<StorageIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return {
        ok: false,
        error: error instanceof ProjectSessionError && error.code === 'invalid_project'
          ? { code: error.code, message: error.message }
          : {
              code: 'project_open_failed',
              message: 'The selected project could not be opened'
            }
      };
    }
  }

  private async executeCreate<T>(
    operation: () => Promise<T>
  ): Promise<StorageIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return {
        ok: false,
        error: {
          code: 'project_create_failed',
          message: error instanceof ProjectSessionError
            ? error.message
            : 'The project could not be created'
        }
      };
    }
  }
}

class ProjectSessionError extends Error {
  constructor(
    readonly code:
      | 'invalid_project'
      | 'project_directory_not_empty'
      | 'project_open_failed',
    message: string
  ) {
    super(message);
    this.name = 'ProjectSessionError';
  }
}

function parseRecentProjectId(request: unknown): string {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('projectId' in request) ||
    typeof request.projectId !== 'string' ||
    request.projectId.trim().length === 0
  ) {
    throw new ProjectSessionError(
      'invalid_project',
      'A recent project id is required'
    );
  }

  return request.projectId;
}

function parseProjectName(request: unknown): string {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('name' in request) ||
    typeof request.name !== 'string'
  ) {
    throw new ProjectSessionError(
      'invalid_project',
      'A non-empty project name is required'
    );
  }

  const name = request.name.trim();
  if (name.length === 0) {
    throw new ProjectSessionError(
      'invalid_project',
      'A non-empty project name is required'
    );
  }

  return name;
}

function readProjectId(manifest: unknown) {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('id' in manifest) ||
    typeof manifest.id !== 'string' ||
    manifest.id.trim().length === 0
  ) {
    throw new ProjectSessionError(
      'invalid_project',
      'Selected directory does not contain a valid project manifest'
    );
  }

  return toProjectId(manifest.id);
}

function toSessionDto(
  session: StorageProjectSession
): StorageProjectSessionDto {
  return {
    projectId: session.projectId,
    projectName: session.projectName
  };
}
