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
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  ViduManagementAdapter,
  ViduSharedRuntime,
  ViduTransportFailure,
  VolcengineManagementAdapter,
  VolcengineSharedRuntime,
  VolcengineTransportFailure,
  type DeepSeekHttpTransport,
  type DeepSeekHttpTransportRequest,
  type DeepSeekHttpTransportResponse,
  type KlingHttpTransport,
  type KlingHttpTransportRequest,
  type KlingHttpTransportResponse,
  type NewApiHttpTransport,
  type NewApiHttpTransportRequest,
  type NewApiHttpTransportResponse,
  type NewApiImageDownloadPort,
  type ProviderManagementAdapterPort,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse,
  type VolcengineHttpTransport,
  type VolcengineHttpTransportRequest,
  type VolcengineHttpTransportResponse
} from '../../src/platform';
import type { ProxyMode } from '../../src/domain';
import {
  downloadImageWithNativeRequest,
  NativeBinaryRequestFailure,
  requestBinaryWithNativeRequest
} from './native-binary-request';

export interface LiveProviderManagementComposition {
  readonly adapters: readonly ProviderManagementAdapterPort[];
  readonly deepSeekRuntime: DeepSeekSharedRuntime;
  readonly newApiRuntime: NewApiSharedRuntime;
  readonly newApiImageDownloads: NewApiImageDownloadPort;
}

export function createLiveProviderManagementComposition(options: {
  readonly getProxyMode: () => Promise<ProxyMode>;
}): LiveProviderManagementComposition {
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
  const volcengineRuntime = new VolcengineSharedRuntime({
    transport: new ElectronVolcengineHttpTransport(),
    proxy: () => activeProxy
  });
  const viduRuntime = new ViduSharedRuntime({
    transport: new ElectronViduHttpTransport(),
    proxy: () => activeProxy
  });
  return {
    deepSeekRuntime,
    newApiRuntime,
    newApiImageDownloads: createElectronNewApiImageDownloadPort(),
    adapters: [
      new DeepSeekManagementAdapter(deepSeekRuntime),
      new NewApiManagementAdapter(newApiRuntime),
      new NewApiManagementAdapter(newApiRuntime, {
        packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID
      }),
      new KlingManagementAdapter(klingRuntime),
      new VolcengineManagementAdapter(volcengineRuntime),
      new ViduManagementAdapter(viduRuntime)
    ]
  };
}

export function createLiveProviderManagementAdapters(options: {
  readonly getProxyMode: () => Promise<ProxyMode>;
}): ProviderManagementAdapterPort[] {
  return [...createLiveProviderManagementComposition(options).adapters];
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
      const headers = Object.fromEntries(response.headers.entries());
      if (wantsEventStream(request.headers)) {
        await rejectOversizedDeclaredLength(
          response,
          request.maxResponseBytes,
          () => new DeepSeekTransportFailure('response_too_large')
        );
        return {
          status: response.status,
          headers,
          stream: readStreamingResponse(
            response,
            request.maxResponseBytes,
            () => new DeepSeekTransportFailure('response_too_large')
          )
        };
      }
      const body = await readBoundedResponse(
        response,
        request.maxResponseBytes,
        () => new DeepSeekTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers,
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
      if (isNewApiVideoResultRequest(request)) {
        return await requestBinaryWithNativeRequest({
          url: request.url,
          headers: request.headers,
          maximumResponseBytes: request.maxResponseBytes,
          signal: request.signal,
          createRequest: (url) => net.request({
            method: request.method,
            url,
            credentials: 'omit',
            redirect: 'error'
          })
        });
      }
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined,
        signal: request.signal,
        redirect: request.redirect
      });
      const headers = Object.fromEntries(response.headers.entries());
      if (wantsEventStream(request.headers)) {
        await rejectOversizedDeclaredLength(
          response,
          request.maxResponseBytes,
          () => new NewApiTransportFailure('response_too_large')
        );
        return {
          status: response.status,
          headers,
          stream: readStreamingResponse(
            response,
            request.maxResponseBytes,
            () => new NewApiTransportFailure('response_too_large')
          )
        };
      }
      const body = await readBoundedResponse(
        response,
        request.maxResponseBytes,
        () => new NewApiTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers,
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new NewApiTransportFailure('cancelled');
      }
      if (error instanceof NativeBinaryRequestFailure) {
        throw new NewApiTransportFailure(error.code);
      }
      if (error instanceof NewApiTransportFailure) throw error;
      throw new NewApiTransportFailure('network');
    }
  }
}

function isNewApiVideoResultRequest(request: NewApiHttpTransportRequest): boolean {
  const accept = request.headers.accept ?? request.headers.Accept ?? '';
  return request.method === 'GET' && accept.toLowerCase() === 'video/mp4';
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

class ElectronVolcengineHttpTransport implements VolcengineHttpTransport {
  async send(request: VolcengineHttpTransportRequest): Promise<VolcengineHttpTransportResponse> {
    try {
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body.byteLength > 0 ? Buffer.from(request.body) : undefined,
        signal: request.signal,
        redirect: request.redirect
      });
      const body = await readBoundedResponse(
        response,
        request.maxResponseBytes,
        () => new VolcengineTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new VolcengineTransportFailure('cancelled');
      }
      if (error instanceof VolcengineTransportFailure) throw error;
      throw new VolcengineTransportFailure('network');
    }
  }
}

class ElectronViduHttpTransport implements ViduHttpTransport {
  async send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse> {
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
        () => new ViduTransportFailure('response_too_large')
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw new ViduTransportFailure('cancelled');
      }
      if (error instanceof ViduTransportFailure) throw error;
      throw new ViduTransportFailure('network');
    }
  }
}

function wantsEventStream(headers: Readonly<Record<string, string>>): boolean {
  const accept = headers.accept ?? headers.Accept ?? '';
  return accept.toLowerCase().includes('text/event-stream');
}

async function rejectOversizedDeclaredLength(
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error
): Promise<void> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
}

async function* readStreamingResponse(
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error
): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
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
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error
): Promise<Uint8Array> {
  await rejectOversizedDeclaredLength(response, maximumBytes, tooLarge);
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

function createElectronNewApiImageDownloadPort(): NewApiImageDownloadPort {
  return {
    async download(input) {
      if (input.endpointSecurity.sendCredential) {
        throw new NewApiTransportFailure('network');
      }
      if (input.endpointSecurity.allowPrivateNetwork) {
        throw new NewApiTransportFailure('network');
      }
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new NewApiTransportFailure('network');
      }
      if (
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      ) {
        throw new NewApiTransportFailure('network');
      }
      try {
        return await downloadImageWithNativeRequest({
          url: parsed.toString(),
          maximumResponseBytes: input.maximumResponseBytes,
          signal: input.signal,
          createRequest: (url) => net.request({
            method: 'GET',
            url,
            credentials: 'omit',
            redirect: 'error'
          })
        });
      } catch (error) {
        if (
          input.signal?.aborted ||
          isAbortError(error) ||
          (error instanceof NativeBinaryRequestFailure && error.code === 'cancelled')
        ) {
          throw new NewApiTransportFailure('cancelled');
        }
        if (
          error instanceof NativeBinaryRequestFailure &&
          error.code === 'response_too_large'
        ) {
          throw new NewApiTransportFailure('response_too_large');
        }
        if (error instanceof NewApiTransportFailure) throw error;
        throw new NewApiTransportFailure('network');
      }
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
