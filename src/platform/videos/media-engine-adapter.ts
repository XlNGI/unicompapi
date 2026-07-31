import { statSync } from 'node:fs';
import { link, mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  FfmpegVideoEditorPreviewAdapter,
  type FfmpegVideoEditorPreviewAdapterOptions
} from './ffmpeg-video-editor-preview';
import {
  type NodeVideoEditorPreviewCache,
  type VideoEditorPreviewArtifact,
  type VideoEditorPreviewArtifactAdapter,
  type VideoEditorPreviewArtifactKind,
  type VideoEditorPreviewPlan
} from './video-editor-preview';
import type {
  BasicTransition,
  CanvasBackground,
  CanvasTransform,
  SourceTimeRange,
  TextOverlay
} from '../../domain';
import {
  ManagedProcessSupervisor,
  type ManagedProcessHandle,
  type ManagedProcessResult
} from '../runtime';

export interface MediaEngineAdapterDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
}

export interface MediaEngineCapabilities {
  readonly descriptor: MediaEngineAdapterDescriptor;
  readonly version: string;
  readonly videoEncoders: readonly string[];
  readonly audioEncoders: readonly string[];
  readonly containers: readonly string[];
  readonly filters: readonly string[];
  readonly supportsProbe: true;
  readonly supportsPreview: true;
  readonly supportsExport: true;
  readonly supportsCancel: true;
}

export interface MediaSource {
  /** Main-process-only path; never serialize this object to renderer DTOs. */
  readonly sourcePath: string;
}

export interface MediaProbeStream {
  readonly index: number;
  readonly type: 'video' | 'audio' | 'other';
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationUs: number | null;
}

export interface MediaProbe {
  readonly container: string | null;
  readonly durationUs: number;
  readonly streams: readonly MediaProbeStream[];
}

export interface MediaEnginePreviewRequest {
  readonly source: MediaSource;
  readonly plan: VideoEditorPreviewPlan;
  readonly kind: VideoEditorPreviewArtifactKind;
  readonly cache: NodeVideoEditorPreviewCache;
}

export interface MediaEngineSingleSourceExportPlan {
  readonly jobId: string;
  readonly source: MediaSource;
  readonly outputPath: string;
  readonly sourceRange: SourceTimeRange;
  readonly includeAudio: boolean;
  readonly videoCodec: 'libvpx-vp9';
  readonly audioCodec?: 'libopus';
}

export interface MediaEngineCompositionClip {
  readonly source: MediaSource;
  readonly sourceRange: SourceTimeRange;
  readonly speed: { readonly numerator: number; readonly denominator: number };
  readonly transform: CanvasTransform;
  readonly sourceAudio: { readonly muted: boolean; readonly volumePermille: number };
  readonly transitionToNext: BasicTransition;
  readonly hasAudio: boolean;
}

export interface MediaEngineCompositionExportPlan {
  readonly jobId: string;
  readonly outputPath: string;
  readonly composition: {
    readonly clips: readonly MediaEngineCompositionClip[];
    readonly canvas: {
      readonly width: number;
      readonly height: number;
      readonly transformPolicy: 'fit' | 'fill';
      readonly background: CanvasBackground;
    };
    readonly textTrack: readonly TextOverlay[];
    readonly backgroundMusic?: {
      readonly source: MediaSource;
      readonly sourceRange: SourceTimeRange;
      readonly timelineRange: { readonly startUs: number; readonly endUs: number };
      readonly volumePermille: number;
      readonly fadeInUs: number;
      readonly fadeOutUs: number;
    };
    readonly cover?: {
      readonly source: MediaSource;
      readonly kind: 'video_frame' | 'image';
      readonly sourceTimeUs?: number;
      readonly durationUs: number;
    };
  };
  readonly videoCodec: 'libvpx-vp9';
  readonly audioCodec: 'libopus';
}

export type MediaEngineExportPlan =
  | MediaEngineSingleSourceExportPlan
  | MediaEngineCompositionExportPlan;

export type MediaEngineExportPhase =
  | 'starting'
  | 'encoding'
  | 'verifying'
  | 'publishing';

export interface MediaEngineProgressEvent {
  readonly phase: MediaEngineExportPhase;
  readonly processedUs?: number;
  readonly totalUs?: number;
  readonly percent?: number;
}

export interface MediaEngineExportEventSink {
  readonly onProgress?: (event: MediaEngineProgressEvent) => void;
}

export interface MediaEngineAdapter {
  readonly descriptor: MediaEngineAdapterDescriptor;
  getCapabilities(): Promise<MediaEngineCapabilities>;
  probe(source: MediaSource): Promise<MediaProbe>;
  buildPreview(request: MediaEnginePreviewRequest): Promise<VideoEditorPreviewArtifact>;
  validateFontFamily(fontFamily: string): Promise<boolean>;
  export(
    plan: MediaEngineExportPlan,
    events?: MediaEngineExportEventSink
  ): Promise<MediaEngineExportResult>;
  cancel(jobId: string): Promise<MediaEngineCancelResult>;
  verifyOutput(outputPath: string): Promise<OutputVerification>;
  interrupt?(): Promise<void>;
  dispose?(): Promise<void>;
}

