import { statSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createVideoEditorPreviewCacheKey,
  type NodeVideoEditorPreviewCache,
  type VideoEditorPreviewAdapterDescriptor,
  type VideoEditorPreviewArtifact,
  type VideoEditorPreviewArtifactAdapter,
  type VideoEditorPreviewArtifactKind,
  type VideoEditorPreviewArtifactResult,
  type VideoEditorPreviewPlan
} from './video-editor-preview';
import { ManagedProcessSupervisor } from '../runtime';

export const developmentFfmpegVersion = '8.1.2';

export interface FfmpegDevelopmentEnvironment {
  readonly VITE_DEV_SERVER_URL?: string;
  readonly UNICOMP_ENABLE_LOCAL_FFMPEG?: string;
  readonly UNICOMP_FFMPEG_PATH?: string;
}

export type FfmpegCommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<void>;

export interface FfmpegVideoEditorPreviewAdapterOptions {
  readonly ffmpegPath: string;
  readonly adapterVersion?: string;
  readonly runCommand?: FfmpegCommandRunner;
  readonly processSupervisor?: ManagedProcessSupervisor;
  readonly commandTimeoutMs?: number;
}

/**
 * Development-only factory. Production builds never opt in because the
 * Vite development URL and the explicit local flag are both required.
 */
export function createDevelopmentVideoEditorPreviewAdapter(
  environment: FfmpegDevelopmentEnvironment = process.env
): VideoEditorPreviewArtifactAdapter {
  const ffmpegPath = environment.UNICOMP_FFMPEG_PATH?.trim();
  if (
    !environment.VITE_DEV_SERVER_URL ||
    environment.UNICOMP_ENABLE_LOCAL_FFMPEG !== '1' ||
    !ffmpegPath ||
    !path.isAbsolute(ffmpegPath) ||
    !isRegularFile(ffmpegPath)
  ) {
    return new UnavailableDevelopmentVideoEditorPreviewAdapter();
  }

  return new FfmpegVideoEditorPreviewAdapter({
    ffmpegPath: path.resolve(ffmpegPath),
    adapterVersion: developmentFfmpegVersion
  });
}

export class UnavailableDevelopmentVideoEditorPreviewAdapter
  implements VideoEditorPreviewArtifactAdapter {
  readonly descriptor: VideoEditorPreviewAdapterDescriptor = {
    adapterId: 'ffmpeg-development-unavailable',
    adapterVersion: '0'
  };

  async requestArtifact(): Promise<VideoEditorPreviewArtifactResult> {
    return { status: 'adapter_unavailable' };
  }
}

