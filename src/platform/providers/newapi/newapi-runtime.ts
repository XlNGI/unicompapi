import { isIP } from 'node:net';
import type {
  ProviderConnection,
  ProxyMode,
  StructuredCredentialRecord
} from '../../../domain';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID,
  NEWAPI_IMAGE_ADAPTER_ID,
  NEWAPI_IMAGE_PROTOCOL_ID,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_VIDEO_ADAPTER_ID,
  NEWAPI_VIDEO_PROTOCOL_ID
} from './newapi-contracts';
import {
  isOpenAiCompatibleCredentialSchemaId,
  matchOpenAiCompatiblePackage
} from './openai-compatible-identity';

export const newApiRuntimeErrorCodes = [
  'invalid_request',
  'protocol_mismatch',
  'endpoint_not_allowed',
  'credential_unavailable',
  'authentication_failed',
  'permission_denied',
  'insufficient_balance',
  'model_not_found',
  'operation_not_found',
  'invalid_parameters',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'cancelled',
  'request_too_large',
  'response_too_large',
  'redirect_not_allowed',
  'invalid_response',
  'network_error',
  'proxy_unavailable',
  'runtime_shutting_down'
] as const;
export type NewApiRuntimeErrorCode =
  (typeof newApiRuntimeErrorCodes)[number];

export class NewApiRuntimeError extends Error {
  constructor(
    readonly code: NewApiRuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'NewApiRuntimeError';
  }
}

export class NewApiTransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'request_too_large'
      | 'response_too_large'
  ) {
    super('NewAPI transport failed');
    this.name = 'NewApiTransportFailure';
  }
}

export interface NewApiHttpTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly proxy: ProxyMode;
  readonly redirect: 'manual';
  readonly endpointSecurity: {
    readonly allowedOrigin: string;
    readonly allowPrivateNetwork: false;
    readonly dnsRebindingProtection: 'required';
  };
}

export type NewApiHttpTransportResponse =
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

export interface NewApiHttpTransport {
  send(request: NewApiHttpTransportRequest): Promise<NewApiHttpTransportResponse>;
}

export interface NewApiSafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly operation?:
    | 'model_catalog'
    | 'chat_stream'
    | 'chat_completion'
    | 'image_submit'
    | 'video_submit'
    | 'video_query'
    | 'video_result';
  readonly method?: 'GET' | 'POST';
  readonly status?: number;
  readonly errorCode?: NewApiRuntimeErrorCode;
  readonly elapsedMs?: number;
}

export interface NewApiEventStreamSession {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly cancel: () => void;
  readonly close: () => void;
}

export interface NewApiSharedRuntimeOptions {
  readonly transport: NewApiHttpTransport;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly logger?: (event: NewApiSafeLogEvent) => void;
  readonly now?: () => number;
}

type RuntimeOperation = NonNullable<NewApiSafeLogEvent['operation']>;

