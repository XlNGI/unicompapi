import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export async function createLocalMediaResponse(
  target: string,
  mimeType?: string,
  method = 'GET'
): Promise<Response> {
  const metadata = await stat(target);
  if (!metadata.isFile()) {
    throw new Error('Local media target is not a file');
  }

  const headers = new Headers();
  if (mimeType && isAsciiHeaderValue(mimeType)) {
    headers.set('content-type', mimeType);
  }
  headers.set('content-length', String(metadata.size));

  if (method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  const body = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

function isAsciiHeaderValue(value: string): boolean {
  return /^[\x20-\x7e]+$/u.test(value);
}
