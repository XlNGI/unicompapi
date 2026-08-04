import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import path from 'node:path';
import {
  createAsset,
  createFileReference,
  getVideoTimelineDurationUs,
  toAssetId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toVideoClipId,
  toVideoEditDraftId,
  toWorkId,
  transitionFile,
  type Asset,
  type BackgroundMusic,
  type CoverSelection,
  type FileLocator,
  type FileReference,
  type IsoTimestamp,
  type MediaIdentitySnapshot,
  type VideoClip,
  type VideoClipSource,
  type VideoEditDraft
} from '../../domain';
import type {
  VideoEditorIpcErrorCode,
  VideoEditorIpcResult,
  VideoEditorAssetSelectionResultDto,
  VideoEditorDraftDto,
  VideoEditorMediaIdentityDto,
  VideoEditorPreviewArtifactDto,
  VideoEditorPreviewArtifactKindDto,
  VideoEditorRelinkPreparationDto,
  VideoEditorSourceDto,
  VideoEditorSourcePreviewDto,
  VideoEditorSourceRegistrationStrategyDto,
  VideoEditorSourceSelectionResultDto,
  VideoEditorSourceStatusDto
} from '../../shared/video-editor-ipc';
import {
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
  JsonWorkRepository
} from '../repositories';
import {
  NodeProjectStorage,
  toProjectRelativePath
} from '../storage';
import {
  NodeVideoEditorPreviewCache,
  UnavailableVideoEditorPreviewAdapter,
  videoEditorPreviewArtifactKinds,
  type VideoEditorPreviewArtifactAdapter,
  type VideoEditorPreviewArtifactKind,
  type VideoEditorPreviewPlan
} from '../videos';
import type { LocalMediaHandleRegistry } from './controlled-local-media';
import type { StorageProjectSession } from './storage-ipc-controller';
import type { VideoEditorController } from './video-editor-controller';

const relinkTokenTtlMs = 5 * 60 * 1000;

export interface VideoEditorMediaControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  chooseVideoFile(): Promise<string | undefined>;
  chooseAudioFile?(): Promise<string | undefined>;
  chooseImageFile?(): Promise<string | undefined>;
  handles: LocalMediaHandleRegistry;
  editor: VideoEditorController;
  videoInspector?: VideoInspector;
  previewAdapter?: VideoEditorPreviewArtifactAdapter;
  createAssetId?(): string;
  createFileId?(): string;
  createClipId?(): string;
  now?(): string;
  nowMs?(): number;
  onError?(error: unknown): void;
}

export class VideoEditorMediaController {
  private readonly inspector: VideoInspector;
  private readonly previewAdapter: VideoEditorPreviewArtifactAdapter;
  private readonly relinkTokens = new Map<string, RelinkCandidate>();

  constructor(
    private readonly dependencies: VideoEditorMediaControllerDependencies
  ) {
    this.inspector = dependencies.videoInspector ?? new NodeVideoInspector();
    this.previewAdapter =
      dependencies.previewAdapter ?? new UnavailableVideoEditorPreviewAdapter();
  }

