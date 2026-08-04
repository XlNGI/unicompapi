import { randomUUID } from 'node:crypto';
import {
  InvariantViolationError,
  applyVideoEditCommand,
  copyVideoEditDraft,
  createEmptyVideoEditDraft,
  isVideoEditCommand,
  maximumVideoTransitionDurationUs,
  minimumVideoTransitionDurationUs,
  redoVideoEditCommand,
  toAssetId,
  toDraftId,
  toFileReferenceId,
  toIsoTimestamp,
  toTextOverlayId,
  toVideoClipId,
  toVideoEditDraftId,
  toWorkId,
  undoVideoEditCommand,
  type BackgroundMusic,
  type CanvasSettings,
  type CoverSelection,
  type OutputPreference,
  type TextOverlay,
  type VideoClip,
  type VideoClipSource,
  type VideoEditCommand,
  type VideoEditDraft,
  type VideoEditDraftRepository,
  type VideoEditSourceIntent
} from '../../domain';
import type {
  VideoEditorCoverDto,
  VideoEditorDraftDto,
  VideoEditorIpcErrorCode,
  VideoEditorIpcResult,
  VideoEditorSourceIntentDto,
  VideoEditorUpdateDto
} from '../../shared/video-editor-ipc';
import {
  JsonVideoEditDraftRepository,
  JsonVideoWorkspaceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';
import { VideoWorkspaceMutationCoordinator } from './video-workspace-mutations';

export interface VideoEditorControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  createDraftId?(): string;
  createClipId?(): string;
  createTextId?(): string;
  now?(): string;
  mutations?: VideoWorkspaceMutationCoordinator;
  createRepository?(
    session: StorageProjectSession
  ): VideoEditDraftRepository;
  onError?(error: unknown): void;
}

export class VideoEditorController {
  private readonly mutations: VideoWorkspaceMutationCoordinator;
  private readonly pendingDrafts = new Map<string, VideoEditDraft>();

  constructor(
    private readonly dependencies: VideoEditorControllerDependencies
  ) {
    this.mutations =
      dependencies.mutations ?? new VideoWorkspaceMutationCoordinator();
  }

  async waitForMutations(): Promise<void> {
    await this.mutations.wait();
    const session = this.dependencies.getSession();
    if (!session) return;
    const context = this.createContext();
    const prefix = session.rootDirectory + '\0';
    for (const [key, draft] of this.pendingDrafts) {
      if (!key.startsWith(prefix)) continue;
      await context.repository.save(draft);
      this.pendingDrafts.delete(key);
    }
  }

