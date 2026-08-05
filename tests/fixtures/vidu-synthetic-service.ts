import {
  ViduTransportFailure,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse
} from '../../src/platform';

export type SyntheticViduAction =
  | ViduHttpTransportResponse
  | ViduTransportFailure;

export interface SyntheticRequestFact {
  readonly method: ViduHttpTransportRequest['method'];
  readonly url: string;
  readonly bodyBytes: number;
  readonly authorized: boolean;
  readonly dnsRebindingProtection: 'required';
}

export class SyntheticViduService implements ViduHttpTransport {
  readonly requests: SyntheticRequestFact[] = [];
  private readonly actions = new Map<string, SyntheticViduAction[]>();
  private readonly downloads = new Map<string, ViduHttpTransportResponse>();

  constructor(
    private readonly expectedToken = 'synthetic-valid-token'
  ) {}

  enqueue(
    method: ViduHttpTransportRequest['method'],
    path: string,
    ...actions: SyntheticViduAction[]
  ): void {
    const key = routeKey(method, path);
    this.actions.set(key, [...(this.actions.get(key) ?? []), ...actions]);
  }

  registerDownload(
    url: string,
    body: Uint8Array,
    contentType: string,
    headers: Readonly<Record<string, string>> = {}
  ): void {
    this.downloads.set(url, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(body.byteLength),
        ...headers
      },
      body: Uint8Array.from(body)
    });
  }

  count(method: ViduHttpTransportRequest['method'], path: string): number {
    return this.requests.filter((request) => {
      const url = new URL(request.url);
      return request.method === method && url.pathname === path;
    }).length;
  }

  async send(
    request: ViduHttpTransportRequest
  ): Promise<ViduHttpTransportResponse> {
    const url = new URL(request.url);
    const authorized =
      request.headers.authorization === `Token ${this.expectedToken}` ||
      request.headers.authorization === `Bearer ${this.expectedToken}`;
    this.requests.push({
      method: request.method,
      url: request.url,
      bodyBytes: request.body?.byteLength ?? 0,
      authorized,
      dnsRebindingProtection: request.dnsRebindingProtection
    });

    const queued = this.actions.get(routeKey(request.method, url.pathname));
    const action = queued?.shift();
    if (action instanceof ViduTransportFailure) throw action;
    if (action) return cloneResponse(action);

    if (url.hostname === 'api.vidu.cn') {
      if (!authorized) return jsonResponse(401, { error: 'invalid token' });
      return this.defaultApiResponse(request.method, url.pathname);
    }

    const download = this.downloads.get(request.url);
    return download
      ? cloneResponse(download)
      : jsonResponse(404, { error: 'synthetic result missing' });
  }

  private defaultApiResponse(
    method: ViduHttpTransportRequest['method'],
    path: string
  ): ViduHttpTransportResponse {
    if (method === 'GET' && path === '/ent/v2/credits') {
      return jsonResponse(200, { credits: 'synthetic-only' });
    }
    if (method === 'POST' && path === '/ent/v1/images/generations') {
      return jsonResponse(200, {
        data: [{
          url: 'https://results.synthetic.invalid/generated.png?signature=private'
        }]
      });
    }
    if (method === 'POST' && path === '/ent/v1/images/edits') {
      return jsonResponse(200, {
        output_format: 'png',
        data: [{ b64_json: pngBytes(4, 4).toString('base64') }]
      });
    }
    if (
      method === 'POST' &&
      path.startsWith('/ent/v2/image/reference2image/')
    ) {
      return jsonResponse(200, {
        candidates: [{
          content: {
            parts: [{
              fileData: {
                fileUri:
                  'https://results.synthetic.invalid/reference.png?signature=private',
                mimeType: 'image/png'
              }
            }]
          }
        }]
      });
    }
    if (method === 'POST' && path === '/ent/v2/reference2video') {
      return jsonResponse(200, { task_id: 'synthetic-video-task' });
    }
    if (
      method === 'GET' &&
      path === '/ent/v2/tasks/synthetic-video-task/creations'
    ) {
      return jsonResponse(200, {
        state: 'success',
        creations: [{
          id: 'synthetic-video-result',
          url: 'https://results.synthetic.invalid/generated.mp4?signature=private'
        }]
      });
    }
    if (
      method === 'POST' &&
      path === '/ent/v2/tasks/synthetic-video-task/cancel'
    ) {
      return jsonResponse(200, {});
    }
    return jsonResponse(404, { error: 'synthetic route missing' });
  }
}

export function jsonResponse(
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {}
): ViduHttpTransportResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      ...headers
    },
    body
  };
}

export function binaryResponse(
  status: number,
  body: Uint8Array,
  contentType: string,
  headers: Readonly<Record<string, string>> = {}
): ViduHttpTransportResponse {
  return {
    status,
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
      ...headers
    },
    body: Uint8Array.from(body)
  };
}

export function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

export function isoBmffVideo(options: {
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
} = {}): Buffer {
  const durationMs = options.durationMs ?? 2_500;
  const width = options.width ?? 1_280;
  const height = options.height ?? 720;
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write('isom', 0, 4, 'ascii');
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
    box('mdat', Buffer.from('synthetic-video-payload'))
  ]);
}

function routeKey(
  method: ViduHttpTransportRequest['method'],
  path: string
): string {
  return `${method} ${path}`;
}

function cloneResponse(
  response: ViduHttpTransportResponse
): ViduHttpTransportResponse {
  return {
    status: response.status,
    headers: { ...response.headers },
    body: Uint8Array.from(response.body)
  };
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}