export type MediaEngineExportResult =
  | {
      readonly status: 'completed';
      readonly output: OutputVerification & { readonly status: 'verified' };
    }
  | {
      readonly status: 'cancelled';
    }
  | {
      readonly status: 'failed';
      readonly code:
        | 'invalid_plan'
        | 'output_exists'
        | 'process_failed'
        | 'output_invalid';
      readonly message: string;
    };

export type MediaEngineCancelResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_running' };

export type OutputVerification =
  | {
      readonly status: 'verified';
      readonly path: string;
      readonly durationUs: number;
      readonly hasVideo: true;
      readonly hasAudio: boolean;
      readonly container: string | null;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly status: 'invalid';
      readonly path: string;
      readonly reason:
        | 'missing'
        | 'empty'
        | 'probe_failed'
        | 'no_video'
        | 'invalid_dimensions'
        | 'invalid_duration';
    };

export interface FfmpegMediaEngineAdapterOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly adapterVersion?: string;
  readonly previewAdapter?: FfmpegVideoEditorPreviewAdapterOptions;
  readonly processSupervisor?: ManagedProcessSupervisor;
  readonly commandTimeoutMs?: number;
  readonly previewTimeoutMs?: number;
  readonly exportTimeoutMs?: number;
}

export interface FfmpegMediaEngineEnvironment {
  readonly UNICOMP_FFMPEG_PATH?: string;
  readonly UNICOMP_FFPROBE_PATH?: string;
  readonly UNICOMP_FFMPEG_VERSION?: string;
}

export function createFfmpegMediaEngineAdapterFromEnvironment(
  environment: FfmpegMediaEngineEnvironment = process.env
): FfmpegMediaEngineAdapter | undefined {
  const ffmpegPath = environment.UNICOMP_FFMPEG_PATH?.trim();
  const ffprobePath = environment.UNICOMP_FFPROBE_PATH?.trim();
  if (
    !ffmpegPath ||
    !ffprobePath ||
    !path.isAbsolute(ffmpegPath) ||
    !path.isAbsolute(ffprobePath) ||
    !isRegularFile(ffmpegPath) ||
    !isRegularFile(ffprobePath)
  ) {
    return undefined;
  }
  return new FfmpegMediaEngineAdapter({
    ffmpegPath,
    ffprobePath,
    adapterVersion: environment.UNICOMP_FFMPEG_VERSION ?? 'unknown'
  });
}

interface ActiveJob {
  readonly process: ManagedProcessHandle;
  cancelRequested: boolean;
}