export class NewApiSharedRuntime {
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: NewApiSharedRuntimeOptions) {}

  async requestModelCatalog(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const response = await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_CHAT_ADAPTER_ID,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      operation: 'model_catalog',
      method: 'GET',
      pathSegments: ['models'],
      signal: input.signal,
      accept: 'application/json',
      maximumRequestBytes: 1,
      maximumResponseBytes: 1024 * 1024,
      requireReadyConnection: false,
      expectedResponse: 'json',
      notFoundKind: 'model'
    });
    return requireBody(response);
  }

  async openChatStream(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<NewApiEventStreamSession> {
    const response = await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_CHAT_ADAPTER_ID,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      operation: 'chat_stream',
      method: 'POST',
      pathSegments: ['chat', 'completions'],
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      accept: 'text/event-stream',
      contentType: 'application/json',
      maximumRequestBytes: 2 * 1024 * 1024,
      maximumResponseBytes: 8 * 1024 * 1024,
      requireReadyConnection: true,
      expectedResponse: 'stream',
      notFoundKind: 'model'
    });
    if (!('stream' in response) || !response.stream) {
      response.close?.();
      throw new NewApiRuntimeError('invalid_response', 'not_retryable');
    }
    return {
      stream: response.stream,
      cancel: response.cancel!,
      close: response.close!
    };
  }

  async requestChatCompletion(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    return requireBody(await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_CHAT_ADAPTER_ID,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      operation: 'chat_completion',
      method: 'POST',
      pathSegments: ['chat', 'completions'],
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      accept: 'application/json',
      contentType: 'application/json',
      maximumRequestBytes: 2 * 1024 * 1024,
      maximumResponseBytes: 2 * 1024 * 1024,
      requireReadyConnection: true,
      expectedResponse: 'json',
      notFoundKind: 'model'
    }));
  }

  async requestImageGeneration(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly path?: 'generations' | 'edits';
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    return requireBody(await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_IMAGE_ADAPTER_ID,
      protocolId: NEWAPI_IMAGE_PROTOCOL_ID,
      operation: 'image_submit',
      method: 'POST',
      pathSegments: ['images', input.path ?? 'generations'],
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      accept: 'application/json',
      contentType: 'application/json',
      maximumRequestBytes: 2 * 1024 * 1024,
      maximumResponseBytes: 64 * 1024 * 1024,
      requireReadyConnection: true,
      expectedResponse: 'json',
      notFoundKind: 'model'
    }));
  }

  async requestVideoCreate(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    return requireBody(await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_VIDEO_ADAPTER_ID,
      protocolId: NEWAPI_VIDEO_PROTOCOL_ID,
      operation: 'video_submit',
      method: 'POST',
      pathSegments: ['videos'],
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      accept: 'application/json',
      contentType: requireVideoCreateContentType(input.contentType),
      maximumRequestBytes: 64 * 1024 * 1024,
      maximumResponseBytes: 2 * 1024 * 1024,
      requireReadyConnection: true,
      expectedResponse: 'json',
      notFoundKind: 'model'
    }));
  }

  async requestVideoQuery(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    return requireBody(await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_VIDEO_ADAPTER_ID,
      protocolId: NEWAPI_VIDEO_PROTOCOL_ID,
      operation: 'video_query',
      method: 'GET',
      pathSegments: ['videos', remoteId(input.providerOperationId)],
      signal: input.signal,
      accept: 'application/json',
      maximumRequestBytes: 1,
      maximumResponseBytes: 2 * 1024 * 1024,
      requireReadyConnection: true,
      expectedResponse: 'json',
      notFoundKind: 'operation'
    }));
  }

  async downloadVideoContent(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
    readonly maximumResponseBytes?: number;
  }): Promise<{ readonly body: Uint8Array; readonly contentType?: string }> {
    const response = await this.request({
      connection: input.connection,
      credentials: input.credentials,
      adapterId: NEWAPI_VIDEO_ADAPTER_ID,
      protocolId: NEWAPI_VIDEO_PROTOCOL_ID,
      operation: 'video_result',
      method: 'GET',
      pathSegments: ['videos', remoteId(input.providerOperationId), 'content'],
      signal: input.signal,
      accept: 'video/mp4',
      maximumRequestBytes: 1,
      maximumResponseBytes: input.maximumResponseBytes ?? 512 * 1024 * 1024,
      requireReadyConnection: true,
      expectedResponse: 'binary',
      notFoundKind: 'operation'
    });
    return {
      body: requireBody(response),
      contentType: normalizedContentType(response.headers)
    };
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
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly adapterId: string;
    readonly protocolId: string;
    readonly operation: RuntimeOperation;
    readonly method: 'GET' | 'POST';
    readonly pathSegments: readonly string[];
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly accept: string;
    readonly contentType?: string;
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly requireReadyConnection: boolean;
    readonly expectedResponse: 'json' | 'stream' | 'binary';
    readonly notFoundKind: 'model' | 'operation';
  }): Promise<NewApiHttpTransportResponse & {
    readonly cancel?: () => void;
    readonly close?: () => void;
  }> {
    if (this.disposed) {
      throw new NewApiRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    const baseUrl = validateConnection(
      input.connection,
      input.adapterId,
      input.protocolId,
      input.requireReadyConnection
    );
    const credential = parseCredential(input.credentials);
    const url = resolvePath(baseUrl, input.pathSegments);
    validateBounds(input.body, input.maximumRequestBytes, input.maximumResponseBytes);
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new NewApiRuntimeError('invalid_request', 'not_retryable');
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
        throw new NewApiRuntimeError('cancelled', 'not_retryable');
      }
      await input.beforeRequestStarted?.();
      requestStarted = true;
      this.log({ event: 'request_started', operation: input.operation, method: input.method });
      const response = await this.options.transport.send({
        method: input.method,
        url: url.toString(),
        headers: {
          accept: input.accept,
          authorization: `Bearer ${credential}`,
          ...(input.contentType ? { 'content-type': input.contentType } : {})
        },
        ...(input.body ? { body: Uint8Array.from(input.body) } : {}),
        signal: controller.signal,
        timeoutMs,
        maxRequestBytes: input.maximumRequestBytes,
        maxResponseBytes: input.maximumResponseBytes,
        proxy: this.options.proxy?.() ?? { kind: 'system_default' },
        redirect: 'manual',
        endpointSecurity: {
          allowedOrigin: baseUrl.origin,
          allowPrivateNetwork: false,
          dnsRebindingProtection: 'required'
        }
      });
      validateDeclaredResponseSize(response.headers, input.maximumResponseBytes);
      if (response.status >= 300 && response.status < 400) {
        throw new NewApiRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(
          response.status,
          response.headers,
          input.notFoundKind,
          response.body
        );
      }
      const headers = normalizeHeaders(response.headers);
      if (input.expectedResponse === 'stream') {
        requireContentType(headers, 'text/event-stream');
        if (!('stream' in response) || !response.stream) {
          throw new NewApiRuntimeError('invalid_response', 'not_retryable');
        }
        this.log({
          event: 'request_completed', operation: input.operation, method: input.method,
          status: response.status, elapsedMs: Math.max(0, this.now() - startedAt)
        });
        return {
          status: response.status,
          headers,
          stream: boundStream(
            response.stream,
            input.maximumResponseBytes,
            close,
            (error) => mapRuntimeFailure(error, controller.signal, timedOut, this.disposed)
          ),
          cancel: () => controller.abort(),
          close: () => {
            controller.abort();
            close();
          }
        };
      }
      if (response.body === undefined || response.body.byteLength > input.maximumResponseBytes) {
        throw new NewApiRuntimeError('invalid_response', 'not_retryable');
      }
      if (input.expectedResponse === 'json') requireContentType(headers, 'application/json');
      this.log({
        event: 'request_completed', operation: input.operation, method: input.method,
        status: response.status, elapsedMs: Math.max(0, this.now() - startedAt)
      });
      close();
      return { status: response.status, headers, body: Uint8Array.from(response.body) };
    } catch (error) {
      close();
      if (!requestStarted && !(error instanceof NewApiRuntimeError)) throw error;
      const mapped = mapRuntimeFailure(error, controller.signal, timedOut, this.disposed);
      this.log({
        event: 'request_failed', operation: input.operation, method: input.method,
        errorCode: mapped.code, elapsedMs: Math.max(0, this.now() - startedAt)
      });
      throw mapped;
    }
  }

  private log(event: NewApiSafeLogEvent): void {
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
  mapFailure: (error: unknown) => NewApiRuntimeError
): AsyncGenerator<Uint8Array> {
  let total = 0;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        throw new NewApiRuntimeError('invalid_response', 'not_retryable');
      }
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new NewApiRuntimeError('response_too_large', 'not_retryable');
      }
      yield Uint8Array.from(chunk);
    }
  } catch (error) {
    if (error instanceof NewApiRuntimeError) throw error;
    throw mapFailure(error);
  } finally {
    close();
  }
}

