import type {
  ProviderConnection,
  ProxyMode,
  StructuredCredentialRecord
} from '../../../domain';
import {
  DEEPSEEK_CREDENTIAL_SCHEMA_ID,
  DEEPSEEK_OFFICIAL_BASE_URL,
  DEEPSEEK_OFFICIAL_TEMPLATE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION
} from './deepseek-contracts';

export const deepSeekRuntimeErrorCodes = [
  'invalid_request',
  'protocol_mismatch',
  'endpoint_not_allowed',
  'credential_unavailable',
  'authentication_failed',
  'insufficient_balance',
  'invalid_parameters',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'cancelled',
  'response_too_large',
  'redirect_not_allowed',
  'invalid_response',
  'network_error',
  'proxy_unavailable',
  'runtime_shutting_down'
] as const;
export type DeepSeekRuntimeErrorCode =
  (typeof deepSeekRuntimeErrorCodes)[number];

export class DeepSeekRuntimeError extends Error {
  constructor(
    readonly code: DeepSeekRuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'DeepSeekRuntimeError';
  }
}

export class DeepSeekTransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'response_too_large'
  ) {
    super('DeepSeek transport failed');
    this.name = 'DeepSeekTransportFailure';
  }
}

export interface DeepSeekHttpTransportRequest {
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

export type DeepSeekHttpTransportResponse =
  | {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly stream?: never;
    }
  | {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly stream: AsyncIterable<Uint8Array>;
      readonly body?: never;
    };

export interface DeepSeekHttpTransport {
  send(request: DeepSeekHttpTransportRequest): Promise<DeepSeekHttpTransportResponse>;
}

export interface DeepSeekSafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly operation?: 'model_catalog' | 'chat_stream' | 'chat_completion';
  readonly method?: 'GET' | 'POST';
  readonly status?: number;
  readonly errorCode?: DeepSeekRuntimeErrorCode;
  readonly elapsedMs?: number;
}

export interface DeepSeekEventStreamSession {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly cancel: () => void;
  readonly close: () => void;
}

export interface DeepSeekSharedRuntimeOptions {
  readonly transport: DeepSeekHttpTransport;
  readonly baseUrl?: string;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxRequestBytes?: number;
  readonly defaultMaxJsonResponseBytes?: number;
  readonly defaultMaxStreamBytes?: number;
  readonly logger?: (event: DeepSeekSafeLogEvent) => void;
  readonly now?: () => number;
}

