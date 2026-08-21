import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  applyImageWorkspaceChangeStaleness,
  createAsset,
  createFileReference,
  createImageWorkspaceDraft,
  toAssetId,
  toDraftId,
  toFileReferenceId,
  toIsoTimestamp,
  toWorkId,
  transitionFile,
  type Asset,
  type FileReference,
  type ImageWorkspaceDraft,
  type IsoTimestamp
} from '../../domain';
import type {
  ImageWorkspaceInputAssetDto,
  ImageWorkspaceInputPreviewDto,
  ImageWorkspaceInputSelectionDto,
  ImageWorkspaceIpcErrorCode,
  ImageWorkspaceIpcResult
} from '../../shared/image-workspace-ipc';
import {
  FileVerificationError,
  FileVerificationPersistenceService,
  ImageInspectionError,
  NodeFileStatusProbe,
  NodeImageInspector,
  NodeSha256FileVerifier,
  resolveFileReferencePathSafely
} from '../files';
import {
  JsonAssetRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonImageWorkspaceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { LocalMediaHandleRegistry } from './controlled-local-media';
import { toImageWorkspaceDto } from './image-workspace-controller';
import type { ImageWorkspaceMutationCoordinator } from './image-workspace-mutations';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ImageLocalMediaControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  chooseImageFile(): Promise<string | undefined>;
  handles: LocalMediaHandleRegistry;
  mutations: ImageWorkspaceMutationCoordinator;
  createAssetId?(): string;
  createFileId?(): string;
  onError?(error: unknown): void;
}

export class ImageLocalMediaController {
  constructor(
    private readonly dependencies: ImageLocalMediaControllerDependencies
  ) {}

