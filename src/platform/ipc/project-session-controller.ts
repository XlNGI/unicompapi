import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { toProjectId } from '../../domain';
import type {
  StorageCreateProjectDto,
  StorageIpcResult,
  StorageOpenProjectDto,
  StorageProjectConversationSummaryDto,
  StorageProjectSessionDto
} from '../../shared/storage-ipc';
import { JsonProjectConversationRepository, JsonProjectRepository } from '../repositories';
import { hasCommittedThreadAuthority } from '../repositories/thread-conversation-repository';
import { ThreadFileRepository } from '../repositories/thread-file-repository';
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
import type { StorageRemoveProjectDto } from '../../shared/storage-ipc';
import { validateProjectTrashTarget } from './project-removal';

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
  readonly threadConversationsEnabled?: boolean;
  readonly registry: StorageProjectSessionRegistry;
  chooseProjectDirectory(): Promise<string | undefined>;
  catalog?: ProjectCatalogService;
  trashProjectDirectory?(directory: string): Promise<void>;
  readonly protectedDirectories?: readonly string[];
  beforeSessionChange?(): Promise<void>;
  afterSessionChange?(): Promise<void>;
  prepareProjectStorage?(rootDirectory: string): Promise<void>;
  onError?(error: unknown): void;
}

export class ProjectSessionController {
  private sessionChange: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dependencies: ProjectSessionControllerDependencies
  ) {}

  openProject(): Promise<StorageIpcResult<StorageOpenProjectDto>> {
    return this.enqueueSessionChange(() => this.execute(async () => {
      const rootDirectory = await this.dependencies.chooseProjectDirectory();

      if (!rootDirectory) {
        return { cancelled: true };
      }

      return {
        cancelled: false,
        session: await this.openProjectDirectory(rootDirectory)
      };
    }));
  }

  openRecentProject(
    request: unknown
  ): Promise<StorageIpcResult<StorageOpenProjectDto>> {
    return this.enqueueSessionChange(() => this.execute(async () => {
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
    }));
  }

  createProject(
    request: unknown
  ): Promise<StorageIpcResult<StorageCreateProjectDto>> {
    return this.enqueueSessionChange(() => this.executeCreate(async () => {
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
    }));
  }

  async listProjectConversationSummaries(
    request: unknown
  ): Promise<StorageIpcResult<readonly StorageProjectConversationSummaryDto[]>> {
    try {
      const projectId = parseRecentProjectId(request);
      const entries = await this.dependencies.catalog?.getEntries();
      const entry = entries?.find((candidate) => candidate.projectId === projectId);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: 'project_open_failed',
            message: 'The recent project could not be found'
          }
        };
      }
      const threadAuthority = this.dependencies.threadConversationsEnabled !== false && await hasCommittedThreadAuthority(entry.rootDirectory);
      if (threadAuthority) {
        const threads = new ThreadFileRepository(entry.rootDirectory);
        const conversations = [];
        for (const summary of await threads.listThreadSummaries()) {
          if (summary.projectId !== projectId) throw new Error('thread_project_scope_mismatch');
          const thread = await threads.getThread(summary.threadId);
          if (thread && thread.status !== 'deleted') conversations.push({ conversationId: thread.threadId, projectId,
            title: thread.title, status: thread.status === 'archived' ? 'archived' as const : 'active' as const, updatedAt: thread.updatedAt });
        }
        return { ok: true, value: conversations };
      }
      const conversations = await new JsonProjectConversationRepository(
        new NodeProjectStorage(entry.rootDirectory),
        toProjectId(projectId)
      ).list({ statuses: ['active', 'archived'] });
      return {
        ok: true,
        value: conversations.map((conversation) => ({
          conversationId: conversation.id,
          projectId,
          title: conversation.title,
          status: conversation.status === 'archived' ? 'archived' : 'active',
          updatedAt: conversation.updatedAt
        }))
      };
    } catch (error) {
      this.dependencies.onError?.(error);
      return {
        ok: false,
        error: {
          code: 'read_model_failed',
          message: 'The project conversations could not be read'
        }
      };
    }
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
    return this.enqueueSessionChange(async () => {
      await this.dependencies.beforeSessionChange?.();
      this.dependencies.registry.clear();
      return { ok: true, value: { closed: true } };
    });
  }

  removeProject(request: unknown): Promise<StorageIpcResult<StorageRemoveProjectDto>> {
    return this.enqueueSessionChange(async () => {
      try {
        if (typeof request !== 'object' || request === null || Array.isArray(request) ||
          !('mode' in request) || (request.mode !== 'forget' && request.mode !== 'trash') ||
          Object.keys(request).some(key => key !== 'projectId' && key !== 'mode')) {
          return { ok: false, error: { code: 'invalid_request', message: 'A project id and removal mode are required' } };
        }
        const projectId = parseRecentProjectId(request);
        const catalog = this.dependencies.catalog;
        if (!catalog) throw new Error('Project catalog is unavailable');
        const entries = await catalog.getEntries();
        const entry = entries.find(candidate => candidate.projectId === projectId);
        const session = this.dependencies.registry.get();
        const sessionClosed = session?.projectId === projectId;
        // Retrying a removal never guesses a directory or repeats a filesystem action.
        if (!entry) return { ok: true, value: { projectId, filesTrashed: false, sessionClosed: false } };
        if (request.mode === 'trash') {
          if (sessionClosed) return { ok: false, error: { code: 'project_in_use', message: 'Close the project before moving it to trash' } };
          if (!this.dependencies.trashProjectDirectory) throw new Error('System trash is unavailable');
          await validateProjectTrashTarget(entry, entries, session?.rootDirectory, this.dependencies.protectedDirectories);
          await this.dependencies.trashProjectDirectory(entry.rootDirectory);
        } else if (sessionClosed) {
          await this.dependencies.beforeSessionChange?.();
        }
        await catalog.remove(projectId);
        if (sessionClosed) {
          this.dependencies.registry.clear();
          // Removal has committed. Optional maintenance must not report it as failed.
          try { await this.dependencies.afterSessionChange?.(); }
          catch (error) { this.dependencies.onError?.(error); }
        }
        return { ok: true, value: { projectId, filesTrashed: request.mode === 'trash', sessionClosed } };
      } catch (error) {
        this.dependencies.onError?.(error);
        return { ok: false, error: { code: error instanceof ProjectSessionError ? 'invalid_request' : 'project_remove_failed',
          message: 'The project could not be removed; you can remove its record while keeping files' } };
      }
    });
  }

  private enqueueSessionChange<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sessionChange.then(operation, operation);
    this.sessionChange = pending;
    return pending;
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
    try {
      await this.dependencies.prepareProjectStorage?.(session.rootDirectory);
    } catch (error) {
      this.dependencies.onError?.(error);
    }
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