export class FfmpegVideoEditorPreviewAdapter
  implements VideoEditorPreviewArtifactAdapter {
  readonly descriptor: VideoEditorPreviewAdapterDescriptor;
  private readonly ffmpegPath: string;
  private readonly runCommand: FfmpegCommandRunner;
  private readonly processSupervisor?: ManagedProcessSupervisor;

  constructor(options: FfmpegVideoEditorPreviewAdapterOptions) {
    this.descriptor = {
      adapterId: 'ffmpeg-development',
      adapterVersion: options.adapterVersion ?? developmentFfmpegVersion
    };
    this.ffmpegPath = options.ffmpegPath;
    if (options.runCommand) {
      this.runCommand = options.runCommand;
      this.processSupervisor = options.processSupervisor;
    } else {
      this.processSupervisor = options.processSupervisor ?? new ManagedProcessSupervisor();
      const timeoutMs = requireTimeout(options.commandTimeoutMs, 10 * 60_000);
      this.runCommand = (command, args) =>
        runFfmpegCommand(this.processSupervisor!, command, args, timeoutMs);
    }
  }

  async requestArtifact(input: {
    readonly plan: VideoEditorPreviewPlan;
    readonly kind: VideoEditorPreviewArtifactKind;
    readonly cache: NodeVideoEditorPreviewCache;
    readonly sourcePath: string;
  }): Promise<VideoEditorPreviewArtifactResult> {
    const specification = artifactSpecification(input.kind);
    const cacheKey = createVideoEditorPreviewCacheKey({
      plan: input.plan,
      kind: input.kind,
      adapter: this.descriptor
    });
    await input.cache.ensure();
    const target = input.cache.resolve(cacheKey, specification.extension);

    if (await isNonEmptyFile(target)) {
      return {
        status: 'available',
        artifact: {
          kind: input.kind,
          cacheKey,
          target,
          mimeType: specification.mimeType
        }
      };
    }

    const temporary = temporaryTarget(target, specification.extension);
    await rm(temporary, { force: true });
    try {
      await this.runCommand(
        this.ffmpegPath,
        buildFfmpegArguments({
          plan: input.plan,
          kind: input.kind,
          sourcePath: input.sourcePath,
          target: temporary
        })
      );
      if (!(await isNonEmptyFile(temporary))) {
        throw new Error('FFmpeg completed without a non-empty preview artifact');
      }
      await rm(target, { force: true });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    const artifact: VideoEditorPreviewArtifact = {
      kind: input.kind,
      cacheKey,
      target,
      mimeType: specification.mimeType
    };
    return { status: 'available', artifact };
  }

  async interrupt(): Promise<void> {
    await this.processSupervisor?.terminateAll('cancelled');
  }

  async dispose(): Promise<void> {
    await this.interrupt();
  }
}

const artifactSpecifications: Record<
  VideoEditorPreviewArtifactKind,
  { readonly extension: string; readonly mimeType: string }
> = {
  proxy_video: { extension: 'webm', mimeType: 'video/webm' },
  proxy_video_clear: { extension: 'webm', mimeType: 'video/webm' },
  proxy_video_smooth: { extension: 'webm', mimeType: 'video/webm' },
  proxy_video_fast: { extension: 'webm', mimeType: 'video/webm' },
  thumbnail_strip: { extension: 'jpg', mimeType: 'image/jpeg' },
  audio_waveform: { extension: 'png', mimeType: 'image/png' }
};

function artifactSpecification(kind: VideoEditorPreviewArtifactKind) {
  return artifactSpecifications[kind];
}

function temporaryTarget(target: string, extension: string): string {
  const basename = path.basename(target, `.${extension}`);
  return path.join(
    path.dirname(target),
    `${basename}.part-${randomUUID()}.${extension}`
  );
}

function buildFfmpegArguments(input: {
  readonly plan: VideoEditorPreviewPlan;
  readonly kind: VideoEditorPreviewArtifactKind;
  readonly sourcePath: string;
  readonly target: string;
}): readonly string[] {
  const range = input.plan.sourceRange;
  const start = formatSeconds(range.inUs, true);
  const duration = formatSeconds(range.outUs - range.inUs, false);
  const common = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    start,
    '-t',
    duration,
    '-i',
    input.sourcePath
  ];

  if (input.kind === 'thumbnail_strip') {
    return [
      ...common,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      'scale=320:-2',
      '-q:v',
      '4',
      '-an',
      input.target
    ];
  }

  if (input.kind === 'audio_waveform') {
    return [
      ...common,
      '-filter_complex',
      '[0:a:0]showwavespic=s=1200x240:colors=white[waveform]',
      '-map',
      '[waveform]',
      '-frames:v',
      '1',
      '-an',
      '-f',
      'image2',
      input.target
    ];
  }

  const proxyProfile = videoProxyProfile(input.kind);
  const filters = [
    ...buildVideoFilters(input.plan),
    ...(proxyProfile.maxHeight
      ? [`scale=-2:trunc(min(${proxyProfile.maxHeight}\\,ih)/2)*2`]
      : [])
  ];
  const args = [
    ...common,
    '-map',
    '0:v:0',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-crf',
    String(proxyProfile.crf),
    '-b:v',
    '0'
  ];
  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }
  if (input.plan.sourceAudio.muted) {
    args.push('-an');
  } else {
    args.push('-map', '0:a:0?', '-c:a', 'libopus', '-b:a', proxyProfile.audioBitrate);
    const audioFilters: string[] = [];
    if (input.plan.speed.numerator !== input.plan.speed.denominator) {
      audioFilters.push(
        audioTempoFilter(input.plan.speed.numerator / input.plan.speed.denominator)
      );
    }
    if (input.plan.sourceAudio.volumePermille !== 1000) {
      audioFilters.push(
        `volume=${formatFilterNumber(input.plan.sourceAudio.volumePermille / 1000)}`
      );
    }
    if (audioFilters.length > 0) {
      args.push('-af', audioFilters.join(','));
    }
  }
  args.push('-shortest', input.target);
  return args;
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