  create(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseCreateRequest(request);
        const context = this.createContext();
        await this.validateSourceIntent(parsed.sourceIntent, context);
        const createdAt = this.now();
        const draft = createEmptyVideoEditDraft({
          id: this.createDraftId(),
          projectId: context.session.projectId,
          title: parsed.title,
          sourceIntent: parsed.sourceIntent,
          createdAt
        });
        await this.persistDraft(context, draft);
        return toVideoEditorDto(draft);
      })
    );
  }

  get(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto | undefined>> {
    return this.execute(async () => {
      await this.mutations.wait();
      const draftId = parseDraftIdRequest(request);
      const context = this.createContext();
      const draft = await this.loadDraft(context, draftId);
      return draft ? toVideoEditorDto(draft) : undefined;
    });
  }

  list(): Promise<VideoEditorIpcResult<readonly VideoEditorDraftDto[]>> {
    return this.execute(async () => {
      await this.mutations.wait();
      const context = this.createContext();
      const stored = await context.repository.list(context.session.projectId);
      const byId = new Map(stored.map((draft) => [draft.id, draft]));
      const prefix = context.session.rootDirectory + '\0';
      for (const [key, draft] of this.pendingDrafts) {
        if (key.startsWith(prefix)) byId.set(draft.id, draft);
      }
      return [...byId.values()].map(toVideoEditorDto);
    });
  }

  update(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.mutateStoredDraft(request, async (stored, parsed) => {
      const command = this.buildCommand(stored, parsed.command);
      return applyVideoEditCommand(stored, command, this.now());
    });
  }

  undo(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.mutateRevisionedDraft(request, async (stored) => {
      if (stored.history.undoStack.length === 0) {
        throw controllerError(
          'nothing_to_undo',
          'There is no video edit command to undo'
        );
      }
      return undoVideoEditCommand(stored, this.now());
    });
  }

  redo(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.mutateRevisionedDraft(request, async (stored) => {
      if (stored.history.redoStack.length === 0) {
        throw controllerError(
          'nothing_to_redo',
          'There is no video edit command to redo'
        );
      }
      return redoVideoEditCommand(stored, this.now());
    });
  }

  copy(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseCopyRequest(request);
        const context = this.createContext();
        const source = await this.loadDraft(context, parsed.draftId);
        this.assertStoredDraft(source, parsed.expectedRevision);
        const copied = copyVideoEditDraft({
          source,
          id: this.createDraftId(),
          title: parsed.title,
          createdAt: this.now()
        });
        await this.persistDraft(context, copied);
        return toVideoEditorDto(copied);
      })
    );
  }

  readForMedia(
    draftId: VideoEditDraft['id']
  ): Promise<VideoEditorIpcResult<VideoEditDraft | undefined>> {
    return this.execute(async () => {
      await this.mutations.wait();
      const context = this.createContext();
      return this.loadDraft(context, draftId);
    });
  }

  insertClipFromMedia(input: {
    readonly draftId: VideoEditDraft['id'];
    readonly expectedRevision: number;
    readonly clip: VideoClip;
  }): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.applyPlatformCommand(
      input.draftId,
      input.expectedRevision,
      (stored) => ({
        schemaVersion: 1,
        kind: 'insert_clip',
        clip: input.clip,
        targetIndex: stored.videoTrack.length
      })
    );
  }

  replaceClipSourceFromMedia(input: {
    readonly draftId: VideoEditDraft['id'];
    readonly expectedRevision: number;
    readonly clipId: VideoClip['id'];
    readonly source: VideoClipSource;
  }): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.applyPlatformCommand(
      input.draftId,
      input.expectedRevision,
      (stored) => {
        const clip = stored.videoTrack.find(
          (candidate) => candidate.id === input.clipId
        );
        if (!clip) {
          throw controllerError(
            'source_not_found',
            'The requested video clip does not exist'
          );
        }
        return {
          schemaVersion: 1,
          kind: 'set_clip_source',
          clipId: input.clipId,
          before: clip.source,
          after: input.source
        };
      }
    );
  }

  getCapabilities(): VideoEditorIpcResult<{
    readonly transitions: readonly {
      readonly kind: 'fade' | 'dissolve';
      readonly minimumDurationUs: number;
      readonly maximumDurationUs: number;
    }[];
    readonly compositionPreview: 'unavailable';
  }> {
    return {
      ok: true,
      value: {
        transitions: (['fade', 'dissolve'] as const).map((kind) => ({
          kind,
          minimumDurationUs: minimumVideoTransitionDurationUs,
          maximumDurationUs: maximumVideoTransitionDurationUs
        })),
        compositionPreview: 'unavailable'
      }
    };
  }

  setBackgroundMusicFromMedia(input: {
    readonly draftId: VideoEditDraft['id'];
    readonly expectedRevision: number;
    readonly music: BackgroundMusic;
  }): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.applyPlatformCommand(
      input.draftId,
      input.expectedRevision,
      (stored) => ({
        schemaVersion: 1,
        kind: 'set_background_music',
        before: stored.backgroundMusic,
        after: input.music
      })
    );
  }

  setCoverFromMedia(input: {
    readonly draftId: VideoEditDraft['id'];
    readonly expectedRevision: number;
    readonly cover: CoverSelection;
  }): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.applyPlatformCommand(
      input.draftId,
      input.expectedRevision,
      (stored) => ({
        schemaVersion: 1,
        kind: 'set_cover',
        before: stored.cover,
        after: input.cover
      })
    );
  }

  private mutateStoredDraft(
    request: unknown,
    mutation: (
      stored: VideoEditDraft,
      parsed: ParsedUpdateRequest
    ) => Promise<VideoEditDraft>
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseMutationRequest(request);
        const context = this.createContext();
        const stored = await this.loadDraft(context, parsed.draftId);
        this.assertStoredDraft(stored, parsed.expectedRevision);
        const updated = await mutation(stored, parsed);
        await this.persistDraft(context, updated);
        return toVideoEditorDto(updated);
      })
    );
  }

  private applyPlatformCommand(
    draftId: VideoEditDraft['id'],
    expectedRevision: number,
    build: (stored: VideoEditDraft) => VideoEditCommand
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const context = this.createContext();
        const stored = await this.loadDraft(context, draftId);
        this.assertStoredDraft(stored, expectedRevision);
        const finalized = build(stored);
        if (!isVideoEditCommand(finalized)) {
          throw controllerError(
            'invalid_request',
            'The prepared media edit command is invalid'
          );
        }
        const updated = applyVideoEditCommand(stored, finalized, this.now());
        await this.persistDraft(context, updated);
        return toVideoEditorDto(updated);
      })
    );
  }

  private mutateRevisionedDraft(
    request: unknown,
    mutation: (stored: VideoEditDraft) => Promise<VideoEditDraft>
  ): Promise<VideoEditorIpcResult<VideoEditorDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseRevisionRequest(request);
        const context = this.createContext();
        const stored = await this.loadDraft(context, parsed.draftId);
        this.assertStoredDraft(stored, parsed.expectedRevision);
        const updated = await mutation(stored);
        await this.persistDraft(context, updated);
        return toVideoEditorDto(updated);
      })
    );
  }

  private assertStoredDraft(
    draft: VideoEditDraft | undefined,
    expectedRevision: number
  ): asserts draft is VideoEditDraft {
    if (!draft) {
      throw controllerError(
        'draft_not_found',
        'The requested video edit draft does not exist'
      );
    }
    if (draft.revision !== expectedRevision) {
      throw controllerError(
        'draft_conflict',
        'The video edit draft changed before this operation was saved'
      );
    }
  }

  private async loadDraft(
    context: ReturnType<VideoEditorController['createContext']>,
    draftId: ReturnType<typeof toVideoEditDraftId>
  ): Promise<VideoEditDraft | undefined> {
    return (
      this.pendingDrafts.get(this.pendingKey(context.session, draftId)) ??
      context.repository.get(draftId)
    );
  }

  private async persistDraft(
    context: ReturnType<VideoEditorController['createContext']>,
    draft: VideoEditDraft
  ): Promise<void> {
    const key = this.pendingKey(context.session, draft.id);
    try {
      await context.repository.save(draft);
      this.pendingDrafts.delete(key);
    } catch (error) {
      this.pendingDrafts.set(key, draft);
      throw new VideoEditorSaveError(draft, error);
    }
  }

  private pendingKey(
    session: StorageProjectSession,
    draftId: ReturnType<typeof toVideoEditDraftId>
  ): string {
    return session.rootDirectory + '\0' + draftId;
  }

  private async validateSourceIntent(
    intent: VideoEditSourceIntent,
    context: ReturnType<VideoEditorController['createContext']>
  ): Promise<void> {
    if (intent.kind === 'blank') return;
    if (intent.kind === 'from_work') {
      const work = await context.works.get(intent.sourceWorkId);
      if (!work) {
        throw controllerError(
          'source_not_found',
          'The source work does not exist'
        );
      }
      if (
        work.projectId !== context.session.projectId ||
        work.mediaKind !== 'video'
      ) {
        throw controllerError(
          'source_invalid',
          'The source work is not an available project video'
        );
      }
      return;
    }
    const sourceDraft = await context.videoWorkspaces.get(intent.sourceDraftId);
    if (!sourceDraft) {
      throw controllerError(
        'source_not_found',
        'The source video generation draft does not exist'
      );
    }
  }

  private buildCommand(
    draft: VideoEditDraft,
    value: VideoEditorUpdateDto
  ): VideoEditCommand {
    let command: VideoEditCommand;
    try {
      command = buildDomainCommand(draft, value, {
        createClipId: () => this.createClipId(),
        createTextId: () => this.createTextId()
      });
    } catch (error) {
      if (error instanceof VideoEditorControllerError) throw error;
      throw controllerError(
        'invalid_request',
        'The requested video edit command is invalid'
      );
    }
    if (!isVideoEditCommand(command)) {
      throw controllerError(
        'invalid_request',
        'The requested video edit command is invalid'
      );
    }
    return command;
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
      repository:
        this.dependencies.createRepository?.(session) ??
        new JsonVideoEditDraftRepository(storage, session.projectId),
      videoWorkspaces: new JsonVideoWorkspaceRepository(
        storage,
        session.projectId
      ),
      works: new JsonWorkRepository(storage, session.projectId)
    };
  }

  private createDraftId() {
    return toVideoEditDraftId(
      this.dependencies.createDraftId?.() ??
        'video-edit-draft-' + randomUUID()
    );
  }

  private createClipId() {
    return toVideoClipId(
      this.dependencies.createClipId?.() ?? 'video-clip-' + randomUUID()
    );
  }

  private createTextId() {
    return toTextOverlayId(
      this.dependencies.createTextId?.() ?? 'text-overlay-' + randomUUID()
    );
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<VideoEditorIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapVideoEditorError(error) };
    }
  }

  private enqueueMutation<T>(
    operation: () => Promise<VideoEditorIpcResult<T>>
  ): Promise<VideoEditorIpcResult<T>> {
    return this.mutations.enqueue(operation);
  }
}