export class FfmpegMediaEngineAdapter
  implements MediaEngineAdapter, VideoEditorPreviewArtifactAdapter {
  readonly descriptor: MediaEngineAdapterDescriptor;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly previewAdapter: FfmpegVideoEditorPreviewAdapter;
  private readonly processSupervisor: ManagedProcessSupervisor;
  private readonly commandTimeoutMs: number;
  private readonly exportTimeoutMs: number;
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly fontAvailability = new Map<string, Promise<boolean>>();
  private fallbackFontResolution?: Promise<string | undefined>;

  constructor(options: FfmpegMediaEngineAdapterOptions) {
    this.ffmpegPath = requireAbsolutePath(options.ffmpegPath, 'ffmpeg');
    this.ffprobePath = requireAbsolutePath(options.ffprobePath, 'ffprobe');
    this.descriptor = {
      adapterId: 'ffmpeg',
      adapterVersion: options.adapterVersion ?? 'unknown'
    };
    this.processSupervisor = options.processSupervisor ?? new ManagedProcessSupervisor();
    this.commandTimeoutMs = positiveTimeout(options.commandTimeoutMs, 30_000);
    const previewTimeoutMs = positiveTimeout(options.previewTimeoutMs, 10 * 60_000);
    this.exportTimeoutMs = positiveTimeout(options.exportTimeoutMs, 12 * 60 * 60_000);
    this.previewAdapter = new FfmpegVideoEditorPreviewAdapter(
      options.previewAdapter ?? {
        ffmpegPath: this.ffmpegPath,
        adapterVersion: this.descriptor.adapterVersion,
        runCommand: async (command, args) => {
          const result = await runManagedProcess(
            this.processSupervisor,
            command,
            args,
            previewTimeoutMs,
            0,
            32_000
          );
          requireSuccessfulProcess(result, command);
        }
      }
    );
  }

  async getCapabilities(): Promise<MediaEngineCapabilities> {
    const [version, encoders, formats, filters] = await Promise.all([
      this.runSimple(this.ffmpegPath, ['-version']),
      this.runSimple(this.ffmpegPath, ['-hide_banner', '-encoders']),
      this.runSimple(this.ffmpegPath, ['-hide_banner', '-formats']),
      this.runSimple(this.ffmpegPath, ['-hide_banner', '-filters'])
    ]);
    return {
      descriptor: this.descriptor,
      version: firstLine(version),
      videoEncoders: parseEncoderNames(encoders, 'video'),
      audioEncoders: parseEncoderNames(encoders, 'audio'),
      containers: parseContainerNames(formats),
      filters: parseFilterNames(filters),
      supportsProbe: true,
      supportsPreview: true,
      supportsExport: true,
      supportsCancel: true
    };
  }

  async probe(source: MediaSource): Promise<MediaProbe> {
    const sourcePath = requireAbsolutePath(source.sourcePath, 'source');
    const result = await this.runSimple(this.ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourcePath
    ]);
    return parseProbe(result);
  }

  async buildPreview(
    request: MediaEnginePreviewRequest
  ): Promise<VideoEditorPreviewArtifact> {
    const result = await this.previewAdapter.requestArtifact({
      plan: request.plan,
      kind: request.kind,
      cache: request.cache,
      sourcePath: requireAbsolutePath(request.source.sourcePath, 'source')
    });
    if (result.status !== 'available') {
      throw new Error('FFmpeg preview adapter is unavailable');
    }
    return result.artifact;
  }

  async requestArtifact(input: {
    readonly plan: VideoEditorPreviewPlan;
    readonly kind: VideoEditorPreviewArtifactKind;
    readonly cache: NodeVideoEditorPreviewCache;
    readonly sourcePath: string;
  }) {
    return this.previewAdapter.requestArtifact(input);
  }

  validateFontFamily(fontFamily: string): Promise<boolean> {
    const normalized = fontFamily.trim();
    if (!normalized) return Promise.resolve(false);
    const cached = this.fontAvailability.get(normalized);
    if (cached) return cached;
    this.fallbackFontResolution ??= this.resolveFontFamily(
      '__unicomp_font_probe_missing_family__'
    );
    const check = Promise.all([
      this.resolveFontFamily(normalized),
      this.fallbackFontResolution
    ]).then(
      ([resolved, fallback]) =>
        resolved !== undefined &&
        (fallback === undefined || normalizeResolvedFontPath(resolved) !== normalizeResolvedFontPath(fallback)),
      () => false
    );
    this.fontAvailability.set(normalized, check);
    return check;
  }

  private async resolveFontFamily(fontFamily: string): Promise<string | undefined> {
    const result = await runManagedProcess(
      this.processSupervisor,
      this.ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'verbose',
        '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.04',
        '-vf', `drawtext=font='${escapeFilterValue(fontFamily)}':text='A'`,
        '-frames:v', '1', '-f', 'null', '-'
      ],
      this.commandTimeoutMs,
      32_000,
      64_000
    );
    requireSuccessfulProcess(result, this.ffmpegPath);
    return parseResolvedFontPath(result.stderr);
  }

  async export(
    plan: MediaEngineExportPlan,
    events: MediaEngineExportEventSink = {}
  ): Promise<MediaEngineExportResult> {
    const validation = validateExportPlan(plan);
    if (validation) {
      return { status: 'failed', code: 'invalid_plan', message: validation };
    }
    if (this.activeJobs.has(plan.jobId)) {
      return {
        status: 'failed',
        code: 'invalid_plan',
        message: `Export job ${plan.jobId} is already running`
      };
    }
    if (await exists(plan.outputPath)) {
      return {
        status: 'failed',
        code: 'output_exists',
        message: `Output already exists: ${plan.outputPath}`
      };
    }

    const outputDirectory = path.dirname(plan.outputPath);
    await mkdir(outputDirectory, { recursive: true });
    const temporaryPath = temporaryOutputPath(plan.outputPath);
    await rm(temporaryPath, { force: true });
    events.onProgress?.({ phase: 'starting' });

    let progressBuffer = '';
    const process = startManagedProcess(
      this.processSupervisor,
      this.ffmpegPath,
      buildExportArguments(plan, temporaryPath),
      this.exportTimeoutMs,
      (chunk) => {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line.trim());
          if (!match) continue;
          const processedUs = Number(match[1]);
          const totalUs = exportDurationUs(plan);
          const percent = Math.min(
            100,
            Math.max(0, Math.round((processedUs / totalUs) * 100))
          );
          events.onProgress?.({
            phase: 'encoding',
            processedUs,
            totalUs,
            percent
          });
        }
      }
    );
    const active: ActiveJob = { process, cancelRequested: false };
    this.activeJobs.set(plan.jobId, active);
    try {
      const result = await process.promise;
      if (
        active.cancelRequested ||
        result.terminationReason === 'cancelled' ||
        result.terminationReason === 'shutdown'
      ) {
        await rm(temporaryPath, { force: true });
        return { status: 'cancelled' };
      }
      if (result.terminationReason === 'timed_out') {
        await rm(temporaryPath, { force: true });
        return {
          status: 'failed',
          code: 'process_failed',
          message: 'FFmpeg export timed out'
        };
      }
      if (result.code !== 0) {
        await rm(temporaryPath, { force: true });
        return {
          status: 'failed',
          code: 'process_failed',
          message: result.stderr.trim() ||
            `FFmpeg exited with code ${result.code} and signal ${result.signal ?? 'none'}`
        };
      }
      events.onProgress?.({ phase: 'verifying' });
      const verification = await this.verifyOutput(temporaryPath);
      if (verification.status !== 'verified') {
        await rm(temporaryPath, { force: true });
        return {
          status: 'failed',
          code: 'output_invalid',
          message: `FFmpeg output failed verification: ${verification.reason}`
        };
      }
      events.onProgress?.({ phase: 'publishing' });
      await syncFile(temporaryPath);
      try {
        await link(temporaryPath, plan.outputPath);
      } catch (error) {
        return {
          status: 'failed',
          code: isNodeError(error) && error.code === 'EEXIST'
            ? 'output_exists'
            : 'process_failed',
          message: isNodeError(error) && error.code === 'EEXIST'
            ? 'The export destination already exists'
            : 'The verified output could not be published atomically'
        };
      }
      await syncFile(plan.outputPath);
      await rm(temporaryPath, { force: true });
      return {
        status: 'completed',
        output: { ...verification, path: plan.outputPath }
      };
    } finally {
      this.activeJobs.delete(plan.jobId);
      await rm(temporaryPath, { force: true });
    }
  }

  async cancel(jobId: string): Promise<MediaEngineCancelResult> {
    const active = this.activeJobs.get(jobId);
    if (!active) return { status: 'not_found' };
    if (active.cancelRequested) return { status: 'not_running' };
    active.cancelRequested = true;
    return active.process.cancel()
      ? { status: 'accepted' }
      : { status: 'not_running' };
  }

  async verifyOutput(outputPath: string): Promise<OutputVerification> {
    const target = requireAbsolutePath(outputPath, 'output');
    let metadata;
    try {
      metadata = await stat(target);
    } catch {
      return { status: 'invalid', path: target, reason: 'missing' };
    }
    if (!metadata.isFile()) {
      return { status: 'invalid', path: target, reason: 'missing' };
    }
    if (metadata.size === 0) {
      return { status: 'invalid', path: target, reason: 'empty' };
    }
    let probe: MediaProbe;
    try {
      probe = parseProbe(
        await this.runSimple(this.ffprobePath, [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          target
        ])
      );
    } catch {
      return { status: 'invalid', path: target, reason: 'probe_failed' };
    }
    const video = probe.streams.find((stream) => stream.type === 'video');
    if (!video) {
      return { status: 'invalid', path: target, reason: 'no_video' };
    }
    if (!video.width || !video.height || video.width <= 0 || video.height <= 0) {
      return { status: 'invalid', path: target, reason: 'invalid_dimensions' };
    }
    if (!Number.isSafeInteger(probe.durationUs) || probe.durationUs <= 0) {
      return { status: 'invalid', path: target, reason: 'invalid_duration' };
    }
    return {
      status: 'verified',
      path: target,
      durationUs: probe.durationUs,
      hasVideo: true,
      hasAudio: probe.streams.some((stream) => stream.type === 'audio'),
      container: probe.container,
      width: video.width,
      height: video.height
    };
  }

  async dispose(): Promise<void> {
    await this.interrupt();
  }

  async interrupt(): Promise<void> {
    for (const active of this.activeJobs.values()) {
      active.cancelRequested = true;
      active.process.cancel('cancelled');
    }
    await this.processSupervisor.terminateAll('cancelled');
    this.activeJobs.clear();
  }

  private async runSimple(command: string, args: readonly string[]): Promise<string> {
    const result = await runManagedProcess(
      this.processSupervisor,
      command,
      args,
      this.commandTimeoutMs
    );
    requireSuccessfulProcess(result, command);
    return result.stdout;
  }
}

