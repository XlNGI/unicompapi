import { deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer) {
  const tag = Buffer.from(type);
  let crc = 0xffffffff;
  for (const b of Buffer.concat([tag, data])) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); tag.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

export function testPng(width: number, height: number, options: { alpha?: boolean; transparency?: boolean; noise?: boolean } = {}) {
  const channels = options.alpha ? 4 : 3;
  const row = width * channels + 1;
  const pixels = Buffer.alloc(row * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) for (let x = 1; x < row; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[y * row + x] = options.noise ? seed & 255 : 128;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = options.alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(options.transparency ? [chunk('tRNS', Buffer.alloc(6))] : []), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
