import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FfmpegMediaEngineAdapter,
  buildExportArguments,
  createFfmpegMediaEngineAdapterFromEnvironment,
  parseEncoderNames,
  parseProbe,
  type MediaEngineExportPlan
} from '../../src/platform';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const ffmpegPath = path.resolve(
  '.tools/media-engine/ffmpeg/8.1.2/win32-x64/bin/ffmpeg.exe'
);
const ffprobePath = path.resolve(
  '.tools/media-engine/ffmpeg/8.1.2/win32-x64/bin/ffprobe.exe'
);
const hasProjectFfmpeg = existsSync(ffmpegPath) && existsSync(ffprobePath);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('media engine adapter contracts', () => {
  it('parses structured probe output without trusting extension names', () => {
    const probe = parseProbe(
      JSON.stringify({
        format: { format_name: 'matroska,webm', duration: '1.250000' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'vp9',
            width: 64,
            height: 64,
            duration: '1.250000'
          },
          {
            index: 1,
            codec_type: 'audio',
            codec_name: 'opus',
            duration: '1.250000'
          }
        ]
      })
    );

    expect(probe).toEqual({
      container: 'matroska,webm',
      durationUs: 1_250_000,
      streams: [
        {
          index: 0,
          type: 'video',
          codec: 'vp9',
          width: 64,
          height: 64,
          durationUs: 1_250_000
        },
        {
          index: 1,
          type: 'audio',
          codec: 'opus',
          width: null,
          height: null,
          durationUs: 1_250_000
        }
      ]
    });
    expect(() => parseProbe('{"streams":[]}')).not.toThrow();
    expect(() => parseProbe('{"format":{}}')).toThrow(/invalid report/);
  });

  it('extracts dynamic audio and video encoders from FFmpeg reports', () => {
    const report = [
      ' V..... libvpx-vp9 VP9',
      ' A..... libopus Opus',
      ' V..... h264 H.264'
    ].join('\n');
    expect(parseEncoderNames(report, 'video')).toEqual(['h264', 'libvpx-vp9']);
    expect(parseEncoderNames(report, 'audio')).toEqual(['libopus']);
  });

  it('builds an argument array with no shell expression or untrusted codec', () => {
    const plan: MediaEngineExportPlan = {
      jobId: 'job-args',
      source: { sourcePath: 'C:\\media\\source.mp4' },
      outputPath: 'C:\\media\\output.webm',
      sourceRange: { inUs: 250_000, outUs: 1_250_000 },
      includeAudio: true,
      videoCodec: 'libvpx-vp9',
      audioCodec: 'libopus'
    };
    const args = buildExportArguments(plan, 'C:\\media\\output.part.webm');
    expect(args).toContain('-progress');
    expect(args).toContain('pipe:1');
    expect(args).toContain('libvpx-vp9');
    expect(args).toContain('libopus');
    expect(args.join(' ')).not.toContain('shell=true');
    expect(args).toContain(plan.source.sourcePath);
  });

  it('does not enable the engine when either controlled binary path is absent', () => {
    expect(
      createFfmpegMediaEngineAdapterFromEnvironment({
        UNICOMP_FFMPEG_PATH: 'C:\\missing\\ffmpeg.exe',
        UNICOMP_FFPROBE_PATH: 'C:\\missing\\ffprobe.exe'
      })
    ).toBeUndefined();
  });

  it('creates the real adapter from two verified main-process paths', () => {
    if (!hasProjectFfmpeg) return;
    const adapter = createFfmpegMediaEngineAdapterFromEnvironment({
      UNICOMP_FFMPEG_PATH: ffmpegPath,
      UNICOMP_FFPROBE_PATH: ffprobePath,
      UNICOMP_FFMPEG_VERSION: '8.1.2'
    });
    expect(adapter?.descriptor).toEqual({
      adapterId: 'ffmpeg',
      adapterVersion: '8.1.2'
    });
  });
});

