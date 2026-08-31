import { open, type FileHandle } from 'node:fs/promises';
import {
  VideoInspectionError,
  type VideoInspection,
  type VideoInspector
} from './video-inspector';

const boxHeaderSize = 8;
const maximumMetadataBytes = 64 * 1024 * 1024;

interface BoxLocation {
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly headerSize: number;
}

interface ParsedBox {
  readonly type: string;
  readonly dataOffset: number;
  readonly end: number;
}

export class NodeVideoInspector implements VideoInspector {
  async inspect(target: string): Promise<VideoInspection> {
    let handle: FileHandle | undefined;

    try {
      handle = await open(target, 'r');
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size < boxHeaderSize) {
        throw new VideoInspectionError(
          'unsupported_video',
          'The selected file is not a supported video container'
        );
      }

      const topLevel = await readTopLevelBoxes(handle, metadata.size);
      const ftyp = topLevel.find((box) => box.type === 'ftyp');
      const moov = topLevel.find((box) => box.type === 'moov');
      const mdat = topLevel.find((box) => box.type === 'mdat');

      if (!ftyp || !moov || !mdat || mdat.size <= mdat.headerSize) {
        throw new VideoInspectionError(
          'unsupported_video',
          'The selected file does not contain a complete video container'
        );
      }
      if (moov.size - moov.headerSize > maximumMetadataBytes) {
        throw new VideoInspectionError(
          'video_unreadable',
          'The selected video metadata is too large to inspect safely'
        );
      }

      const brand = await inspectBrand(handle, ftyp);
      const moovBuffer = await readExact(
        handle,
        moov.offset + moov.headerSize,
        moov.size - moov.headerSize
      );
      const movieBoxes = parseBoxes(moovBuffer, 0, moovBuffer.length);
      const durationMs = inspectDuration(moovBuffer, movieBoxes);
      const dimensions = inspectVideoDimensions(moovBuffer, movieBoxes);

      return {
        ...brand,
        durationMs,
        ...dimensions,
        sizeBytes: metadata.size
      };
    } catch (error) {
      if (error instanceof VideoInspectionError) {
        throw error;
      }
      throw new VideoInspectionError(
        'video_unreadable',
        'The selected video could not be read and inspected'
      );
    } finally {
      await handle?.close();
    }
  }
}

async function readTopLevelBoxes(
  handle: FileHandle,
  fileSize: number
): Promise<readonly BoxLocation[]> {
  const boxes: BoxLocation[] = [];
  let offset = 0;

  while (offset < fileSize) {
    const box = await readBoxLocation(handle, offset, fileSize);
    boxes.push(box);
    offset += box.size;
  }

  if (offset !== fileSize) {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video container is truncated'
    );
  }
  return boxes;
}

async function readBoxLocation(
  handle: FileHandle,
  offset: number,
  parentEnd: number
): Promise<BoxLocation> {
  const base = await readExact(handle, offset, boxHeaderSize);
  const size32 = base.readUInt32BE(0);
  const type = base.toString('ascii', 4, 8);
  let headerSize = boxHeaderSize;
  let size = size32;

  if (size32 === 1) {
    const extended = await readExact(handle, offset + boxHeaderSize, 8);
    const extendedSize = extended.readBigUInt64BE(0);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new VideoInspectionError(
        'video_unreadable',
        'The selected video contains an unsupported box size'
      );
    }
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  }

  if (
    !isBoxType(type) ||
    size < headerSize ||
    offset + size > parentEnd
  ) {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video contains invalid container metadata'
    );
  }

  return { type, offset, size, headerSize };
}

async function inspectBrand(
  handle: FileHandle,
  ftyp: BoxLocation
): Promise<Pick<VideoInspection, 'mimeType' | 'container'>> {
  const payloadSize = ftyp.size - ftyp.headerSize;
  if (payloadSize < 8 || payloadSize > 4096) {
    throw new VideoInspectionError(
      'unsupported_video',
      'The selected file has an invalid video brand declaration'
    );
  }

  const payload = await readExact(
    handle,
    ftyp.offset + ftyp.headerSize,
    payloadSize
  );
  const brands = [payload.toString('ascii', 0, 4)];
  for (let offset = 8; offset + 4 <= payload.length; offset += 4) {
    brands.push(payload.toString('ascii', offset, offset + 4));
  }

  if (brands.includes('qt  ')) {
    return { mimeType: 'video/quicktime', container: 'quicktime' };
  }
  if (brands.some(isMp4Brand)) {
    return { mimeType: 'video/mp4', container: 'mp4' };
  }
  throw new VideoInspectionError(
    'unsupported_video',
    'The selected video container is not locally supported'
  );
}