interface ParsedUpdateRequest {
  readonly draftId: ReturnType<typeof toVideoEditDraftId>;
  readonly expectedRevision: number;
  readonly command: VideoEditorUpdateDto;
}

class VideoEditorControllerError extends Error {
  constructor(
    readonly code: VideoEditorIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoEditorControllerError';
  }
}

class VideoEditorSaveError extends Error {
  constructor(
    readonly draft: VideoEditDraft,
    readonly cause: unknown
  ) {
    super('The video edit draft could not be saved');
    this.name = 'VideoEditorSaveError';
  }
}

function parseCreateRequest(request: unknown): {
  readonly sourceIntent: VideoEditSourceIntent;
  readonly title?: string;
} {
  if (!isRecord(request) || !exact(request, ['sourceIntent', 'title'])) {
    throw invalidRequest('A valid video edit draft request is required');
  }
  if (
    request.title !== undefined &&
    (typeof request.title !== 'string' || request.title.trim().length === 0)
  ) {
    throw invalidRequest('A valid video edit draft title is required');
  }
  return {
    sourceIntent: parseSourceIntent(request.sourceIntent),
    title: request.title
  };
}

function parseSourceIntent(value: unknown): VideoEditSourceIntent {
  if (value === undefined) return { kind: 'blank' };
  if (!isRecord(value)) {
    throw invalidRequest('A valid video edit source is required');
  }
  if (value.kind === 'blank' && exact(value, ['kind'])) {
    return { kind: 'blank' };
  }
  if (
    value.kind === 'from_work' &&
    exact(value, ['kind', 'sourceWorkId']) &&
    typeof value.sourceWorkId === 'string'
  ) {
    try {
      return { kind: 'from_work', sourceWorkId: toWorkId(value.sourceWorkId) };
    } catch {
      throw invalidRequest('A valid source work ID is required');
    }
  }
  if (
    value.kind === 'from_video_draft' &&
    exact(value, ['kind', 'sourceDraftId']) &&
    typeof value.sourceDraftId === 'string'
  ) {
    try {
      return {
        kind: 'from_video_draft',
        sourceDraftId: toDraftId(value.sourceDraftId)
      };
    } catch {
      throw invalidRequest('A valid source video draft ID is required');
    }
  }
  throw invalidRequest('A supported video edit source is required');
}