  selectSource(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorSourceSelectionResultDto>> {
    return this.execute(async () => {
      const parsed = parseSelectSourceRequest(request);
      const context = this.createContext();
      const draft = await this.requireDraft(parsed.draftId);
      assertRevision(draft, parsed.expectedRevision);
      const selectedPath = await this.dependencies.chooseVideoFile();
      if (!selectedPath) return { cancelled: true };

      const selected = await this.inspectStable(context, selectedPath);
      const registered = parsed.strategy === 'managed_project_copy'
        ? await this.copyAndRegister(context, selectedPath, selected)
        : await this.registerFile(context, {
            selectedPath,
            selected,
            locator: { kind: 'external', absolutePath: path.resolve(selectedPath) },
            referenceKind: 'external_reference'
          });

      const clip = this.createClip(registered.file, registered.asset, selected);
      const updated = await this.dependencies.editor.insertClipFromMedia({
        draftId: draft.id,
        expectedRevision: parsed.expectedRevision,
        clip
      });
      const dto = unwrapEditorResult(updated);
      return {
        cancelled: false,
        draft: dto,
        source: toSourceDto(
          clip,
          registered.asset,
          registered.referenceKind,
          registered.file.state
        )
      };
    });
  }

  attachWork(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorSourceSelectionResultDto>> {
    return this.execute(async () => {
      const parsed = parseAttachWorkRequest(request);
      const context = this.createContext();
      const draft = await this.requireDraft(parsed.draftId);
      assertRevision(draft, parsed.expectedRevision);
      const work = await context.workRepository.get(parsed.workId);
      if (
        !work ||
        work.projectId !== context.session.projectId ||
        work.mediaKind !== 'video'
      ) {
        throw mediaError('work_not_found', 'The requested project video work does not exist');
      }
      const file = await context.fileRepository.get(work.fileId);
      if (!file) {
        throw mediaError('source_unavailable', 'The work source file record is unavailable');
      }
      const verified = await this.verifyFile(context, file, file.checksumSha256);
      if (
        verified.file.state !== 'available' ||
        verified.matchesIdentity === false
      ) {
        throw mediaError('source_unavailable', 'The work source is not locally verified');
      }
      const target = await resolveFileReferencePathSafely(
        context.session.rootDirectory,
        verified.file
      );
      const selected = await this.inspectStable(context, target);
      if (
        file.checksumSha256 &&
        selected.checksumSha256 !== file.checksumSha256
      ) {
        throw mediaError('source_changed', 'The work source changed after it was registered');
      }
      const asset = createVideoAsset({
        id: this.createAssetId(),
        projectId: context.session.projectId,
        fileId: file.id,
        name: work.name,
        origin: 'derived',
        inspection: selected.inspection,
        createdAt: this.now()
      });
      await context.assetRepository.save(asset);
      const clip = this.createClip(verified.file, asset, selected, work.id);
      const updated = await this.dependencies.editor.insertClipFromMedia({
        draftId: draft.id,
        expectedRevision: parsed.expectedRevision,
        clip
      });
      return {
        cancelled: false,
        draft: unwrapEditorResult(updated),
        source: toSourceDto(clip, asset, 'managed_work', verified.file.state)
      };
    });
  }

  selectBackgroundMusic(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorAssetSelectionResultDto>> {
    return this.execute(async () => {
      const parsed = parseRevisionRequest(request);
      const context = this.createContext();
      const draft = await this.requireDraft(parsed.draftId);
      assertRevision(draft, parsed.expectedRevision);
      const timelineDurationUs = getVideoTimelineDurationUs(draft);
      if (timelineDurationUs <= 0) {
        throw mediaError('invalid_request', 'Background music requires a non-empty timeline');
      }
      const selectedPath = await this.dependencies.chooseAudioFile?.();
      if (!selectedPath) return { cancelled: true };

      const inspected = await inspectStableWave(
        context.session.rootDirectory,
        selectedPath,
        this.now()
      );
      const registered = await this.registerAuxiliaryFile(context, {
        selectedPath,
        mediaKind: 'audio',
        role: 'video_editor_background_music',
        verification: inspected.verification
      });
      const identity = {
        sizeBytes: inspected.verification.sizeBytes,
        modifiedAtMs: inspected.modifiedAtMs,
        durationUs: inspected.durationUs,
        container: 'wav',
        width: 0,
        height: 0,
        checksumSha256: inspected.verification.checksumSha256
      };
      const music: BackgroundMusic = {
        kind: 'background_music',
        fileId: registered.file.id,
        assetId: registered.asset.id,
        identity,
        sourceRange: { inUs: 0, outUs: identity.durationUs },
        timelineRange: {
          startUs: 0,
          endUs: Math.min(identity.durationUs, timelineDurationUs)
        },
        volumePermille: 1000,
        fadeInUs: 0,
        fadeOutUs: 0
      };
      const updated = await this.dependencies.editor.setBackgroundMusicFromMedia({
        draftId: draft.id,
        expectedRevision: parsed.expectedRevision,
        music
      });
      return { cancelled: false, draft: unwrapEditorResult(updated) };
    });
  }

  selectCoverImage(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorAssetSelectionResultDto>> {
    return this.execute(async () => {
      const parsed = parseCoverSelectionRequest(request);
      const context = this.createContext();
      const draft = await this.requireDraft(parsed.draftId);
      assertRevision(draft, parsed.expectedRevision);
      const selectedPath = await this.dependencies.chooseImageFile?.();
      if (!selectedPath) return { cancelled: true };

      const inspected = await inspectStableImage(
        context.session.rootDirectory,
        selectedPath,
        this.now()
      );
      const registered = await this.registerAuxiliaryFile(context, {
        selectedPath,
        mediaKind: 'image',
        role: 'video_editor_cover',
        verification: inspected.verification,
        imageMetadata: inspected.image
      });
      const updated = await this.dependencies.editor.setCoverFromMedia({
        draftId: draft.id,
        expectedRevision: parsed.expectedRevision,
        cover: {
          kind: 'local_image',
          fileId: registered.file.id,
          assetId: registered.asset.id,
          prependToVideo: parsed.prependToVideo,
          prependDurationUs: parsed.prependDurationUs
        }
      });
      return { cancelled: false, draft: unwrapEditorResult(updated) };
    });
  }

  attachCoverWork(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.execute(async () => {
      const parsed = parseCoverWorkRequest(request);
      const context = this.createContext();
      const draft = await this.requireDraft(parsed.draftId);
      assertRevision(draft, parsed.expectedRevision);
      const work = await context.workRepository.get(parsed.workId);
      if (
        !work ||
        work.projectId !== context.session.projectId ||
        work.mediaKind !== 'image'
      ) {
        throw mediaError('work_not_found', 'The requested project image work does not exist');
      }
      const file = await context.fileRepository.get(work.fileId);
      if (!file) {
        throw mediaError('source_unavailable', 'The project image file is unavailable');
      }
      const verified = await this.verifyFile(context, file, file.checksumSha256);
      if (
        verified.file.state !== 'available' ||
        verified.matchesIdentity === false
      ) {
        throw mediaError('source_unavailable', 'The project image is not locally verified');
      }
      try {
        await new NodeImageInspector().inspect(
          await resolveFileReferencePathSafely(
            context.session.rootDirectory,
            verified.file
          )
        );
      } catch {
        throw mediaError('unsupported_image', 'The project work is not a supported image');
      }
      const cover: CoverSelection = {
        kind: 'project_image',
        workId: work.id,
        fileId: verified.file.id,
        prependToVideo: parsed.prependToVideo,
        prependDurationUs: parsed.prependDurationUs
      };
      return unwrapEditorResult(
        await this.dependencies.editor.setCoverFromMedia({
          draftId: draft.id,
          expectedRevision: parsed.expectedRevision,
          cover
        })
      );
    });
  }

  getSourceStatus(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorSourceStatusDto>> {
    return this.execute(async () => {
      const parsed = parseClipRequest(request);
      const context = this.createContext();
      const resolved = await this.resolveClip(context, parsed.draftId, parsed.clipId);
      return this.checkSource(context, resolved.clip);
    });
  }

  prepareRelink(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorRelinkPreparationDto>> {
    return this.execute(async () => {
      const parsed = parseClipRequest(request);
      const context = this.createContext();
      const resolved = await this.resolveClip(context, parsed.draftId, parsed.clipId);
      const selectedPath = await this.dependencies.chooseVideoFile();
      if (!selectedPath) return { cancelled: true };
      const selected = await this.inspectStable(context, selectedPath);
      const comparison = compareIdentity(resolved.clip.source.identity, selected.identity);
      this.removeExpiredTokens();
      const token = randomUUID();
      const expiresAtMs = this.nowMs() + relinkTokenTtlMs;
      this.relinkTokens.set(token, {
        draftId: resolved.draft.id,
        draftRevision: resolved.draft.revision,
        clipId: resolved.clip.id,
        before: structuredClone(resolved.clip.source),
        selectedPath: path.resolve(selectedPath),
        selected,
        matchesIdentity: comparison.matches,
        expiresAtMs
      });
      return {
        cancelled: false,
        token,
        expiresAt: new Date(expiresAtMs).toISOString(),
        matchesIdentity: comparison.matches,
        candidate: toIdentityDto(selected.identity),
        differences: comparison.differences
      };
    });
  }

  confirmRelink(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorSourceSelectionResultDto>> {
    return this.execute(async () => {
      const parsed = parseConfirmRelinkRequest(request);
      this.removeExpiredTokens();
      const candidate = this.relinkTokens.get(parsed.token);
      if (
        !candidate ||
        candidate.draftId !== parsed.draftId ||
        candidate.clipId !== parsed.clipId
      ) {
        throw mediaError('relink_token_invalid', 'The relink confirmation has expired or is invalid');
      }
      const context = this.createContext();
      const resolved = await this.resolveClip(context, parsed.draftId, parsed.clipId);
      if (
        resolved.draft.revision !== candidate.draftRevision ||
        JSON.stringify(resolved.clip.source) !== JSON.stringify(candidate.before)
      ) {
        throw mediaError('draft_conflict', 'The draft changed while relink confirmation was pending');
      }
      if (!candidate.matchesIdentity && !parsed.acceptMismatch) {
        throw mediaError(
          'relink_mismatch_confirmation_required',
          'The selected replacement differs from the original and requires explicit confirmation'
        );
      }
      if (candidate.selected.identity.durationUs < resolved.clip.sourceRange.outUs) {
        throw mediaError(
          'relink_candidate_too_short',
          'The replacement video is shorter than the clip source range'
        );
      }

      const registered = await this.registerFile(context, {
        selectedPath: candidate.selectedPath,
        selected: candidate.selected,
        locator: locatorForPath(context.session.rootDirectory, candidate.selectedPath),
        referenceKind: candidate.before.workId && candidate.matchesIdentity
          ? 'managed_work'
          : locatorForPath(context.session.rootDirectory, candidate.selectedPath).kind === 'project'
            ? 'managed_project_copy'
            : 'external_reference'
      });
      const source: VideoClipSource = {
        fileId: registered.file.id,
        assetId: registered.asset.id,
        workId: candidate.matchesIdentity ? candidate.before.workId : undefined,
        identity: candidate.selected.identity
      };
      const updated = await this.dependencies.editor.replaceClipSourceFromMedia({
        draftId: resolved.draft.id,
        expectedRevision: candidate.draftRevision,
        clipId: resolved.clip.id,
        source
      });
      const draft = unwrapEditorResult(updated);
      this.relinkTokens.delete(parsed.token);
      const updatedClip = { ...resolved.clip, source };
      return {
        cancelled: false,
        draft,
        source: toSourceDto(
          updatedClip,
          registered.asset,
          source.workId ? 'managed_work' : registered.referenceKind,
          registered.file.state
        )
      };
    });
  }

  createSourcePreview(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorSourcePreviewDto>> {
    return this.execute(async () => {
      const parsed = parseClipRequest(request);
      const context = this.createContext();
      const resolved = await this.resolveClip(context, parsed.draftId, parsed.clipId);
      const verified = await this.requireVerifiedSource(context, resolved.clip);
      const target = await resolveFileReferencePathSafely(
        context.session.rootDirectory,
        verified
      );
      const mimeType = videoMimeType(resolved.clip.source.identity.container);
      return {
        draftRevision: resolved.draft.revision,
        ...this.dependencies.handles.create(target, mimeType),
        mimeType,
        kind: 'original'
      };
    });
  }

  requestPreviewArtifact(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorPreviewArtifactDto>> {
    return this.execute(async () => {
      const parsed = parsePreviewArtifactRequest(request);
      const context = this.createContext();
      const resolved = await this.resolveClip(context, parsed.draftId, parsed.clipId);
      const source = await this.requireVerifiedSource(context, resolved.clip);
      const sourcePath = await resolveFileReferencePathSafely(
        context.session.rootDirectory,
        source
      );
      const plan: VideoEditorPreviewPlan = {
        schemaVersion: 1,
        draftId: resolved.draft.id,
        draftRevision: resolved.draft.revision,
        clipId: resolved.clip.id,
        sourceIdentity: resolved.clip.source.identity,
        sourceRange: resolved.clip.sourceRange,
        speed: resolved.clip.speed,
        transform: resolved.clip.transform,
        sourceAudio: resolved.clip.sourceAudio,
        transitionToNext: resolved.clip.transitionToNext
      };
      const cache = new NodeVideoEditorPreviewCache(context.session.rootDirectory);
      const result = await this.previewAdapter.requestArtifact({
        plan,
        kind: parsed.kind,
        cache,
        sourcePath
      });
      if (result.status === 'adapter_unavailable') {
        throw mediaError(
          'adapter_unavailable',
          'No approved local media adapter is available for preview artifacts'
        );
      }
      const handle = this.dependencies.handles.create(
        result.artifact.target,
        result.artifact.mimeType
      );
      return {
        kind: result.artifact.kind,
        draftRevision: resolved.draft.revision,
        ...handle,
        mimeType: result.artifact.mimeType
      };
    });
  }

  clearPreviewCache(): Promise<
    VideoEditorIpcResult<{ readonly cleared: true }>
  > {
    return this.execute(async () => {
      const context = this.createContext();
      await new NodeVideoEditorPreviewCache(context.session.rootDirectory).clear();
      return { cleared: true };
    });
  }

  private async requireDraft(
    draftId: VideoEditDraft['id']
  ): Promise<VideoEditDraft> {
    const result = await this.dependencies.editor.readForMedia(draftId);
    const draft = unwrapEditorResult(result);
    if (!draft) {
      throw mediaError('draft_not_found', 'The requested video edit draft does not exist');
    }
    return draft;
  }

  private async resolveClip(
    context: MediaContext,
    draftId: VideoEditDraft['id'],
    clipId: VideoClip['id']
  ): Promise<{ readonly draft: VideoEditDraft; readonly clip: VideoClip }> {
    const draft = await this.requireDraft(draftId);
    if (draft.projectId !== context.session.projectId) {
      throw mediaError('draft_not_found', 'The requested video edit draft does not exist');
    }
    const clip = draft.videoTrack.find((candidate) => candidate.id === clipId);
    if (!clip) {
      throw mediaError('clip_not_found', 'The requested video clip does not exist');
    }
    return { draft, clip };
  }

  private async inspectStable(
    context: MediaContext,
    target: string
  ): Promise<InspectedSource> {
    const beforeMetadata = await stat(target);
    const before = await this.inspector.inspect(target);
    const provisional = createFileReference({
      id: this.createFileId(),
      projectId: context.session.projectId,
      locator: { kind: 'external', absolutePath: path.resolve(target) },
      createdAt: this.now()
    });
    const verification = await new NodeSha256FileVerifier(
      context.session.rootDirectory
    ).verify({ file: provisional });
    const after = await this.inspector.inspect(target);
    const afterMetadata = await stat(target);
    if (
      !beforeMetadata.isFile() ||
      !afterMetadata.isFile() ||
      beforeMetadata.size !== afterMetadata.size ||
      Math.trunc(beforeMetadata.mtimeMs) !== Math.trunc(afterMetadata.mtimeMs) ||
      !sameInspection(before, after, verification.sizeBytes)
    ) {
      throw mediaError('source_changed', 'The selected video changed while it was being verified');
    }
    return {
      inspection: after,
      identity: {
        sizeBytes: verification.sizeBytes,
        modifiedAtMs: Math.max(0, Math.trunc(afterMetadata.mtimeMs)),
        durationUs: after.durationMs * 1000,
        container: after.container,
        width: after.width,
        height: after.height,
        checksumSha256: verification.checksumSha256
      },
      checksumSha256: verification.checksumSha256
    };
  }

  private async copyAndRegister(
    context: MediaContext,
    sourcePath: string,
    selected: InspectedSource
  ): Promise<RegisteredSource> {
    const extension = selected.inspection.container === 'quicktime' ? 'mov' : 'mp4';
    const fileName = `${randomUUID()}.${extension}`;
    const relativePath = toProjectRelativePath(`files/editor-sources/${fileName}`);
    const temporaryRelativePath = toProjectRelativePath(
      `tmp/editor-sources/.${fileName}.${randomUUID()}.tmp`
    );
    const target = path.join(context.session.rootDirectory, relativePath);
    const temporary = path.join(context.session.rootDirectory, temporaryRelativePath);
    try {
      await Promise.all([
        mkdir(path.dirname(target), { recursive: true }),
        mkdir(path.dirname(temporary), { recursive: true })
      ]);
      await copyFile(sourcePath, temporary);
      const handle = await open(temporary, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const copied = await this.inspectStable(context, temporary);
      if (
        copied.checksumSha256 !== selected.checksumSha256 ||
        !sameInspection(copied.inspection, selected.inspection, selected.identity.sizeBytes)
      ) {
        throw mediaError('managed_copy_failed', 'The managed project copy failed verification');
      }
      await rename(temporary, target);
      return this.registerFile(context, {
        selectedPath: target,
        selected: copied,
        locator: { kind: 'project', relativePath },
        referenceKind: 'managed_project_copy'
      });
    } catch (error) {
      await rm(temporary, { force: true });
      if (error instanceof VideoEditorMediaError) throw error;
      throw mediaError('managed_copy_failed', 'The managed project copy could not be published');
    }
  }

  private async registerFile(
    context: MediaContext,
    input: {
      readonly selectedPath: string;
      readonly selected: InspectedSource;
      readonly locator: FileLocator;
      readonly referenceKind: RegisteredSource['referenceKind'];
    }
  ): Promise<RegisteredSource> {
    const createdAt = this.now();
    const provisional = createFileReference({
      id: this.createFileId(),
      projectId: context.session.projectId,
      locator: input.locator,
      createdAt
    });
    const file = createAvailableFile(
      provisional,
      input.selected.identity.sizeBytes,
      input.selected.checksumSha256,
      createdAt
    );
    const asset = createVideoAsset({
      id: this.createAssetId(),
      projectId: context.session.projectId,
      fileId: file.id,
      name: path.basename(input.selectedPath),
      origin: 'imported',
      inspection: input.selected.inspection,
      createdAt
    });
    await context.fileRepository.save(file);
    if (file.locator.kind === 'project') {
      await context.indexRepository.upsert({
        fileId: file.id,
        relativePath: toProjectRelativePath(file.locator.relativePath),
        state: file.state,
        sizeBytes: file.sizeBytes,
        checksumSha256: file.checksumSha256,
        updatedAt: file.updatedAt
      });
    }
    await context.assetRepository.save(asset);
    return { file, asset, referenceKind: input.referenceKind };
  }

  private async registerAuxiliaryFile(
    context: MediaContext,
    input: {
      readonly selectedPath: string;
      readonly mediaKind: 'audio' | 'image';
      readonly role: string;
      readonly verification: {
        readonly sizeBytes: number;
        readonly checksumSha256: string;
        readonly verifiedAt: IsoTimestamp;
      };
      readonly imageMetadata?: {
        readonly mimeType: string;
        readonly width: number;
        readonly height: number;
      };
    }
  ): Promise<{ readonly file: FileReference; readonly asset: Asset }> {
    const provisional = createFileReference({
      id: this.createFileId(),
      projectId: context.session.projectId,
      locator: {
        kind: 'external',
        absolutePath: path.resolve(input.selectedPath)
      },
      createdAt: input.verification.verifiedAt
    });
    const file = createAvailableFile(
      provisional,
      input.verification.sizeBytes,
      input.verification.checksumSha256,
      input.verification.verifiedAt
    );
    const asset = createAsset({
      id: this.createAssetId(),
      projectId: context.session.projectId,
      fileId: file.id,
      name: path.basename(input.selectedPath),
      mediaKind: input.mediaKind,
      origin: 'imported',
      role: input.role,
      imageMetadata: input.imageMetadata,
      createdAt: input.verification.verifiedAt
    });
    await context.fileRepository.save(file);
    await context.assetRepository.save(asset);
    return { file, asset };
  }

  private createClip(
    file: FileReference,
    asset: Asset,
    selected: InspectedSource,
    workId?: ReturnType<typeof toWorkId>
  ): VideoClip {
    return {
      kind: 'video_clip',
      id: this.createClipId(),
      source: {
        fileId: file.id,
        assetId: asset.id,
        workId,
        identity: selected.identity
      },
      sourceRange: { inUs: 0, outUs: selected.identity.durationUs },
      speed: { numerator: 1, denominator: 1 },
      transform: {
        scalePermille: 1000,
        positionXPermille: 0,
        positionYPermille: 0,
        rotationMilliDegrees: 0,
        flipX: false,
        flipY: false,
        crop: null
      },
      sourceAudio: { muted: false, volumePermille: 1000 },
      transitionToNext: { kind: 'none' }
    };
  }

  private async checkSource(
    context: MediaContext,
    clip: VideoClip
  ): Promise<VideoEditorSourceStatusDto> {
    const file = await context.fileRepository.get(clip.source.fileId);
    if (!file) {
      return {
        clipId: clip.id,
        state: 'missing',
        issues: ['file_record_missing'],
        relinkRequired: true,
        referenceKind: clip.source.workId ? 'managed_work' : 'external_reference'
      };
    }
    const verified = await this.verifyFile(
      context,
      file,
      clip.source.identity.checksumSha256
    );
    const issues = [...verified.issues];
    if (verified.file.state === 'available') {
      try {
        const target = await resolveFileReferencePathSafely(
          context.session.rootDirectory,
          verified.file
        );
        const metadata = await stat(target);
        if (Math.trunc(metadata.mtimeMs) !== clip.source.identity.modifiedAtMs) {
          issues.push('metadata_changed');
        }
      } catch {
        // The content probe already supplies the authoritative availability state.
      }
    }
    return {
      clipId: clip.id,
      state: verified.file.state,
      issues,
      matchesIdentity: verified.matchesIdentity,
      relinkRequired:
        verified.file.state !== 'available' || verified.matchesIdentity === false,
      referenceKind: clip.source.workId
        ? 'managed_work'
        : verified.file.locator.kind === 'project'
          ? 'managed_project_copy'
          : 'external_reference',
      checkedAt: verified.file.lastVerification?.verifiedAt
    };
  }

  private async verifyFile(
    context: MediaContext,
    file: FileReference,
    expectedChecksum?: string
  ): Promise<{
    readonly file: FileReference;
    readonly issues: readonly string[];
    readonly matchesIdentity?: boolean;
  }> {
    const probe = new NodeFileStatusProbe(context.session.rootDirectory);
    const result = await probe.inspect(file, { expectedChecksum });
    const persistence = new FileVerificationPersistenceService(
      context.fileRepository,
      context.indexRepository,
      probe,
      () => this.now()
    );
    const updated = await persistence.persistProbeResult(file, result);
    return {
      file: updated,
      issues: result.issues,
      matchesIdentity: result.verification?.matchesExpected
    };
  }

  private async requireVerifiedSource(
    context: MediaContext,
    clip: VideoClip
  ): Promise<FileReference> {
    const file = await context.fileRepository.get(clip.source.fileId);
    if (!file) {
      throw mediaError('preview_unavailable', 'The source file record is unavailable');
    }
    const verified = await this.verifyFile(
      context,
      file,
      clip.source.identity.checksumSha256
    );
    if (
      verified.file.state !== 'available' ||
      verified.matchesIdentity === false
    ) {
      throw mediaError('preview_unavailable', 'The source is not locally available and verified');
    }
    return verified.file;
  }

  private createContext(): MediaContext {
    const session = this.dependencies.getSession();
    if (!session) {
      throw mediaError('project_not_open', 'No project is currently open');
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      assetRepository: new JsonAssetRepository(storage, session.projectId),
      fileRepository: new JsonFileReferenceRepository(storage, session.projectId),
      indexRepository: new JsonFileIndexRepository(storage, session.projectId),
      workRepository: new JsonWorkRepository(storage, session.projectId)
    };
  }

  private createAssetId() {
    return toAssetId(
      this.dependencies.createAssetId?.() ?? `asset-video-editor-${randomUUID()}`
    );
  }

  private createFileId() {
    return toFileReferenceId(
      this.dependencies.createFileId?.() ?? `file-video-editor-${randomUUID()}`
    );
  }

  private createClipId() {
    return toVideoClipId(
      this.dependencies.createClipId?.() ?? `video-editor-clip-${randomUUID()}`
    );
  }

  private now(): IsoTimestamp {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private nowMs(): number {
    return this.dependencies.nowMs?.() ?? Date.now();
  }

  private removeExpiredTokens(): void {
    const now = this.nowMs();
    for (const [token, candidate] of this.relinkTokens) {
      if (candidate.expiresAtMs <= now) this.relinkTokens.delete(token);
    }
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<VideoEditorIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapMediaError(error) };
    }
  }
}

async function inspectStableImage(
  projectRoot: string,
  selectedPath: string,
  createdAt: IsoTimestamp
) {
  try {
    const inspector = new NodeImageInspector();
    const beforeMetadata = await stat(selectedPath);
    const before = await inspector.inspect(selectedPath);
    const verification = await verifySelectedFile(
      projectRoot,
      selectedPath,
      createdAt
    );
    const after = await inspector.inspect(selectedPath);
    const afterMetadata = await stat(selectedPath);
    if (
      Math.trunc(beforeMetadata.mtimeMs) !== Math.trunc(afterMetadata.mtimeMs) ||
      before.mimeType !== after.mimeType ||
      before.width !== after.width ||
      before.height !== after.height ||
      before.sizeBytes !== after.sizeBytes ||
      after.sizeBytes !== verification.sizeBytes
    ) {
      throw mediaError('source_changed', 'The selected image changed while it was verified');
    }
    return { image: after, verification };
  } catch (error) {
    if (error instanceof VideoEditorMediaError) throw error;
    if (error instanceof ImageInspectionError) {
      throw mediaError(
        error.code === 'unsupported_image' ? 'unsupported_image' : 'media_unreadable',
        'The selected image is not locally supported'
      );
    }
    throw mediaError('media_unreadable', 'The selected image could not be verified');
  }
}

async function inspectStableWave(
  projectRoot: string,
  selectedPath: string,
  createdAt: IsoTimestamp
) {
  const beforeMetadata = await stat(selectedPath);
  const before = await inspectWave(selectedPath);
  const verification = await verifySelectedFile(
    projectRoot,
    selectedPath,
    createdAt
  );
  const after = await inspectWave(selectedPath);
  const afterMetadata = await stat(selectedPath);
  if (
    Math.trunc(beforeMetadata.mtimeMs) !== Math.trunc(afterMetadata.mtimeMs) ||
    before.durationUs !== after.durationUs ||
    before.sizeBytes !== after.sizeBytes ||
    after.sizeBytes !== verification.sizeBytes
  ) {
    throw mediaError('source_changed', 'The selected audio changed while it was verified');
  }
  return {
    ...after,
    modifiedAtMs: Math.max(0, Math.trunc(afterMetadata.mtimeMs)),
    verification
  };
}

async function verifySelectedFile(
  projectRoot: string,
  selectedPath: string,
  createdAt: IsoTimestamp
) {
  const provisional = createFileReference({
    id: toFileReferenceId('file-editor-selection'),
    projectId: toProjectId('project-editor-selection'),
    locator: { kind: 'external', absolutePath: path.resolve(selectedPath) },
    createdAt
  });
  return new NodeSha256FileVerifier(projectRoot).verify({ file: provisional });
}

async function inspectWave(
  selectedPath: string
): Promise<{ readonly durationUs: number; readonly sizeBytes: number }> {
  const metadata = await stat(selectedPath);
  if (!metadata.isFile() || metadata.size < 44) {
    throw mediaError('unsupported_audio', 'The selected file is not a readable WAV audio file');
  }
  const handle = await open(selectedPath, 'r');
  try {
    const header = Buffer.alloc(Math.min(metadata.size, 1024 * 1024));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const data = header.subarray(0, bytesRead);
    if (
      data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw mediaError('unsupported_audio', 'Only verified PCM or float WAV audio is supported');
    }
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= data.length) {
      const type = data.toString('ascii', offset, offset + 4);
      const size = data.readUInt32LE(offset + 4);
      const payload = offset + 8;
      if (type === 'fmt ' && size >= 16 && payload + 16 <= data.length) {
        const format = data.readUInt16LE(payload);
        byteRate = data.readUInt32LE(payload + 8);
        if ((format !== 1 && format !== 3) || byteRate <= 0) {
          throw mediaError('unsupported_audio', 'The WAV encoding is not locally supported');
        }
      }
      if (type === 'data') {
        dataSize = size;
        if (payload + dataSize > metadata.size) {
          throw mediaError('media_unreadable', 'The selected WAV file is truncated');
        }
        break;
      }
      offset = payload + size + (size % 2);
    }
    const durationUs = Math.floor((dataSize * 1_000_000) / byteRate);
    if (!byteRate || !dataSize || !Number.isSafeInteger(durationUs) || durationUs <= 0) {
      throw mediaError('media_unreadable', 'The WAV duration could not be read safely');
    }
    return { durationUs, sizeBytes: metadata.size };
  } finally {
    await handle.close();
  }
}

interface MediaContext {
  readonly session: StorageProjectSession;
  readonly assetRepository: JsonAssetRepository;
  readonly fileRepository: JsonFileReferenceRepository;
  readonly indexRepository: JsonFileIndexRepository;
  readonly workRepository: JsonWorkRepository;
}

interface InspectedSource {
  readonly inspection: VideoInspection;
  readonly identity: MediaIdentitySnapshot;
  readonly checksumSha256: string;
}

interface RegisteredSource {
  readonly file: FileReference;
  readonly asset: Asset;
  readonly referenceKind:
    | VideoEditorSourceRegistrationStrategyDto
    | 'managed_work';
}

interface RelinkCandidate {
  readonly draftId: VideoEditDraft['id'];
  readonly draftRevision: number;
  readonly clipId: VideoClip['id'];
  readonly before: VideoClipSource;
  readonly selectedPath: string;
  readonly selected: InspectedSource;
  readonly matchesIdentity: boolean;
  readonly expiresAtMs: number;
}

class VideoEditorMediaError extends Error {
  constructor(
    readonly code: VideoEditorIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoEditorMediaError';
  }
}

function parseSelectSourceRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly expectedRevision: number;
  readonly strategy: VideoEditorSourceRegistrationStrategyDto;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'expectedRevision', 'strategy']) ||
    typeof request.draftId !== 'string' ||
    !isNonNegativeInteger(request.expectedRevision) ||
    (request.strategy !== 'external_reference' &&
      request.strategy !== 'managed_project_copy')
  ) {
    throw mediaError('invalid_request', 'A valid source selection request is required');
  }
  return {
    draftId: parseDraftId(request.draftId),
    expectedRevision: request.expectedRevision,
    strategy: request.strategy
  };
}

function parseRevisionRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly expectedRevision: number;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'expectedRevision']) ||
    typeof request.draftId !== 'string' ||
    !isNonNegativeInteger(request.expectedRevision)
  ) {
    throw mediaError('invalid_request', 'A valid media selection request is required');
  }
  return {
    draftId: parseDraftId(request.draftId),
    expectedRevision: request.expectedRevision
  };
}

function parseCoverSelectionRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly expectedRevision: number;
  readonly prependToVideo: boolean;
  readonly prependDurationUs?: number;
} {
  if (
    !isRecord(request) ||
    !exact(request, request.prependDurationUs === undefined
      ? ['draftId', 'expectedRevision', 'prependToVideo']
      : ['draftId', 'expectedRevision', 'prependToVideo', 'prependDurationUs']) ||
    typeof request.prependToVideo !== 'boolean' ||
    !isValidPrependDuration(request.prependToVideo, request.prependDurationUs)
  ) {
    throw mediaError('invalid_request', 'A valid cover image request is required');
  }
  return {
    ...parseRevisionRequest({
      draftId: request.draftId,
      expectedRevision: request.expectedRevision
    }),
    prependToVideo: request.prependToVideo,
    prependDurationUs: request.prependDurationUs as number | undefined
  };
}

function parseCoverWorkRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly expectedRevision: number;
  readonly workId: ReturnType<typeof toWorkId>;
  readonly prependToVideo: boolean;
  readonly prependDurationUs?: number;
} {
  if (
    !isRecord(request) ||
    !exact(request, request.prependDurationUs === undefined
      ? ['draftId', 'expectedRevision', 'workId', 'prependToVideo']
      : [
          'draftId',
          'expectedRevision',
          'workId',
          'prependToVideo',
          'prependDurationUs'
        ]) ||
    typeof request.workId !== 'string' ||
    typeof request.prependToVideo !== 'boolean' ||
    !isValidPrependDuration(request.prependToVideo, request.prependDurationUs)
  ) {
    throw mediaError('invalid_request', 'A valid project cover request is required');
  }
  try {
    return {
      ...parseRevisionRequest({
        draftId: request.draftId,
        expectedRevision: request.expectedRevision
      }),
      workId: toWorkId(request.workId),
      prependToVideo: request.prependToVideo,
      prependDurationUs: request.prependDurationUs as number | undefined
    };
  } catch (error) {
    if (error instanceof VideoEditorMediaError) throw error;
    throw mediaError('invalid_request', 'The project cover identifier is invalid');
  }
}