function parseCredential(record: StructuredCredentialRecord): string {
  if (
    !isOpenAiCompatibleCredentialSchemaId(record.schemaId) ||
    record.schemaVersion !== 1 ||
    !isRecord(record.values) ||
    Object.keys(record.values).length !== 1 ||
    typeof record.values.api_key !== 'string'
  ) {
    throw new NewApiRuntimeError('credential_unavailable', 'not_retryable');
  }
  const value = record.values.api_key.trim();
  if (value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NewApiRuntimeError('credential_unavailable', 'not_retryable');
  }
  return value;
}

function validateConnection(
  connection: ProviderConnection,
  adapterId: string,
  protocolId: string,
  requireReady: boolean
): URL {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === adapterId &&
      item.adapterVersion === NEWAPI_ADAPTER_VERSION &&
      item.protocolId === protocolId &&
      item.protocolVersion === NEWAPI_PROTOCOL_VERSION
  );
  const packageIdentity = matchOpenAiCompatiblePackage(connection);
  if (
    !packageIdentity ||
    connection.state === 'disabled' ||
    connection.state === 'deleted' ||
    connection.credentialState === 'deleted' ||
    (requireReady &&
      (connection.state !== 'available' || connection.credentialState !== 'valid')) ||
    !binding
  ) {
    throw new NewApiRuntimeError('protocol_mismatch', 'not_retryable');
  }
  return parseBaseUrl(connection.endpoint ?? '');
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NewApiRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  const classification = classifyHost(host);
  if (
    url.username || url.password || url.search || url.hash ||
    !['/v1', '/v1/'].includes(url.pathname) ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    (url.protocol === 'http:' && classification !== 'loopback') ||
    classification === 'private' || host.endsWith('.local') || host.length < 1
  ) {
    throw new NewApiRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  url.hostname = host;
  url.pathname = '/v1/';
  return url;
}

