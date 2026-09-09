import { randomUUID } from 'node:crypto';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  deriveImageWorkspaceDraft,
  applyImageWorkspaceChangeStaleness,
  imageWorkspaceModes,
  isImageWorkspaceDraft,
  toDraftId,
  toIsoTimestamp,
  type ImageWorkspaceDraft,
  type ImageWorkspaceMode
} from '../../domain';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceIpcErrorCode,
  ImageWorkspaceIpcResult
} from '../../shared/image-workspace-ipc';
import { JsonImageWorkspaceRepository } from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';
import { ImageWorkspaceMutationCoordinator } from './image-workspace-mutations';

export interface ImageWorkspaceControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  createDraftId?(): string;
  now?(): string;
  mutations?: ImageWorkspaceMutationCoordinator;
  onError?(error: unknown): void;
}

export class ImageWorkspaceController {
  private readonly mutations: ImageWorkspaceMutationCoordinator;

  constructor(
    private readonly dependencies: ImageWorkspaceControllerDependencies
  ) {
    this.mutations =
      dependencies.mutations ?? new ImageWorkspaceMutationCoordinator();
  }

  waitForMutations(): Promise<void> {
    return this.mutations.wait();
  }

  create(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const mode = parseModeRequest(request);
        const context = this.createContext();
        const createdAt = this.now();
        const draft = createEmptyImageWorkspaceDraft({
          id: this.createDraftId(),
          projectId: context.session.projectId,
          mode,
          createdAt
        });

        await context.repository.save(draft);
        return toImageWorkspaceDto(draft);
      })
    );
  }

  get(
    request: unknown
  ): Promise<
    ImageWorkspaceIpcResult<ImageWorkspaceDraftDto | undefined>
  > {
    return this.execute(async () => {
      await this.mutations.wait();
      const draftId = parseDraftIdRequest(request);
      const context = this.createContext();
      const draft = await context.repository.get(draftId);
      return draft ? toImageWorkspaceDto(draft) : undefined;
    });
  }

  list(): Promise<
    ImageWorkspaceIpcResult<readonly ImageWorkspaceDraftDto[]>
  > {
    return this.execute(async () => {
      await this.mutations.wait();
      const context = this.createContext();
      const drafts = await context.repository.list(context.session.projectId);
      return drafts.map(toImageWorkspaceDto);
    });
  }

  update(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const requested = parseUpdateRequest(request);
        const context = this.createContext();
        const stored = await context.repository.get(requested.id);

        if (!stored) {
          throw new ImageWorkspaceControllerError(
            'draft_not_found',
            'The requested image workspace draft does not exist'
          );
        }

        if (requested.updatedAt !== stored.updatedAt) {
          throw new ImageWorkspaceControllerError(
            'draft_conflict',
            'The image workspace draft changed before this update was saved'
          );
        }

        if (
          requested.projectId !== context.session.projectId ||
          requested.mode !== stored.mode ||
          requested.createdAt !== stored.createdAt ||
          JSON.stringify(requested.origin) !== JSON.stringify(stored.origin)
        ) {
          throw new ImageWorkspaceControllerError(
            'invalid_request',
            'Immutable image workspace fields cannot be changed'
          );
        }

        const updatedAt = this.now();
        const candidate = createImageWorkspaceDraft({
          ...requested,
          id: stored.id,
          projectId: stored.projectId,
          mode: stored.mode,
          origin: stored.origin,
          createdAt: stored.createdAt,
          updatedAt
        } as ImageWorkspaceDraft);
        const updated = applyImageWorkspaceChangeStaleness(
          stored,
          candidate,
          updatedAt
        );

        await context.repository.save(updated);
        return toImageWorkspaceDto(updated);
      })
    );
  }

  derive(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseDeriveRequest(request);
        const context = this.createContext();
        const source = await context.repository.get(parsed.sourceDraftId);

        if (!source) {
          throw new ImageWorkspaceControllerError(
            'draft_not_found',
            'The source image workspace draft does not exist'
          );
        }

        const derived = deriveImageWorkspaceDraft({
          id: this.createDraftId(),
          source,
          targetMode: parsed.targetMode,
          createdAt: this.now()
        });

        await context.repository.save(derived);
        return toImageWorkspaceDto(derived);
      })
    );
  }

  private createContext() {
    const session = this.dependencies.getSession();

    if (!session) {
      throw new ImageWorkspaceControllerError(
        'project_not_open',
        'No project is currently open'
      );
    }

    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      repository: new JsonImageWorkspaceRepository(storage, session.projectId)
    };
  }

  private createDraftId() {
    return toDraftId(
      this.dependencies.createDraftId?.() ?? `image-draft-${randomUUID()}`
    );
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<ImageWorkspaceIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapImageWorkspaceError(error) };
    }
  }

  private enqueueMutation<T>(
    operation: () => Promise<ImageWorkspaceIpcResult<T>>
  ): Promise<ImageWorkspaceIpcResult<T>> {
    return this.mutations.enqueue(operation);
  }
}

class ImageWorkspaceControllerError extends Error {
  constructor(
    readonly code: ImageWorkspaceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageWorkspaceControllerError';
  }
}

function parseModeRequest(request: unknown): ImageWorkspaceMode {
  if (
    !isRecord(request) ||
    typeof request.mode !== 'string' ||
    !imageWorkspaceModes.includes(request.mode as ImageWorkspaceMode)
  ) {
    throw invalidRequest('A supported image workspace mode is required');
  }

  return request.mode as ImageWorkspaceMode;
}

function parseDraftIdRequest(request: unknown) {
  if (!isRecord(request) || typeof request.draftId !== 'string') {
    throw invalidRequest('A valid image workspace draft ID is required');
  }

  try {
    return toDraftId(request.draftId);
  } catch {
    throw invalidRequest('A valid image workspace draft ID is required');
  }
}

function parseUpdateRequest(request: unknown): ImageWorkspaceDraft {
  if (!isRecord(request) || !isRecord(request.draft)) {
    throw invalidRequest('A valid image workspace draft is required');
  }

  const { draftId, ...rest } = request.draft;
  const value = { ...rest, id: draftId };

  if (!isImageWorkspaceDraft(value)) {
    throw invalidRequest('The image workspace draft is invalid');
  }

  return createImageWorkspaceDraft(value);
}

function parseDeriveRequest(request: unknown): {
  readonly sourceDraftId: ReturnType<typeof toDraftId>;
  readonly targetMode: ImageWorkspaceMode;
} {
  if (!isRecord(request)) {
    throw invalidRequest('A source draft and target mode are required');
  }

  const sourceDraftId = parseDraftIdRequest({
    draftId: request.sourceDraftId
  });
  const targetMode = parseModeRequest({ mode: request.targetMode });
  return { sourceDraftId, targetMode };
}

export function toImageWorkspaceDto(
  draft: ImageWorkspaceDraft
): ImageWorkspaceDraftDto {
  const { id, ...rest } = createImageWorkspaceDraft(draft);
  return { ...rest, draftId: id } as ImageWorkspaceDraftDto;
}

function invalidRequest(message: string): ImageWorkspaceControllerError {
  return new ImageWorkspaceControllerError('invalid_request', message);
}

function mapImageWorkspaceError(error: unknown): {
  readonly code: ImageWorkspaceIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof ImageWorkspaceControllerError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: 'workspace_storage_error',
    message: 'The local image workspace operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