function isValidPrependDuration(prepend: boolean, duration: unknown): boolean {
  return prepend
    ? isNonNegativeInteger(duration) && duration > 0
    : duration === undefined;
}

function parseAttachWorkRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly expectedRevision: number;
  readonly workId: ReturnType<typeof toWorkId>;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'expectedRevision', 'workId']) ||
    typeof request.draftId !== 'string' ||
    typeof request.workId !== 'string' ||
    !isNonNegativeInteger(request.expectedRevision)
  ) {
    throw mediaError('invalid_request', 'A valid managed work request is required');
  }
  try {
    return {
      draftId: toVideoEditDraftId(request.draftId),
      expectedRevision: request.expectedRevision,
      workId: toWorkId(request.workId)
    };
  } catch {
    throw mediaError('invalid_request', 'The managed work identifiers are invalid');
  }
}

function parseClipRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly clipId: VideoClip['id'];
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'clipId']) ||
    typeof request.draftId !== 'string' ||
    typeof request.clipId !== 'string'
  ) {
    throw mediaError('invalid_request', 'A valid video clip request is required');
  }
  try {
    return {
      draftId: toVideoEditDraftId(request.draftId),
      clipId: toVideoClipId(request.clipId)
    };
  } catch {
    throw mediaError('invalid_request', 'The video clip identifiers are invalid');
  }
}

function parseConfirmRelinkRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly clipId: VideoClip['id'];
  readonly token: string;
  readonly acceptMismatch: boolean;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'clipId', 'token', 'acceptMismatch']) ||
    typeof request.draftId !== 'string' ||
    typeof request.clipId !== 'string' ||
    typeof request.token !== 'string' ||
    request.token.trim().length === 0 ||
    typeof request.acceptMismatch !== 'boolean'
  ) {
    throw mediaError('invalid_request', 'A valid relink confirmation is required');
  }
  const parsed = parseClipRequest({
    draftId: request.draftId,
    clipId: request.clipId
  });
  return { ...parsed, token: request.token, acceptMismatch: request.acceptMismatch };
}

function parsePreviewArtifactRequest(request: unknown): {
  readonly draftId: VideoEditDraft['id'];
  readonly clipId: VideoClip['id'];
  readonly kind: VideoEditorPreviewArtifactKind;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'clipId', 'kind']) ||
    typeof request.draftId !== 'string' ||
    typeof request.clipId !== 'string' ||
    !videoEditorPreviewArtifactKinds.includes(
      request.kind as VideoEditorPreviewArtifactKindDto
    )
  ) {
    throw mediaError('invalid_request', 'A valid preview artifact request is required');
  }
  const parsed = parseClipRequest({
    draftId: request.draftId,
    clipId: request.clipId
  });
  return { ...parsed, kind: request.kind as VideoEditorPreviewArtifactKind };
}