function parseDraftIdRequest(request: unknown) {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId']) ||
    typeof request.draftId !== 'string'
  ) {
    throw invalidRequest('A valid video edit draft ID is required');
  }
  try {
    return toVideoEditDraftId(request.draftId);
  } catch {
    throw invalidRequest('A valid video edit draft ID is required');
  }
}

function parseMutationRequest(request: unknown): ParsedUpdateRequest {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'expectedRevision', 'command']) ||
    typeof request.draftId !== 'string' ||
    !isNonNegativeInteger(request.expectedRevision) ||
    !isRecord(request.command) ||
    typeof request.command.kind !== 'string'
  ) {
    throw invalidRequest('A valid video edit mutation is required');
  }
  let draftId: ReturnType<typeof toVideoEditDraftId>;
  try {
    draftId = toVideoEditDraftId(request.draftId);
  } catch {
    throw invalidRequest('A valid video edit draft ID is required');
  }
  validateUpdateDto(request.command);
  return {
    draftId,
    expectedRevision: request.expectedRevision,
    command: request.command as unknown as VideoEditorUpdateDto
  };
}

function parseRevisionRequest(request: unknown): {
  readonly draftId: ReturnType<typeof toVideoEditDraftId>;
  readonly expectedRevision: number;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'expectedRevision']) ||
    typeof request.draftId !== 'string' ||
    !isNonNegativeInteger(request.expectedRevision)
  ) {
    throw invalidRequest('A valid revisioned video edit request is required');
  }
  try {
    return {
      draftId: toVideoEditDraftId(request.draftId),
      expectedRevision: request.expectedRevision
    };
  } catch {
    throw invalidRequest('A valid video edit draft ID is required');
  }
}

