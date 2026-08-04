import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  CanvasTransform,
  BasicTransition,
  MediaIdentitySnapshot,
  Rational,
  SourceAudioSettings,
  SourceTimeRange,
  VideoClipId,
  VideoEditDraftId
} from '../../domain';

export const videoEditorPreviewArtifactKinds = [
  'proxy_video',
  'thumbnail_strip',
  'audio_waveform'
] as const;

export type VideoEditorPreviewArtifactKind =
  (typeof videoEditorPreviewArtifactKinds)[number];

export interface VideoEditorPreviewPlan {
  readonly schemaVersion: 1;
  readonly draftId: VideoEditDraftId;
  readonly draftRevision: number;
  readonly clipId: VideoClipId;
  readonly sourceIdentity: MediaIdentitySnapshot;
  readonly sourceRange: SourceTimeRange;
  readonly speed: Rational;
  readonly transform: CanvasTransform;
  readonly sourceAudio: SourceAudioSettings;
  readonly transitionToNext: BasicTransition;
}

export interface VideoEditorPreviewAdapterDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
}

export interface VideoEditorPreviewArtifact {
  readonly kind: VideoEditorPreviewArtifactKind;
  readonly cacheKey: string;
  readonly target: string;
  readonly mimeType: string;
}

export type VideoEditorPreviewArtifactResult =
  | {
      readonly status: 'available';
      readonly artifact: VideoEditorPreviewArtifact;
    }
  | {
      readonly status: 'adapter_unavailable';
    };

export interface VideoEditorPreviewArtifactAdapter {
  readonly descriptor: VideoEditorPreviewAdapterDescriptor;
  requestArtifact(input: {
    readonly plan: VideoEditorPreviewPlan;
    readonly kind: VideoEditorPreviewArtifactKind;
    readonly cache: NodeVideoEditorPreviewCache;
    /**
     * A verified source path held by the main process. This is intentionally
     * not part of PreviewPlan or any renderer DTO.
     */
    readonly sourcePath: string;
  }): Promise<VideoEditorPreviewArtifactResult>;
  interrupt?(): Promise<void>;
  dispose?(): Promise<void>;
}

export class UnavailableVideoEditorPreviewAdapter
  implements VideoEditorPreviewArtifactAdapter {
  readonly descriptor: VideoEditorPreviewAdapterDescriptor = {
    adapterId: 'unavailable',
    adapterVersion: '0'
  };

  async requestArtifact(): Promise<VideoEditorPreviewArtifactResult> {
    return { status: 'adapter_unavailable' };
  }
}

export class NodeVideoEditorPreviewCache {
  private readonly rootDirectory: string;

  constructor(projectRoot: string) {
    this.rootDirectory = path.join(
      path.resolve(projectRoot),
      'cache',
      'video-editor-preview'
    );
  }

  async ensure(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  resolve(cacheKey: string, extension: string): string {
    if (!/^[a-f0-9]{64}$/.test(cacheKey) || !/^[a-z0-9]+$/.test(extension)) {
      throw new TypeError('Preview cache path components are invalid');
    }
    return path.join(this.rootDirectory, `${cacheKey}.${extension}`);
  }

  async clear(): Promise<void> {
    await rm(this.rootDirectory, { recursive: true, force: true });
  }
}

export function createVideoEditorPreviewCacheKey(input: {
  readonly plan: VideoEditorPreviewPlan;
  readonly kind: VideoEditorPreviewArtifactKind;
  readonly adapter: VideoEditorPreviewAdapterDescriptor;
}): string {
  return createHash('sha256')
    .update(stableSerialize({
      schemaVersion: input.plan.schemaVersion,
      sourceIdentity: input.plan.sourceIdentity,
      sourceRange: input.plan.sourceRange,
      speed: input.plan.speed,
      transform: input.plan.transform,
      sourceAudio: input.plan.sourceAudio,
      transitionToNext: input.plan.transitionToNext,
      kind: input.kind,
      adapter: input.adapter
    }))
    .digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableSerialize).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) =>
      JSON.stringify(key) + ':' + stableSerialize(record[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