function parseDraftId(value: string): VideoEditDraft['id'] {
  try {
    return toVideoEditDraftId(value);
  } catch {
    throw mediaError('invalid_request', 'The video edit draft ID is invalid');
  }
}

function assertRevision(draft: VideoEditDraft, expectedRevision: number): void {
  if (draft.revision !== expectedRevision) {
    throw mediaError('draft_conflict', 'The video edit draft changed before the source was saved');
  }
}

function createAvailableFile(
  provisional: FileReference,
  sizeBytes: number,
  checksumSha256: string,
  verifiedAt: IsoTimestamp
): FileReference {
  const verification = {
    sizeBytes,
    checksumSha256,
    matchesExpected: undefined,
    verifiedAt
  };
  const verifying = transitionFile(provisional, 'verifying', verifiedAt);
  const available = transitionFile(verifying, 'available', verifiedAt, verification);
  return { ...available, lastVerification: verification };
}

function createVideoAsset(input: {
  readonly id: ReturnType<typeof toAssetId>;
  readonly projectId: VideoEditDraft['projectId'];
  readonly fileId: FileReference['id'];
  readonly name: string;
  readonly origin: 'imported' | 'derived';
  readonly inspection: VideoInspection;
  readonly createdAt: IsoTimestamp;
}): Asset {
  return createAsset({
    id: input.id,
    projectId: input.projectId,
    fileId: input.fileId,
    name: input.name,
    mediaKind: 'video',
    origin: input.origin,
    role: 'video_editor_source',
    videoMetadata: {
      mimeType: input.inspection.mimeType,
      container: input.inspection.container,
      durationMs: input.inspection.durationMs,
      width: input.inspection.width,
      height: input.inspection.height
    },
    createdAt: input.createdAt
  });
}

