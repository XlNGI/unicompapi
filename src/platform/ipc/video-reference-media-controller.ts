import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  applyVideoWorkspaceChangeStaleness,
  createAsset,
  createFileReference,
  createVideoWorkspaceDraft,
  toAssetId,
  toDraftId,
  toFileReferenceId,
  toIsoTimestamp,
  transitionFile,
  type Asset,
  type FileLocator,
  type FileReference,
  type IsoTimestamp,
  type VideoMaterialKind,
  type VideoMaterialSelection,
  type VideoWorkspaceDraft
} from '../../domain';
import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcErrorCode,
  VideoWorkspaceIpcResult,
  VideoWorkspaceMaterialAssetDto,
  VideoWorkspaceMaterialPreviewDto,
  VideoWorkspaceMaterialSelectionResultDto,
  VideoWorkspaceMaterialTargetDto
} from '../../shared/video-workspace-ipc';
import {
  FileVerificationError,
  FileVerificationPersistenceService,
  ImageInspectionError,
  NodeFileStatusProbe,
  NodeImageInspector,
  NodeSha256FileVerifier,
  NodeVideoInspector,
  VideoInspectionError,
  resolveFileReferencePathSafely,
  type VideoInspection,
  type VideoInspector
} from '../files';
import {
  JsonAssetRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonVideoWorkspaceRepository
} from '../repositories';
import {
  NodeProjectStorage,
  findFileIndexEntryByRelativePath,
  toProjectRelativePath
} from '../storage';
import type { LocalMediaHandleRegistry } from './controlled-local-media';
import type { StorageProjectSession } from './storage-ipc-controller';
import { toVideoWorkspaceDto } from './video-workspace-controller';
import type { VideoWorkspaceMutationCoordinator } from './video-workspace-mutations';

export interface VideoReferenceMediaControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  chooseMediaFile(mediaKind: VideoMaterialKind): Promise<string | undefined>;
  handles: LocalMediaHandleRegistry;
  mutations: VideoWorkspaceMutationCoordinator;
  videoInspector?: VideoInspector;
  createAssetId?(): string;
  createFileId?(): string;
  now?(): string;
  onError?(error: unknown): void;
}

export class VideoReferenceMediaController {
  private readonly videoInspector: VideoInspector;

  constructor(
    private readonly dependencies: VideoReferenceMediaControllerDependencies
  ) {
    this.videoInspector = dependencies.videoInspector ?? new NodeVideoInspector();
  }

