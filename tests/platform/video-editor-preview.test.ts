import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  toFileReferenceId,
  toVideoClipId,
  toVideoEditDraftId
} from '../../src/domain';
import {
  FfmpegVideoEditorPreviewAdapter,
  NodeVideoEditorPreviewCache,
  createDevelopmentVideoEditorPreviewAdapter,
  createVideoEditorPreviewCacheKey,
  type VideoEditorPreviewPlan
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function plan(): VideoEditorPreviewPlan {
  return {
    schemaVersion: 1,
    draftId: toVideoEditDraftId('preview-plan-draft'),
    draftRevision: 4,
    clipId: toVideoClipId('preview-plan-clip'),
    sourceIdentity: {
      sizeBytes: 1024,
      modifiedAtMs: 10,
      durationUs: 5_000_000,
      container: 'mp4',
      width: 1280,
      height: 720,
      checksumSha256: 'a'.repeat(64)
    },
    sourceRange: { inUs: 0, outUs: 5_000_000 },
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

describe('video editor preview cache boundary', () => {
  it('keys cache artifacts by source, parameters, kind and adapter version', () => {
    const base = createVideoEditorPreviewCacheKey({
      plan: plan(),
      kind: 'proxy_video',
      adapter: { adapterId: 'approved-adapter', adapterVersion: '1' }
    });
    const nextVersion = createVideoEditorPreviewCacheKey({
      plan: plan(),
      kind: 'proxy_video',
      adapter: { adapterId: 'approved-adapter', adapterVersion: '2' }
    });
    const waveform = createVideoEditorPreviewCacheKey({
      plan: plan(),
      kind: 'audio_waveform',
      adapter: { adapterId: 'approved-adapter', adapterVersion: '1' }
    });
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set([base, nextVersion, waveform]).size).toBe(3);
  });

  it('clears derived cache files without touching project entities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-preview-cache-'));
    roots.push(root);
    const cache = new NodeVideoEditorPreviewCache(root);
    await cache.ensure();
    const target = cache.resolve('a'.repeat(64), 'bin');
    await writeFile(target, 'derived-cache');
    const entity = path.join(root, 'entities.json');
    await writeFile(entity, JSON.stringify({ fileId: toFileReferenceId('safe-file') }));

    await cache.clear();

    await expect(writeFile(entity, 'still-safe')).resolves.toBeUndefined();
    await expect(writeFile(target, 'missing-parent')).rejects.toBeDefined();
  });

  it('keeps the FFmpeg adapter disabled outside explicit local development', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ffmpeg-config-'));
    roots.push(root);
    const executable = path.join(root, 'ffmpeg.exe');
    await writeFile(executable, 'development-only-placeholder');

    const production = createDevelopmentVideoEditorPreviewAdapter({
      UNICOMP_ENABLE_LOCAL_FFMPEG: '1',
      UNICOMP_FFMPEG_PATH: executable
    });
    const development = createDevelopmentVideoEditorPreviewAdapter({
      UNICOMP_ENABLE_LOCAL_FFMPEG: '1',
      UNICOMP_FFMPEG_PATH: executable,
      VITE_DEV_SERVER_URL: 'http://localhost:5173'
    });

    expect(production.descriptor.adapterId).toBe('ffmpeg-development-unavailable');
    expect(development.descriptor.adapterId).toBe('ffmpeg-development');
  });

  it('runs a structured local FFmpeg preview and reuses the verified cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ffmpeg-preview-'));
    roots.push(root);
    const cache = new NodeVideoEditorPreviewCache(root);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const adapter = new FfmpegVideoEditorPreviewAdapter({
      ffmpegPath: path.join(root, 'ffmpeg.exe'),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        const target = args.at(-1);
        if (!target) throw new Error('missing output target');
        await writeFile(target, 'fake-webm-artifact');
      }
    });
    const sourcePath = path.join(root, 'source.mp4');

    const first = await adapter.requestArtifact({
      plan: plan(),
      kind: 'proxy_video',
      cache,
      sourcePath
    });
    const second = await adapter.requestArtifact({
      plan: plan(),
      kind: 'proxy_video',
      cache,
      sourcePath
    });

    expect(first.status).toBe('available');
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(path.join(root, 'ffmpeg.exe'));
    expect(calls[0].args).toContain('-i');
    expect(calls[0].args[calls[0].args.indexOf('-i') + 1]).toBe(sourcePath);
    expect(calls[0].args).toContain('libvpx-vp9');
    expect(calls[0].args).toContain('libopus');
    expect(calls[0].args.join(' ')).not.toContain('shell=true');
  });

  it('builds a waveform request without accepting a shell command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-ffmpeg-waveform-'));
    roots.push(root);
    const cache = new NodeVideoEditorPreviewCache(root);
    let args: readonly string[] = [];
    const adapter = new FfmpegVideoEditorPreviewAdapter({
      ffmpegPath: 'ffmpeg-development-placeholder',
      runCommand: async (_command, nextArgs) => {
        args = nextArgs;
        const target = nextArgs.at(-1);
        if (!target) throw new Error('missing output target');
        await writeFile(target, 'fake-png-artifact');
      }
    });

    await adapter.requestArtifact({
      plan: plan(),
      kind: 'audio_waveform',
      cache,
      sourcePath: path.join(root, 'source.mp4')
    });

    expect(args).toContain(
      '[0:a:0]showwavespic=s=1200x240:colors=white[waveform]'
    );
    expect(args).toContain('[waveform]');
    expect(args).toContain('-an');
    expect(args).not.toContain('-vn');
    expect(args).not.toContain('--shell');
  });
});