function locatorForPath(projectRoot: string, targetPath: string): FileLocator {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return { kind: 'project', relativePath: toProjectRelativePath(relative) };
  }
  return { kind: 'external', absolutePath: target };
}

function compareIdentity(
  original: MediaIdentitySnapshot,
  candidate: MediaIdentitySnapshot
): {
  readonly matches: boolean;
  readonly differences: NonNullable<VideoEditorRelinkPreparationDto['differences']>;
} {
  const content = original.checksumSha256
    ? original.checksumSha256 !== candidate.checksumSha256
    : false;
  const differences = {
    content,
    size: original.sizeBytes !== candidate.sizeBytes,
    duration: original.durationUs !== candidate.durationUs,
    container: original.container !== candidate.container,
    dimensions:
      original.width !== candidate.width || original.height !== candidate.height
  };
  const matches = original.checksumSha256
    ? !content
    : !Object.values(differences).some(Boolean);
  return { matches, differences };
}

function sameInspection(
  left: VideoInspection,
  right: VideoInspection,
  sizeBytes: number
): boolean {
  return left.mimeType === right.mimeType &&
    left.container === right.container &&
    left.durationMs === right.durationMs &&
    left.width === right.width &&
    left.height === right.height &&
    left.sizeBytes === right.sizeBytes &&
    right.sizeBytes === sizeBytes;
}