export function parseResolvedFontPath(report: string): string | undefined {
  return report.match(/\bUsing "([^"\r\n]+)"/)?.[1];
}

function normalizeResolvedFontPath(value: string): string {
  return value.replace(/\\/g, '/').toLocaleLowerCase('en-US');
}

export function buildExportArguments(
  plan: MediaEngineExportPlan,
  temporaryPath: string
): readonly string[] {
  if ('composition' in plan) {
    return buildCompositionExportArguments(plan, temporaryPath);
  }

  const common = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    '-y',
    '-ss',
    formatSeconds(plan.sourceRange.inUs),
    '-t',
    formatSeconds(plan.sourceRange.outUs - plan.sourceRange.inUs),
    '-i',
    plan.source.sourcePath,
    '-map',
    '0:v:0',
    '-c:v',
    plan.videoCodec,
    '-deadline',
    'good',
    '-crf',
    '32',
    '-b:v',
    '0'
  ];
  if (!plan.includeAudio) {
    return [...common, '-an', '-f', 'webm', temporaryPath];
  }
  return [
    ...common,
    '-map',
    '0:a:0?',
    '-c:a',
    plan.audioCodec ?? 'libopus',
    '-b:a',
    '96k',
    '-shortest',
    '-f',
    'webm',
    temporaryPath
  ];
}

