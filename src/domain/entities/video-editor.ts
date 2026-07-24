import { InvariantViolationError } from '../errors';
import type {
  AssetId,
  DraftId,
  FileReferenceId,
  ProjectId,
  TextOverlayId,
  VideoClipId,
  VideoEditDraftId,
  WorkId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';

export const videoEditDraftKind = 'video_basic_edit' as const;
export const videoEditHistoryLimit = 100;

export type VideoEditSourceIntent =
  | { readonly kind: 'blank' }
  | { readonly kind: 'from_work'; readonly sourceWorkId: WorkId }
  | { readonly kind: 'from_video_draft'; readonly sourceDraftId: DraftId };

export interface MediaIdentitySnapshot {
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly durationUs: number;
  readonly container: string;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256?: string;
}

export interface VideoClipSource {
  readonly fileId: FileReferenceId;
  readonly assetId?: AssetId;
  readonly workId?: WorkId;
  readonly identity: MediaIdentitySnapshot;
}

export interface SourceTimeRange {
  readonly inUs: number;
  readonly outUs: number;
}

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface NormalizedCrop {
  readonly xPermille: number;
  readonly yPermille: number;
  readonly widthPermille: number;
  readonly heightPermille: number;
}

export interface CanvasTransform {
  readonly scalePermille: number;
  readonly positionXPermille: number;
  readonly positionYPermille: number;
  readonly rotationMilliDegrees: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly crop: NormalizedCrop | null;
}

export interface SourceAudioSettings {
  readonly muted: boolean;
  readonly volumePermille: number;
}

export type BasicTransition =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'fade' | 'dissolve';
      readonly durationUs: number;
    };

export interface VideoClip {
  readonly kind: 'video_clip';
  readonly id: VideoClipId;
  readonly source: VideoClipSource;
  readonly sourceRange: SourceTimeRange;
  readonly speed: Rational;
  readonly transform: CanvasTransform;
  readonly sourceAudio: SourceAudioSettings;
  readonly transitionToNext: BasicTransition;
}

export interface RemovedVideoClip {
  readonly clip: VideoClip;
  readonly previousIndex: number;
}

export type CanvasAspectRatio =
  | { readonly kind: 'source' }
  | {
      readonly kind: 'ratio';
      readonly numerator: number;
      readonly denominator: number;
    };

export type CanvasBackground =
  | { readonly kind: 'solid'; readonly color: string }
  | { readonly kind: 'blur_source'; readonly strengthPermille: number };

export interface CanvasSettings {
  readonly aspectRatio: CanvasAspectRatio;
  readonly transformPolicy: 'fit' | 'fill';
  readonly background: CanvasBackground;
}

export interface TextStyle {
  readonly requestedFontFamily: string;
  readonly resolvedFontId?: string;
  readonly fontSizeMilliPx: number;
  readonly alignment: 'left' | 'center' | 'right';
  readonly opacityPermille: number;
  readonly color: string;
}

export interface TextOverlay {
  readonly kind: 'text_overlay';
  readonly id: TextOverlayId;
  readonly content: string;
  readonly range: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly style: TextStyle;
  readonly position: {
    readonly xPermille: number;
    readonly yPermille: number;
  };
  readonly entrance: 'none' | 'fade_in';
  readonly exit: 'none' | 'fade_out';
}

export interface BackgroundMusic {
  readonly kind: 'background_music';
  readonly fileId: FileReferenceId;
  readonly assetId?: AssetId;
  readonly identity: MediaIdentitySnapshot;
  readonly sourceRange: SourceTimeRange;
  readonly timelineRange: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly volumePermille: number;
  readonly fadeInUs: number;
  readonly fadeOutUs: number;
}

export type CoverSelection =
  | {
      readonly kind: 'video_frame';
      readonly clipId: VideoClipId;
      readonly sourceTimeUs: number;
      readonly prependToVideo: boolean;
    }
  | {
      readonly kind: 'local_image';
      readonly fileId: FileReferenceId;
      readonly assetId?: AssetId;
      readonly prependToVideo: boolean;
    }
  | {
      readonly kind: 'project_image';
      readonly workId: WorkId;
      readonly fileId: FileReferenceId;
      readonly prependToVideo: boolean;
    };

export type CapabilityPreference =
  | { readonly kind: 'auto' }
  | { readonly kind: 'capability'; readonly valueId: string };

export type ResolutionPreference =
  | { readonly kind: 'source' }
  | { readonly kind: 'capability'; readonly valueId: string };

export interface OutputPreference {
  readonly destinationId?: string;
  readonly fileName?: string;
  readonly container: CapabilityPreference;
  readonly videoCodec: CapabilityPreference;
  readonly audioCodec: CapabilityPreference;
  readonly resolution: ResolutionPreference;
  readonly frameRate: ResolutionPreference;
  readonly quality: CapabilityPreference;
  readonly hardwareAcceleration:
    | 'auto'
    | 'prefer_hardware'
    | 'software_only';
  readonly conflictPolicy: 'fail' | 'create_unique_name';
}

interface VideoEditCommandBase {
  readonly schemaVersion: 1;
}