function resolvePath(baseUrl: URL, segments: readonly string[]): URL {
  if (segments.length < 1 || segments.some((segment) => !isPathSegment(segment))) {
    throw new NewApiRuntimeError('invalid_request', 'not_retryable');
  }
  const url = new URL(`${baseUrl.pathname}${segments.map(encodeURIComponent).join('/')}`, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/v1/')) {
    throw new NewApiRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
}

function remoteId(value: unknown): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new NewApiRuntimeError('invalid_request', 'not_retryable');
  }
  return value;
}

function isPathSegment(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\/\u0000-\u001f\u007f]/u.test(value);
}

function classifyHost(host: string): 'public' | 'private' | 'loopback' {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    if (octets[0] === 127) return 'loopback';
    if (
      octets[0] === 10 || octets[0] === 0 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    ) return 'private';
  }
  if (family === 6) {
    if (host === '::1') return 'loopback';
    if (
      host === '::' || host.startsWith('fc') || host.startsWith('fd') ||
      /^fe[89ab]/u.test(host)
    ) return 'private';
  }
  return 'public';
}

function validateBounds(
  body: Uint8Array | undefined,
  maximumRequestBytes: number,
  maximumResponseBytes: number
): void {
  if (
    !Number.isSafeInteger(maximumRequestBytes) || maximumRequestBytes < 1 ||
    !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 ||
    (body && (body.byteLength < 1 || body.byteLength > maximumRequestBytes))
  ) {
    throw new NewApiRuntimeError('request_too_large', 'not_retryable');
  }
}

function requireMultipartContentType(value: string): string {
  if (!/^multipart\/form-data; boundary=[A-Za-z0-9._-]{16,128}$/u.test(value)) {
    throw new NewApiRuntimeError('invalid_request', 'not_retryable');
  }
  return value;
}

function requireVideoCreateContentType(value: string): string {
  if (value === 'application/json') return value;
  return requireMultipartContentType(value);
}