  selectMaterial(
    request: unknown
  ): Promise<
    VideoWorkspaceIpcResult<VideoWorkspaceMaterialSelectionResultDto>
  > {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const parsed = parseMaterialRequest(request, true);
        if (!parsed.mediaKind) {
          throw mediaError(
            'invalid_request',
            'A supported material media kind is required'
          );
        }
        const mediaKind = parsed.mediaKind;
        const context = this.createContext();
        const draft = await requireDraft(context.workspaceRepository, parsed.draftId);
        const binding = resolveTarget(draft, parsed.target, mediaKind);
        const selectedPath = await this.dependencies.chooseMediaFile(
          mediaKind
        );

        if (!selectedPath) {
          return { cancelled: true };
        }

        const before = await this.inspect(selectedPath, mediaKind);
        const createdAt = this.now();
        const locator = locatorForSelectedFile(
          context.session.rootDirectory,
          selectedPath
        );
        const reusable = locator.kind === 'project'
          ? await findReusableProjectFile(context, locator.relativePath)
          : undefined;
        const provisional = reusable ?? createFileReference({
          id: this.createFileId(),
          projectId: context.session.projectId,
          locator,
          createdAt
        });
        const verifier = new NodeSha256FileVerifier(
          context.session.rootDirectory
        );
        const verification = await verifier.verify({ file: provisional });
        const after = await this.inspect(selectedPath, mediaKind);

        if (!sameInspection(before, after, verification.sizeBytes)) {
          throw mediaError(
            'media_changed_during_selection',
            'The selected media changed while it was being verified'
          );
        }

        const file = refreshAvailableFile(provisional, verification);
        const asset = createMediaAsset({
          id: this.createAssetId(),
          projectId: context.session.projectId,
          file,
          selectedPath,
          role: binding.role,
          inspection: after,
          createdAt: verification.verifiedAt
        });
        const updated = attachSelection(
          draft,
          parsed.target,
          asset,
          verification.verifiedAt
        );

        await context.fileRepository.save(file);
        await context.assetRepository.save(asset);
        await context.workspaceRepository.save(updated);
        if (file.locator.kind === 'project' && !reusable) {
          await registerProjectFileIndex(context, file);
        }

        return {
          cancelled: false,
          draft: toVideoWorkspaceDto(updated),
          material: toMaterialDto(asset, file)
        };
      })
    );
  }

  getMaterial(
    request: unknown
  ): Promise<
    VideoWorkspaceIpcResult<VideoWorkspaceMaterialAssetDto | undefined>
  > {
    return this.execute(async () => {
      await this.dependencies.mutations.wait();
      const parsed = parseMaterialRequest(request, false);
      const context = this.createContext();
      const draft = await requireDraft(context.workspaceRepository, parsed.draftId);
      const binding = resolveTarget(draft, parsed.target);
      if (!binding.selection) return undefined;
      const resolved = await resolveMaterial(context, binding.selection);
      return toMaterialDto(resolved.asset, resolved.file);
    });
  }

  clearMaterial(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>> {
    return this.dependencies.mutations.enqueue(() =>
      this.execute(async () => {
        const parsed = parseMaterialRequest(request, false);
        const context = this.createContext();
        const draft = await requireDraft(context.workspaceRepository, parsed.draftId);
        const binding = resolveTarget(draft, parsed.target);
        if (!binding.selection) return toVideoWorkspaceDto(draft);

        const updated = clearSelection(draft, parsed.target, this.now());
        await context.workspaceRepository.save(updated);
        return toVideoWorkspaceDto(updated);
      })
    );
  }

  createMaterialPreview(
    request: unknown
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceMaterialPreviewDto>> {
    return this.execute(async () => {
      await this.dependencies.mutations.wait();
      const parsed = parseMaterialRequest(request, false);
      const context = this.createContext();
      const draft = await requireDraft(context.workspaceRepository, parsed.draftId);
      const binding = resolveTarget(draft, parsed.target);
      if (!binding.selection) {
        throw mediaError(
          'material_not_found',
          'The requested video workspace material is not selected'
        );
      }

      const resolved = await resolveMaterial(context, binding.selection);
      const probe = new NodeFileStatusProbe(context.session.rootDirectory);
      const persistence = new FileVerificationPersistenceService(
        context.fileRepository,
        context.indexRepository,
        probe,
        () => this.now()
      );
      const result = await probe.inspect(resolved.file, {
        expectedChecksum: resolved.file.checksumSha256
      });
      const verified = await persistence.persistProbeResult(
        resolved.file,
        result
      );

      if (
        verified.state !== 'available' ||
        verified.lastVerification?.matchesExpected === false
      ) {
        throw mediaError(
          'preview_unavailable',
          'The selected media is not locally available and verified'
        );
      }

      const target = await resolveFileReferencePathSafely(
        context.session.rootDirectory,
        verified
      );
      const mimeType = mediaMimeType(resolved.asset);
      const handle = this.dependencies.handles.create(target, mimeType);
      return {
        ...handle,
        mediaKind: resolved.asset.mediaKind as VideoMaterialKind,
        mimeType
      };
    });
  }

  private createContext(): VideoReferenceMediaContext {
    const session = this.dependencies.getSession();
    if (!session) {
      throw mediaError('project_not_open', 'No project is currently open');
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      workspaceRepository: new JsonVideoWorkspaceRepository(
        storage,
        session.projectId
      ),
      assetRepository: new JsonAssetRepository(storage, session.projectId),
      fileRepository: new JsonFileReferenceRepository(storage, session.projectId),
      indexRepository: new JsonFileIndexRepository(storage, session.projectId)
    };
  }

  private inspect(target: string, mediaKind: VideoMaterialKind) {
    return mediaKind === 'image'
      ? new NodeImageInspector().inspect(target)
      : this.videoInspector.inspect(target);
  }

  private createAssetId() {
    return toAssetId(
      this.dependencies.createAssetId?.() ?? `asset-video-material-${randomUUID()}`
    );
  }

  private createFileId() {
    return toFileReferenceId(
      this.dependencies.createFileId?.() ?? `file-video-material-${randomUUID()}`
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
      return { ok: false, error: mapMediaError(error) };
    }
  }
}

interface VideoReferenceMediaContext {
  readonly session: StorageProjectSession;
  readonly workspaceRepository: JsonVideoWorkspaceRepository;
  readonly assetRepository: JsonAssetRepository;
  readonly fileRepository: JsonFileReferenceRepository;
  readonly indexRepository: JsonFileIndexRepository;
}

interface ParsedMaterialRequest {
  readonly draftId: ReturnType<typeof toDraftId>;
  readonly target: VideoWorkspaceMaterialTargetDto;
  readonly mediaKind?: VideoMaterialKind;
}

interface MaterialBinding {
  readonly role: string;
  readonly selection?: VideoMaterialSelection;
}

type MediaInspection =
  | Awaited<ReturnType<NodeImageInspector['inspect']>>
  | VideoInspection;

class VideoReferenceMediaError extends Error {
  constructor(
    readonly code: VideoWorkspaceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoReferenceMediaError';
  }
}

function parseMaterialRequest(
  request: unknown,
  requireMediaKind: boolean
): ParsedMaterialRequest {
  if (!isRecord(request) || typeof request.draftId !== 'string') {
    throw mediaError(
      'invalid_request',
      'A video workspace draft and material target are required'
    );
  }

  let draftId: ReturnType<typeof toDraftId>;
  try {
    draftId = toDraftId(request.draftId);
  } catch {
    throw mediaError('invalid_request', 'The video workspace draft ID is invalid');
  }

  const target = parseTarget(request.target);
  const mediaKind = request.mediaKind;
  if (
    requireMediaKind &&
    mediaKind !== 'image' &&
    mediaKind !== 'video'
  ) {
    throw mediaError(
      'invalid_request',
      'A supported material media kind is required'
    );
  }
  return {
    draftId,
    target,
    mediaKind: mediaKind === 'image' || mediaKind === 'video'
      ? mediaKind
      : undefined
  };
}

function parseTarget(value: unknown): VideoWorkspaceMaterialTargetDto {
  if (!isRecord(value)) {
    throw mediaError('invalid_request', 'A valid material target is required');
  }
  if (value.kind === 'quick_reference' && Object.keys(value).length === 1) {
    return { kind: 'quick_reference' };
  }
  if (value.kind === 'image_source' && Object.keys(value).length === 1) {
    return { kind: 'image_source' };
  }
  if (
    value.kind === 'slot' &&
    typeof value.slotId === 'string' &&
    value.slotId.trim().length > 0 &&
    Object.keys(value).every((key) => key === 'kind' || key === 'slotId')
  ) {
    return { kind: 'slot', slotId: value.slotId.trim() };
  }
  throw mediaError('invalid_request', 'A valid material target is required');
}

async function requireDraft(
  repository: JsonVideoWorkspaceRepository,
  draftId: ReturnType<typeof toDraftId>
): Promise<VideoWorkspaceDraft> {
  const draft = await repository.get(draftId);
  if (!draft) {
    throw mediaError(
      'draft_not_found',
      'The requested video workspace draft does not exist'
    );
  }
  return draft;
}

function resolveTarget(
  draft: VideoWorkspaceDraft,
  target: VideoWorkspaceMaterialTargetDto,
  requestedKind?: VideoMaterialKind
): MaterialBinding {
  if (target.kind === 'quick_reference') {
    if (draft.mode !== 'quick_video') {
      throw mediaError(
        'material_target_mismatch',
        'The quick reference target belongs only to quick video drafts'
      );
    }
    return { role: 'reference', selection: draft.quick.reference };
  }

  if (target.kind === 'image_source') {
    if (draft.mode !== 'image_to_video') {
      throw mediaError(
        'material_target_mismatch',
        'The image source target belongs only to image-to-video drafts'
      );
    }
    if (requestedKind && requestedKind !== 'image') {
      throw mediaError(
        'material_type_mismatch',
        'Image-to-video requires exactly one image source'
      );
    }
    return { role: 'image_to_video_source', selection: draft.imageToVideo.source };
  }

  if (draft.mode === 'quick_video') {
    throw mediaError(
      'material_target_mismatch',
      'Quick video drafts do not expose dynamic material slots'
    );
  }
  const materials = draft.mode === 'text_to_video'
    ? draft.textToVideo.materials
    : draft.imageToVideo.materials;
  const slot = materials?.slots.find((candidate) => candidate.id === target.slotId);
  if (!slot) {
    throw mediaError(
      'material_target_not_found',
      'The requested dynamic material slot does not exist'
    );
  }
  if (requestedKind && !slot.acceptedMediaKinds.includes(requestedKind)) {
    throw mediaError(
      'material_type_mismatch',
      'The selected media kind is not accepted by this material slot'
    );
  }
  return { role: slot.role, selection: slot.selection };
}

function attachSelection(
  draft: VideoWorkspaceDraft,
  target: VideoWorkspaceMaterialTargetDto,
  asset: Asset,
  updatedAt: IsoTimestamp
): VideoWorkspaceDraft {
  const selection: VideoMaterialSelection = {
    assetId: asset.id,
    mediaKind: asset.mediaKind as VideoMaterialKind,
    role: asset.role ?? 'reference',
    selectedAt: updatedAt
  };
  const candidate = target.kind === 'quick_reference'
    ? {
        ...draft,
        state: 'editing' as const,
        quick: { reference: selection },
        updatedAt
      }
    : target.kind === 'image_source'
      ? {
          ...draft,
          state: 'editing' as const,
          imageToVideo: {
            ...(draft as Extract<VideoWorkspaceDraft, { mode: 'image_to_video' }>).imageToVideo,
            source: selection
          },
          updatedAt
        }
    : replaceSlotSelection(draft, target.slotId, selection, updatedAt);
  return applyVideoWorkspaceChangeStaleness(
    draft,
    createVideoWorkspaceDraft(candidate as VideoWorkspaceDraft),
    updatedAt
  );
}

function clearSelection(
  draft: VideoWorkspaceDraft,
  target: VideoWorkspaceMaterialTargetDto,
  updatedAt: IsoTimestamp
): VideoWorkspaceDraft {
  const candidate = target.kind === 'quick_reference'
    ? {
        ...draft,
        state: 'editing' as const,
        quick: {},
        updatedAt
      }
    : target.kind === 'image_source'
      ? {
          ...draft,
          state: 'editing' as const,
          imageToVideo: withoutImageSource(
            (draft as Extract<VideoWorkspaceDraft, { mode: 'image_to_video' }>).imageToVideo
          ),
          updatedAt
        }
    : replaceSlotSelection(draft, target.slotId, undefined, updatedAt);
  return applyVideoWorkspaceChangeStaleness(
    draft,
    createVideoWorkspaceDraft(candidate as VideoWorkspaceDraft),
    updatedAt
  );
}

function withoutImageSource(
  workspace: Extract<VideoWorkspaceDraft, { mode: 'image_to_video' }>['imageToVideo']
) {
  const { source, ...rest } = workspace;
  void source;
  return rest;
}

function replaceSlotSelection(
  draft: VideoWorkspaceDraft,
  slotId: string,
  selection: VideoMaterialSelection | undefined,
  updatedAt: IsoTimestamp
): VideoWorkspaceDraft {
  if (draft.mode === 'quick_video') {
    throw mediaError(
      'material_target_mismatch',
      'Quick video drafts do not expose dynamic material slots'
    );
  }
  const materials = draft.mode === 'text_to_video'
    ? draft.textToVideo.materials
    : draft.imageToVideo.materials;
  if (!materials) {
    throw mediaError(
      'material_target_not_found',
      'The video workspace does not have dynamic material slots'
    );
  }
  const slots = materials.slots.map((slot) =>
    slot.id === slotId
      ? selection
        ? { ...slot, selection }
        : {
            id: slot.id,
            role: slot.role,
            required: slot.required,
            acceptedMediaKinds: [...slot.acceptedMediaKinds]
          }
      : slot
  );
  return draft.mode === 'text_to_video'
    ? {
        ...draft,
        state: 'editing',
        textToVideo: {
          ...draft.textToVideo,
          materials: { ...materials, slots }
        },
        updatedAt
      }
    : {
        ...draft,
        state: 'editing',
        imageToVideo: {
          ...draft.imageToVideo,
          materials: { ...materials, slots }
        },
        updatedAt
      };
}

async function resolveMaterial(
  context: VideoReferenceMediaContext,
  selection: VideoMaterialSelection
): Promise<{ readonly asset: Asset; readonly file: FileReference }> {
  const asset = await context.assetRepository.get(selection.assetId);
  if (
    !asset ||
    asset.mediaKind !== selection.mediaKind ||
    asset.role !== selection.role ||
    (asset.mediaKind === 'image' && !asset.imageMetadata) ||
    (asset.mediaKind === 'video' && !asset.videoMetadata)
  ) {
    throw mediaError(
      'material_not_found',
      'The selected material asset does not exist or no longer matches its role'
    );
  }
  const file = await context.fileRepository.get(asset.fileId);
  if (!file) {
    throw mediaError(
      'material_not_found',
      'The selected material file record does not exist'
    );
  }
  return { asset, file };
}

function createMediaAsset(input: {
  readonly id: ReturnType<typeof toAssetId>;
  readonly projectId: VideoWorkspaceDraft['projectId'];
  readonly file: FileReference;
  readonly selectedPath: string;
  readonly role: string;
  readonly inspection: MediaInspection;
  readonly createdAt: IsoTimestamp;
}): Asset {
  const shared = {
    id: input.id,
    projectId: input.projectId,
    fileId: input.file.id,
    name: path.basename(input.selectedPath),
    origin: 'imported' as const,
    role: input.role,
    createdAt: input.createdAt
  };
  return 'durationMs' in input.inspection
    ? createAsset({
        ...shared,
        mediaKind: 'video',
        videoMetadata: {
          mimeType: input.inspection.mimeType,
          container: input.inspection.container,
          durationMs: input.inspection.durationMs,
          width: input.inspection.width,
          height: input.inspection.height
        }
      })
    : createAsset({
        ...shared,
        mediaKind: 'image',
        imageMetadata: {
          mimeType: input.inspection.mimeType,
          width: input.inspection.width,
          height: input.inspection.height
        }
      });
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
  return { ...available, lastVerification: { ...verification } };
}

function refreshAvailableFile(
  provisional: FileReference,
  verification: {
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly matchesExpected: boolean | undefined;
    readonly verifiedAt: IsoTimestamp;
  }
): FileReference {
  if (provisional.state === 'available') {
    return {
      ...provisional,
      sizeBytes: verification.sizeBytes,
      checksumSha256: verification.checksumSha256,
      updatedAt: verification.verifiedAt,
      lastVerification: {
        sizeBytes: verification.sizeBytes,
        checksumSha256: verification.checksumSha256,
        matchesExpected: verification.matchesExpected,
        verifiedAt: verification.verifiedAt
      }
    };
  }
  return createAvailableFile(provisional, verification);
}

async function findReusableProjectFile(
  context: VideoReferenceMediaContext,
  relativePath: string
): Promise<FileReference | undefined> {
  const normalized = toProjectRelativePath(relativePath);
  const indexed = findFileIndexEntryByRelativePath(
    await context.indexRepository.load(),
    normalized
  );
  if (indexed) {
    const owned = await context.fileRepository.get(indexed.fileId);
    if (
      owned &&
      owned.locator.kind === 'project' &&
      owned.locator.relativePath === normalized
    ) {
      return owned;
    }
  }

  const files = await context.fileRepository.list(context.session.projectId);
  return files.find(
    (candidate) =>
      candidate.locator.kind === 'project' &&
      candidate.locator.relativePath === normalized &&
      candidate.state === 'available'
  );
}

async function registerProjectFileIndex(
  context: VideoReferenceMediaContext,
  file: FileReference
): Promise<void> {
  if (file.locator.kind !== 'project') {
    return;
  }
  try {
    await context.indexRepository.upsert({
      fileId: file.id,
      relativePath: toProjectRelativePath(file.locator.relativePath),
      state: file.state,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      updatedAt: file.updatedAt
    });
  } catch {
    // Selection already saved the file/asset/draft. Index ownership races are
    // tolerated here because preview/submit can verify without stealing paths.
  }
}

function locatorForSelectedFile(
  projectRoot: string,
  selectedPath: string
): FileLocator {
  const root = path.resolve(projectRoot);
  const target = path.resolve(selectedPath);
  const relative = path.relative(root, target);
  if (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return {
      kind: 'project',
      relativePath: toProjectRelativePath(relative)
    };
  }
  return { kind: 'external', absolutePath: target };
}

function toMaterialDto(
  asset: Asset,
  file: FileReference
): VideoWorkspaceMaterialAssetDto {
  if (file.sizeBytes === undefined) {
    throw mediaError(
      'material_not_found',
      'The selected material verification metadata is incomplete'
    );
  }
  const shared = {
    assetId: asset.id,
    name: asset.name,
    role: asset.role ?? 'reference',
    sizeBytes: file.sizeBytes,
    fileState: file.state,
    referenceKind: file.locator.kind
  } as const;
  if (asset.mediaKind === 'image' && asset.imageMetadata) {
    return {
      ...shared,
      mediaKind: 'image',
      mimeType: asset.imageMetadata.mimeType,
      width: asset.imageMetadata.width,
      height: asset.imageMetadata.height
    };
  }
  if (asset.mediaKind === 'video' && asset.videoMetadata) {
    return {
      ...shared,
      mediaKind: 'video',
      mimeType: asset.videoMetadata.mimeType,
      container: asset.videoMetadata.container,
      durationMs: asset.videoMetadata.durationMs,
      width: asset.videoMetadata.width,
      height: asset.videoMetadata.height
    };
  }
  throw mediaError(
    'material_not_found',
    'The selected material metadata is incomplete'
  );
}

function mediaMimeType(asset: Asset): string {
  if (asset.mediaKind === 'image' && asset.imageMetadata) {
    return asset.imageMetadata.mimeType;
  }
  if (asset.mediaKind === 'video' && asset.videoMetadata) {
    return asset.videoMetadata.mimeType;
  }
  throw mediaError(
    'material_not_found',
    'The selected material MIME type is unavailable'
  );
}

function sameInspection(
  before: MediaInspection,
  after: MediaInspection,
  verifiedSize: number
): boolean {
  return JSON.stringify(before) === JSON.stringify(after) &&
    after.sizeBytes === verifiedSize;
}

function mediaError(
  code: VideoWorkspaceIpcErrorCode,
  message: string
): VideoReferenceMediaError {
  return new VideoReferenceMediaError(code, message);
}

function mapMediaError(error: unknown): {
  readonly code: VideoWorkspaceIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof VideoReferenceMediaError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ImageInspectionError) {
    return error.code === 'unsupported_image'
      ? {
          code: 'unsupported_image',
          message: 'The selected file is not a locally supported image'
        }
      : {
          code: 'media_unreadable',
          message: 'The selected image could not be read and verified'
        };
  }
  if (error instanceof VideoInspectionError) {
    return {
      code: error.code === 'unsupported_video'
        ? 'unsupported_video'
        : 'media_unreadable',
      message: error.code === 'unsupported_video'
        ? 'The selected file is not a locally supported video'
        : 'The selected video could not be read and inspected'
    };
  }
  if (error instanceof FileVerificationError) {
    return {
      code: 'media_unreadable',
      message: 'The selected media could not be read and verified'
    };
  }
  return {
    code: 'workspace_storage_error',
    message: 'The local video material operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