export type VideoEditCommand = VideoEditCommandBase &
  (
    | {
        readonly kind: 'set_title';
        readonly before: string;
        readonly after: string;
      }
    | {
        readonly kind: 'insert_clip';
        readonly clip: VideoClip;
        readonly targetIndex: number;
      }
    | {
        readonly kind: 'trim_clip';
        readonly clipId: VideoClipId;
        readonly before: SourceTimeRange;
        readonly after: SourceTimeRange;
      }
    | {
        readonly kind: 'set_clip_source';
        readonly clipId: VideoClipId;
        readonly before: VideoClipSource;
        readonly after: VideoClipSource;
      }
    | {
        readonly kind: 'split_clip';
        readonly sourceIndex: number;
        readonly before: VideoClip;
        readonly afterLeft: VideoClip;
        readonly createdRight: VideoClip;
      }
    | {
        readonly kind: 'remove_clip';
        readonly clip: VideoClip;
        readonly previousIndex: number;
      }
    | {
        readonly kind: 'restore_clip';
        readonly clip: VideoClip;
        readonly targetIndex: number;
      }
    | {
        readonly kind: 'duplicate_clip';
        readonly sourceClipId: VideoClipId;
        readonly createdClip: VideoClip;
        readonly targetIndex: number;
      }
    | {
        readonly kind: 'move_clip';
        readonly clipId: VideoClipId;
        readonly fromIndex: number;
        readonly toIndex: number;
      }
    | {
        readonly kind: 'set_clip_speed';
        readonly clipId: VideoClipId;
        readonly before: Rational;
        readonly after: Rational;
      }
    | {
        readonly kind: 'set_clip_transform';
        readonly clipId: VideoClipId;
        readonly before: CanvasTransform;
        readonly after: CanvasTransform;
      }
    | {
        readonly kind: 'set_clip_transition';
        readonly clipId: VideoClipId;
        readonly before: BasicTransition;
        readonly after: BasicTransition;
      }
    | {
        readonly kind: 'set_source_audio';
        readonly clipId: VideoClipId;
        readonly before: SourceAudioSettings;
        readonly after: SourceAudioSettings;
      }
    | {
        readonly kind: 'upsert_text';
        readonly before: TextOverlay | null;
        readonly after: TextOverlay;
      }
    | {
        readonly kind: 'remove_text';
        readonly before: TextOverlay;
      }
    | {
        readonly kind: 'set_background_music';
        readonly before: BackgroundMusic | null;
        readonly after: BackgroundMusic | null;
      }
    | {
        readonly kind: 'set_cover';
        readonly before: CoverSelection | null;
        readonly after: CoverSelection | null;
      }
    | {
        readonly kind: 'set_canvas';
        readonly before: CanvasSettings;
        readonly after: CanvasSettings;
      }
    | {
        readonly kind: 'set_output_preference';
        readonly before: OutputPreference;
        readonly after: OutputPreference;
      }
  );

export interface PersistedEditHistory {
  readonly baseRevision: number;
  readonly undoStack: readonly VideoEditCommand[];
  readonly redoStack: readonly VideoEditCommand[];
}