function toSourceDto(
  clip: VideoClip,
  asset: Asset,
  referenceKind: RegisteredSource['referenceKind'],
  fileState: string
): VideoEditorSourceDto {
  return {
    clipId: clip.id,
    assetId: clip.source.assetId,
    workId: clip.source.workId,
    name: asset.name,
    referenceKind,
    fileState,
    identity: toIdentityDto(clip.source.identity)
  };
}

function toIdentityDto(identity: MediaIdentitySnapshot): VideoEditorMediaIdentityDto {
  return {
    sizeBytes: identity.sizeBytes,
    durationUs: identity.durationUs,
    container: identity.container,
    width: identity.width,
    height: identity.height
  };
}

function videoMimeType(
  container: string
): 'video/mp4' | 'video/quicktime' {
  return container === 'quicktime' ? 'video/quicktime' : 'video/mp4';
}

function unwrapEditorResult<T>(result: VideoEditorIpcResult<T>): T {
  if (result.ok) return result.value;
  throw mediaError(result.error.code, result.error.message);
}

function mediaError(
  code: VideoEditorIpcErrorCode,
  message: string
): VideoEditorMediaError {
  return new VideoEditorMediaError(code, message);
}

function mapMediaError(error: unknown): {
  readonly code: VideoEditorIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof VideoEditorMediaError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof VideoInspectionError) {
    return {
      code: error.code === 'unsupported_video' ? 'unsupported_video' : 'media_unreadable',
      message: error.code === 'unsupported_video'
        ? 'The selected file is not a supported local video'
        : 'The selected video could not be inspected safely'
    };
  }
  return {
    code: 'workspace_storage_error',
    message: 'The editor media operation could not be completed'
  };
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
