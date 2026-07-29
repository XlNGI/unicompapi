import type {
  ProviderConnection,
  ProviderProtocolBinding,
  ProxyMode
} from '../../../domain';
import { isIP } from 'node:net';
import {
  CredentialNotFoundError,
  CredentialUnreadableError,
  CredentialVaultUnavailableError,
  type SecureCredentialVault
} from '../credential-vault';
import {
  ViduRuntimeError,
  ViduTransportFailure
} from './vidu-runtime-errors';

export interface ViduHttpTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly proxy: ProxyMode;
  readonly redirect: 'manual';
}

export interface ViduHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ViduHttpTransport {
  send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse>;
}

export interface ViduSafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly method?: 'GET' | 'POST';
  readonly protocolId?: string;
  readonly status?: number;
  readonly errorCode?: string;
  readonly elapsedMs?: number;
}

export interface ViduRuntimeRequest {
  readonly connection: ProviderConnection;
  readonly binding?: ProviderProtocolBinding;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Uint8Array;
  readonly contentType?: 'application/json';
  readonly authScheme: 'token' | 'none';
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ViduRuntimeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ViduResultDownloadRequest {
  readonly url: string;
  readonly accept?: 'image/*' | 'video/*';
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ViduResultDownloadResponse {
  readonly body: Uint8Array;
  readonly contentType?: string;
}

export interface ViduSharedRuntimeOptions {
  readonly credentialVault: SecureCredentialVault;
  readonly transport: ViduHttpTransport;
  readonly baseUrl?: string;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxRequestBytes?: number;
  readonly defaultMaxResponseBytes?: number;
  readonly logger?: (event: ViduSafeLogEvent) => void;
  readonly now?: () => number;
}

const protocolPaths: Readonly<Record<string, readonly RegExp[]>> = {
  'vidu.ent.v1.images': [
    /^\/ent\/v1\/images\/generations$/,
    /^\/ent\/v1\/images\/edits$/
  ],
  'vidu.ent.v2.image.reference2image': [
    /^\/ent\/v2\/image\/reference2image\/[A-Za-z0-9._-]+$/
  ],
  'vidu.ent.v2.reference2video': [
    /^\/ent\/v2\/reference2video$/,
    /^\/ent\/v2\/tasks\/[A-Za-z0-9._-]+\/creations$/,
    /^\/ent\/v2\/tasks\/[A-Za-z0-9._-]+\/cancel$/
  ]
};

export class ViduSharedRuntime {
  private readonly baseUrl: URL;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: ViduSharedRuntimeOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl ?? 'https://api.vidu.cn');
  }

