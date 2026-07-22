import {
  toFileReferenceId,
  toIsoTimestamp,
  type FileReference,
  type ProjectId
} from '../../domain';
import type {
  StorageFileStatusDto,
  StorageIndexRebuildDto,
  StorageIpcErrorCode,
  StorageIpcResult,
  StorageRelinkResultDto
} from '../../shared/storage-ipc';
import {
  FileIndexRebuildError,
  FileIndexRebuildService,
  FileRecoveryPersistenceError,
  FileVerificationError,
  FileVerificationPersistenceService,
  NodeFileStatusProbe
} from '../files';
import {
  JsonFileIndexRepository,
  JsonFileReferenceRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';

export interface StorageProjectSession {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly rootDirectory: string;
}

export interface StorageIpcControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  chooseRelinkFile(): Promise<string | undefined>;
  onError?(error: unknown): void;
}

export class StorageIpcController {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: StorageIpcControllerDependencies) {}

  waitForMutations(): Promise<void> {
    return this.mutationQueue;
  }

  probeFile(request: unknown): Promise<StorageIpcResult<StorageFileStatusDto>> {
    return this.execute(async () => {
      const fileId = parseFileId(request);
      const context = await this.createContext();
      const file = await requireFile(context.fileRepository, fileId);
      const result = await context.probe.inspect(file);
      return toStatusDto(file, result.recommendedState, result.issues, result.verification);
    });
  }

  verifyFile(request: unknown): Promise<StorageIpcResult<StorageFileStatusDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const fileId = parseFileId(request);
        const context = await this.createContext();
        const file = await requireFile(context.fileRepository, fileId);
        const result = await context.probe.inspect(file);
        const updated = await context.persistence.persistProbeResult(file, result);
        return toPersistedStatusDto(updated, result.issues);
      })
    );
  }

  relinkFile(
    request: unknown
  ): Promise<StorageIpcResult<StorageRelinkResultDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const fileId = parseFileId(request);
        const context = await this.createContext();
        const file = await requireFile(context.fileRepository, fileId);
        const selectedPath = await this.dependencies.chooseRelinkFile();

        if (!selectedPath) {
          return { cancelled: true };
        }

        const updated = await context.persistence.relink({
          file,
          locator: { kind: 'external', absolutePath: selectedPath },
          confirmedByUser: true
        });

        return {
          cancelled: false,
          file: toPersistedStatusDto(updated, [])
        };
      })
    );
  }

  rebuildIndex(): Promise<StorageIpcResult<StorageIndexRebuildDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const context = await this.createContext();
        return context.rebuild.rebuild();
      })
    );
  }

  private async createContext() {
    const session = this.dependencies.getSession();

    if (!session) {
      throw new StorageControllerError(
        'project_not_open',
        'No project is currently open'
      );
    }

    const storage = new NodeProjectStorage(session.rootDirectory);
    const fileRepository = new JsonFileReferenceRepository(
      storage,
      session.projectId
    );
    const indexRepository = new JsonFileIndexRepository(
      storage,
      session.projectId
    );
    const probe = new NodeFileStatusProbe(session.rootDirectory);
    const persistence = new FileVerificationPersistenceService(
      fileRepository,
      indexRepository,
      probe,
      () => toIsoTimestamp(new Date().toISOString())
    );
    const rebuild = new FileIndexRebuildService(
      session.projectId,
      fileRepository,
      indexRepository
    );

    return { fileRepository, persistence, probe, rebuild };
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<StorageIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapStorageError(error) };
    }
  }

  private enqueueMutation<T>(
    operation: () => Promise<StorageIpcResult<T>>
  ): Promise<StorageIpcResult<T>> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

class StorageControllerError extends Error {
  constructor(
    readonly code: StorageIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'StorageControllerError';
  }
}

function parseFileId(request: unknown) {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('fileId' in request) ||
    typeof request.fileId !== 'string' ||
    request.fileId.trim().length === 0
  ) {
    throw new StorageControllerError(
      'invalid_request',
      'A valid file ID is required'
    );
  }

  return toFileReferenceId(request.fileId);
}

async function requireFile(
  repository: JsonFileReferenceRepository,
  fileId: ReturnType<typeof toFileReferenceId>
): Promise<FileReference> {
  const file = await repository.get(fileId);

  if (!file) {
    throw new StorageControllerError(
      'file_not_found',
      'The requested file record does not exist'
    );
  }

  return file;
}

function toStatusDto(
  file: FileReference,
  state: string,
  issues: readonly string[],
  verification?: {
    readonly sizeBytes: number;
    readonly matchesExpected: boolean | undefined;
    readonly verifiedAt: string;
  }
): StorageFileStatusDto {
  return {
    fileId: file.id,
    state,
    issues,
    sizeBytes: verification?.sizeBytes,
    matchesExpected: verification?.matchesExpected,
    verifiedAt: verification?.verifiedAt
  };
}

function toPersistedStatusDto(
  file: FileReference,
  issues: readonly string[]
): StorageFileStatusDto {
  return toStatusDto(file, file.state, issues, file.lastVerification);
}

function mapStorageError(error: unknown): {
  code: StorageIpcErrorCode;
  message: string;
} {
  if (error instanceof StorageControllerError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof FileVerificationError) {
    return {
      code: 'verification_failed',
      message: 'The local file could not be verified'
    };
  }

  if (error instanceof FileRecoveryPersistenceError) {
    return {
      code: 'relink_rejected',
      message: 'The selected file could not be linked safely'
    };
  }

  if (error instanceof FileIndexRebuildError) {
    return {
      code: 'index_rebuild_failed',
      message: 'The local file index could not be rebuilt'
    };
  }

  return {
    code: 'storage_error',
    message: 'The local storage operation failed'
  };
}
