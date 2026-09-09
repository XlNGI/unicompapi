export type NativeBinaryRequestFailureCode =
  | 'cancelled'
  | 'network'
  | 'response_too_large';

export class NativeBinaryRequestFailure extends Error {
  constructor(readonly code: NativeBinaryRequestFailureCode) {
    super(code);
    this.name = 'NativeBinaryRequestFailure';
  }
}

export interface NativeBinaryResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'aborted', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface NativeBinaryRequest {
  setHeader(name: string, value: string): void;
  on(event: 'response', listener: (response: NativeBinaryResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  abort(): void;
  end(): void;
}

export type NativeBinaryRequestFactory = (url: string) => NativeBinaryRequest;

export async function requestBinaryWithNativeRequest(input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maximumResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly createRequest: NativeBinaryRequestFactory;
}): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}> {
  if (input.signal?.aborted) {
    throw new NativeBinaryRequestFailure('cancelled');
  }

  return new Promise((resolve, reject) => {
    const request = input.createRequest(input.url);
    let settled = false;
    const finish = (
      result:
        | {
            readonly status: number;
            readonly headers: Readonly<Record<string, string>>;
            readonly body: Uint8Array;
          }
        | NativeBinaryRequestFailure
    ) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', abort);
      if (result instanceof NativeBinaryRequestFailure) reject(result);
      else resolve(result);
    };
    const abort = () => {
      request.abort();
      finish(new NativeBinaryRequestFailure('cancelled'));
    };

    input.signal?.addEventListener('abort', abort, { once: true });
    for (const [name, value] of Object.entries(input.headers)) {
      request.setHeader(name, value);
    }
    request.on('error', () => {
      finish(new NativeBinaryRequestFailure(
        input.signal?.aborted ? 'cancelled' : 'network'
      ));
    });
    request.on('response', (response) => {
      const declaredLength = firstHeader(response.headers['content-length']);
      if (
        declaredLength !== undefined &&
        /^\d+$/u.test(declaredLength) &&
        Number(declaredLength) > input.maximumResponseBytes
      ) {
        request.abort();
        finish(new NativeBinaryRequestFailure('response_too_large'));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > input.maximumResponseBytes) {
          request.abort();
          finish(new NativeBinaryRequestFailure('response_too_large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('aborted', () => {
        finish(new NativeBinaryRequestFailure('network'));
      });
      response.on('error', () => {
        finish(new NativeBinaryRequestFailure('network'));
      });
      response.on('end', () => {
        finish({
          status: response.statusCode,
          headers: safeResponseHeaders(response.headers),
          body: Uint8Array.from(Buffer.concat(chunks, total))
        });
      });
    });
    request.end();
  });
}

export async function downloadImageWithNativeRequest(input: {
  readonly url: string;
  readonly maximumResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly createRequest: NativeBinaryRequestFactory;
}): Promise<{ readonly body: Uint8Array; readonly contentType?: string }> {
  const response = await requestBinaryWithNativeRequest({
    ...input,
    headers: { accept: 'image/*' }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new NativeBinaryRequestFailure('network');
  }
  const contentType = response.headers['content-type'];
  return {
    body: response.body,
    ...(contentType ? { contentType } : {})
  };
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function safeResponseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'retry-after'] as const) {
    const value = firstHeader(headers[name]);
    if (value && /^[\x20-\x7e]+$/u.test(value)) result[name] = value;
  }
  return result;
}