function videoProxyProfile(kind: VideoEditorPreviewArtifactKind): {
  readonly maxHeight?: number;
  readonly crf: number;
  readonly audioBitrate: string;
} {
  switch (kind) {
    case 'proxy_video_clear':
      return { maxHeight: 1080, crf: 28, audioBitrate: '128k' };
    case 'proxy_video_smooth':
      return { maxHeight: 720, crf: 34, audioBitrate: '96k' };
    case 'proxy_video_fast':
      return { maxHeight: 480, crf: 40, audioBitrate: '64k' };
    default:
      return { crf: 35, audioBitrate: '96k' };
  }
}

function buildVideoFilters(plan: VideoEditorPreviewPlan): string[] {
  const filters: string[] = [];
  if (plan.speed.numerator !== plan.speed.denominator) {
    filters.push(
      `setpts=PTS*${plan.speed.denominator}/${plan.speed.numerator}`
    );
  }
  if (plan.transform.crop) {
    const crop = plan.transform.crop;
    filters.push(
      `crop=iw*${crop.widthPermille}/1000:ih*${crop.heightPermille}/1000:iw*${crop.xPermille}/1000:ih*${crop.yPermille}/1000`
    );
  }
  if (plan.transform.scalePermille !== 1000) {
    filters.push(
      `scale=trunc(iw*${plan.transform.scalePermille}/2000)*2:trunc(ih*${plan.transform.scalePermille}/2000)*2`
    );
  }
  if (plan.transform.flipX) filters.push('hflip');
  if (plan.transform.flipY) filters.push('vflip');
  if (plan.transform.rotationMilliDegrees !== 0) {
    const radians =
      (plan.transform.rotationMilliDegrees / 1000) * (Math.PI / 180);
    filters.push(`rotate=${formatFilterNumber(radians)}:fillcolor=black@0`);
  }
  return filters;
}

function formatSeconds(microseconds: number, allowZero: boolean): string {
  if (
    !Number.isSafeInteger(microseconds) ||
    microseconds < 0 ||
    (!allowZero && microseconds === 0)
  ) {
    throw new TypeError('FFmpeg preview time values are invalid');
  }
  return formatFilterNumber(microseconds / 1_000_000);
}

function formatFilterNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('FFmpeg preview numeric values are invalid');
  }
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

async function isNonEmptyFile(target: string): Promise<boolean> {
  try {
    const metadata = await stat(target);
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

function isRegularFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

async function runFfmpegCommand(
  supervisor: ManagedProcessSupervisor,
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<void> {
  const result = await supervisor.start({
    command,
    args,
    timeoutMs,
    maxStdoutBytes: 0,
    maxStderrBytes: 16_384
  }).promise;
  if (result.terminationReason === 'timed_out') {
    throw new Error('FFmpeg preview timed out');
  }
  if (result.terminationReason) {
    throw new Error(`FFmpeg preview was ${result.terminationReason}`);
  }
  if (result.code !== 0) {
    const suffix = result.stderr.trim() ? `: ${result.stderr.trim()}` : '';
    throw new Error(
      `FFmpeg preview failed (code=${result.code ?? 'null'}, signal=${result.signal ?? 'none'})${suffix}`
    );
  }
}

function requireTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('FFmpeg preview timeout is invalid');
  }
  return value;
}
