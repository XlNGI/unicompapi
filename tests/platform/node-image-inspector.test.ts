import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ImageInspectionError,
  NodeImageInspector
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-inspector-'));
  roots.push(root);
  return root;
}

function pngHeader(width: number, height: number) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('NodeImageInspector', () => {
  it('detects image content and dimensions without trusting the extension', async () => {
    const root = await createRoot();
    const target = path.join(root, 'not-an-image-extension.bin');
    await writeFile(target, pngHeader(640, 360));

    await expect(new NodeImageInspector().inspect(target)).resolves.toEqual({
      mimeType: 'image/png',
      width: 640,
      height: 360,
      sizeBytes: 24
    });
  });

  it('reads JPEG frame dimensions from the binary marker stream', async () => {
    const root = await createRoot();
    const target = path.join(root, 'photo.jpg');
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x01, 0x20,
      0x02, 0x00,
      0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00,
      0x03, 0x11, 0x00,
      0xff, 0xd9
    ]);
    await writeFile(target, jpeg);

    await expect(new NodeImageInspector().inspect(target)).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      width: 512,
      height: 288
    });
  });

  it('rejects empty, unsupported and structurally invalid image files', async () => {
    const root = await createRoot();
    const empty = path.join(root, 'empty.png');
    const text = path.join(root, 'text.png');
    const invalid = path.join(root, 'invalid.png');
    await writeFile(empty, Buffer.alloc(0));
    await writeFile(text, 'not an image', 'utf8');
    await writeFile(invalid, pngHeader(0, 10));
    const inspector = new NodeImageInspector();

    await expect(inspector.inspect(empty)).rejects.toMatchObject({
      code: 'empty_file'
    });
    await expect(inspector.inspect(text)).rejects.toBeInstanceOf(
      ImageInspectionError
    );
    await expect(inspector.inspect(text)).rejects.toMatchObject({
      code: 'unsupported_image'
    });
    await expect(inspector.inspect(invalid)).rejects.toMatchObject({
      code: 'invalid_image'
    });
  });
});