function parseCopyRequest(request: unknown): {
  readonly draftId: ReturnType<typeof toVideoEditDraftId>;
  readonly expectedRevision: number;
  readonly title?: string;
} {
  if (
    !isRecord(request) ||
    !exact(request, ['draftId', 'expectedRevision', 'title']) ||
    typeof request.draftId !== 'string' ||
    !isNonNegativeInteger(request.expectedRevision) ||
    (request.title !== undefined &&
      (typeof request.title !== 'string' || request.title.trim().length === 0))
  ) {
    throw invalidRequest('A valid video edit copy request is required');
  }
  try {
    return {
      draftId: toVideoEditDraftId(request.draftId),
      expectedRevision: request.expectedRevision,
      title: request.title
    };
  } catch {
    throw invalidRequest('A valid video edit draft ID is required');
  }
}

function validateUpdateDto(value: Record<string, unknown>): void {
  const keysByKind: Readonly<Record<string, readonly string[]>> = {
    set_title: ['kind', 'title'],
    trim_clip: ['kind', 'clipId', 'sourceRange'],
    split_clip: ['kind', 'clipId', 'atSourceUs'],
    remove_clip: ['kind', 'clipId'],
    restore_clip: ['kind', 'clipId', 'targetIndex'],
    duplicate_clip: ['kind', 'clipId', 'targetIndex'],
    move_clip: ['kind', 'clipId', 'toIndex'],
    set_clip_speed: ['kind', 'clipId', 'speed'],
    set_clip_transform: ['kind', 'clipId', 'transform'],
    set_clip_transition: ['kind', 'clipId', 'transition'],
    set_source_audio: ['kind', 'clipId', 'sourceAudio'],
    upsert_text: ['kind', 'text'],
    remove_text: ['kind', 'textId'],
    update_background_music: [
      'kind',
      'sourceRange',
      'timelineRange',
      'volumePermille',
      'fadeInUs',
      'fadeOutUs'
    ],
    clear_background_music: ['kind'],
    set_cover: ['kind', 'cover'],
    set_canvas: ['kind', 'canvas'],
    set_output_preference: ['kind', 'outputPreference']
  };
  const allowed = keysByKind[value.kind as string];
  if (!allowed || !exact(value, allowed)) {
    throw invalidRequest('The video edit command contains unsupported fields');
  }
}

