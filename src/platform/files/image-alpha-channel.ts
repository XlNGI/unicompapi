/** Inspect actual PNG bytes, including palette/RGB tRNS transparency. Fail closed on truncation. */
export function imageHasAlphaChannel(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new TypeError('Invalid JPEG');
    return false;
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (mimeType !== 'image/png' || !signature.every((b, i) => bytes[i] === b)) throw new TypeError('Invalid PNG');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let color = -1;
  let alpha = false;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new TypeError('Truncated PNG');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && type !== 'IHDR') throw new TypeError('Missing PNG header');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new TypeError('Invalid PNG header');
      color = bytes[offset + 17];
      if (![0, 2, 3, 4, 6].includes(color)) throw new TypeError('Invalid PNG color type');
      alpha = color === 4 || color === 6;
    }
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT') imageData = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length || !imageData || color === -1) throw new TypeError('Invalid PNG end');
      return alpha;
    }
  }
  throw new TypeError('Incomplete PNG');
}