  selectInput(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceInputSelectionDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const draftId = parseDraftId(request);
        const context = this.createContext();
        const draft = await requireDraft(context.workspaceRepository, draftId);
        assertInputSelectionAllowed(draft);
        const selectedPath = await this.dependencies.chooseImageFile();

        if (!selectedPath) {
          return { cancelled: true };
        }
        return this.registerInput(draftId, selectedPath);
      })
    );
  }

  importInput(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceInputSelectionDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const draftId = parseDraftId(request);
        return this.registerInput(draftId, parseDroppedFilePath(request));
      })
    );
  }

  useWorkAsInput(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceInputSelectionDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const draftId = parseDraftId(request);
        const workId = parseWorkId(request);
        const context = this.createContext();
        const draft = await requireDraft(context.workspaceRepository, draftId);
        assertInputSelectionAllowed(draft);
        const work = (await context.workRepository.list(context.session.projectId))
          .find((candidate) => candidate.id === workId);
        if (!work || work.mediaKind !== 'image') {
          throw new ImageLocalMediaError(
            'input_not_found',
            'The selected local image Work does not exist'
          );
        }
        const file = await context.fileRepository.get(work.fileId);
        if (!file || file.state !== 'available' || !file.checksumSha256) {
          throw new ImageLocalMediaError(
            'input_not_found',
            'The selected local image Work is unavailable'
          );
        }
        const verification = await new NodeSha256FileVerifier(
          context.session.rootDirectory
        ).verify({ file, expectedChecksum: file.checksumSha256 });
        if (!verification.matchesExpected) {
          throw new ImageLocalMediaError(
            'image_unreadable',
            'The selected local image Work changed after registration'
          );
        }
        const target = await resolveFileReferencePathSafely(
          context.session.rootDirectory,
          file
        );
        const inspection = await new NodeImageInspector().inspect(target);
        const existing = (await context.assetRepository.list(context.session.projectId))
          .find((candidate) =>
            candidate.fileId === file.id && candidate.mediaKind === 'image'
          );
        const asset = existing ?? createAsset({
          id: this.createAssetId(),
          projectId: context.session.projectId,
          fileId: file.id,
          name: work.name,
          mediaKind: 'image',
          origin: 'generated',
          role: inputRoleForMode(draft.mode),
          imageMetadata: {
            mimeType: inspection.mimeType,
            width: inspection.width,
            height: inspection.height
          },
          createdAt: verification.verifiedAt
        });
        if (!existing) await context.assetRepository.save(asset);
        const updated = attachInput(
          draft,
          asset,
          verification.verifiedAt,
          work.id
        );
        await context.workspaceRepository.save(updated);
        return {
          cancelled: false,
          draft: toImageWorkspaceDto(updated),
          input: toInputDto(asset, file)
        };
      })
    );
  }

  clearInput(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ReturnType<typeof toImageWorkspaceDto>>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const draftId = parseDraftId(request);
        const context = this.createContext();
        const draft = await requireDraft(context.workspaceRepository, draftId);
        if (!draft.input) return toImageWorkspaceDto(draft);
        const updatedAt = toIsoTimestamp(new Date().toISOString());
        const shared = {
          ...draft,
          state: 'editing' as const,
          input: undefined,
          updatedAt
        };
        const candidate = createImageWorkspaceDraft(
          draft.mode === 'image_editing'
            ? {
                ...shared,
                mode: draft.mode,
                editing: { ...draft.editing, lineage: undefined }
              }
            : shared as ImageWorkspaceDraft
        );
        const updated = applyImageWorkspaceChangeStaleness(
          draft,
          candidate,
          updatedAt
        );
        await context.workspaceRepository.save(updated);
        return toImageWorkspaceDto(updated);
      })
    );
  }

  getInput(
    request: unknown
  ): Promise<
    ImageWorkspaceIpcResult<ImageWorkspaceInputAssetDto | undefined>
  > {
    return this.execute(async () => {
      await this.dependencies.mutations.wait();
      const draftId = parseDraftId(request);
      const context = this.createContext();
      const draft = await requireDraft(context.workspaceRepository, draftId);

      if (!draft.input) {
        return undefined;
      }

      const resolved = await resolveInput(context, draft.input.assetId);
      return toInputDto(resolved.asset, resolved.file);
    });
  }

  createInputPreview(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceInputPreviewDto>> {
    return this.execute(async () => {
      await this.dependencies.mutations.wait();
      const draftId = parseDraftId(request);
      const context = this.createContext();
      const draft = await requireDraft(context.workspaceRepository, draftId);

      if (!draft.input) {
        throw new ImageLocalMediaError(
          'input_not_found',
          'The image workspace does not have a selected input'
        );
      }

      const resolved = await resolveInput(context, draft.input.assetId);
      const probe = new NodeFileStatusProbe(context.session.rootDirectory);
      const persistence = new FileVerificationPersistenceService(
        context.fileRepository,
        context.indexRepository,
        probe,
        () => toIsoTimestamp(new Date().toISOString())
      );
      const result = await probe.inspect(resolved.file, {
        expectedChecksum: resolved.file.checksumSha256
      });
      const verified = await persistence.persistProbeResult(resolved.file, result);

      if (
        verified.state !== 'available' ||
        verified.lastVerification?.matchesExpected === false
      ) {
        throw new ImageLocalMediaError(
          'preview_unavailable',
          'The selected image is not locally available and verified'
        );
      }

      const target = await resolveFileReferencePathSafely(
        context.session.rootDirectory,
        verified
      );
      const mimeType = resolved.asset.imageMetadata?.mimeType ?? 'image/unknown';
      const handle = this.dependencies.handles.create(target, mimeType);
      return {
        ...handle,
        mimeType
      };
    });
  }

  private createContext() {
    const session = this.dependencies.getSession();

    if (!session) {
      throw new ImageLocalMediaError(
        'project_not_open',
        'No project is currently open'
      );
    }

    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      workspaceRepository: new JsonImageWorkspaceRepository(
        storage,
        session.projectId
      ),
      assetRepository: new JsonAssetRepository(storage, session.projectId),
      fileRepository: new JsonFileReferenceRepository(storage, session.projectId),
      indexRepository: new JsonFileIndexRepository(storage, session.projectId),
      workRepository: new JsonWorkRepository(storage, session.projectId)
    };
  }

  private async registerInput(
    draftId: ReturnType<typeof toDraftId>,
    selectedPath: string
  ): Promise<ImageWorkspaceInputSelectionDto> {
    const context = this.createContext();
    const draft = await requireDraft(context.workspaceRepository, draftId);
    assertInputSelectionAllowed(draft);
    const inspector = new NodeImageInspector();
    const before = await inspector.inspect(selectedPath);
    const verifier = new NodeSha256FileVerifier(context.session.rootDirectory);
    const provisional = createFileReference({
      id: this.createFileId(),
      projectId: context.session.projectId,
      locator: { kind: 'external', absolutePath: selectedPath },
      createdAt: toIsoTimestamp(new Date().toISOString())
    });
    const verification = await verifier.verify({ file: provisional });
    const after = await inspector.inspect(selectedPath);

    if (!sameInspection(before, after, verification.sizeBytes)) {
      throw new ImageLocalMediaError(
        'image_unreadable',
        'The selected image changed while it was being verified'
      );
    }

    const file = createAvailableFile(provisional, verification);
    const asset = createAsset({
      id: this.createAssetId(),
      projectId: context.session.projectId,
      fileId: file.id,
      name: path.basename(selectedPath),
      mediaKind: 'image',
      origin: 'imported',
      role: inputRoleForMode(draft.mode),
      imageMetadata: {
        mimeType: after.mimeType,
        width: after.width,
        height: after.height
      },
      createdAt: verification.verifiedAt
    });
    const updated = attachInput(draft, asset, verification.verifiedAt);

    await context.fileRepository.save(file);
    await context.assetRepository.save(asset);
    await context.workspaceRepository.save(updated);

    return {
      cancelled: false,
      draft: toImageWorkspaceDto(updated),
      input: toInputDto(asset, file)
    };
  }

  private createAssetId() {
    return toAssetId(
      this.dependencies.createAssetId?.() ?? `asset-image-${randomUUID()}`
    );
  }

  private createFileId() {
    return toFileReferenceId(
      this.dependencies.createFileId?.() ?? `file-image-${randomUUID()}`
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<ImageWorkspaceIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapImageLocalMediaError(error) };
    }
  }
}

