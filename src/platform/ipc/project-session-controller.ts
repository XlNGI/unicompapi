import path from 'node:path';
import { toProjectId } from '../../domain';
import type {
  StorageIpcResult,
  StorageOpenProjectDto,
  StorageProjectSessionDto
} from '../../shared/storage-ipc';
import { JsonProjectRepository } from '../repositories';
import { NodeProjectStorage, projectStoragePaths } from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';

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
  beforeSessionChange?(): Promise<void>;
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

      if (!path.isAbsolute(rootDirectory)) {
        throw new ProjectSessionError(
          'invalid_project',
          'Selected project directory is invalid'
        );
      }

      const storage = new NodeProjectStorage(rootDirectory);
      const manifest = await storage.readJson<unknown>(projectStoragePaths.manifest);
      const projectId = readProjectId(manifest);
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
      await this.dependencies.beforeSessionChange?.();
      this.dependencies.registry.set(session);

      return {
        cancelled: false,
        session: toSessionDto(session)
      };
    });
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

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<StorageIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return {
        ok: false,
        error: error instanceof ProjectSessionError
          ? { code: error.code, message: error.message }
          : {
              code: 'project_open_failed',
              message: 'The selected project could not be opened'
            }
      };
    }
  }
}

class ProjectSessionError extends Error {
  constructor(
    readonly code: 'invalid_project',
    message: string
  ) {
    super(message);
    this.name = 'ProjectSessionError';
  }
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
