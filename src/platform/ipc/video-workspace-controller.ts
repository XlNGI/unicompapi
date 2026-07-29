import { randomUUID } from 'node:crypto';
import {
  applyVideoWorkspaceChangeStaleness,
  createAsset,
  createEmptyVideoWorkspaceDraft,
  createVideoWorkspaceDraft,
  deriveVideoWorkspaceDraft,
  isVideoWorkspaceDraft,
  toDraftId,
  toAssetId,
  toIsoTimestamp,
  videoWorkspaceModes,
  type VideoWorkspaceDraft,
  type VideoWorkspaceMode
} from '../../domain';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceIpcResult
} from '../../shared/video-workspace-ipc';
import {
  JsonAssetRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonVideoWorkspaceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import {
  NodeImageInspector,
  NodeSha256FileVerifier,
  resolveFileReferencePathSafely
} from '../files';
import type { StorageProjectSession } from './storage-ipc-controller';
import { VideoWorkspaceMutationCoordinator } from './video-workspace-mutations';

export interface VideoWorkspaceControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  createDraftId?(): string;
  now?(): string;
  mutations?: VideoWorkspaceMutationCoordinator;
  onError?(error: unknown): void;
}

export class VideoWorkspaceController {
  private readonly mutations: VideoWorkspaceMutationCoordinator;

  constructor(
    private readonly dependencies: VideoWorkspaceControllerDependencies
  ) {
    this.mutations = dependencies.mutations ??
      new VideoWorkspaceMutationCoordinator();
  }

  waitForMutations(): Promise<void> {
    return this.mutations.wait();
  }

  create(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const mode = parseModeRequest(request);
        const context = this.createContext();
        const createdAt = this.now();
        const draft = createEmptyVideoWorkspaceDraft({
          id: this.createDraftId(),
          projectId: context.session.projectId,
          mode,
          createdAt
        });
        await context.repository.save(draft);
        return toVideoWorkspaceDto(draft);
      })
    );
  }

  get(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto | undefined>> {
    return this.execute(async () => {
      await this.mutations.wait();
      const draftId = parseDraftIdRequest(request);
      const context = this.createContext();
      const draft = await context.repository.get(draftId);
      return draft ? toVideoWorkspaceDto(draft) : undefined;
    });
  }

  list(): Promise<
    VideoWorkspaceIpcResult<readonly VideoWorkspaceDraftDto[]>
  > {
    return this.execute(async () => {
      await this.mutations.wait();
      const context = this.createContext();
      const drafts = await context.repository.list(context.session.projectId);
      return drafts.map(toVideoWorkspaceDto);
    });
  }

  update(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const requested = parseUpdateRequest(request);
        const context = this.createContext();
        const stored = await context.repository.get(requested.id);

        if (!stored) {
          throw controllerError(
            'draft_not_found',
            'The requested video workspace draft does not exist'
          );
        }
        if (requested.updatedAt !== stored.updatedAt) {
          throw controllerError(
            'draft_conflict',
            'The video workspace draft changed before this update was saved'
          );
        }
        if (
          requested.projectId !== context.session.projectId ||
          requested.mode !== stored.mode ||
          requested.createdAt !== stored.createdAt ||
          JSON.stringify(requested.origin) !== JSON.stringify(stored.origin)
        ) {
          throw controllerError(
            'invalid_request',
            'Immutable video workspace fields cannot be changed'
          );
        }

        const updatedAt = this.now();
        const candidate = createVideoWorkspaceDraft({
          ...requested,
          id: stored.id,
          projectId: stored.projectId,
          mode: stored.mode,
          origin: stored.origin,
          createdAt: stored.createdAt,
          updatedAt
        } as VideoWorkspaceDraft);
        const updated = applyVideoWorkspaceChangeStaleness(
          stored,
          candidate,
          updatedAt
        );
        await context.repository.save(updated);
        return toVideoWorkspaceDto(updated);
      })
    );
  }

  derive(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseDeriveRequest(request);
        const context = this.createContext();
        const source = await context.repository.get(parsed.sourceDraftId);
        if (!source) {
          throw controllerError(
            'draft_not_found',
            'The source video workspace draft does not exist'
          );
        }
        const derived = deriveVideoWorkspaceDraft({
          id: this.createDraftId(),
          source,
          targetMode: parsed.targetMode,
          createdAt: this.now()
        });
        await context.repository.save(derived);
        return toVideoWorkspaceDto(derived);
      })
    );
  }

  createFromImageWork(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const workId = parseStringId(request, 'workId');
        const context = this.createContext();
        const works = new JsonWorkRepository(
          context.storage,
          context.session.projectId
        );
        const files = new JsonFileReferenceRepository(
          context.storage,
          context.session.projectId
        );
        const assets = new JsonAssetRepository(
          context.storage,
          context.session.projectId
        );
        const tasks = new JsonTaskRepository(
          context.storage,
          context.session.projectId
        );
        const work = (await works.list(context.session.projectId)).find(
          (candidate) => candidate.id === workId
        );
        if (!work || work.mediaKind !== 'image') {
          throw controllerError(
            'material_not_found',
            'A verified image Work is required'
          );
        }
        const file = await files.get(work.fileId);
        if (!file || file.state !== 'available') {
          throw controllerError(
            'material_not_found',
            'The image Work file is unavailable'
          );
        }
        if (!file.checksumSha256) {
          throw controllerError(
            'material_not_found',
            'The image Work does not have a verified file identity'
          );
        }
        const verification = await new NodeSha256FileVerifier(
          context.session.rootDirectory
        ).verify({ file, expectedChecksum: file.checksumSha256 });
        if (!verification.matchesExpected) {
          throw controllerError(
            'material_not_found',
            'The image Work file changed after registration'
          );
        }
        const target = await resolveFileReferencePathSafely(
          context.session.rootDirectory,
          file
        );
        const inspection = await new NodeImageInspector().inspect(target);
        const existing = (await assets.list(context.session.projectId)).find(
          (candidate) => candidate.fileId === file.id && candidate.mediaKind === 'image'
        );
        const createdAt = this.now();
        const asset = existing ?? createAsset({
          id: toAssetId(`asset-work-image-${randomUUID()}`),
          projectId: context.session.projectId,
          fileId: file.id,
          name: work.name,
          mediaKind: 'image',
          origin: 'generated',
          role: 'reference',
          imageMetadata: {
            mimeType: inspection.mimeType,
            width: inspection.width,
            height: inspection.height
          },
          createdAt
        });
        if (!existing) await assets.save(asset);
        const sourceTask = await tasks.get(work.sourceTaskId);
        const parentMode = sourceTask?.submission.image?.mode ?? 'professional_image';
        const draft = createEmptyVideoWorkspaceDraft({
          id: this.createDraftId(),
          projectId: context.session.projectId,
          mode: 'image_to_video',
          createdAt,
          origin: sourceTask
            ? {
                kind: 'derived',
                parentDraftId: sourceTask.sourceDraftId as ReturnType<typeof toDraftId>,
                parentMode
              }
            : { kind: 'new' }
        });
        const withSource = createVideoWorkspaceDraft({
          ...draft,
          imageToVideo: {
            ...draft.imageToVideo,
            source: {
              assetId: asset.id,
              mediaKind: 'image',
              role: 'reference',
              selectedAt: createdAt
            }
          }
        });
        await context.repository.save(withSource);
        return toVideoWorkspaceDto(withSource);
      })
    );
  }

  private createContext() {
    const session = this.dependencies.getSession();
    if (!session) {
      throw controllerError(
        'project_not_open',
        'No project is currently open'
      );
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      storage,
      repository: new JsonVideoWorkspaceRepository(
        storage,
        session.projectId
      )
    };
  }

  private createDraftId() {
    return toDraftId(
      this.dependencies.createDraftId?.() ?? `video-draft-${randomUUID()}`
    );
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<VideoWorkspaceIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapVideoWorkspaceError(error) };
    }
  }

  private enqueueMutation<T>(
    operation: () => Promise<VideoWorkspaceIpcResult<T>>
  ): Promise<VideoWorkspaceIpcResult<T>> {
    return this.mutations.enqueue(operation);
  }
}