export function buildCompositionExportArguments(
  plan: MediaEngineCompositionExportPlan,
  temporaryPath: string
): readonly string[] {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'
  ];
  for (const clip of plan.composition.clips) {
    args.push('-i', clip.source.sourcePath);
  }
  if (plan.composition.backgroundMusic) {
    args.push('-i', plan.composition.backgroundMusic.source.sourcePath);
  }
  if (plan.composition.cover) {
    if (plan.composition.cover.kind === 'image') {
      args.push(
        '-loop', '1', '-t', formatSeconds(plan.composition.cover.durationUs),
        '-i', plan.composition.cover.source.sourcePath
      );
    } else {
      args.push(
        '-ss', formatSeconds(plan.composition.cover.sourceTimeUs ?? 0),
        '-i', plan.composition.cover.source.sourcePath
      );
    }
  }

  const filters: string[] = [];
  const durations: number[] = [];
  plan.composition.clips.forEach((clip, index) => {
    const sourceDurationUs = clip.sourceRange.outUs - clip.sourceRange.inUs;
    const durationUs = Math.round(
      sourceDurationUs * clip.speed.denominator / clip.speed.numerator
    );
    durations.push(durationUs);
    const inputFilter =
      `[${index}:v:0]trim=start=${formatSeconds(clip.sourceRange.inUs)}` +
      `:end=${formatSeconds(clip.sourceRange.outUs)},setpts=(PTS-STARTPTS)*` +
      `${clip.speed.denominator}/${clip.speed.numerator}`;
    if (plan.composition.canvas.background.kind === 'blur_source') {
      const foreground = foregroundTransformFilter(clip, plan.composition.canvas);
      const blur = Math.max(
        1,
        Math.round(plan.composition.canvas.background.strengthPermille / 40)
      );
      const x = `(W-w)/2+${Math.round(plan.composition.canvas.width * clip.transform.positionXPermille / 2000)}`;
      const y = `(H-h)/2+${Math.round(plan.composition.canvas.height * clip.transform.positionYPermille / 2000)}`;
      filters.push(`${inputFilter},split=2[bgsrc${index}][fgsrc${index}]`);
      filters.push(
        `[bgsrc${index}]scale=${plan.composition.canvas.width}:` +
        `${plan.composition.canvas.height}:force_original_aspect_ratio=increase,` +
        `crop=${plan.composition.canvas.width}:${plan.composition.canvas.height},` +
        `gblur=sigma=${blur}[bg${index}]`
      );
      filters.push(`[fgsrc${index}]${foreground}[fg${index}]`);
      filters.push(
        `[bg${index}][fg${index}]overlay=x=${x}:y=${y},setsar=1[v${index}]`
      );
    } else {
      const foreground = foregroundTransformFilter(clip, plan.composition.canvas);
      const x = `(W-w)/2+${Math.round(plan.composition.canvas.width * clip.transform.positionXPermille / 2000)}`;
      const y = `(H-h)/2+${Math.round(plan.composition.canvas.height * clip.transform.positionYPermille / 2000)}`;
      filters.push(`${inputFilter},${foreground}[fg${index}]`);
      filters.push(
        `color=c=${normalizeFfmpegColor(plan.composition.canvas.background.color)}:` +
        `s=${plan.composition.canvas.width}x${plan.composition.canvas.height}:` +
        `d=${formatSeconds(durationUs)}[bg${index}]`
      );
      filters.push(
        `[bg${index}][fg${index}]overlay=x=${x}:y=${y}:` +
        `shortest=1,setsar=1[v${index}]`
      );
    }
    if (clip.hasAudio && !clip.sourceAudio.muted) {
      filters.push(
        `[${index}:a:0]atrim=start=${formatSeconds(clip.sourceRange.inUs)}` +
        `:end=${formatSeconds(clip.sourceRange.outUs)},asetpts=PTS-STARTPTS,` +
        `${audioTempoFilter(clip.speed.numerator / clip.speed.denominator)},` +
        `volume=${(clip.sourceAudio.volumePermille / 1000).toFixed(3)}[a${index}]`
      );
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${formatSeconds(durationUs)}[a${index}]`
      );
    }
  });

  let videoLabel = 'v0';
  let audioLabel = 'a0';
  let combinedDurationUs = durations[0] ?? 0;
  for (let index = 1; index < durations.length; index += 1) {
    const transition = plan.composition.clips[index - 1].transitionToNext;
    const nextVideo = `vx${index}`;
    const nextAudio = `ax${index}`;
    if (transition.kind === 'none') {
      filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0[${nextVideo}]`);
      filters.push(`[${audioLabel}][a${index}]concat=n=2:v=0:a=1[${nextAudio}]`);
      combinedDurationUs += durations[index];
    } else {
      const duration = transition.durationUs;
      filters.push(
        `[${videoLabel}][v${index}]xfade=transition=fade:` +
        `duration=${formatSeconds(duration)}:` +
        `offset=${formatSeconds(combinedDurationUs - duration)}[${nextVideo}]`
      );
      filters.push(
        `[${audioLabel}][a${index}]acrossfade=d=${formatSeconds(duration)}[${nextAudio}]`
      );
      combinedDurationUs += durations[index] - duration;
    }
    videoLabel = nextVideo;
    audioLabel = nextAudio;
  }

  plan.composition.textTrack.forEach((overlay, index) => {
    const next = `text${index}`;
    filters.push(
      `[${videoLabel}]${textOverlayFilter(overlay, plan.composition.canvas)}[${next}]`
    );
    videoLabel = next;
  });

  const cover = plan.composition.cover;
  if (cover) {
    const coverInput = plan.composition.clips.length +
      (plan.composition.backgroundMusic ? 1 : 0);
    filters.push(
      `[${coverInput}:v:0]trim=duration=${formatSeconds(cover.durationUs)},` +
      `setpts=PTS-STARTPTS,scale=${plan.composition.canvas.width}:` +
      `${plan.composition.canvas.height}:force_original_aspect_ratio=decrease,` +
      `pad=${plan.composition.canvas.width}:${plan.composition.canvas.height}:` +
      `(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[coverv]`
    );
    filters.push(
      `anullsrc=r=48000:cl=stereo,atrim=duration=${formatSeconds(cover.durationUs)}[covera]`
    );
    filters.push(`[coverv][${videoLabel}]concat=n=2:v=1:a=0[withcoverv]`);
    filters.push(`[covera][${audioLabel}]concat=n=2:v=0:a=1[withcovera]`);
    videoLabel = 'withcoverv';
    audioLabel = 'withcovera';
  }

  const music = plan.composition.backgroundMusic;
  if (music) {
    const musicInput = plan.composition.clips.length;
    const delayMs = Math.round(
      (music.timelineRange.startUs + (cover?.durationUs ?? 0)) / 1000
    );
    const filtersForMusic = [
      `atrim=start=${formatSeconds(music.sourceRange.inUs)}:end=${formatSeconds(music.sourceRange.outUs)}`,
      'asetpts=PTS-STARTPTS',
      `volume=${(music.volumePermille / 1000).toFixed(3)}`
    ];
    if (music.fadeInUs > 0) {
      filtersForMusic.push(`afade=t=in:st=0:d=${formatSeconds(music.fadeInUs)}`);
    }
    if (music.fadeOutUs > 0) {
      const lengthUs = music.timelineRange.endUs - music.timelineRange.startUs;
      filtersForMusic.push(
        `afade=t=out:st=${formatSeconds(lengthUs - music.fadeOutUs)}:` +
        `d=${formatSeconds(music.fadeOutUs)}`
      );
    }
    filtersForMusic.push(`adelay=${delayMs}|${delayMs}`);
    filters.push(`[${musicInput}:a:0]${filtersForMusic.join(',')}[music]`);
    filters.push(
      `[${audioLabel}][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`
    );
    audioLabel = 'aout';
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${videoLabel}]`, '-map', `[${audioLabel}]`,
    '-c:v', plan.videoCodec, '-deadline', 'good', '-crf', '32', '-b:v', '0',
    '-pix_fmt', 'yuv420p', '-c:a', plan.audioCodec, '-b:a', '96k',
    '-f', 'webm', temporaryPath
  );
  return args;
}

export function parseProbe(value: string): MediaProbe {
  const parsed = JSON.parse(value) as {
    format?: { format_name?: unknown; duration?: unknown };
    streams?: Array<Record<string, unknown>>;
  };
  if (!parsed || !Array.isArray(parsed.streams)) {
    throw new Error('ffprobe returned an invalid report');
  }
  const durationUs = parseDurationUs(parsed.format?.duration);
  return {
    container: stringOrNull(parsed.format?.format_name),
    durationUs,
    streams: parsed.streams.map((stream, index) => ({
      index: numberOrDefault(stream.index, index),
      type: streamType(stream.codec_type),
      codec: stringOrNull(stream.codec_name),
      width: numberOrNull(stream.width),
      height: numberOrNull(stream.height),
      durationUs: parseDurationUs(stream.duration)
    }))
  };
}

export function parseEncoderNames(
  output: string,
  type: 'video' | 'audio'
): string[] {
  const names = new Set<string>();
  const prefix = type === 'video' ? 'V' : 'A';
  for (const match of output.matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)) {
    const line = match[0];
    if (line.trimStart().startsWith(prefix) || line.trimStart().startsWith(`.${prefix}`)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

export function parseContainerNames(output: string): string[] {
  const names = new Set<string>();
  for (const match of output.matchAll(/^\s*[D E]{0,2}\s+([A-Za-z0-9_,-]+)/gm)) {
    for (const name of match[1].split(',')) names.add(name);
  }
  return [...names].sort();
}

function validateExportPlan(plan: MediaEngineExportPlan): string | null {
  if (!plan.jobId.trim()) return 'jobId is required';
  try {
    requireAbsolutePath(plan.outputPath, 'output');
    if ('composition' in plan) {
      for (const clip of plan.composition.clips) {
        requireAbsolutePath(clip.source.sourcePath, 'source');
      }
      if (plan.composition.backgroundMusic) {
        requireAbsolutePath(
          plan.composition.backgroundMusic.source.sourcePath,
          'background music'
        );
      }
    } else {
      requireAbsolutePath(plan.source.sourcePath, 'source');
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (path.extname(plan.outputPath).toLowerCase() !== '.webm') {
    return 'development export requires a .webm output';
  }
  if (plan.videoCodec !== 'libvpx-vp9') return 'unsupported video codec';
  if (
    ('composition' in plan || plan.includeAudio) &&
    plan.audioCodec !== 'libopus'
  ) {
    return 'unsupported audio codec';
  }
  if ('composition' in plan) {
    const { composition } = plan;
    if (composition.clips.length === 0) return 'composition requires video clips';
    if (
      !Number.isSafeInteger(composition.canvas.width) ||
      !Number.isSafeInteger(composition.canvas.height) ||
      composition.canvas.width <= 0 || composition.canvas.height <= 0 ||
      composition.canvas.width % 2 !== 0 || composition.canvas.height % 2 !== 0
    ) return 'composition canvas dimensions must be positive even integers';
    for (const clip of composition.clips) {
      if (!validRange(clip.sourceRange)) return 'composition source range is invalid';
      if (
        !Number.isSafeInteger(clip.speed.numerator) ||
        !Number.isSafeInteger(clip.speed.denominator) ||
        clip.speed.numerator <= 0 || clip.speed.denominator <= 0
      ) return 'composition clip speed is invalid';
    }
    return null;
  }
  if (
    !validRange(plan.sourceRange)
  ) {
    return 'source range is invalid';
  }
  return null;
}

export function parseFilterNames(output: string): string[] {
  const names = new Set<string>();
  for (const match of output.matchAll(/^\s*[TSC.]{2}\s+(\S+)/gm)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function validRange(range: SourceTimeRange): boolean {
  return Number.isSafeInteger(range.inUs) &&
    Number.isSafeInteger(range.outUs) &&
    range.inUs >= 0 && range.outUs > range.inUs;
}

function exportDurationUs(plan: MediaEngineExportPlan): number {
  if (!('composition' in plan)) {
    return plan.sourceRange.outUs - plan.sourceRange.inUs;
  }
  const timelineDuration = plan.composition.clips.reduce((total, clip, index) => {
    const duration = Math.round(
      (clip.sourceRange.outUs - clip.sourceRange.inUs) *
      clip.speed.denominator / clip.speed.numerator
    );
    const transition = index > 0
      ? plan.composition.clips[index - 1].transitionToNext
      : { kind: 'none' as const };
    return total + duration - (transition.kind === 'none' ? 0 : transition.durationUs);
  }, 0);
  return timelineDuration + (plan.composition.cover?.durationUs ?? 0);
}

function foregroundTransformFilter(
  clip: MediaEngineCompositionClip,
  canvas: MediaEngineCompositionExportPlan['composition']['canvas']
): string {
  const filters: string[] = [];
  const crop = clip.transform.crop;
  if (crop) {
    filters.push(
      `crop=iw*${crop.widthPermille}/1000:ih*${crop.heightPermille}/1000:` +
      `iw*${crop.xPermille}/1000:ih*${crop.yPermille}/1000`
    );
  }
  const scale = clip.transform.scalePermille / 1000;
  const fit = canvas.transformPolicy === 'fit' ? 'decrease' : 'increase';
  filters.push(
    `scale=w=${Math.max(2, Math.round(canvas.width * scale))}:` +
    `h=${Math.max(2, Math.round(canvas.height * scale))}:` +
    `force_original_aspect_ratio=${fit}`
  );
  if (canvas.transformPolicy === 'fill') {
    filters.push(`crop=${canvas.width}:${canvas.height}`);
  }
  if (clip.transform.flipX) filters.push('hflip');
  if (clip.transform.flipY) filters.push('vflip');
  if (clip.transform.rotationMilliDegrees !== 0) {
    filters.push(
      `rotate=${(clip.transform.rotationMilliDegrees / 1000).toFixed(3)}*PI/180:` +
      'ow=rotw(iw):oh=roth(ih):c=black@0'
    );
  }
  return filters.join(',');
}

function audioTempoFilter(speed: number): string {
  const values: number[] = [];
  let remaining = speed;
  while (remaining > 2) {
    values.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    values.push(0.5);
    remaining /= 0.5;
  }
  values.push(remaining);
  return values.map((value) => `atempo=${value.toFixed(6)}`).join(',');
}

function textOverlayFilter(
  overlay: TextOverlay,
  canvas: MediaEngineCompositionExportPlan['composition']['canvas']
): string {
  const xBase = Math.round(canvas.width * overlay.position.xPermille / 1000);
  const x = overlay.style.alignment === 'center'
    ? `${xBase}-text_w/2`
    : overlay.style.alignment === 'right'
      ? `${xBase}-text_w`
      : `${xBase}`;
  const y = Math.round(canvas.height * overlay.position.yPermille / 1000);
  const start = formatSeconds(overlay.range.startUs);
  const end = formatSeconds(overlay.range.endUs);
  const opacity = overlay.style.opacityPermille / 1000;
  const fadeSeconds = Math.min(
    0.25,
    (overlay.range.endUs - overlay.range.startUs) / 4_000_000
  );
  const alpha = textAlphaExpression(
    opacity,
    Number(start),
    Number(end),
    fadeSeconds,
    overlay.entrance === 'fade_in',
    overlay.exit === 'fade_out'
  );
  return 'drawtext=' +
    `font='${escapeFilterValue(overlay.style.requestedFontFamily)}':` +
    `text='${escapeFilterValue(overlay.content)}':` +
    `fontsize=${Math.max(1, Math.round(overlay.style.fontSizeMilliPx / 1000))}:` +
    `fontcolor=${normalizeFfmpegColor(overlay.style.color)}:` +
    `alpha='${alpha}':` +
    `x=${x}:y=${y}:enable='between(t,${start},${end})'`;
}

function textAlphaExpression(
  opacity: number,
  start: number,
  end: number,
  fade: number,
  fadeIn: boolean,
  fadeOut: boolean
): string {
  let expression = opacity.toFixed(3);
  if (fadeIn && fade > 0) {
    expression = `if(lt(t,${(start + fade).toFixed(6)}),` +
      `${opacity.toFixed(3)}*(t-${start.toFixed(6)})/${fade.toFixed(6)},${expression})`;
  }
  if (fadeOut && fade > 0) {
    expression = `if(gt(t,${(end - fade).toFixed(6)}),` +
      `${opacity.toFixed(3)}*(${end.toFixed(6)}-t)/${fade.toFixed(6)},${expression})`;
  }
  return expression;
}

function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, '\\n');
}

function normalizeFfmpegColor(value: string): string {
  return value.startsWith('#') ? `0x${value.slice(1, 7)}` : value;
}

function startManagedProcess(
  supervisor: ManagedProcessSupervisor,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  onStdout?: (chunk: string) => void
): ManagedProcessHandle {
  return supervisor.start({
    command,
    args,
    timeoutMs,
    onStdout
  });
}

async function runManagedProcess(
  supervisor: ManagedProcessSupervisor,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxStdoutBytes = 512_000,
  maxStderrBytes = 32_000
): Promise<ManagedProcessResult> {
  return supervisor.start({
    command,
    args,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes
  }).promise;
}

function requireSuccessfulProcess(result: ManagedProcessResult, command: string): void {
  if (result.terminationReason === 'timed_out') {
    throw new Error(`${path.basename(command)} timed out`);
  }
  if (result.terminationReason) {
    throw new Error(`${path.basename(command)} was ${result.terminationReason}`);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `${path.basename(command)} failed`);
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Media engine process timeout is invalid');
  }
  return value;
}

function temporaryOutputPath(outputPath: string): string {
  const extension = path.extname(outputPath);
  return path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, extension)}.part-${randomUUID()}${extension}`
  );
}

function requireAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${label} path must be absolute`);
  }
  return path.resolve(value);
}

function isRegularFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function parseDurationUs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 1_000_000);
  }
  if (typeof value === 'string' && value.trim()) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1_000_000);
  }
  return 0;
}

function formatSeconds(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Media engine time value is invalid');
  }
  return (value / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].trim();
}

function streamType(value: unknown): MediaProbeStream['type'] {
  if (value === 'video' || value === 'audio') return value;
  return 'other';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}
