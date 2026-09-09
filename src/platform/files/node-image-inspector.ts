import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import {
  ImageInspectionError,
  type ImageInspectionResult,
  type ImageInspector
} from './image-inspector';

const maximumHeaderBytes = 1024 * 1024;

export class NodeImageInspector implements ImageInspector {
  async inspect(target: string): Promise<ImageInspectionResult> {
    const metadata = await readMetadata(target);
    const header = await readHeader(target, metadata.sizeBytes);
    const dimensions = inspectHeader(header);

    return {
      ...dimensions,
      sizeBytes: metadata.sizeBytes
    };
  }
}

async function readMetadata(target: string): Promise<{ sizeBytes: number }> {
  try {
    const metadata = await stat(target);

    if (!metadata.isFile()) {
      throw new ImageInspectionError(
        'not_regular_file',
        'Selected image is not a regular file'
      );
    }

    if (metadata.size === 0) {
      throw new ImageInspectionError('empty_file', 'Selected image is empty');
    }

    await access(target, constants.R_OK);
    return { sizeBytes: metadata.size };
  } catch (error) {
    if (error instanceof ImageInspectionError) {
      throw error;
    }

    throw mapNodeError(error);
  }
}

async function readHeader(target: string, sizeBytes: number): Promise<Buffer> {
  const length = Math.min(sizeBytes, maximumHeaderBytes);
  let handle;

  try {
    handle = await open(target, 'r');
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } catch (error) {
    throw mapNodeError(error);
  } finally {
    await handle?.close();
  }
}

function inspectHeader(header: Buffer): Omit<ImageInspectionResult, 'sizeBytes'> {
  return (
    inspectPng(header) ??
    inspectJpeg(header) ??
    inspectGif(header) ??
    inspectWebp(header) ??
    inspectBmp(header) ??
    unsupportedImage()
  );
}

function inspectPng(
  header: Buffer
): Omit<ImageInspectionResult, 'sizeBytes'> | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (header.length < 24 || !header.subarray(0, 8).equals(signature)) {
    return undefined;
  }

  if (
    header.readUInt32BE(8) !== 13 ||
    header.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw invalidImage('PNG image does not contain a valid IHDR header');
  }

  return dimensions('image/png', header.readUInt32BE(16), header.readUInt32BE(20));
}

function inspectJpeg(
  header: Buffer
): Omit<ImageInspectionResult, 'sizeBytes'> | undefined {
  if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 4 <= header.length) {
    while (offset < header.length && header[offset] === 0xff) {
      offset += 1;
    }

    const marker = header[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > header.length) {
      break;
    }

    const segmentLength = header.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > header.length) {
      break;
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) {
        throw invalidImage('JPEG frame header is invalid');
      }

      return dimensions(
        'image/jpeg',
        header.readUInt16BE(offset + 5),
        header.readUInt16BE(offset + 3)
      );
    }

    offset += segmentLength;
  }

  throw invalidImage('JPEG dimensions could not be read safely');
}

function inspectGif(
  header: Buffer
): Omit<ImageInspectionResult, 'sizeBytes'> | undefined {
  const signature = header.toString('ascii', 0, 6);
  if (header.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    return undefined;
  }

  return dimensions('image/gif', header.readUInt16LE(6), header.readUInt16LE(8));
}

function inspectWebp(
  header: Buffer
): Omit<ImageInspectionResult, 'sizeBytes'> | undefined {
  if (
    header.length < 30 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return undefined;
  }

  const chunk = header.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return dimensions(
      'image/webp',
      readUInt24LE(header, 24) + 1,
      readUInt24LE(header, 27) + 1
    );
  }

  if (chunk === 'VP8 ' && header.toString('hex', 23, 26) === '9d012a') {
    return dimensions(
      'image/webp',
      header.readUInt16LE(26) & 0x3fff,
      header.readUInt16LE(28) & 0x3fff
    );
  }

  if (chunk === 'VP8L' && header[20] === 0x2f) {
    const bits = header.readUInt32LE(21);
    return dimensions(
      'image/webp',
      (bits & 0x3fff) + 1,
      ((bits >> 14) & 0x3fff) + 1
    );
  }

  throw invalidImage('WebP dimensions could not be read safely');
}

function inspectBmp(
  header: Buffer
): Omit<ImageInspectionResult, 'sizeBytes'> | undefined {
  if (header.length < 26 || header.toString('ascii', 0, 2) !== 'BM') {
    return undefined;
  }

  const width = Math.abs(header.readInt32LE(18));
  const height = Math.abs(header.readInt32LE(22));
  return dimensions('image/bmp', width, height);
}

function dimensions(
  mimeType: string,
  width: number,
  height: number
): Omit<ImageInspectionResult, 'sizeBytes'> {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalidImage('Image dimensions are invalid');
  }

  return { mimeType, width, height };
}

function isJpegStartOfFrame(marker: number): boolean {
  return [
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf
  ].includes(marker);
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

function unsupportedImage(): never {
  throw new ImageInspectionError(
    'unsupported_image',
    'Selected file is not a locally supported image'
  );
}

function invalidImage(message: string): ImageInspectionError {
  return new ImageInspectionError('invalid_image', message);
}

function mapNodeError(error: unknown): ImageInspectionError {
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return new ImageInspectionError('not_found', 'Selected image was not found');
    }

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return new ImageInspectionError(
        'permission_denied',
        'Selected image cannot be read'
      );
    }
  }

  return new ImageInspectionError('read_failed', 'Selected image could not be read');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