  async request(input: ViduRuntimeRequest): Promise<ViduRuntimeResponse> {
    if (this.disposed) {
      throw new ViduRuntimeError(
        'runtime_shutting_down',
        'not_retryable'
      );
    }
    const request = this.prepare(input);
    const controller = new AbortController();
    const removeExternalAbort = linkAbort(input.signal, controller);
    this.active.add(controller);
    const startedAt = this.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    this.log({
      event: 'request_started',
      method: input.method,
      protocolId: input.binding?.protocolId ?? 'vidu.connection'
    });
    try {
      return await this.withCredential(input, async (credential) => {
        const headers: Record<string, string> = {
          accept: 'application/json'
        };
        if (input.contentType) headers['content-type'] = input.contentType;
        if (credential !== undefined) {
          headers.authorization = `Token ${credential}`;
        }
        const response = await this.options.transport.send({
          ...request,
          headers,
          signal: controller.signal,
          proxy: this.options.proxy?.() ?? { kind: 'system_default' },
          redirect: 'manual'
        });
        validateResponseSize(response, request.maxResponseBytes);
        if (response.status >= 300 && response.status < 400) {
          throw new ViduRuntimeError('redirect_not_allowed', 'not_retryable');
        }
        if (response.status < 200 || response.status >= 300) {
          throw mapHttpStatus(response.status, response.headers);
        }
        this.log({
          event: 'request_completed',
          method: input.method,
          protocolId: input.binding?.protocolId ?? 'vidu.connection',
          status: response.status,
          elapsedMs: Math.max(0, this.now() - startedAt)
        });
        return {
          status: response.status,
          headers: normalizeHeaders(response.headers),
          body: Uint8Array.from(response.body)
        };
      });
    } catch (error) {
      const mapped = mapRuntimeFailure(
        error,
        controller.signal.aborted,
        timedOut
      );
      this.log({
        event: 'request_failed',
        method: input.method,
        protocolId: input.binding?.protocolId ?? 'vidu.connection',
        errorCode: mapped.code,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      throw mapped;
    } finally {
      clearTimeout(timeout);
      removeExternalAbort();
      this.active.delete(controller);
    }
  }

  async downloadResult(
    input: ViduResultDownloadRequest
  ): Promise<ViduResultDownloadResponse> {
    if (this.disposed) {
      throw new ViduRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    const url = parseResultUrl(input.url);
    const timeoutMs = input.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const maxResponseBytes = input.maxResponseBytes ?? 20 * 1024 * 1024;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1
    ) {
      throw new ViduRuntimeError('invalid_request', 'not_retryable');
    }

    const controller = new AbortController();
    const removeExternalAbort = linkAbort(input.signal, controller);
    this.active.add(controller);
    const startedAt = this.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    this.log({ event: 'request_started', method: 'GET', protocolId: 'vidu.result' });
    try {
      const response = await this.options.transport.send({
        method: 'GET',
        url: url.toString(),
        headers: { accept: input.accept ?? 'image/*' },
        signal: controller.signal,
        timeoutMs,
        maxResponseBytes,
        proxy: this.options.proxy?.() ?? { kind: 'system_default' },
        redirect: 'manual'
      });
      validateResponseSize(response, maxResponseBytes);
      if (response.status >= 300 && response.status < 400) {
        throw new ViduRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(response.status, response.headers);
      }
      this.log({
        event: 'request_completed',
        method: 'GET',
        protocolId: 'vidu.result',
        status: response.status,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      return {
        body: Uint8Array.from(response.body),
        contentType: normalizeContentType(response.headers)
      };
    } catch (error) {
      const mapped = mapRuntimeFailure(
        error,
        controller.signal.aborted,
        timedOut
      );
      this.log({
        event: 'request_failed',
        method: 'GET',
        protocolId: 'vidu.result',
        errorCode: mapped.code,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      throw mapped;
    } finally {
      clearTimeout(timeout);
      removeExternalAbort();
      this.active.delete(controller);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.log({ event: 'runtime_disposed' });
  }

  get activeRequestCount(): number {
    return this.active.size;
  }

  private prepare(input: ViduRuntimeRequest): Omit<
    ViduHttpTransportRequest,
    'headers' | 'signal' | 'proxy' | 'redirect'
  > {
    validateConnection(input.connection, this.baseUrl);
    validateProtocol(input.binding, input.connection, input.path, this.baseUrl);
    if (input.authScheme === 'token') {
      if (
        input.binding &&
        input.binding.authScheme !== 'token'
      ) {
        throw new ViduRuntimeError('protocol_mismatch', 'not_retryable');
      }
      if (!input.connection.credentialReference) {
        throw new ViduRuntimeError('credential_unavailable', 'not_retryable');
      }
    }
    const url = new URL(input.path, this.baseUrl);
    if (
      url.origin !== this.baseUrl.origin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
    }
    const maxRequestBytes =
      input.maxRequestBytes ??
      this.options.defaultMaxRequestBytes ??
      20 * 1024 * 1024;
    if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) {
      throw new ViduRuntimeError('invalid_request', 'not_retryable');
    }
    if (input.body && input.body.byteLength > maxRequestBytes) {
      throw new ViduRuntimeError('invalid_request', 'not_retryable');
    }
    const timeoutMs =
      input.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const maxResponseBytes =
      input.maxResponseBytes ??
      this.options.defaultMaxResponseBytes ??
      2 * 1024 * 1024;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1
    ) {
      throw new ViduRuntimeError('invalid_request', 'not_retryable');
    }
    return {
      method: input.method,
      url: url.toString(),
      body: input.body ? Uint8Array.from(input.body) : undefined,
      timeoutMs,
      maxResponseBytes
    };
  }

  private async withCredential<T>(
    input: ViduRuntimeRequest,
    operation: (credential: string | undefined) => Promise<T>
  ): Promise<T> {
    if (input.authScheme === 'none') return operation(undefined);
    try {
      return await this.options.credentialVault.useValue(
        input.connection.credentialReference!,
        operation
      );
    } catch (error) {
      if (
        error instanceof CredentialNotFoundError ||
        error instanceof CredentialUnreadableError ||
        error instanceof CredentialVaultUnavailableError
      ) {
        throw new ViduRuntimeError(
          'credential_unavailable',
          'not_retryable'
        );
      }
      throw error;
    }
  }

  private log(event: ViduSafeLogEvent): void {
    this.options.logger?.(Object.freeze({ ...event }));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function parseResultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ViduRuntimeError('invalid_response', 'not_retryable');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    !hostname.includes('.')
  ) {
    throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
}

function normalizeContentType(
  headers: Readonly<Record<string, string>>
): string | undefined {
  const normalized = normalizeHeaders(headers)['content-type'];
  const value = normalized?.split(';', 1)[0]?.trim().toLowerCase();
  return value || undefined;
}

function validateConnection(connection: ProviderConnection, baseUrl: URL): void {
  if (
    connection.state === 'deleted' ||
    connection.state === 'disabled' ||
    connection.providerId !== 'provider-vidu'
  ) {
    throw new ViduRuntimeError('protocol_mismatch', 'not_retryable');
  }
  if (connection.endpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(connection.endpoint);
    } catch {
      throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
    }
    if (endpoint.protocol !== 'https:') {
      throw new ViduRuntimeError('insecure_transport', 'not_retryable');
    }
    if (endpoint.origin !== baseUrl.origin) {
      throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
    }
  }
}

function validateProtocol(
  binding: ProviderProtocolBinding | undefined,
  connection: ProviderConnection,
  path: string,
  baseUrl: URL
): void {
  if (path === '/ent/v2/credits') {
    if (binding) {
      throw new ViduRuntimeError('protocol_mismatch', 'not_retryable');
    }
    return;
  }
  if (
    !binding ||
    binding.providerId !== 'provider-vidu' ||
    binding.connectionId !== connection.id
  ) {
    throw new ViduRuntimeError('protocol_mismatch', 'not_retryable');
  }
  const patterns = protocolPaths[binding.protocolId];
  if (!patterns?.some((pattern) => pattern.test(path))) {
    throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  if (binding.endpointTemplate) {
    let template: URL;
    try {
      template = new URL(binding.endpointTemplate.replace(/\{[^}]+\}/g, 'x'));
    } catch {
      throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
    }
    if (template.protocol !== 'https:') {
      throw new ViduRuntimeError('insecure_transport', 'not_retryable');
    }
    if (template.origin !== baseUrl.origin) {
      throw new ViduRuntimeError('endpoint_not_allowed', 'not_retryable');
    }
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Vidu base URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError('Vidu base URL must be a credential-free HTTPS origin');
  }
  return new URL(url.origin);
}

function linkAbort(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function validateResponseSize(
  response: ViduHttpTransportResponse,
  maximum: number
): void {
  const declared = headerValue(response.headers, 'content-length');
  const contentLength = Number(declared);
  if (
    response.body.byteLength > maximum ||
    (Number.isFinite(contentLength) && contentLength > maximum)
  ) {
    throw new ViduRuntimeError('response_too_large', 'not_retryable');
  }
  if (
    declared !== undefined &&
    (!Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength !== response.body.byteLength)
  ) {
    throw new ViduRuntimeError('invalid_response', 'not_retryable');
  }
}

function mapHttpStatus(
  status: number,
  headers: Readonly<Record<string, string>>
): ViduRuntimeError {
  if (status === 401) {
    return new ViduRuntimeError('authentication_failed', 'not_retryable');
  }
  if (status === 403) {
    return new ViduRuntimeError('permission_denied', 'not_retryable');
  }
  if (status === 429) {
    return new ViduRuntimeError(
      'rate_limited',
      'retryable',
      parseRetryAfter(headers)
    );
  }
  if (status >= 500) {
    return new ViduRuntimeError('provider_unavailable', 'retryable');
  }
  return new ViduRuntimeError('invalid_response', 'not_retryable');
}

function parseRetryAfter(
  headers: Readonly<Record<string, string>>
): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 60 * 60 * 1000);
}

function mapRuntimeFailure(
  error: unknown,
  aborted: boolean,
  timedOut: boolean
): ViduRuntimeError {
  if (error instanceof ViduRuntimeError) return error;
  if (timedOut) return new ViduRuntimeError('timeout', 'retryable');
  if (error instanceof ViduTransportFailure) {
    if (error.kind === 'timeout') {
      return new ViduRuntimeError('timeout', 'retryable');
    }
    if (error.kind === 'cancelled') {
      return new ViduRuntimeError('cancelled', 'not_retryable');
    }
    if (error.kind === 'proxy_unavailable') {
      return new ViduRuntimeError('proxy_unavailable', 'retryable');
    }
    if (error.kind === 'response_too_large') {
      return new ViduRuntimeError('response_too_large', 'not_retryable');
    }
    return new ViduRuntimeError('network_error', 'retryable');
  }
  if (aborted) return new ViduRuntimeError('cancelled', 'not_retryable');
  return new ViduRuntimeError('network_error', 'unknown');
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string
): string | undefined {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name
  );
  return entry?.[1];
}