export interface VideoEditDraft {
  readonly schemaVersion: 1;
  readonly kind: typeof videoEditDraftKind;
  readonly id: VideoEditDraftId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly revision: number;
  readonly sourceIntent: VideoEditSourceIntent;
  readonly canvas: CanvasSettings;
  readonly videoTrack: readonly VideoClip[];
  readonly removedClips: readonly RemovedVideoClip[];
  readonly textTrack: readonly TextOverlay[];
  readonly backgroundMusic: BackgroundMusic | null;
  readonly cover: CoverSelection | null;
  readonly outputPreference: OutputPreference;
  readonly history: PersistedEditHistory;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface CreateEmptyVideoEditDraftInput {
  readonly id: VideoEditDraftId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly sourceIntent?: VideoEditSourceIntent;
  readonly createdAt: IsoTimestamp;
}

const defaultCanvas = (): CanvasSettings => ({
  aspectRatio: { kind: 'source' },
  transformPolicy: 'fit',
  background: { kind: 'solid', color: '#000000' }
});

const defaultOutputPreference = (): OutputPreference => ({
  container: { kind: 'auto' },
  videoCodec: { kind: 'auto' },
  audioCodec: { kind: 'auto' },
  resolution: { kind: 'source' },
  frameRate: { kind: 'source' },
  quality: { kind: 'auto' },
  hardwareAcceleration: 'auto',
  conflictPolicy: 'create_unique_name'
});

export function createEmptyVideoEditDraft(
  input: CreateEmptyVideoEditDraftInput
): VideoEditDraft {
  return createVideoEditDraft({
    schemaVersion: 1,
    kind: videoEditDraftKind,
    id: input.id,
    projectId: input.projectId,
    title: input.title?.trim() || '视频基础编辑草稿',
    revision: 0,
    sourceIntent: input.sourceIntent ?? { kind: 'blank' },
    canvas: defaultCanvas(),
    videoTrack: [],
    removedClips: [],
    textTrack: [],
    backgroundMusic: null,
    cover: null,
    outputPreference: defaultOutputPreference(),
    history: {
      baseRevision: 0,
      undoStack: [],
      redoStack: []
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function createVideoEditDraft(input: VideoEditDraft): VideoEditDraft {
  if (!isVideoEditDraft(input)) {
    throw new InvariantViolationError('video edit draft is invalid');
  }
  return structuredClone(input);
}

export function copyVideoEditDraft(input: {
  readonly source: VideoEditDraft;
  readonly id: VideoEditDraftId;
  readonly title?: string;
  readonly createdAt: IsoTimestamp;
}): VideoEditDraft {
  return createVideoEditDraft({
    ...structuredClone(input.source),
    id: input.id,
    title: input.title?.trim() || input.source.title + ' 副本',
    revision: 0,
    history: { baseRevision: 0, undoStack: [], redoStack: [] },
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function applyVideoEditCommand(
  draft: VideoEditDraft,
  command: VideoEditCommand,
  updatedAt: IsoTimestamp
): VideoEditDraft {
  assertDraftAndCommand(draft, command);
  const changed = executeCommand(draft, command, 'apply');
  const overflow = Math.max(
    0,
    changed.history.undoStack.length + 1 - videoEditHistoryLimit
  );
  return finalizeDraft({
    ...changed,
    revision: draft.revision + 1,
    history: {
      baseRevision: draft.history.baseRevision + overflow,
      undoStack: [...draft.history.undoStack, command].slice(
        -videoEditHistoryLimit
      ),
      redoStack: []
    },
    updatedAt
  });
}

export function undoVideoEditCommand(
  draft: VideoEditDraft,
  updatedAt: IsoTimestamp
): VideoEditDraft {
  if (!isVideoEditDraft(draft)) {
    throw new InvariantViolationError('video edit draft is invalid');
  }
  const command = draft.history.undoStack.at(-1);
  if (!command) {
    throw new InvariantViolationError('there is no video edit command to undo');
  }
  const changed = executeCommand(draft, command, 'revert');
  return finalizeDraft({
    ...changed,
    revision: draft.revision + 1,
    history: {
      baseRevision: draft.history.baseRevision,
      undoStack: draft.history.undoStack.slice(0, -1),
      redoStack: [...draft.history.redoStack, command]
    },
    updatedAt
  });
}

export function redoVideoEditCommand(
  draft: VideoEditDraft,
  updatedAt: IsoTimestamp
): VideoEditDraft {
  if (!isVideoEditDraft(draft)) {
    throw new InvariantViolationError('video edit draft is invalid');
  }
  const command = draft.history.redoStack.at(-1);
  if (!command) {
    throw new InvariantViolationError('there is no video edit command to redo');
  }
  const changed = executeCommand(draft, command, 'apply');
  return finalizeDraft({
    ...changed,
    revision: draft.revision + 1,
    history: {
      baseRevision: draft.history.baseRevision,
      undoStack: [...draft.history.undoStack, command],
      redoStack: draft.history.redoStack.slice(0, -1)
    },
    updatedAt
  });
}

export function getVideoTimelineDurationUs(draft: VideoEditDraft): number {
  return draft.videoTrack.reduce((total, clip) => {
    const transitionUs =
      clip.transitionToNext.kind === 'none'
        ? 0
        : clip.transitionToNext.durationUs;
    return total + effectiveClipDurationUs(clip) - transitionUs;
  }, 0);
}

export function isVideoEditDraft(value: unknown): value is VideoEditDraft {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'kind',
      'id',
      'projectId',
      'title',
      'revision',
      'sourceIntent',
      'canvas',
      'videoTrack',
      'removedClips',
      'textTrack',
      'backgroundMusic',
      'cover',
      'outputPreference',
      'history',
      'createdAt',
      'updatedAt'
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== videoEditDraftKind ||
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.projectId) ||
    !isNonBlankString(value.title) ||
    !isNonNegativeInteger(value.revision) ||
    !isSourceIntent(value.sourceIntent) ||
    !isCanvasSettings(value.canvas) ||
    !Array.isArray(value.videoTrack) ||
    !value.videoTrack.every(isVideoClip) ||
    !Array.isArray(value.removedClips) ||
    !value.removedClips.every(isRemovedVideoClip) ||
    !Array.isArray(value.textTrack) ||
    !value.textTrack.every(isTextOverlay) ||
    !(value.backgroundMusic === null || isBackgroundMusic(value.backgroundMusic)) ||
    !(value.cover === null || isCoverSelection(value.cover)) ||
    !isOutputPreference(value.outputPreference) ||
    !isPersistedHistory(value.history) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return false;
  }

  const clips = value.videoTrack as readonly VideoClip[];
  const removed = value.removedClips as readonly RemovedVideoClip[];
  const texts = value.textTrack as readonly TextOverlay[];
  const clipIds = clips.map((clip) => clip.id);
  const removedIds = removed.map((entry) => entry.clip.id);
  const textIds = texts.map((text) => text.id);

  if (
    new Set(clipIds).size !== clipIds.length ||
    new Set(removedIds).size !== removedIds.length ||
    new Set(textIds).size !== textIds.length ||
    removedIds.some((id) => clipIds.includes(id))
  ) {
    return false;
  }

  for (let index = 0; index < clips.length; index += 1) {
    const transition = clips[index]?.transitionToNext;
    if (
      transition &&
      transition.kind !== 'none' &&
      (index === clips.length - 1 ||
        transition.durationUs >= effectiveClipDurationUs(clips[index]!) ||
        transition.durationUs >= effectiveClipDurationUs(clips[index + 1]!))
    ) {
      return false;
    }
  }

  const durationUs = getVideoTimelineDurationUs(value as unknown as VideoEditDraft);
  if (
    !Number.isSafeInteger(durationUs) ||
    durationUs < 0 ||
    texts.some(
      (text) => text.range.endUs > durationUs || text.range.startUs >= text.range.endUs
    ) ||
    (value.backgroundMusic !== null &&
      value.backgroundMusic.timelineRange.endUs > durationUs)
  ) {
    return false;
  }

  const cover = value.cover as CoverSelection | null;
  if (cover?.kind === 'video_frame') {
    const clip = clips.find((candidate) => candidate.id === cover.clipId);
    if (
      !clip ||
      cover.sourceTimeUs < clip.sourceRange.inUs ||
      cover.sourceTimeUs >= clip.sourceRange.outUs
    ) {
      return false;
    }
  }

  return true;
}

export function isVideoEditCommand(value: unknown): value is VideoEditCommand {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string'
  ) {
    return false;
  }
  switch (value.kind) {
    case 'set_title':
      return exact(value, ['schemaVersion', 'kind', 'before', 'after']) &&
        isNonBlankString(value.before) &&
        isNonBlankString(value.after);
    case 'insert_clip':
      return exact(value, ['schemaVersion', 'kind', 'clip', 'targetIndex']) &&
        isVideoClip(value.clip) &&
        isNonNegativeInteger(value.targetIndex);
    case 'trim_clip':
      return exact(value, ['schemaVersion', 'kind', 'clipId', 'before', 'after']) &&
        isNonBlankString(value.clipId) &&
        isSourceTimeRange(value.before) &&
        isSourceTimeRange(value.after);
    case 'set_clip_source':
      return exact(value, ['schemaVersion', 'kind', 'clipId', 'before', 'after']) &&
        isNonBlankString(value.clipId) &&
        isVideoClipSource(value.before) &&
        isVideoClipSource(value.after);
    case 'split_clip':
      return exact(value, [
        'schemaVersion',
        'kind',
        'sourceIndex',
        'before',
        'afterLeft',
        'createdRight'
      ]) &&
        isNonNegativeInteger(value.sourceIndex) &&
        isVideoClip(value.before) &&
        isVideoClip(value.afterLeft) &&
        isVideoClip(value.createdRight);
    case 'remove_clip':
      return exact(value, ['schemaVersion', 'kind', 'clip', 'previousIndex']) &&
        isVideoClip(value.clip) &&
        isNonNegativeInteger(value.previousIndex);
    case 'restore_clip':
      return exact(value, ['schemaVersion', 'kind', 'clip', 'targetIndex']) &&
        isVideoClip(value.clip) &&
        isNonNegativeInteger(value.targetIndex);
    case 'duplicate_clip':
      return exact(value, [
        'schemaVersion',
        'kind',
        'sourceClipId',
        'createdClip',
        'targetIndex'
      ]) &&
        isNonBlankString(value.sourceClipId) &&
        isVideoClip(value.createdClip) &&
        isNonNegativeInteger(value.targetIndex);
    case 'move_clip':
      return exact(value, [
        'schemaVersion',
        'kind',
        'clipId',
        'fromIndex',
        'toIndex'
      ]) &&
        isNonBlankString(value.clipId) &&
        isNonNegativeInteger(value.fromIndex) &&
        isNonNegativeInteger(value.toIndex);
    case 'set_clip_speed':
      return exact(value, ['schemaVersion', 'kind', 'clipId', 'before', 'after']) &&
        isNonBlankString(value.clipId) &&
        isRational(value.before) &&
        isRational(value.after);
    case 'set_clip_transform':
      return exact(value, ['schemaVersion', 'kind', 'clipId', 'before', 'after']) &&
        isNonBlankString(value.clipId) &&
        isCanvasTransform(value.before) &&
        isCanvasTransform(value.after);
    case 'set_clip_transition':
      return exact(value, ['schemaVersion', 'kind', 'clipId', 'before', 'after']) &&
        isNonBlankString(value.clipId) &&
        isBasicTransition(value.before) &&
        isBasicTransition(value.after);
    case 'set_source_audio':
      return exact(value, ['schemaVersion', 'kind', 'clipId', 'before', 'after']) &&
        isNonBlankString(value.clipId) &&
        isSourceAudio(value.before) &&
        isSourceAudio(value.after);
    case 'upsert_text':
      return exact(value, ['schemaVersion', 'kind', 'before', 'after']) &&
        (value.before === null || isTextOverlay(value.before)) &&
        isTextOverlay(value.after);
    case 'remove_text':
      return exact(value, ['schemaVersion', 'kind', 'before']) &&
        isTextOverlay(value.before);
    case 'set_background_music':
      return exact(value, ['schemaVersion', 'kind', 'before', 'after']) &&
        (value.before === null || isBackgroundMusic(value.before)) &&
        (value.after === null || isBackgroundMusic(value.after));
    case 'set_cover':
      return exact(value, ['schemaVersion', 'kind', 'before', 'after']) &&
        (value.before === null || isCoverSelection(value.before)) &&
        (value.after === null || isCoverSelection(value.after));
    case 'set_canvas':
      return exact(value, ['schemaVersion', 'kind', 'before', 'after']) &&
        isCanvasSettings(value.before) &&
        isCanvasSettings(value.after);
    case 'set_output_preference':
      return exact(value, ['schemaVersion', 'kind', 'before', 'after']) &&
        isOutputPreference(value.before) &&
        isOutputPreference(value.after);
    default:
      return false;
  }
}

function executeCommand(
  draft: VideoEditDraft,
  command: VideoEditCommand,
  direction: 'apply' | 'revert'
): VideoEditDraft {
  const apply = direction === 'apply';
  switch (command.kind) {
    case 'set_title':
      assertEqual(draft.title, apply ? command.before : command.after, 'title');
      return { ...draft, title: apply ? command.after : command.before };
    case 'insert_clip':
      return apply
        ? insertClip(draft, command.clip, command.targetIndex)
        : removeActiveClip(draft, command.clip, command.targetIndex, false);
    case 'trim_clip':
      return replaceClipField(
        draft,
        command.clipId,
        'sourceRange',
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'set_clip_source':
      return replaceClipField(
        draft,
        command.clipId,
        'source',
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'split_clip':
      return apply
        ? splitClip(draft, command)
        : unsplitClip(draft, command);
    case 'remove_clip':
      return apply
        ? removeActiveClip(draft, command.clip, command.previousIndex, true)
        : restoreRemovedClip(draft, command.clip, command.previousIndex);
    case 'restore_clip':
      return apply
        ? restoreRemovedClip(draft, command.clip, command.targetIndex)
        : removeActiveClip(draft, command.clip, command.targetIndex, true);
    case 'duplicate_clip':
      {
      const source = draft.videoTrack.find(
        (clip) => clip.id === command.sourceClipId
      );
      if (!source) {
        throw new InvariantViolationError('duplicate source clip is missing');
      }
      assertEqual(
        duplicateComparable(command.createdClip),
        duplicateComparable(source),
        'duplicated clip content'
      );
      return apply
        ? insertClip(draft, command.createdClip, command.targetIndex)
        : removeActiveClip(draft, command.createdClip, command.targetIndex, false);
      }
    case 'move_clip':
      return moveClip(
        draft,
        command.clipId,
        apply ? command.fromIndex : command.toIndex,
        apply ? command.toIndex : command.fromIndex
      );
    case 'set_clip_speed':
      return replaceClipField(
        draft,
        command.clipId,
        'speed',
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'set_clip_transform':
      return replaceClipField(
        draft,
        command.clipId,
        'transform',
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'set_clip_transition':
      return replaceClipField(
        draft,
        command.clipId,
        'transitionToNext',
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'set_source_audio':
      return replaceClipField(
        draft,
        command.clipId,
        'sourceAudio',
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'upsert_text':
      return upsertText(
        draft,
        apply ? command.before : command.after,
        apply ? command.after : command.before
      );
    case 'remove_text':
      return upsertText(draft, apply ? command.before : null, apply ? null : command.before);
    case 'set_background_music':
      assertEqual(
        draft.backgroundMusic,
        apply ? command.before : command.after,
        'background music'
      );
      return {
        ...draft,
        backgroundMusic: structuredClone(apply ? command.after : command.before)
      };
    case 'set_cover':
      assertEqual(draft.cover, apply ? command.before : command.after, 'cover');
      return {
        ...draft,
        cover: structuredClone(apply ? command.after : command.before)
      };
    case 'set_canvas':
      assertEqual(draft.canvas, apply ? command.before : command.after, 'canvas');
      return { ...draft, canvas: structuredClone(apply ? command.after : command.before) };
    case 'set_output_preference':
      assertEqual(
        draft.outputPreference,
        apply ? command.before : command.after,
        'output preference'
      );
      return {
        ...draft,
        outputPreference: structuredClone(apply ? command.after : command.before)
      };
  }
}

function insertClip(
  draft: VideoEditDraft,
  clip: VideoClip,
  targetIndex: number
): VideoEditDraft {
  if (
    targetIndex > draft.videoTrack.length ||
    draft.videoTrack.some((item) => item.id === clip.id) ||
    draft.removedClips.some((item) => item.clip.id === clip.id)
  ) {
    throw new InvariantViolationError('clip cannot be inserted at the requested position');
  }
  const track = [...draft.videoTrack];
  track.splice(targetIndex, 0, structuredClone(clip));
  return { ...draft, videoTrack: track };
}

function removeActiveClip(
  draft: VideoEditDraft,
  clip: VideoClip,
  index: number,
  keepRemoved: boolean
): VideoEditDraft {
  assertEqual(draft.videoTrack[index], clip, 'clip');
  const track = [...draft.videoTrack];
  track.splice(index, 1);
  return {
    ...draft,
    videoTrack: track,
    removedClips: keepRemoved
      ? [...draft.removedClips, { clip: structuredClone(clip), previousIndex: index }]
      : draft.removedClips
  };
}

function restoreRemovedClip(
  draft: VideoEditDraft,
  clip: VideoClip,
  targetIndex: number
): VideoEditDraft {
  const removedIndex = draft.removedClips.findIndex(
    (entry) => entry.clip.id === clip.id
  );
  if (removedIndex < 0 || targetIndex > draft.videoTrack.length) {
    throw new InvariantViolationError('removed clip cannot be restored');
  }
  assertEqual(draft.removedClips[removedIndex]?.clip, clip, 'removed clip');
  const removed = [...draft.removedClips];
  removed.splice(removedIndex, 1);
  const track = [...draft.videoTrack];
  track.splice(targetIndex, 0, structuredClone(clip));
  return { ...draft, videoTrack: track, removedClips: removed };
}

function moveClip(
  draft: VideoEditDraft,
  clipId: VideoClipId,
  fromIndex: number,
  toIndex: number
): VideoEditDraft {
  if (
    fromIndex >= draft.videoTrack.length ||
    toIndex >= draft.videoTrack.length ||
    draft.videoTrack[fromIndex]?.id !== clipId
  ) {
    throw new InvariantViolationError('clip cannot be moved from the requested position');
  }
  const track = [...draft.videoTrack];
  const [clip] = track.splice(fromIndex, 1);
  track.splice(toIndex, 0, clip!);
  return { ...draft, videoTrack: track };
}

function splitClip(
  draft: VideoEditDraft,
  command: Extract<VideoEditCommand, { readonly kind: 'split_clip' }>
): VideoEditDraft {
  assertEqual(draft.videoTrack[command.sourceIndex], command.before, 'split source');
  if (
    command.afterLeft.id !== command.before.id ||
    command.createdRight.id === command.before.id ||
    !sameClipSource(command.before, command.afterLeft) ||
    !sameClipSource(command.before, command.createdRight) ||
    command.afterLeft.sourceRange.inUs !== command.before.sourceRange.inUs ||
    command.afterLeft.sourceRange.outUs !==
      command.createdRight.sourceRange.inUs ||
    command.createdRight.sourceRange.outUs !==
      command.before.sourceRange.outUs
  ) {
    throw new InvariantViolationError('split clip identities are invalid');
  }
  const track = [...draft.videoTrack];
  track.splice(
    command.sourceIndex,
    1,
    structuredClone(command.afterLeft),
    structuredClone(command.createdRight)
  );
  return { ...draft, videoTrack: track };
}

function unsplitClip(
  draft: VideoEditDraft,
  command: Extract<VideoEditCommand, { readonly kind: 'split_clip' }>
): VideoEditDraft {
  assertEqual(draft.videoTrack[command.sourceIndex], command.afterLeft, 'split left');
  assertEqual(
    draft.videoTrack[command.sourceIndex + 1],
    command.createdRight,
    'split right'
  );
  const track = [...draft.videoTrack];
  track.splice(command.sourceIndex, 2, structuredClone(command.before));
  return { ...draft, videoTrack: track };
}

function replaceClipField<TKey extends keyof VideoClip>(
  draft: VideoEditDraft,
  clipId: VideoClipId,
  key: TKey,
  before: VideoClip[TKey],
  after: VideoClip[TKey]
): VideoEditDraft {
  const index = draft.videoTrack.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new InvariantViolationError('video clip is missing');
  assertEqual(draft.videoTrack[index]?.[key], before, 'clip ' + String(key));
  const track = draft.videoTrack.map((clip, currentIndex) =>
    currentIndex === index ? { ...clip, [key]: structuredClone(after) } : clip
  );
  return { ...draft, videoTrack: track };
}

function upsertText(
  draft: VideoEditDraft,
  before: TextOverlay | null,
  after: TextOverlay | null
): VideoEditDraft {
  const id = before?.id ?? after?.id;
  if (!id) throw new InvariantViolationError('text overlay identity is missing');
  const index = draft.textTrack.findIndex((text) => text.id === id);
  if (before === null) {
    if (index >= 0 || after === null) {
      throw new InvariantViolationError('text overlay cannot be inserted');
    }
    return { ...draft, textTrack: [...draft.textTrack, structuredClone(after)] };
  }
  if (index < 0) throw new InvariantViolationError('text overlay is missing');
  assertEqual(draft.textTrack[index], before, 'text overlay');
  if (after === null) {
    return {
      ...draft,
      textTrack: draft.textTrack.filter((_, currentIndex) => currentIndex !== index)
    };
  }
  if (after.id !== before.id) {
    throw new InvariantViolationError('text overlay identity cannot change');
  }
  return {
    ...draft,
    textTrack: draft.textTrack.map((text, currentIndex) =>
      currentIndex === index ? structuredClone(after) : text
    )
  };
}

function finalizeDraft(draft: VideoEditDraft): VideoEditDraft {
  if (!isVideoEditDraft(draft)) {
    throw new InvariantViolationError('video edit command produced an invalid draft');
  }
  return structuredClone(draft);
}

function assertDraftAndCommand(
  draft: VideoEditDraft,
  command: VideoEditCommand
): void {
  if (!isVideoEditDraft(draft) || !isVideoEditCommand(command)) {
    throw new InvariantViolationError('video edit draft or command is invalid');
  }
}

function effectiveClipDurationUs(clip: VideoClip): number {
  const sourceDuration = clip.sourceRange.outUs - clip.sourceRange.inUs;
  const result =
    (BigInt(sourceDuration) * BigInt(clip.speed.denominator)) /
    BigInt(clip.speed.numerator);
  return Number(result);
}

function sameClipSource(left: VideoClip, right: VideoClip): boolean {
  return (
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    JSON.stringify(left.speed) === JSON.stringify(right.speed) &&
    JSON.stringify(left.transform) === JSON.stringify(right.transform) &&
    JSON.stringify(left.sourceAudio) === JSON.stringify(right.sourceAudio)
  );
}

function duplicateComparable(clip: VideoClip) {
  return {
    kind: clip.kind,
    source: clip.source,
    sourceRange: clip.sourceRange,
    speed: clip.speed,
    transform: clip.transform,
    sourceAudio: clip.sourceAudio
  };
}

function isSourceIntent(value: unknown): boolean {
  return isRecord(value) &&
    ((exact(value, ['kind']) && value.kind === 'blank') ||
      (exact(value, ['kind', 'sourceWorkId']) &&
        value.kind === 'from_work' &&
        isNonBlankString(value.sourceWorkId)) ||
      (exact(value, ['kind', 'sourceDraftId']) &&
        value.kind === 'from_video_draft' &&
        isNonBlankString(value.sourceDraftId)));
}

function isVideoClip(value: unknown): value is VideoClip {
  return isRecord(value) &&
    exact(value, [
      'kind',
      'id',
      'source',
      'sourceRange',
      'speed',
      'transform',
      'sourceAudio',
      'transitionToNext'
    ]) &&
    value.kind === 'video_clip' &&
    isNonBlankString(value.id) &&
    isVideoClipSource(value.source) &&
    isSourceTimeRange(value.sourceRange) &&
    isRational(value.speed) &&
    isCanvasTransform(value.transform) &&
    isSourceAudio(value.sourceAudio) &&
    isBasicTransition(value.transitionToNext) &&
    value.sourceRange.outUs <=
      (value.source as unknown as VideoClipSource).identity.durationUs &&
    Number.isSafeInteger(
      effectiveClipDurationUs(value as unknown as VideoClip)
    ) &&
    effectiveClipDurationUs(value as unknown as VideoClip) > 0;
}

function isVideoClipSource(value: unknown): boolean {
  return isRecord(value) &&
    exact(value, ['fileId', 'assetId', 'workId', 'identity']) &&
    isNonBlankString(value.fileId) &&
    (value.assetId === undefined || isNonBlankString(value.assetId)) &&
    (value.workId === undefined || isNonBlankString(value.workId)) &&
    isMediaIdentity(value.identity);
}

function isMediaIdentity(value: unknown): boolean {
  return isRecord(value) &&
    exact(value, [
      'sizeBytes',
      'modifiedAtMs',
      'durationUs',
      'container',
      'width',
      'height',
      'checksumSha256'
    ]) &&
    isNonNegativeInteger(value.sizeBytes) &&
    isNonNegativeInteger(value.modifiedAtMs) &&
    isPositiveInteger(value.durationUs) &&
    isNonBlankString(value.container) &&
    isPositiveInteger(value.width) &&
    isPositiveInteger(value.height) &&
    (value.checksumSha256 === undefined ||
      (typeof value.checksumSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(value.checksumSha256)));
}

function isSourceTimeRange(value: unknown): value is SourceTimeRange {
  return isRecord(value) &&
    exact(value, ['inUs', 'outUs']) &&
    isNonNegativeInteger(value.inUs) &&
    isPositiveInteger(value.outUs) &&
    value.inUs < value.outUs;
}

function isRational(value: unknown): value is Rational {
  return isRecord(value) &&
    exact(value, ['numerator', 'denominator']) &&
    isPositiveInteger(value.numerator) &&
    isPositiveInteger(value.denominator);
}

function isCanvasTransform(value: unknown): value is CanvasTransform {
  return isRecord(value) &&
    exact(value, [
      'scalePermille',
      'positionXPermille',
      'positionYPermille',
      'rotationMilliDegrees',
      'flipX',
      'flipY',
      'crop'
    ]) &&
    isPositiveInteger(value.scalePermille) &&
    isSafeInteger(value.positionXPermille) &&
    isSafeInteger(value.positionYPermille) &&
    isSafeInteger(value.rotationMilliDegrees) &&
    typeof value.flipX === 'boolean' &&
    typeof value.flipY === 'boolean' &&
    (value.crop === null || isCrop(value.crop));
}

function isCrop(value: unknown): boolean {
  return isRecord(value) &&
    exact(value, ['xPermille', 'yPermille', 'widthPermille', 'heightPermille']) &&
    isPermille(value.xPermille) &&
    isPermille(value.yPermille) &&
    isPositivePermille(value.widthPermille) &&
    isPositivePermille(value.heightPermille) &&
    value.xPermille + value.widthPermille <= 1000 &&
    value.yPermille + value.heightPermille <= 1000;
}

function isSourceAudio(value: unknown): value is SourceAudioSettings {
  return isRecord(value) &&
    exact(value, ['muted', 'volumePermille']) &&
    typeof value.muted === 'boolean' &&
    isPermille(value.volumePermille);
}

function isBasicTransition(value: unknown): value is BasicTransition {
  return isRecord(value) &&
    ((exact(value, ['kind']) && value.kind === 'none') ||
      (exact(value, ['kind', 'durationUs']) &&
        (value.kind === 'fade' || value.kind === 'dissolve') &&
        isPositiveInteger(value.durationUs)));
}

function isRemovedVideoClip(value: unknown): boolean {
  return isRecord(value) &&
    exact(value, ['clip', 'previousIndex']) &&
    isVideoClip(value.clip) &&
    isNonNegativeInteger(value.previousIndex);
}

function isCanvasSettings(value: unknown): value is CanvasSettings {
  return isRecord(value) &&
    exact(value, ['aspectRatio', 'transformPolicy', 'background']) &&
    isCanvasAspectRatio(value.aspectRatio) &&
    (value.transformPolicy === 'fit' || value.transformPolicy === 'fill') &&
    isCanvasBackground(value.background);
}

function isCanvasAspectRatio(value: unknown): boolean {
  return isRecord(value) &&
    ((exact(value, ['kind']) && value.kind === 'source') ||
      (exact(value, ['kind', 'numerator', 'denominator']) &&
        value.kind === 'ratio' &&
        isPositiveInteger(value.numerator) &&
        isPositiveInteger(value.denominator)));
}

function isCanvasBackground(value: unknown): boolean {
  return isRecord(value) &&
    ((exact(value, ['kind', 'color']) &&
      value.kind === 'solid' &&
      isColor(value.color)) ||
      (exact(value, ['kind', 'strengthPermille']) &&
        value.kind === 'blur_source' &&
        isPermille(value.strengthPermille)));
}

function isTextOverlay(value: unknown): value is TextOverlay {
  return isRecord(value) &&
    exact(value, [
      'kind',
      'id',
      'content',
      'range',
      'style',
      'position',
      'entrance',
      'exit'
    ]) &&
    value.kind === 'text_overlay' &&
    isNonBlankString(value.id) &&
    typeof value.content === 'string' &&
    isRecord(value.range) &&
    exact(value.range, ['startUs', 'endUs']) &&
    isNonNegativeInteger(value.range.startUs) &&
    isPositiveInteger(value.range.endUs) &&
    value.range.startUs < value.range.endUs &&
    isTextStyle(value.style) &&
    isRecord(value.position) &&
    exact(value.position, ['xPermille', 'yPermille']) &&
    isPermille(value.position.xPermille) &&
    isPermille(value.position.yPermille) &&
    (value.entrance === 'none' || value.entrance === 'fade_in') &&
    (value.exit === 'none' || value.exit === 'fade_out');
}

function isTextStyle(value: unknown): boolean {
  return isRecord(value) &&
    exact(value, [
      'requestedFontFamily',
      'resolvedFontId',
      'fontSizeMilliPx',
      'alignment',
      'opacityPermille',
      'color'
    ]) &&
    isNonBlankString(value.requestedFontFamily) &&
    (value.resolvedFontId === undefined || isNonBlankString(value.resolvedFontId)) &&
    isPositiveInteger(value.fontSizeMilliPx) &&
    (value.alignment === 'left' ||
      value.alignment === 'center' ||
      value.alignment === 'right') &&
    isPermille(value.opacityPermille) &&
    isColor(value.color);
}

function isBackgroundMusic(value: unknown): value is BackgroundMusic {
  return isRecord(value) &&
    exact(value, [
      'kind',
      'fileId',
      'assetId',
      'identity',
      'sourceRange',
      'timelineRange',
      'volumePermille',
      'fadeInUs',
      'fadeOutUs'
    ]) &&
    value.kind === 'background_music' &&
    isNonBlankString(value.fileId) &&
    (value.assetId === undefined || isNonBlankString(value.assetId)) &&
    isMediaIdentity(value.identity) &&
    isSourceTimeRange(value.sourceRange) &&
    value.sourceRange.outUs <=
      (value.identity as unknown as MediaIdentitySnapshot).durationUs &&
    isRecord(value.timelineRange) &&
    exact(value.timelineRange, ['startUs', 'endUs']) &&
    isNonNegativeInteger(value.timelineRange.startUs) &&
    isPositiveInteger(value.timelineRange.endUs) &&
    value.timelineRange.startUs < value.timelineRange.endUs &&
    isPermille(value.volumePermille) &&
    isNonNegativeInteger(value.fadeInUs) &&
    isNonNegativeInteger(value.fadeOutUs) &&
    value.fadeInUs + value.fadeOutUs <=
      value.timelineRange.endUs - value.timelineRange.startUs;
}

function isCoverSelection(value: unknown): value is CoverSelection {
  return isRecord(value) &&
    ((exact(value, ['kind', 'clipId', 'sourceTimeUs', 'prependToVideo']) &&
      value.kind === 'video_frame' &&
      isNonBlankString(value.clipId) &&
      isNonNegativeInteger(value.sourceTimeUs) &&
      typeof value.prependToVideo === 'boolean') ||
      (exact(value, ['kind', 'fileId', 'assetId', 'prependToVideo']) &&
        value.kind === 'local_image' &&
        isNonBlankString(value.fileId) &&
        (value.assetId === undefined || isNonBlankString(value.assetId)) &&
        typeof value.prependToVideo === 'boolean') ||
      (exact(value, ['kind', 'workId', 'fileId', 'prependToVideo']) &&
        value.kind === 'project_image' &&
        isNonBlankString(value.workId) &&
        isNonBlankString(value.fileId) &&
        typeof value.prependToVideo === 'boolean'));
}

function isOutputPreference(value: unknown): value is OutputPreference {
  return isRecord(value) &&
    exact(value, [
      'destinationId',
      'fileName',
      'container',
      'videoCodec',
      'audioCodec',
      'resolution',
      'frameRate',
      'quality',
      'hardwareAcceleration',
      'conflictPolicy'
    ]) &&
    (value.destinationId === undefined || isNonBlankString(value.destinationId)) &&
    (value.fileName === undefined || isSafeFileName(value.fileName)) &&
    isCapabilityPreference(value.container) &&
    isCapabilityPreference(value.videoCodec) &&
    isCapabilityPreference(value.audioCodec) &&
    isResolutionPreference(value.resolution) &&
    isResolutionPreference(value.frameRate) &&
    isCapabilityPreference(value.quality) &&
    (value.hardwareAcceleration === 'auto' ||
      value.hardwareAcceleration === 'prefer_hardware' ||
      value.hardwareAcceleration === 'software_only') &&
    (value.conflictPolicy === 'fail' ||
      value.conflictPolicy === 'create_unique_name');
}

function isCapabilityPreference(value: unknown): boolean {
  return isRecord(value) &&
    ((exact(value, ['kind']) && value.kind === 'auto') ||
      (exact(value, ['kind', 'valueId']) &&
        value.kind === 'capability' &&
        isNonBlankString(value.valueId)));
}

function isResolutionPreference(value: unknown): boolean {
  return isRecord(value) &&
    ((exact(value, ['kind']) && value.kind === 'source') ||
      (exact(value, ['kind', 'valueId']) &&
        value.kind === 'capability' &&
        isNonBlankString(value.valueId)));
}

function isPersistedHistory(value: unknown): boolean {
  return isRecord(value) &&
    exact(value, ['baseRevision', 'undoStack', 'redoStack']) &&
    isNonNegativeInteger(value.baseRevision) &&
    Array.isArray(value.undoStack) &&
    value.undoStack.length <= videoEditHistoryLimit &&
    value.undoStack.every(isVideoEditCommand) &&
    Array.isArray(value.redoStack) &&
    value.redoStack.length <= videoEditHistoryLimit &&
    value.redoStack.every(isVideoEditCommand);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new InvariantViolationError(
      label + ' changed before the command was applied'
    );
  }
}

function isTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isColor(value: unknown): boolean {
  return typeof value === 'string' &&
    (/^#[0-9a-fA-F]{6}$/.test(value) || /^#[0-9a-fA-F]{8}$/.test(value));
}

function isSafeFileName(value: unknown): boolean {
  return (
    isNonBlankString(value) &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/\0]/.test(value)
  );
}

function isPermille(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 1000;
}

function isPositivePermille(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 1000;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return hasOnlyKeys(value, keys);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