function inspectDuration(
  buffer: Buffer,
  boxes: readonly ParsedBox[]
): number {
  const mvhd = boxes.find((box) => box.type === 'mvhd');
  if (!mvhd) {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video does not declare a readable duration'
    );
  }

  const version = readUInt8(buffer, mvhd.dataOffset, mvhd.end);
  let timescale: number;
  let duration: bigint;
  if (version === 0) {
    timescale = readUInt32(buffer, mvhd.dataOffset + 12, mvhd.end);
    duration = BigInt(readUInt32(buffer, mvhd.dataOffset + 16, mvhd.end));
  } else if (version === 1) {
    timescale = readUInt32(buffer, mvhd.dataOffset + 20, mvhd.end);
    duration = readUInt64(buffer, mvhd.dataOffset + 24, mvhd.end);
  } else {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video uses an unsupported duration format'
    );
  }

  if (timescale === 0 || duration === 0n) {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video duration is unavailable'
    );
  }
  const durationMs = Number((duration * 1000n) / BigInt(timescale));
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video duration is invalid'
    );
  }
  return durationMs;
}

function inspectVideoDimensions(
  buffer: Buffer,
  boxes: readonly ParsedBox[]
): Pick<VideoInspection, 'width' | 'height'> {
  for (const track of boxes.filter((box) => box.type === 'trak')) {
    const trackBoxes = parseBoxes(buffer, track.dataOffset, track.end);
    const media = trackBoxes.find((box) => box.type === 'mdia');
    const trackHeader = trackBoxes.find((box) => box.type === 'tkhd');
    if (!media || !trackHeader) continue;

    const mediaBoxes = parseBoxes(buffer, media.dataOffset, media.end);
    const handler = mediaBoxes.find((box) => box.type === 'hdlr');
    if (!handler || readAscii(buffer, handler.dataOffset + 8, 4, handler.end) !== 'vide') {
      continue;
    }

    const version = readUInt8(buffer, trackHeader.dataOffset, trackHeader.end);
    const dimensionOffset = version === 0
      ? trackHeader.dataOffset + 76
      : version === 1
        ? trackHeader.dataOffset + 88
        : -1;
    if (dimensionOffset < 0) {
      throw new VideoInspectionError(
        'video_unreadable',
        'The selected video uses an unsupported track format'
      );
    }
    const width = fixedPointDimension(
      readUInt32(buffer, dimensionOffset, trackHeader.end)
    );
    const height = fixedPointDimension(
      readUInt32(buffer, dimensionOffset + 4, trackHeader.end)
    );
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  throw new VideoInspectionError(
    'video_unreadable',
    'The selected video does not contain a readable video track'
  );
}

function parseBoxes(
  buffer: Buffer,
  start: number,
  end: number
): readonly ParsedBox[] {
  const boxes: ParsedBox[] = [];
  let offset = start;

  while (offset < end) {
    ensureRange(offset, boxHeaderSize, end);
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = boxHeaderSize;
    let size = size32;

    if (size32 === 1) {
      ensureRange(offset, 16, end);
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidMetadata();
      }
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }

    if (!isBoxType(type) || size < headerSize || offset + size > end) {
      throw invalidMetadata();
    }
    boxes.push({
      type,
      dataOffset: offset + headerSize,
      end: offset + size
    });
    offset += size;
  }

  if (offset !== end) throw invalidMetadata();
  return boxes;
}

async function readExact(
  handle: FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new VideoInspectionError(
      'video_unreadable',
      'The selected video is truncated'
    );
  }
  return buffer;
}

function readUInt8(buffer: Buffer, offset: number, end: number): number {
  ensureRange(offset, 1, end);
  return buffer.readUInt8(offset);
}

function readUInt32(buffer: Buffer, offset: number, end: number): number {
  ensureRange(offset, 4, end);
  return buffer.readUInt32BE(offset);
}

function readUInt64(buffer: Buffer, offset: number, end: number): bigint {
  ensureRange(offset, 8, end);
  return buffer.readBigUInt64BE(offset);
}

function readAscii(
  buffer: Buffer,
  offset: number,
  length: number,
  end: number
): string {
  ensureRange(offset, length, end);
  return buffer.toString('ascii', offset, offset + length);
}

function ensureRange(offset: number, length: number, end: number): void {
  if (offset < 0 || length < 0 || offset + length > end) {
    throw invalidMetadata();
  }
}

function fixedPointDimension(value: number): number {
  return Math.round(value / 65_536);
}

function isMp4Brand(brand: string): boolean {
  return (
    brand.startsWith('iso') ||
    brand.startsWith('mp4') ||
    brand === 'avc1' ||
    brand === 'M4V ' ||
    brand === 'MSNV'
  );
}

function isBoxType(value: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(value);
}

function invalidMetadata(): VideoInspectionError {
  return new VideoInspectionError(
    'video_unreadable',
    'The selected video contains invalid container metadata'
  );
}
