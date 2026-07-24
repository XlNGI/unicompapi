import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
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
import type { SourceTimeRange } from '../../domain';

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

export interface MediaEngineExportPlan {
  readonly jobId: string;
  readonly source: MediaSource;
  readonly outputPath: string;
  readonly sourceRange: SourceTimeRange;
  readonly includeAudio: boolean;
  readonly videoCodec: 'libvpx-vp9';
  readonly audioCodec?: 'libopus';
}

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
  export(
    plan: MediaEngineExportPlan,
    events?: MediaEngineExportEventSink
  ): Promise<MediaEngineExportResult>;
  cancel(jobId: string): Promise<MediaEngineCancelResult>;
  verifyOutput(outputPath: string): Promise<OutputVerification>;
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
    }
  | {
      readonly status: 'invalid';
      readonly path: string;
      readonly reason:
        | 'missing'
        | 'empty'
        | 'probe_failed'
        | 'no_video'
        | 'invalid_duration';
    };

export interface FfmpegMediaEngineAdapterOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly adapterVersion?: string;
  readonly previewAdapter?: FfmpegVideoEditorPreviewAdapterOptions;
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

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProcessHandle {
  readonly promise: Promise<ProcessResult>;
  cancel(): boolean;
}

interface ActiveJob {
  readonly process: ProcessHandle;
  cancelRequested: boolean;
}

export class FfmpegMediaEngineAdapter
  implements MediaEngineAdapter, VideoEditorPreviewArtifactAdapter {
  readonly descriptor: MediaEngineAdapterDescriptor;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly previewAdapter: FfmpegVideoEditorPreviewAdapter;
  private readonly activeJobs = new Map<string, ActiveJob>();

  constructor(options: FfmpegMediaEngineAdapterOptions) {
    this.ffmpegPath = requireAbsolutePath(options.ffmpegPath, 'ffmpeg');
    this.ffprobePath = requireAbsolutePath(options.ffprobePath, 'ffprobe');
    this.descriptor = {
      adapterId: 'ffmpeg',
      adapterVersion: options.adapterVersion ?? 'unknown'
    };
    this.previewAdapter = new FfmpegVideoEditorPreviewAdapter(
      options.previewAdapter ?? {
        ffmpegPath: this.ffmpegPath,
        adapterVersion: this.descriptor.adapterVersion
      }
    );
  }

  async getCapabilities(): Promise<MediaEngineCapabilities> {
    const [version, encoders, formats] = await Promise.all([
      runSimple(this.ffmpegPath, ['-version']),
      runSimple(this.ffmpegPath, ['-hide_banner', '-encoders']),
      runSimple(this.ffmpegPath, ['-hide_banner', '-formats'])
    ]);
    return {
      descriptor: this.descriptor,
      version: firstLine(version),
      videoEncoders: parseEncoderNames(encoders, 'video'),
      audioEncoders: parseEncoderNames(encoders, 'audio'),
      containers: parseContainerNames(formats),
      supportsProbe: true,
      supportsPreview: true,
      supportsExport: true,
      supportsCancel: true
    };
  }

  async probe(source: MediaSource): Promise<MediaProbe> {
    const sourcePath = requireAbsolutePath(source.sourcePath, 'source');
    const result = await runSimple(this.ffprobePath, [
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
    const process = spawnProcess(
      this.ffmpegPath,
      buildExportArguments(plan, temporaryPath),
      (chunk) => {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line.trim());
          if (!match) continue;
          const processedUs = Number(match[1]);
          const totalUs = plan.sourceRange.outUs - plan.sourceRange.inUs;
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
      if (active.cancelRequested || result.signal) {
        await rm(temporaryPath, { force: true });
        return { status: 'cancelled' };
      }
      if (result.code !== 0) {
        await rm(temporaryPath, { force: true });
        return {
          status: 'failed',
          code: 'process_failed',
          message: result.stderr.trim() || `FFmpeg exited with code ${result.code}`
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
      await rename(temporaryPath, plan.outputPath);
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
        await runSimple(this.ffprobePath, [
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
    const hasVideo = probe.streams.some((stream) => stream.type === 'video');
    if (!hasVideo) {
      return { status: 'invalid', path: target, reason: 'no_video' };
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
      container: probe.container
    };
  }
}

export function buildExportArguments(
  plan: MediaEngineExportPlan,
  temporaryPath: string
): readonly string[] {
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
    requireAbsolutePath(plan.source.sourcePath, 'source');
    requireAbsolutePath(plan.outputPath, 'output');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (path.extname(plan.outputPath).toLowerCase() !== '.webm') {
    return 'development export requires a .webm output';
  }
  if (plan.videoCodec !== 'libvpx-vp9') return 'unsupported video codec';
  if (plan.includeAudio && plan.audioCodec !== 'libopus') {
    return 'unsupported audio codec';
  }
  if (
    !Number.isSafeInteger(plan.sourceRange.inUs) ||
    !Number.isSafeInteger(plan.sourceRange.outUs) ||
    plan.sourceRange.inUs < 0 ||
    plan.sourceRange.outUs <= plan.sourceRange.inUs
  ) {
    return 'source range is invalid';
  }
  return null;
}

function spawnProcess(
  command: string,
  args: readonly string[],
  onStdout?: (chunk: string) => void
): ProcessHandle {
  const child = spawn(command, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 512_000) stdout = stdout.slice(-512_000);
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
  });
  const promise = new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    promise,
    cancel: () => {
      if (closed) return false;
      return child.kill();
    }
  };
}

async function runSimple(command: string, args: readonly string[]): Promise<string> {
  const process = spawnProcess(command, args);
  const result = await process.promise;
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `${path.basename(command)} failed`);
  }
  return result.stdout;
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
