import {
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  type FileReference,
  type ProjectId
} from '../../domain';
import {
  FileIndexRebuildService,
  FileVerificationPersistenceService,
  NodeFileStatusProbe,
  planFileRecovery,
  type FileIndexRebuildReport,
  type FileStatusProbeResult,
  type RecoveryPlan
} from '../files';
import {
  JsonFileIndexRepository,
  JsonFileReferenceRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';

export const storageRecoveryChannels = {
  probe: 'storage-recovery:probe',
  verify: 'storage-recovery:verify',
  relink: 'storage-recovery:relink',
  rebuildIndex: 'storage-recovery:rebuild-index'
} as const;

export interface FileTargetRequest {
  readonly projectId: string;
  readonly fileId: string;
}

export interface RelinkRequest extends FileTargetRequest {
  readonly confirmedByUser: boolean;
}

export interface ProbeFileResponse {
  readonly result: FileStatusProbeResult;
  readonly recovery: RecoveryPlan;
}

export interface StorageRecoveryApi {
  probeFile(request: FileTargetRequest): Promise<ProbeFileResponse>;
  verifyFile(request: FileTargetRequest): Promise<FileReference>;
  relinkFile(request: RelinkRequest): Promise<FileReference | undefined>;
  rebuildFileIndex(request: { readonly projectId: string }): Promise<FileIndexRebuildReport>;
}

export interface StorageRecoveryDependencies {
  readonly getProjectRoot: (projectId: ProjectId) => string;
  readonly selectRelinkCandidate: () => Promise<string | undefined>;
}

export class StorageRecoveryIpcError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'file_not_found',
    message: string
  ) {
    super(message);
    this.name = 'StorageRecoveryIpcError';
  }
}

interface ProjectContext {
  readonly files: JsonFileReferenceRepository;
  readonly index: JsonFileIndexRepository;
  readonly probe: NodeFileStatusProbe;
  readonly persistence: FileVerificationPersistenceService;
  readonly rebuild: FileIndexRebuildService;
}

export function createStorageRecoveryApi(
  dependencies: StorageRecoveryDependencies
): StorageRecoveryApi {
  const contexts = new Map<string, ProjectContext>();

  const getContext = (projectId: ProjectId): ProjectContext => {
    const existing = contexts.get(projectId);

    if (existing) {
      return existing;
    }

    const root = dependencies.getProjectRoot(projectId);
    const storage = new NodeProjectStorage(root);
    const files = new JsonFileReferenceRepository(storage, projectId);
    const index = new JsonFileIndexRepository(storage, projectId);
    const probe = new NodeFileStatusProbe(root);
    const context = {
      files,
      index,
      probe,
      persistence: new FileVerificationPersistenceService(
        files,
        index,
        probe,
        () => toIsoTimestamp(new Date().toISOString())
      ),
      rebuild: new FileIndexRebuildService(projectId, files, index)
    };

    contexts.set(projectId, context);
    return context;
  };

  const loadFile = async (request: unknown) => {
    const values = readRequest(request, ['projectId', 'fileId']);
    const projectId = toProjectId(values.projectId);
    const context = getContext(projectId);
    const file = await context.files.get(
      toFileReferenceId(values.fileId as string)
    );

    if (!file || file.projectId !== projectId) {
      throw new StorageRecoveryIpcError(
        'file_not_found',
        'File reference was not found in the selected project'
      );
    }

    return { context, file, projectId };
  };

  return {
    async probeFile(request) {
      const { context, file } = await loadFile(request);
      const result = await context.probe.inspect(file);
      return { result, recovery: planFileRecovery(result) };
    },

    async verifyFile(request) {
      const { context, file } = await loadFile(request);
      const result = await context.probe.inspect(file);
      return context.persistence.persistProbeResult(file, result);
    },

    async relinkFile(request) {
      const values = readRequest(request, [
        'projectId',
        'fileId',
        'confirmedByUser'
      ]);

      if (values.confirmedByUser !== true) {
        throw new StorageRecoveryIpcError(
          'invalid_request',
          'Relink requires explicit user confirmation'
        );
      }

      const { context, file } = await loadFile({
        projectId: values.projectId,
        fileId: values.fileId
      });
      const candidate = await dependencies.selectRelinkCandidate();

      if (!candidate) {
        return undefined;
      }

      return context.persistence.relink({
        file,
        locator: { kind: 'external', absolutePath: candidate },
        confirmedByUser: true
      });
    },

    async rebuildFileIndex(request) {
      const values = readRequest(request, ['projectId']);
      return getContext(toProjectId(values.projectId)).rebuild.rebuild();
    }
  };
}

function readRequest(
  value: unknown,
  allowedKeys: readonly string[]
): Record<string, string | boolean> & { projectId: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new StorageRecoveryIpcError('invalid_request', 'Unexpected IPC request fields');
  }

  for (const key of allowedKeys) {
    if (key === 'confirmedByUser') {
      continue;
    }

    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      throw new StorageRecoveryIpcError('invalid_request', `${key} is required`);
    }
  }

  return value as Record<string, string | boolean> & { projectId: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
