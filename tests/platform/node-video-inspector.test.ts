import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeVideoInspector } from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

export function isoBmffVideo(options: {
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly brand?: string;
  readonly suffix?: string;
} = {}): Buffer {
  const durationMs = options.durationMs ?? 2_500;
  const width = options.width ?? 1_280;
  const height = options.height ?? 720;
  const brand = options.brand ?? 'isom';

  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write(brand, 0, 4, 'ascii');
  ftypPayload.writeUInt32BE(0, 4);
  ftypPayload.write('isom', 8, 4, 'ascii');
  ftypPayload.write('mp42', 12, 4, 'ascii');

  const mvhdPayload = Buffer.alloc(20);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(durationMs, 16);

  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(width * 65_536, 76);
  tkhdPayload.writeUInt32BE(height * 65_536, 80);

  const hdlrPayload = Buffer.alloc(12);
  hdlrPayload.write('vide', 8, 4, 'ascii');

  return Buffer.concat([
    box('ftyp', ftypPayload),
    box(
      'moov',
      Buffer.concat([
        box('mvhd', mvhdPayload),
        box(
          'trak',
          Buffer.concat([
            box('tkhd', tkhdPayload),
            box('mdia', box('hdlr', hdlrPayload))
          ])
        )
      ])
    ),
    box('mdat', Buffer.from(options.suffix ?? 'video-payload'))
  ]);
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

describe('NodeVideoInspector', () => {
  it('reads MP4 metadata from file contents without trusting the extension', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-probe-'));
    roots.push(root);
    const target = path.join(root, 'selected-media.dat');
    const content = isoBmffVideo();
    await writeFile(target, content);

    await expect(new NodeVideoInspector().inspect(target)).resolves.toEqual({
      mimeType: 'video/mp4',
      container: 'mp4',
      durationMs: 2_500,
      width: 1_280,
      height: 720,
      sizeBytes: content.length
    });
  });

  it('recognizes QuickTime brands as a distinct container and MIME type', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-probe-'));
    roots.push(root);
    const target = path.join(root, 'clip.bin');
    await writeFile(target, isoBmffVideo({ brand: 'qt  ' }));

    await expect(new NodeVideoInspector().inspect(target)).resolves.toMatchObject({
      mimeType: 'video/quicktime',
      container: 'quicktime'
    });
  });

  it('rejects unsupported and truncated files instead of inventing metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-probe-'));
    roots.push(root);
    const unsupported = path.join(root, 'unsupported.mp4');
    const truncated = path.join(root, 'truncated.mp4');
    await writeFile(unsupported, 'not a video', 'utf8');
    await writeFile(truncated, isoBmffVideo().subarray(0, 20));

    await expect(new NodeVideoInspector().inspect(unsupported)).rejects.toMatchObject({
      code: expect.stringMatching(/unsupported_video|video_unreadable/)
    });
    await expect(new NodeVideoInspector().inspect(truncated)).rejects.toMatchObject({
      code: 'video_unreadable'
    });
  });
});