interface ImageLocalMediaContext {
  readonly session: StorageProjectSession;
  readonly workspaceRepository: JsonImageWorkspaceRepository;
  readonly assetRepository: JsonAssetRepository;
  readonly fileRepository: JsonFileReferenceRepository;
  readonly indexRepository: JsonFileIndexRepository;
  readonly workRepository: JsonWorkRepository;
}

class ImageLocalMediaError extends Error {
  constructor(
    readonly code: ImageWorkspaceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageLocalMediaError';
  }
}

function parseDraftId(request: unknown) {
  if (!isRecord(request) || typeof request.draftId !== 'string') {
    throw new ImageLocalMediaError(
      'invalid_request',
      'A valid image workspace draft ID is required'
    );
  }

  try {
    return toDraftId(request.draftId);
  } catch {
    throw new ImageLocalMediaError(
      'invalid_request',
      'A valid image workspace draft ID is required'
    );
  }
}

function parseDroppedFilePath(request: unknown): string {
  if (
    !isRecord(request) ||
    typeof request.sourcePath !== 'string' ||
    !path.isAbsolute(request.sourcePath)
  ) {
    throw new ImageLocalMediaError(
      'invalid_request',
      'A local dropped image file is required'
    );
  }
  return request.sourcePath;
}

function parseWorkId(request: unknown) {
  if (!isRecord(request) || typeof request.workId !== 'string') {
    throw new ImageLocalMediaError(
      'invalid_request',
      'A valid local image Work ID is required'
    );
  }
  try {
    return toWorkId(request.workId);
  } catch {
    throw new ImageLocalMediaError(
      'invalid_request',
      'A valid local image Work ID is required'
    );
  }
}

async function requireDraft(
  repository: JsonImageWorkspaceRepository,
  draftId: ReturnType<typeof toDraftId>
): Promise<ImageWorkspaceDraft> {
  const draft = await repository.get(draftId);
  if (!draft) {
    throw new ImageLocalMediaError(
      'draft_not_found',
      'The requested image workspace draft does not exist'
    );
  }
  return draft;
}

