import { InvariantViolationError } from '../errors';
import type {
  FileReferenceId,
  ProjectId,
  TaskId,
  VideoEditDraftId,
  VideoExportPlanId,
  WorkId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import type {
  BackgroundMusic,
  CanvasSettings,
  CoverSelection,
  MediaIdentitySnapshot,
  TextOverlay,
  VideoClip
} from './video-editor';
import { isVideoEditDraft } from './video-editor';

export type VideoExportInputRole =
  | { readonly kind: 'clip'; readonly clipId: string }
  | { readonly kind: 'background_music' }
  | { readonly kind: 'cover' };

export interface VideoExportInputSnapshot {
  readonly fileId: FileReferenceId;
  readonly role: VideoExportInputRole;
  readonly identity: Pick<
    MediaIdentitySnapshot,
    'sizeBytes' | 'modifiedAtMs' | 'checksumSha256'
  > & Partial<Pick<
    MediaIdentitySnapshot,
    'durationUs' | 'container' | 'width' | 'height'
  >>;
}

export interface ResolvedVideoExportOutput {
  readonly relativePath: string;
  readonly fileName: string;
  readonly conflictPolicy: 'fail' | 'create_unique_name';
  readonly container: 'webm';
  readonly videoCodec: 'libvpx-vp9';
  readonly audioCodec: 'libopus';
  readonly resolution: { readonly kind: 'source' };
  readonly frameRate: { readonly kind: 'source' };
  readonly quality: { readonly kind: 'crf'; readonly value: 32 };
  readonly hardwareAcceleration: 'software_only';
}

export interface VideoExportEngineSnapshot {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly videoEncoder: 'libvpx-vp9';
  readonly audioEncoder: 'libopus';
  readonly container: 'webm';
}

export interface VideoExportPlan {
  readonly schemaVersion: 1;
  readonly planVersion: 1;
  readonly id: VideoExportPlanId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly draftId: VideoEditDraftId;
  readonly draftRevision: number;
  readonly title: string;
  readonly inputs: readonly VideoExportInputSnapshot[];
  readonly timeline: {
    readonly canvas: CanvasSettings;
    readonly clips: readonly VideoClip[];
    readonly textTrack: readonly TextOverlay[];
    readonly backgroundMusic: BackgroundMusic | null;
    readonly cover: CoverSelection | null;
  };
  readonly output: ResolvedVideoExportOutput;
  readonly engine: VideoExportEngineSnapshot;
  readonly estimatedOutputBytes: number;
  readonly parentWorkId?: WorkId;
  readonly planHash: string;
  readonly createdAt: IsoTimestamp;
}

export function createVideoExportPlan(
  input: Omit<VideoExportPlan, 'schemaVersion' | 'planVersion'>
): VideoExportPlan {
  if (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0) {
    throw new InvariantViolationError('export plan draft revision is invalid');
  }
  if (input.inputs.length === 0 || input.timeline.clips.length === 0) {
    throw new InvariantViolationError('export plan requires at least one video clip');
  }
  if (!/^[a-f0-9]{64}$/.test(input.planHash)) {
    throw new InvariantViolationError('export plan hash must be SHA-256');
  }
  if (!Number.isSafeInteger(input.estimatedOutputBytes) || input.estimatedOutputBytes <= 0) {
    throw new InvariantViolationError('export plan estimated output size is invalid');
  }

  return structuredClone({
    ...input,
    schemaVersion: 1 as const,
    planVersion: 1 as const
  });
}

export function isVideoExportPlan(value: unknown): value is VideoExportPlan {
  if (!isRecord(value)) return false;
  const timelineValid = isRecord(value.timeline) &&
    isVideoEditDraft({
      schemaVersion: 1,
      kind: 'video_basic_edit',
      id: value.draftId,
      projectId: value.projectId,
      title: value.title,
      revision: value.draftRevision,
      sourceIntent: { kind: 'blank' },
      canvas: value.timeline.canvas,
      videoTrack: value.timeline.clips,
      removedClips: [],
      textTrack: value.timeline.textTrack,
      backgroundMusic: value.timeline.backgroundMusic,
      cover: value.timeline.cover,
      outputPreference: {
        container: { kind: 'auto' },
        videoCodec: { kind: 'auto' },
        audioCodec: { kind: 'auto' },
        resolution: { kind: 'source' },
        frameRate: { kind: 'source' },
        quality: { kind: 'auto' },
        hardwareAcceleration: 'software_only',
        conflictPolicy: 'fail'
      },
      history: { baseRevision: 0, undoStack: [], redoStack: [] },
      createdAt: value.createdAt,
      updatedAt: value.createdAt
    });
  return timelineValid && value.schemaVersion === 1 &&
    value.planVersion === 1 &&
    isNonBlank(value.id) &&
    isNonBlank(value.projectId) &&
    isNonBlank(value.taskId) &&
    isNonBlank(value.draftId) &&
    Number.isSafeInteger(value.draftRevision) &&
    Number(value.draftRevision) >= 0 &&
    isNonBlank(value.title) &&
    Array.isArray(value.inputs) &&
    value.inputs.length > 0 &&
    value.inputs.every(isInput) &&
    isRecord(value.timeline) &&
    Array.isArray(value.timeline.clips) &&
    value.timeline.clips.length > 0 &&
    Array.isArray(value.timeline.textTrack) &&
    isRecord(value.output) &&
    isNonBlank(value.output.relativePath) &&
    isNonBlank(value.output.fileName) &&
    value.output.container === 'webm' &&
    value.output.videoCodec === 'libvpx-vp9' &&
    value.output.audioCodec === 'libopus' &&
    value.output.hardwareAcceleration === 'software_only' &&
    isRecord(value.engine) &&
    value.engine.adapterId === 'ffmpeg' &&
    isNonBlank(value.engine.adapterVersion) &&
    isNonBlank(value.engine.engineVersion) &&
    Number.isSafeInteger(value.estimatedOutputBytes) &&
    Number(value.estimatedOutputBytes) > 0 &&
    typeof value.planHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.planHash) &&
    typeof value.createdAt === 'string';
}

function isInput(value: unknown): boolean {
  return isRecord(value) && isNonBlank(value.fileId) &&
    isRecord(value.role) &&
    (value.role.kind === 'background_music' || value.role.kind === 'cover' ||
      (value.role.kind === 'clip' && isNonBlank(value.role.clipId))) &&
    isRecord(value.identity) &&
    Number.isSafeInteger(value.identity.sizeBytes) &&
    Number(value.identity.sizeBytes) >= 0 &&
    (value.identity.durationUs === undefined ||
      (Number.isSafeInteger(value.identity.durationUs) &&
        Number(value.identity.durationUs) > 0));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