function buildDomainCommand(
  draft: VideoEditDraft,
  value: VideoEditorUpdateDto,
  ids: {
    readonly createClipId: () => ReturnType<typeof toVideoClipId>;
    readonly createTextId: () => ReturnType<typeof toTextOverlayId>;
  }
): VideoEditCommand {
  switch (value.kind) {
    case 'set_title':
      return {
        schemaVersion: 1,
        kind: 'set_title',
        before: draft.title,
        after: value.title
      };
    case 'trim_clip': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'trim_clip',
        clipId: clip.id,
        before: clip.sourceRange,
        after: value.sourceRange
      };
    }
    case 'split_clip': {
      const clip = requireClip(draft, value.clipId);
      const sourceIndex = draft.videoTrack.findIndex(
        (candidate) => candidate.id === clip.id
      );
      if (
        !isNonNegativeInteger(value.atSourceUs) ||
        value.atSourceUs <= clip.sourceRange.inUs ||
        value.atSourceUs >= clip.sourceRange.outUs
      ) {
        throw invalidRequest('The split point must be inside the clip range');
      }
      return {
        schemaVersion: 1,
        kind: 'split_clip',
        sourceIndex,
        before: clip,
        afterLeft: {
          ...clip,
          sourceRange: {
            inUs: clip.sourceRange.inUs,
            outUs: value.atSourceUs
          },
          transitionToNext: { kind: 'none' }
        },
        createdRight: {
          ...structuredClone(clip),
          id: ids.createClipId(),
          sourceRange: {
            inUs: value.atSourceUs,
            outUs: clip.sourceRange.outUs
          }
        }
      };
    }
    case 'remove_clip': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'remove_clip',
        clip,
        previousIndex: draft.videoTrack.findIndex(
          (candidate) => candidate.id === clip.id
        )
      };
    }
    case 'restore_clip': {
      const removed = draft.removedClips.find(
        (entry) => entry.clip.id === value.clipId
      );
      if (!removed) throw invalidRequest('The removed video clip does not exist');
      const targetIndex =
        value.targetIndex ?? Math.min(removed.previousIndex, draft.videoTrack.length);
      return {
        schemaVersion: 1,
        kind: 'restore_clip',
        clip: removed.clip,
        targetIndex
      };
    }
    case 'duplicate_clip': {
      const clip = requireClip(draft, value.clipId);
      const sourceIndex = draft.videoTrack.findIndex(
        (candidate) => candidate.id === clip.id
      );
      return {
        schemaVersion: 1,
        kind: 'duplicate_clip',
        sourceClipId: clip.id,
        createdClip: {
          ...structuredClone(clip),
          id: ids.createClipId(),
          transitionToNext: { kind: 'none' }
        },
        targetIndex: value.targetIndex ?? sourceIndex + 1
      };
    }
    case 'move_clip': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'move_clip',
        clipId: clip.id,
        fromIndex: draft.videoTrack.findIndex(
          (candidate) => candidate.id === clip.id
        ),
        toIndex: value.toIndex
      };
    }
    case 'set_clip_speed': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'set_clip_speed',
        clipId: clip.id,
        before: clip.speed,
        after: value.speed
      };
    }
    case 'set_clip_transform': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'set_clip_transform',
        clipId: clip.id,
        before: clip.transform,
        after: value.transform
      };
    }
    case 'set_clip_transition': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'set_clip_transition',
        clipId: clip.id,
        before: clip.transitionToNext,
        after: value.transition
      };
    }
    case 'set_source_audio': {
      const clip = requireClip(draft, value.clipId);
      return {
        schemaVersion: 1,
        kind: 'set_source_audio',
        clipId: clip.id,
        before: clip.sourceAudio,
        after: value.sourceAudio
      };
    }
    case 'upsert_text': {
      const id = value.text.textId
        ? parseTextId(value.text.textId)
        : ids.createTextId();
      const before =
        draft.textTrack.find((candidate) => candidate.id === id) ?? null;
      const after: TextOverlay = {
        ...value.text,
        kind: 'text_overlay',
        id
      };
      return {
        schemaVersion: 1,
        kind: 'upsert_text',
        before,
        after
      };
    }
    case 'remove_text': {
      const id = parseTextId(value.textId);
      const before = draft.textTrack.find((candidate) => candidate.id === id);
      if (!before) throw invalidRequest('The text overlay does not exist');
      return { schemaVersion: 1, kind: 'remove_text', before };
    }
    case 'update_background_music': {
      const before = draft.backgroundMusic;
      if (!before) throw invalidRequest('The background music does not exist');
      const after: BackgroundMusic = {
        ...before,
        sourceRange: value.sourceRange,
        timelineRange: value.timelineRange,
        volumePermille: value.volumePermille,
        fadeInUs: value.fadeInUs,
        fadeOutUs: value.fadeOutUs
      };
      return {
        schemaVersion: 1,
        kind: 'set_background_music',
        before,
        after
      };
    }
    case 'clear_background_music':
      if (!draft.backgroundMusic) {
        throw invalidRequest('The background music does not exist');
      }
      return {
        schemaVersion: 1,
        kind: 'set_background_music',
        before: draft.backgroundMusic,
        after: null
      };
    case 'set_cover':
      return {
        schemaVersion: 1,
        kind: 'set_cover',
        before: draft.cover,
        after: toDomainCover(value.cover)
      };
    case 'set_canvas':
      return {
        schemaVersion: 1,
        kind: 'set_canvas',
        before: draft.canvas,
        after: value.canvas as CanvasSettings
      };
    case 'set_output_preference':
      return {
        schemaVersion: 1,
        kind: 'set_output_preference',
        before: draft.outputPreference,
        after: value.outputPreference as OutputPreference
      };
  }
}

function requireClip(draft: VideoEditDraft, clipId: string) {
  const id = parseClipId(clipId);
  const clip = draft.videoTrack.find((candidate) => candidate.id === id);
  if (!clip) throw invalidRequest('The video clip does not exist');
  return clip;
}

