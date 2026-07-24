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
  NodeVideoEditorPreviewCache,
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
    sourceAudio: { muted: false, volumePermille: 1000 }
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
});