function requireContentType(
  headers: Readonly<Record<string, string>>,
  expected: 'application/json' | 'text/event-stream'
): void {
  const actual = normalizedContentType(headers);
  if (actual === expected) return;
  // Some OpenAI-compatible video gateways omit Content-Type on JSON bodies.
  if (
    expected === 'application/json' &&
    (actual === undefined || actual === 'text/json' || actual.endsWith('+json'))
  ) {
    return;
  }
  throw new NewApiRuntimeError('invalid_response', 'not_retryable');
}

function normalizedContentType(
  headers: Readonly<Record<string, string>>
): string | undefined {
  return headerValue(headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
}

function validateDeclaredResponseSize(
  headers: Readonly<Record<string, string>>,
  maximum: number
): void {
  const value = headerValue(headers, 'content-length');
  if (value === undefined) return;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new NewApiRuntimeError('invalid_response', 'not_retryable');
  }
  if (bytes > maximum) {
    throw new NewApiRuntimeError('response_too_large', 'not_retryable');
  }
}

function mapHttpStatus(
  status: number,
  headers: Readonly<Record<string, string>>,
  notFoundKind: 'model' | 'operation',
  body?: Uint8Array
): NewApiRuntimeError {
  if (status === 401) return new NewApiRuntimeError('authentication_failed', 'not_retryable');
  if (status === 402) return new NewApiRuntimeError('insufficient_balance', 'not_retryable');
  if (status === 403) return new NewApiRuntimeError('permission_denied', 'not_retryable');
  if (status === 404 || status === 410) {
    return new NewApiRuntimeError(
      notFoundKind === 'operation' ? 'operation_not_found' : 'model_not_found',
      'not_retryable'
    );
  }
  if (status === 408 || status === 504) return new NewApiRuntimeError('timeout', 'retryable');
  if (status === 413) return new NewApiRuntimeError('request_too_large', 'not_retryable');
  if (status === 429) {
    return new NewApiRuntimeError('rate_limited', 'retryable', parseRetryAfter(headers));
  }
  if (status >= 500 && status <= 599) {
    // Some gateways wrap client parameter errors as HTTP 500 (e.g. invalid max_tokens).
    const fromBody = classifyOpenAiErrorBody(body);
    if (fromBody) return fromBody;
    return new NewApiRuntimeError('provider_unavailable', 'retryable');
  }
  if (status === 400 || status === 409 || status === 422) {
    const fromBody = classifyOpenAiErrorBody(body);
    if (fromBody) return fromBody;
    if (status === 409 || status === 422) {
      return new NewApiRuntimeError('invalid_parameters', 'not_retryable');
    }
    return new NewApiRuntimeError('invalid_request', 'not_retryable');
  }
  return new NewApiRuntimeError('invalid_response', 'not_retryable');
}

/** Classify OpenAI-style error envelopes by allowlisted code/type only — never echo free text. */
function classifyOpenAiErrorBody(body: Uint8Array | undefined): NewApiRuntimeError | undefined {
  if (!body || body.byteLength < 2 || body.byteLength > 64 * 1024) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  if (!isRecord(error)) return undefined;
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  const type = typeof error.type === 'string' ? error.type.toLowerCase() : '';
  const token = code || type;
  if (
    token === 'model_not_found' ||
    token === 'model_not_available' ||
    token.includes('model_not_found')
  ) {
    return new NewApiRuntimeError('model_not_found', 'not_retryable');
  }
  if (
    token === 'invalid_api_key' ||
    token === 'authentication_error' ||
    token === 'unauthorized'
  ) {
    return new NewApiRuntimeError('authentication_failed', 'not_retryable');
  }
  if (
    token === 'insufficient_quota' ||
    token === 'billing_not_active' ||
    token === 'insufficient_balance'
  ) {
    return new NewApiRuntimeError('insufficient_balance', 'not_retryable');
  }
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (
    message.includes('insufficient') ||
    message.includes('quota') ||
    message.includes('balance') ||
    message.includes('额度不足') ||
    message.includes('余额不足') ||
    message.includes('积分不足') ||
    message.includes('token重算')
  ) {
    return new NewApiRuntimeError('insufficient_balance', 'not_retryable');
  }
  if (
    message.includes('max_tokens') ||
    message.includes('max_completion_tokens') ||
    (token === 'invalid_request' && message.includes('invalid'))
  ) {
    return new NewApiRuntimeError('invalid_parameters', 'not_retryable');
  }
  if (token === 'rate_limit_exceeded' || token === 'rate_limit_error') {
    return new NewApiRuntimeError('rate_limited', 'retryable');
  }
  if (
    token === 'invalid_request_error' ||
    token === 'invalid_request' ||
    token === 'invalid_parameter' ||
    token === 'invalid_parameters'
  ) {
    return new NewApiRuntimeError(
      token.includes('parameter') ? 'invalid_parameters' : 'invalid_request',
      'not_retryable'
    );
  }
  return undefined;
}

function mapRuntimeFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean,
  disposed: boolean
): NewApiRuntimeError {
  if (error instanceof NewApiRuntimeError) return error;
  if (disposed) return new NewApiRuntimeError('runtime_shutting_down', 'not_retryable');
  if (timedOut) return new NewApiRuntimeError('timeout', 'retryable');
  if (signal.aborted) return new NewApiRuntimeError('cancelled', 'not_retryable');
  if (error instanceof NewApiTransportFailure) {
    if (error.kind === 'timeout') return new NewApiRuntimeError('timeout', 'retryable');
    if (error.kind === 'cancelled') return new NewApiRuntimeError('cancelled', 'not_retryable');
    if (error.kind === 'proxy_unavailable') return new NewApiRuntimeError('proxy_unavailable', 'retryable');
    if (error.kind === 'request_too_large') return new NewApiRuntimeError('request_too_large', 'not_retryable');
    if (error.kind === 'response_too_large') return new NewApiRuntimeError('response_too_large', 'not_retryable');
  }
  return new NewApiRuntimeError('network_error', 'unknown');
}

function parseRetryAfter(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? Math.min(seconds * 1000, 3_600_000) : undefined;
}

function requireBody(
  response: NewApiHttpTransportResponse
): Uint8Array {
  if (response.body === undefined) {
    throw new NewApiRuntimeError('invalid_response', 'not_retryable');
  }
  return Uint8Array.from(response.body);
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
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
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

function messageForCode(code: NewApiRuntimeErrorCode): string {
  const messages: Record<NewApiRuntimeErrorCode, string> = {
    invalid_request: 'The NewAPI request is invalid',
    protocol_mismatch: 'The NewAPI protocol binding does not match the request',
    endpoint_not_allowed: 'The NewAPI endpoint is not allowed',
    credential_unavailable: 'The NewAPI credential is unavailable',
    authentication_failed: 'NewAPI authentication failed',
    permission_denied: 'NewAPI denied the request',
    insufficient_balance: 'The NewAPI account balance is insufficient',
    model_not_found: 'The NewAPI model was not found',
    operation_not_found: 'The NewAPI operation was not found',
    invalid_parameters: 'NewAPI rejected the request parameters',
    rate_limited: 'NewAPI rate limited the request',
    provider_unavailable: 'NewAPI is temporarily unavailable',
    timeout: 'The NewAPI request timed out',
    cancelled: 'The NewAPI request was cancelled',
    request_too_large: 'The NewAPI request exceeded the allowed size',
    response_too_large: 'The NewAPI response exceeded the allowed size',
    redirect_not_allowed: 'The NewAPI response redirected unexpectedly',
    invalid_response: 'The NewAPI response was invalid',
    network_error: 'The NewAPI network request failed',
    proxy_unavailable: 'The configured proxy could not be used',
    runtime_shutting_down: 'The NewAPI runtime is shutting down'
  };
  return messages[code];
}
