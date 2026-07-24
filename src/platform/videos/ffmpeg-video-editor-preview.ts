import { spawn } from 'node:child_process';
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

  constructor(options: FfmpegVideoEditorPreviewAdapterOptions) {
    this.descriptor = {
      adapterId: 'ffmpeg-development',
      adapterVersion: options.adapterVersion ?? developmentFfmpegVersion
    };
    this.ffmpegPath = options.ffmpegPath;
    this.runCommand = options.runCommand ?? runFfmpegCommand;
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
}

const artifactSpecifications: Record<
  VideoEditorPreviewArtifactKind,
  { readonly extension: string; readonly mimeType: string }
> = {
  proxy_video: { extension: 'webm', mimeType: 'video/webm' },
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
      '-map',
      '0:a:0',
      '-vn',
      '-frames:v',
      '1',
      '-filter_complex',
      'showwavespic=s=1200x240:colors=white',
      '-f',
      'image2',
      input.target
    ];
  }

  const filters = buildVideoFilters(input.plan);
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
    '35',
    '-b:v',
    '0'
  ];
  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }
  if (input.plan.sourceAudio.muted) {
    args.push('-an');
  } else {
    args.push('-map', '0:a:0?', '-c:a', 'libopus', '-b:a', '96k');
    if (input.plan.sourceAudio.volumePermille !== 1000) {
      args.push(
        '-af',
        `volume=${formatFilterNumber(input.plan.sourceAudio.volumePermille / 1000)}`
      );
    }
  }
  args.push('-shortest', input.target);
  return args;
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

function runFfmpegCommand(
  command: string,
  args: readonly string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
      reject(
        new Error(
          `FFmpeg preview failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})${suffix}`
        )
      );
    });
  });
}