function parseClipId(value: string) {
  try {
    return toVideoClipId(value);
  } catch {
    throw invalidRequest('A valid video clip ID is required');
  }
}

function parseTextId(value: string) {
  try {
    return toTextOverlayId(value);
  } catch {
    throw invalidRequest('A valid text overlay ID is required');
  }
}

function toDomainCover(value: VideoEditorCoverDto | null): CoverSelection | null {
  if (value === null) return null;
  if (value.kind === 'video_frame') {
    return { ...value, clipId: parseClipId(value.clipId) };
  }
  if (value.kind === 'local_image') {
    return {
      ...value,
      fileId: toFileReferenceId(value.fileId),
      assetId: value.assetId ? toAssetId(value.assetId) : undefined
    };
  }
  return {
    ...value,
    workId: toWorkId(value.workId),
    fileId: toFileReferenceId(value.fileId)
  };
}

export function toVideoEditorDto(
  draft: VideoEditDraft
): VideoEditorDraftDto {
  return {
    schemaVersion: 1,
    kind: 'video_basic_edit',
    draftId: draft.id,
    projectId: draft.projectId,
    title: draft.title,
    revision: draft.revision,
    sourceIntent: structuredClone(draft.sourceIntent) as VideoEditorSourceIntentDto,
    canvas: structuredClone(draft.canvas),
    videoTrack: draft.videoTrack.map(toClipDto),
    removedClips: draft.removedClips.map((entry) => ({
      clip: toClipDto(entry.clip),
      previousIndex: entry.previousIndex
    })),
    textTrack: draft.textTrack.map(({ id, kind: _kind, ...text }) => ({
      ...structuredClone(text),
      textId: id
    })),
    backgroundMusic: draft.backgroundMusic
      ? {
          fileId: draft.backgroundMusic.fileId,
          assetId: draft.backgroundMusic.assetId,
          identity: safeIdentity(draft.backgroundMusic.identity),
          sourceRange: structuredClone(draft.backgroundMusic.sourceRange),
          timelineRange: structuredClone(draft.backgroundMusic.timelineRange),
          volumePermille: draft.backgroundMusic.volumePermille,
          fadeInUs: draft.backgroundMusic.fadeInUs,
          fadeOutUs: draft.backgroundMusic.fadeOutUs
        }
      : null,
    cover: structuredClone(draft.cover) as VideoEditorCoverDto | null,
    outputPreference: structuredClone(draft.outputPreference),
    canUndo: draft.history.undoStack.length > 0,
    canRedo: draft.history.redoStack.length > 0,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

function toClipDto(clip: VideoEditDraft['videoTrack'][number]) {
  return {
    clipId: clip.id,
    source: {
      fileId: clip.source.fileId,
      assetId: clip.source.assetId,
      workId: clip.source.workId,
      identity: safeIdentity(clip.source.identity)
    },
    sourceRange: structuredClone(clip.sourceRange),
    speed: structuredClone(clip.speed),
    transform: structuredClone(clip.transform),
    sourceAudio: structuredClone(clip.sourceAudio),
    transitionToNext: structuredClone(clip.transitionToNext)
  };
}

function safeIdentity(identity: VideoEditDraft['videoTrack'][number]['source']['identity']) {
  return {
    sizeBytes: identity.sizeBytes,
    durationUs: identity.durationUs,
    container: identity.container,
    width: identity.width,
    height: identity.height
  };
}

function invalidRequest(message: string): VideoEditorControllerError {
  return controllerError('invalid_request', message);
}

function controllerError(
  code: VideoEditorIpcErrorCode,
  message: string
): VideoEditorControllerError {
  return new VideoEditorControllerError(code, message);
}

function mapVideoEditorError(error: unknown): {
  readonly code: VideoEditorIpcErrorCode;
  readonly message: string;
  readonly recoverableDraft?: VideoEditorDraftDto;
} {
  if (error instanceof VideoEditorControllerError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof InvariantViolationError) {
    return { code: 'invalid_request', message: error.message };
  }
  if (error instanceof VideoEditorSaveError) {
    return {
      code: 'workspace_storage_error',
      message:
        'The edit is retained in memory but could not be saved to the project',
      recoverableDraft: toVideoEditorDto(error.draft)
    };
  }
  return {
    code: 'workspace_storage_error',
    message: 'The local video editor operation failed'
  };
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
