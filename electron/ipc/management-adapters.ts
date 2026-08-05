import { net } from 'electron';
import {
  DeepSeekManagementAdapter,
  DeepSeekSharedRuntime,
  DeepSeekTransportFailure,
  KlingManagementAdapter,
  KlingSharedRuntime,
  KlingTransportFailure,
  NewApiManagementAdapter,
  NewApiSharedRuntime,
  NewApiTransportFailure,
  type DeepSeekHttpTransport,
  type DeepSeekHttpTransportRequest,
  type DeepSeekHttpTransportResponse,
  type KlingHttpTransport,
  type KlingHttpTransportRequest,
  type KlingHttpTransportResponse,
  type NewApiHttpTransport,
  type NewApiHttpTransportRequest,
  type NewApiHttpTransportResponse,
  type ProviderManagementAdapterPort
} from '../../src/platform';
import type { ProxyMode } from '../../src/domain';

export function createLiveProviderManagementAdapters(options: {
  readonly getProxyMode: () => Promise<ProxyMode>;
}): ProviderManagementAdapterPort[] {
  let activeProxy: ProxyMode = { kind: 'system_default' };
  void options.getProxyMode().then((proxy) => {
    activeProxy = proxy;
  }).catch(() => undefined);
  const deepSeekRuntime = new DeepSeekSharedRuntime({
    transport: new ElectronDeepSeekHttpTransport(),
    proxy: () => activeProxy
  });
  const newApiRuntime = new NewApiSharedRuntime({
    transport: new ElectronNewApiHttpTransport(),
    proxy: () => activeProxy
  });
  const klingRuntime = new KlingSharedRuntime({
    transport: new ElectronKlingHttpTransport(),
    proxy: () => activeProxy
  });
  return [
    new DeepSeekManagementAdapter(deepSeekRuntime),
    new NewApiManagementAdapter(newApiRuntime),
    new KlingManagementAdapter(klingRuntime)
  ];
}

class ElectronDeepSeekHttpTransport implements DeepSeekHttpTransport {
  async send(request: DeepSeekHttpTransportRequest): Promise<DeepSeekHttpTransportResponse> {
    try {
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined,
        signal: request.signal,
        redirect: request.redirect
      });
      const body = await readBoundedResponse(
        response,
        request.maxResponseBytes,
        () => new DeepSeekTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new DeepSeekTransportFailure('cancelled');
      }
      if (error instanceof DeepSeekTransportFailure) throw error;
      throw new DeepSeekTransportFailure('network');
    }
  }
}

class ElectronNewApiHttpTransport implements NewApiHttpTransport {
  async send(request: NewApiHttpTransportRequest): Promise<NewApiHttpTransportResponse> {
    try {
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined,
        signal: request.signal,
        redirect: request.redirect
      });
      const body = await readBoundedResponse(
        response,
        request.maxResponseBytes,
        () => new NewApiTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new NewApiTransportFailure('cancelled');
      }
      if (error instanceof NewApiTransportFailure) throw error;
      throw new NewApiTransportFailure('network');
    }
  }
}

class ElectronKlingHttpTransport implements KlingHttpTransport {
  async send(request: KlingHttpTransportRequest): Promise<KlingHttpTransportResponse> {
    try {
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined,
        signal: request.signal,
        redirect: request.redirect
      });
      const body = await readBoundedResponse(
        response,
        request.maxResponseBytes,
        () => new KlingTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new KlingTransportFailure('cancelled');
      }
      if (error instanceof KlingTransportFailure) throw error;
      throw new KlingTransportFailure('network');
    }
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
