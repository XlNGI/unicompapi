import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMediaResponse } from '../../electron/ipc/local-media-response';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('createLocalMediaResponse', () => {
  it('streams media from a Unicode project path without filename headers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-response-'));
    roots.push(root);
    const target = path.join(root, '中文项目', '自动生成图片.png');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'verified image bytes', 'utf8');

    const response = await createLocalMediaResponse(target, 'image/png');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe('20');
    expect(response.headers.has('content-disposition')).toBe(false);
    await expect(response.text()).resolves.toBe('verified image bytes');
  });

  it('returns headers only for HEAD and rejects non-files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-response-'));
    roots.push(root);
    const response = await createLocalMediaResponse(root, 'image/png', 'HEAD')
      .catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Error);
  });

  it('serves a requested byte range for video playback and seeking', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-response-'));
    roots.push(root);
    const target = path.join(root, 'clip.mp4');
    await writeFile(target, '0123456789', 'utf8');

    const response = await createLocalMediaResponse(
      target,
      'video/mp4',
      'GET',
      'bytes=2-5'
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    await expect(response.text()).resolves.toBe('2345');
  });

  it('returns a range response without a body for HEAD', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-response-'));
    roots.push(root);
    const target = path.join(root, 'clip.mp4');
    await writeFile(target, '0123456789', 'utf8');

    const response = await createLocalMediaResponse(
      target,
      'video/mp4',
      'HEAD',
      'bytes=-3'
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe('3');
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10');
    await expect(response.text()).resolves.toBe('');
  });

  it('rejects unsatisfiable byte ranges without exposing file content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-response-'));
    roots.push(root);
    const target = path.join(root, 'clip.mp4');
    await writeFile(target, '0123456789', 'utf8');

    const response = await createLocalMediaResponse(
      target,
      'video/mp4',
      'GET',
      'bytes=10-12'
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    await expect(response.text()).resolves.toBe('');
  });
});