async function resolveInput(
  context: ImageLocalMediaContext,
  assetId: ReturnType<typeof toAssetId>
) {
  const asset = await context.assetRepository.get(assetId);
  if (!asset || asset.mediaKind !== 'image' || !asset.imageMetadata) {
    throw new ImageLocalMediaError(
      'input_not_found',
      'The selected image asset does not exist'
    );
  }

  const file = await context.fileRepository.get(asset.fileId);
  if (!file) {
    throw new ImageLocalMediaError(
      'input_not_found',
      'The selected image file record does not exist'
    );
  }

  return { asset, file };
}

function createAvailableFile(
  provisional: FileReference,
  verification: {
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly matchesExpected: boolean | undefined;
    readonly verifiedAt: IsoTimestamp;
  }
): FileReference {
  const verifying = transitionFile(
    provisional,
    'verifying',
    verification.verifiedAt
  );
  const available = transitionFile(
    verifying,
    'available',
    verification.verifiedAt,
    verification
  );
  return {
    ...available,
    lastVerification: { ...verification }
  };
}

function attachInput(
  draft: ImageWorkspaceDraft,
  asset: Asset,
  updatedAt: IsoTimestamp,
  parentWorkId?: ReturnType<typeof toWorkId>
): ImageWorkspaceDraft {
  const role = inputRoleForMode(draft.mode);
  const shared = {
    ...draft,
    state: 'editing' as const,
    input: {
      assetId: asset.id,
      role,
      purpose: draft.input?.purpose,
      selectedAt: updatedAt
    },
    updatedAt
  };
  const candidate = createImageWorkspaceDraft(
    draft.mode === 'image_editing'
      ? {
          ...shared,
          mode: draft.mode,
          editing: {
            ...draft.editing,
            lineage: { parentAssetId: asset.id, parentWorkId }
          }
        }
      : shared as ImageWorkspaceDraft
  );
  return applyImageWorkspaceChangeStaleness(draft, candidate, updatedAt);
}

function inputRoleForMode(mode: ImageWorkspaceDraft['mode']) {
  return mode === 'quick_image' || mode === 'professional_image'
    ? 'reference' as const
    : 'source' as const;
}

function assertInputSelectionAllowed(draft: ImageWorkspaceDraft): void {
  if (draft.mode === 'quick_image') {
    throw new ImageLocalMediaError(
      'invalid_request',
      'Quick image generation is text-only and cannot accept reference media'
    );
  }
  if (
    draft.mode === 'professional_image' &&
    draft.featureSelection?.productFeature !== 'reference_to_image'
  ) {
    throw new ImageLocalMediaError(
      'invalid_request',
      'Professional image generation must explicitly select reference-to-image first'
    );
  }
}

function toInputDto(
  asset: Asset,
  file: FileReference
): ImageWorkspaceInputAssetDto {
  if (!asset.imageMetadata || file.sizeBytes === undefined) {
    throw new ImageLocalMediaError(
      'input_not_found',
      'The selected image metadata is incomplete'
    );
  }

  return {
    assetId: asset.id,
    name: asset.name,
    mimeType: asset.imageMetadata.mimeType,
    width: asset.imageMetadata.width,
    height: asset.imageMetadata.height,
    sizeBytes: file.sizeBytes,
    fileState: file.state
  };
}

function sameInspection(
  before: { readonly mimeType: string; readonly width: number; readonly height: number; readonly sizeBytes: number },
  after: { readonly mimeType: string; readonly width: number; readonly height: number; readonly sizeBytes: number },
  verifiedSize: number
): boolean {
  return (
    before.mimeType === after.mimeType &&
    before.width === after.width &&
    before.height === after.height &&
    before.sizeBytes === after.sizeBytes &&
    after.sizeBytes === verifiedSize
  );
}

function mapImageLocalMediaError(error: unknown): {
  readonly code: ImageWorkspaceIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof ImageLocalMediaError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof ImageInspectionError) {
    return error.code === 'unsupported_image'
      ? {
          code: 'unsupported_image',
          message: 'The selected file is not a locally supported image'
        }
      : {
          code: 'image_unreadable',
          message: 'The selected image could not be read and verified'
        };
  }

  if (error instanceof FileVerificationError) {
    return {
      code: 'image_unreadable',
      message: 'The selected image could not be read and verified'
    };
  }

  return {
    code: 'workspace_storage_error',
    message: 'The local image input operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