function parseStringId(request: unknown, field: string): string {
  if (!isRecord(request) || Object.keys(request).length !== 1 ||
    Object.keys(request)[0] !== field || typeof request[field] !== 'string' ||
    request[field].trim().length === 0) {
    throw controllerError('invalid_request', `${field} is required`);
  }
  return request[field].trim();
}

class VideoWorkspaceControllerError extends Error {
  constructor(
    readonly code: VideoWorkspaceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoWorkspaceControllerError';
  }
}

function parseModeRequest(request: unknown): VideoWorkspaceMode {
  if (
    !isRecord(request) ||
    typeof request.mode !== 'string' ||
    !videoWorkspaceModes.includes(request.mode as VideoWorkspaceMode)
  ) {
    throw controllerError(
      'invalid_request',
      'A supported video workspace mode is required'
    );
  }
  return request.mode as VideoWorkspaceMode;
}

function parseDraftIdRequest(request: unknown) {
  if (!isRecord(request) || typeof request.draftId !== 'string') {
    throw controllerError(
      'invalid_request',
      'A valid video workspace draft ID is required'
    );
  }
  try {
    return toDraftId(request.draftId);
  } catch {
    throw controllerError(
      'invalid_request',
      'A valid video workspace draft ID is required'
    );
  }
}

function parseUpdateRequest(request: unknown): VideoWorkspaceDraft {
  if (!isRecord(request) || !isRecord(request.draft)) {
    throw controllerError(
      'invalid_request',
      'A valid video workspace draft is required'
    );
  }
  const { draftId, ...rest } = request.draft;
  const value = { ...rest, id: draftId };
  if (!isVideoWorkspaceDraft(value)) {
    throw controllerError(
      'invalid_request',
      'The video workspace draft is invalid'
    );
  }
  return createVideoWorkspaceDraft(value);
}

function parseDeriveRequest(request: unknown): {
  readonly sourceDraftId: ReturnType<typeof toDraftId>;
  readonly targetMode: VideoWorkspaceMode;
} {
  if (!isRecord(request)) {
    throw controllerError(
      'invalid_request',
      'A source draft and target mode are required'
    );
  }
  return {
    sourceDraftId: parseDraftIdRequest({
      draftId: request.sourceDraftId
    }),
    targetMode: parseModeRequest({ mode: request.targetMode })
  };
}

export function toVideoWorkspaceDto(
  draft: VideoWorkspaceDraft
): VideoWorkspaceDraftDto {
  const { id, ...rest } = structuredClone(draft);
  return { ...rest, draftId: id } as VideoWorkspaceDraftDto;
}

function controllerError(
  code: VideoWorkspaceIpcErrorCode,
  message: string
): VideoWorkspaceControllerError {
  return new VideoWorkspaceControllerError(code, message);
}

function mapVideoWorkspaceError(error: unknown): {
  readonly code: VideoWorkspaceIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof VideoWorkspaceControllerError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'workspace_storage_error',
    message: 'The local video workspace operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