describe.skipIf(!hasProjectFfmpeg)('real FFmpeg media engine integration', () => {
  it('probes and exports a real WebM artifact, then verifies it independently', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-engine-real-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.webm');
    const outputPath = path.join(root, 'export.webm');
    await mkdir(root, { recursive: true });
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000',
      '-t',
      '1.5',
      '-c:v',
      'libvpx-vp9',
      '-c:a',
      'libopus',
      sourcePath
    ]);

    const adapter = new FfmpegMediaEngineAdapter({
      ffmpegPath,
      ffprobePath,
      adapterVersion: '8.1.2'
    });
    const capabilities = await adapter.getCapabilities();
    expect(capabilities.videoEncoders).toContain('libvpx-vp9');
    expect(capabilities.audioEncoders).toContain('libopus');

    const probe = await adapter.probe({ sourcePath });
    expect(probe.durationUs).toBeGreaterThan(0);
    expect(probe.streams.some((stream) => stream.type === 'video')).toBe(true);
    expect(probe.streams.some((stream) => stream.type === 'audio')).toBe(true);

    const progress: string[] = [];
    const result = await adapter.export(
      {
        jobId: 'real-export',
        source: { sourcePath },
        outputPath,
        sourceRange: { inUs: 0, outUs: 1_000_000 },
        includeAudio: true,
        videoCodec: 'libvpx-vp9',
        audioCodec: 'libopus'
      },
      { onProgress: (event) => progress.push(event.phase) }
    );

    expect(result.status).toBe('completed');
    expect(progress).toContain('encoding');
    expect(progress).toContain('verifying');
    const outputStats = await stat(outputPath);
    expect(outputStats.isFile()).toBe(true);
    const verified = await adapter.verifyOutput(outputPath);
    expect(verified.status).toBe('verified');
    if (verified.status === 'verified') {
      expect(verified.hasVideo).toBe(true);
      expect(verified.hasAudio).toBe(true);
      expect(verified.durationUs).toBeGreaterThan(0);
    }
  }, 120_000);

  it('rejects output overwrite and invalid ranges without starting FFmpeg', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-engine-plan-'));
    roots.push(root);
    const outputPath = path.join(root, 'existing.webm');
    await execFileAsync('node', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, 'x')`]);
    const adapter = new FfmpegMediaEngineAdapter({ ffmpegPath, ffprobePath });
    const base: MediaEngineExportPlan = {
      jobId: 'invalid-export',
      source: { sourcePath: path.join(root, 'missing.mp4') },
      outputPath,
      sourceRange: { inUs: 0, outUs: 1_000_000 },
      includeAudio: false,
      videoCodec: 'libvpx-vp9'
    };
    await expect(adapter.export(base)).resolves.toMatchObject({
      status: 'failed',
      code: 'output_exists'
    });
    await expect(
      adapter.export({
        ...base,
        jobId: 'invalid-range',
        outputPath: path.join(root, 'new.webm'),
        sourceRange: { inUs: 1_000_000, outUs: 1_000_000 }
      })
    ).resolves.toMatchObject({ status: 'failed', code: 'invalid_plan' });
  });

  it('confirms cancellation and removes partial output from a real process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-engine-cancel-'));
    roots.push(root);
    const sourcePath = path.join(root, 'long-source.mkv');
    const outputPath = path.join(root, 'cancelled.webm');
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=640x360:r=30',
      '-t',
      '20',
      '-c:v',
      'ffv1',
      sourcePath
    ]);
    const adapter = new FfmpegMediaEngineAdapter({ ffmpegPath, ffprobePath });
    const exportPromise = adapter.export({
      jobId: 'cancel-export',
      source: { sourcePath },
      outputPath,
      sourceRange: { inUs: 0, outUs: 20_000_000 },
      includeAudio: false,
      videoCodec: 'libvpx-vp9'
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(adapter.cancel('cancel-export')).resolves.toEqual({
      status: 'accepted'
    });
    await expect(exportPromise).resolves.toEqual({ status: 'cancelled' });
    await expect(stat(outputPath)).rejects.toBeDefined();
    expect((await readdir(root)).some((name) => name.includes('.part-'))).toBe(false);
  }, 120_000);
});