export class DeepSeekSharedRuntime {
  private readonly baseUrl: URL;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: DeepSeekSharedRuntimeOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl ?? DEEPSEEK_OFFICIAL_BASE_URL);
  }

  async requestModelCatalog(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    validateOfficialConnection(input.connection, this.baseUrl);
    const response = await this.request({
      operation: 'model_catalog',
      method: 'GET',
      path: '/models',
      credentials: input.credentials,
      signal: input.signal,
      accept: 'application/json',
      maxResponseBytes:
        this.options.defaultMaxJsonResponseBytes ?? 512 * 1024
    });
    if (response.body === undefined) {
      throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
    }
    requireContentType(response.headers, 'application/json');
    return Uint8Array.from(response.body);
  }

  async openChatStream(input: {
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<DeepSeekEventStreamSession> {
    const maximumRequestBytes =
      this.options.defaultMaxRequestBytes ?? 2 * 1024 * 1024;
    if (input.body.byteLength < 1 || input.body.byteLength > maximumRequestBytes) {
      throw new DeepSeekRuntimeError('invalid_request', 'not_retryable');
    }
    const response = await this.request({
      operation: 'chat_stream',
      method: 'POST',
      path: '/chat/completions',
      credentials: input.credentials,
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      accept: 'text/event-stream',
      contentType: 'application/json',
      maxResponseBytes:
        this.options.defaultMaxStreamBytes ?? 8 * 1024 * 1024,
      keepOpen: true
    });
    if (!('stream' in response) || !response.stream) {
      response.close?.();
      throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
    }
    try {
      requireContentType(response.headers, 'text/event-stream');
    } catch (error) {
      response.close?.();
      throw error;
    }
    return {
      stream: response.stream,
      cancel: response.cancel!,
      close: response.close!
    };
  }

  async requestChatCompletion(input: {
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const maximumRequestBytes =
      this.options.defaultMaxRequestBytes ?? 2 * 1024 * 1024;
    if (input.body.byteLength < 1 || input.body.byteLength > maximumRequestBytes) {
      throw new DeepSeekRuntimeError('invalid_request', 'not_retryable');
    }
    const response = await this.request({
      operation: 'chat_completion',
      method: 'POST',
      path: '/chat/completions',
      credentials: input.credentials,
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      accept: 'application/json',
      contentType: 'application/json',
      maxResponseBytes:
        this.options.defaultMaxJsonResponseBytes ?? 2 * 1024 * 1024
    });
    if (response.body === undefined) {
      throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
    }
    requireContentType(response.headers, 'application/json');
    return Uint8Array.from(response.body);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    this.log({ event: 'runtime_disposed' });
  }

  get activeRequestCount(): number {
    return this.active.size;
  }

  private async request(input: {
    readonly operation: 'model_catalog' | 'chat_stream' | 'chat_completion';
    readonly method: 'GET' | 'POST';
    readonly path: '/models' | '/chat/completions';
    readonly credentials: StructuredCredentialRecord;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly accept: 'application/json' | 'text/event-stream';
    readonly contentType?: 'application/json';
    readonly maxResponseBytes: number;
    readonly keepOpen?: boolean;
  }): Promise<DeepSeekHttpTransportResponse & {
    readonly cancel?: () => void;
    readonly close?: () => void;
  }> {
    if (this.disposed) {
      throw new DeepSeekRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    const credential = parseCredential(input.credentials);
    const url = resolvePath(this.baseUrl, input.path);
    const timeoutMs = this.options.defaultTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes < 1
    ) {
      throw new DeepSeekRuntimeError('invalid_request', 'not_retryable');
    }
    const controller = new AbortController();
    const removeExternalAbort = linkAbort(input.signal, controller);
    this.active.add(controller);
    let closed = false;
    let timedOut = false;
    let requestStarted = false;
    const startedAt = this.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      removeExternalAbort();
      this.active.delete(controller);
    };
    try {
      if (controller.signal.aborted) {
        throw new DeepSeekRuntimeError('cancelled', 'not_retryable');
      }
      await input.beforeRequestStarted?.();
      requestStarted = true;
      this.log({
        event: 'request_started',
        operation: input.operation,
        method: input.method
      });
      const headers: Record<string, string> = {
        accept: input.accept,
        authorization: `Bearer ${credential}`
      };
      if (input.contentType) headers['content-type'] = input.contentType;
      const response = await this.options.transport.send({
        method: input.method,
        url: url.toString(),
        headers,
        ...(input.body ? { body: Uint8Array.from(input.body) } : {}),
        signal: controller.signal,
        timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
        proxy: this.options.proxy?.() ?? { kind: 'system_default' },
        redirect: 'manual'
      });
      validateDeclaredResponseSize(response.headers, input.maxResponseBytes);
      if (response.status >= 300 && response.status < 400) {
        throw new DeepSeekRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(response.status, response.headers);
      }
      const headersResult = normalizeHeaders(response.headers);
      this.log({
        event: 'request_completed',
        operation: input.operation,
        method: input.method,
        status: response.status,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      if (response.body !== undefined) {
        if (response.body.byteLength > input.maxResponseBytes) {
          throw new DeepSeekRuntimeError('response_too_large', 'not_retryable');
        }
        close();
        return {
          status: response.status,
          headers: headersResult,
          body: Uint8Array.from(response.body)
        };
      }
      if (!input.keepOpen) {
        throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
      }
      const stream = boundStream(
        response.stream,
        input.maxResponseBytes,
        close,
        (error) => mapRuntimeFailure(
          error,
          controller.signal.aborted,
          timedOut,
          this.disposed
        )
      );
      return {
        status: response.status,
        headers: headersResult,
        stream,
        cancel: () => controller.abort(),
        close: () => {
          controller.abort();
          close();
        }
      };
    } catch (error) {
      close();
      if (!requestStarted && !(error instanceof DeepSeekRuntimeError)) {
        throw error;
      }
      const mapped = mapRuntimeFailure(
        error,
        controller.signal.aborted,
        timedOut,
        this.disposed
      );
      this.log({
        event: 'request_failed',
        operation: input.operation,
        method: input.method,
        errorCode: mapped.code,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      throw mapped;
    }
  }

  private log(event: DeepSeekSafeLogEvent): void {
    this.options.logger?.(Object.freeze({ ...event }));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

async function* boundStream(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  close: () => void,
  mapFailure: (error: unknown) => DeepSeekRuntimeError
): AsyncGenerator<Uint8Array> {
  let total = 0;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
      }
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new DeepSeekRuntimeError('response_too_large', 'not_retryable');
      }
      yield Uint8Array.from(chunk);
    }
  } catch (error) {
    if (error instanceof DeepSeekRuntimeError) throw error;
    throw mapFailure(error);
  } finally {
    close();
  }
}

function parseCredential(record: StructuredCredentialRecord): string {
  if (
    record.schemaId !== DEEPSEEK_CREDENTIAL_SCHEMA_ID ||
    record.schemaVersion !== 1 ||
    !isRecord(record.values) ||
    Object.keys(record.values).length !== 1 ||
    typeof record.values.api_key !== 'string' ||
    record.values.api_key.trim().length < 1 ||
    record.values.api_key.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(record.values.api_key)
  ) {
    throw new DeepSeekRuntimeError('credential_unavailable', 'not_retryable');
  }
  return record.values.api_key;
}

function validateOfficialConnection(connection: ProviderConnection, baseUrl: URL): void {
  if (
    connection.packageId !== DEEPSEEK_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== DEEPSEEK_PROVIDER_PACKAGE_VERSION ||
    connection.templateId !== DEEPSEEK_OFFICIAL_TEMPLATE_ID ||
    connection.state === 'disabled' ||
    connection.state === 'deleted'
  ) {
    throw new DeepSeekRuntimeError('protocol_mismatch', 'not_retryable');
  }
  if (!connection.endpoint) {
    throw new DeepSeekRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(connection.endpoint);
  } catch {
    throw new DeepSeekRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  if (
    endpoint.origin !== baseUrl.origin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new DeepSeekRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('DeepSeek base URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.deepseek.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('DeepSeek base URL must be the credential-free official HTTPS origin');
  }
  return new URL(url.origin);
}

function resolvePath(baseUrl: URL, path: '/models' | '/chat/completions'): URL {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !['/models', '/chat/completions'].includes(url.pathname)) {
    throw new DeepSeekRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
}

function requireContentType(
  headers: Readonly<Record<string, string>>,
  expected: 'application/json' | 'text/event-stream'
): void {
  const contentType = headerValue(headers, 'content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== expected) {
    throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
  }
}

function validateDeclaredResponseSize(
  headers: Readonly<Record<string, string>>,
  maximum: number
): void {
  const declared = headerValue(headers, 'content-length');
  if (declared === undefined) return;
  const bytes = Number(declared);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new DeepSeekRuntimeError('invalid_response', 'not_retryable');
  }
  if (bytes > maximum) {
    throw new DeepSeekRuntimeError('response_too_large', 'not_retryable');
  }
}

function mapHttpStatus(
  status: number,
  headers: Readonly<Record<string, string>>
): DeepSeekRuntimeError {
  if (status === 400) return new DeepSeekRuntimeError('invalid_request', 'not_retryable');
  if (status === 401) return new DeepSeekRuntimeError('authentication_failed', 'not_retryable');
  if (status === 402) return new DeepSeekRuntimeError('insufficient_balance', 'not_retryable');
  if (status === 422) return new DeepSeekRuntimeError('invalid_parameters', 'not_retryable');
  if (status === 429) {
    return new DeepSeekRuntimeError(
      'rate_limited',
      'retryable',
      parseRetryAfter(headers)
    );
  }
  if (status === 500 || status === 503) {
    return new DeepSeekRuntimeError('provider_unavailable', 'retryable');
  }
  return new DeepSeekRuntimeError('invalid_response', 'not_retryable');
}

function mapRuntimeFailure(
  error: unknown,
  aborted: boolean,
  timedOut: boolean,
  disposed: boolean
): DeepSeekRuntimeError {
  if (error instanceof DeepSeekRuntimeError) return error;
  if (disposed) return new DeepSeekRuntimeError('runtime_shutting_down', 'not_retryable');
  if (timedOut) return new DeepSeekRuntimeError('timeout', 'retryable');
  if (error instanceof DeepSeekTransportFailure) {
    if (error.kind === 'timeout') return new DeepSeekRuntimeError('timeout', 'retryable');
    if (error.kind === 'cancelled') return new DeepSeekRuntimeError('cancelled', 'not_retryable');
    if (error.kind === 'proxy_unavailable') {
      return new DeepSeekRuntimeError('proxy_unavailable', 'retryable');
    }
    if (error.kind === 'response_too_large') {
      return new DeepSeekRuntimeError('response_too_large', 'not_retryable');
    }
    return new DeepSeekRuntimeError('network_error', 'unknown');
  }
  if (aborted) return new DeepSeekRuntimeError('cancelled', 'not_retryable');
  return new DeepSeekRuntimeError('network_error', 'unknown');
}

function parseRetryAfter(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 60 * 60 * 1000);
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
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name
  )?.[1];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageForCode(code: DeepSeekRuntimeErrorCode): string {
  const messages: Record<DeepSeekRuntimeErrorCode, string> = {
    invalid_request: 'The DeepSeek request is invalid',
    protocol_mismatch: 'The DeepSeek protocol binding does not match the request',
    endpoint_not_allowed: 'The DeepSeek endpoint is not allowed',
    credential_unavailable: 'The DeepSeek credential is unavailable',
    authentication_failed: 'DeepSeek authentication failed',
    insufficient_balance: 'The DeepSeek account balance is insufficient',
    invalid_parameters: 'DeepSeek rejected the request parameters',
    rate_limited: 'DeepSeek rate limited the request',
    provider_unavailable: 'DeepSeek is temporarily unavailable',
    timeout: 'The DeepSeek request timed out',
    cancelled: 'The DeepSeek request was cancelled',
    response_too_large: 'The DeepSeek response exceeded the allowed size',
    redirect_not_allowed: 'The DeepSeek response redirected unexpectedly',
    invalid_response: 'The DeepSeek response was invalid',
    network_error: 'The DeepSeek network request failed',
    proxy_unavailable: 'The configured proxy could not be used',
    runtime_shutting_down: 'The DeepSeek runtime is shutting down'
  };
  return messages[code];
}
