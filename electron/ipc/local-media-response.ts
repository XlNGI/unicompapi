import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export async function createLocalMediaResponse(
  target: string,
  mimeType?: string,
  method = 'GET',
  rangeHeader?: string
): Promise<Response> {
  const metadata = await stat(target);
  if (!metadata.isFile()) {
    throw new Error('Local media target is not a file');
  }

  const headers = new Headers();
  if (mimeType && isAsciiHeaderValue(mimeType)) {
    headers.set('content-type', mimeType);
  }
  headers.set('accept-ranges', 'bytes');

  const range = parseByteRange(rangeHeader, metadata.size);
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }

  const contentLength = range ? range.end - range.start + 1 : metadata.size;
  headers.set('content-length', String(contentLength));
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${metadata.size}`);
  }

  if (method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const body = Readable.toWeb(
    createReadStream(target, range ? { start: range.start, end: range.end } : undefined)
  ) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function parseByteRange(
  rawRange: string | undefined,
  size: number
): { readonly start: number; readonly end: number } | 'unsatisfiable' | undefined {
  if (!rawRange) return undefined;

  const match = /^bytes=(\d*)-(\d*)$/u.exec(rawRange.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'unsatisfiable';

  const startText = match[1];
  const endText = match[2];
  if (!startText) {
    const suffixLength = parseRangeNumber(endText);
    if (suffixLength === undefined || suffixLength === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = parseRangeNumber(startText);
  if (start === undefined || start >= size) return 'unsatisfiable';

  const requestedEnd = endText ? parseRangeNumber(endText) : size - 1;
  if (requestedEnd === undefined || requestedEnd < start) return 'unsatisfiable';

  return { start, end: Math.min(requestedEnd, size - 1) };
}

function parseRangeNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isAsciiHeaderValue(value: string): boolean {
  return /^[\x20-\x7e]+$/u.test(value);
}
