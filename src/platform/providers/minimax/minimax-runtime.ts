import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  ProviderConnection,
  ProxyMode,
  StructuredCredentialRecord
} from '../../../domain';
import {
  hostForMiniMaxH3EndpointPolicy,
  isMiniMaxH3EndpointPolicy,
  isMiniMaxH3OfficialTemplate,
  MINIMAX_H3_ALLOWED_HOSTS,
  MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
  MINIMAX_H3_VIDEO_ADAPTER_ID,
  MINIMAX_H3_VIDEO_ADAPTER_VERSION,
  MINIMAX_H3_VIDEO_PROTOCOL_ID,
  MINIMAX_H3_VIDEO_PROTOCOL_VERSION
} from './minimax-contracts';

export const minimaxRuntimeErrorCodes = [
  'invalid_request',
  'protocol_mismatch',
  'endpoint_not_allowed',
  'credential_unavailable',
  'authentication_failed',
  'permission_denied',
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
export type MiniMaxRuntimeErrorCode = (typeof minimaxRuntimeErrorCodes)[number];

export class MiniMaxRuntimeError extends Error {
  constructor(
    readonly code: MiniMaxRuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'MiniMaxRuntimeError';
  }
}

export class MiniMaxTransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'request_too_large'
      | 'response_too_large'
  ) {
    super('MiniMax transport failed');
    this.name = 'MiniMaxTransportFailure';
  }
}

export interface MiniMaxHttpTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly proxy: ProxyMode;
  readonly redirect: 'manual';
}

export interface MiniMaxHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface MiniMaxHttpTransport {
  send(request: MiniMaxHttpTransportRequest): Promise<MiniMaxHttpTransportResponse>;
}

export interface MiniMaxSafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly operation?:
    | 'credential_probe'
    | 'video_upload'
    | 'video_submit'
    | 'video_query'
    | 'video_result';
  readonly method?: 'GET' | 'POST';
  readonly status?: number;
  readonly errorCode?: MiniMaxRuntimeErrorCode;
  readonly elapsedMs?: number;
}

export interface MiniMaxSharedRuntimeOptions {
  readonly transport: MiniMaxHttpTransport;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly logger?: (event: MiniMaxSafeLogEvent) => void;
  readonly now?: () => number;
}

export class MiniMaxSharedRuntime {
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: MiniMaxSharedRuntimeOptions) {}

  async requestCredentialProbe(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly signal?: AbortSignal;
  }): Promise<MiniMaxHttpTransportResponse> {
    if (this.disposed) {
      throw new MiniMaxRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    const origin = validateManagementConnection(input.connection);
    const credential = parseCredential(input.credentials);
    validateBounds(undefined, 1, 256 * 1024);
    const url = new URL('/v1/files/retrieve', origin);
    url.searchParams.set('file_id', '0');
    return this.send({
      operation: 'credential_probe',
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.apiKey}`
      },
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 256 * 1024,
      requireJson: false,
      notFoundKind: 'operation',
      acceptClientError: true
    });
  }

  async requestFileUpload(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const origin = validateOfficialConnection(input.connection);
    const encoded = encodeMultipartForm([
      {
        name: 'purpose',
        value: new TextEncoder().encode('video_generation_input')
      },
      {
        name: 'file',
        filename: input.filename,
        contentType: input.mimeType,
        value: input.bytes
      }
    ]);
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_upload',
      method: 'POST',
      url: new URL('/v1/files/upload', origin),
      headers: { 'content-type': encoded.contentType },
      body: encoded.body,
      signal: input.signal,
      maximumRequestBytes: 32 * 1024 * 1024,
      maximumResponseBytes: 2 * 1024 * 1024,
      notFoundKind: 'model'
    });
    return Uint8Array.from(response.body);
  }

  async requestVideoCreate(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const origin = validateOfficialConnection(input.connection);
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_submit',
      method: 'POST',
      url: new URL('/v2/video_generation', origin),
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: 2 * 1024 * 1024,
      maximumResponseBytes: 2 * 1024 * 1024,
      notFoundKind: 'model'
    });
    return Uint8Array.from(response.body);
  }

  async requestVideoQuery(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const origin = validateOfficialConnection(input.connection);
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_query',
      method: 'GET',
      url: queryTaskUrl(origin, input.providerOperationId),
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 4 * 1024 * 1024,
      notFoundKind: 'operation'
    });
    return Uint8Array.from(response.body);
  }

  async downloadVideoResult(input: {
    readonly url: string;
    readonly signal?: AbortSignal;
    readonly maximumResponseBytes?: number;
  }): Promise<{ readonly body: Uint8Array; readonly contentType?: string }> {
    const response = await this.requestWithoutCredential({
      url: parseResultUrl(input.url),
      signal: input.signal,
      maximumResponseBytes: input.maximumResponseBytes ?? 512 * 1024 * 1024
    });
    return {
      body: Uint8Array.from(response.body),
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

  private async requestOfficialApi(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly operation: 'video_upload' | 'video_submit' | 'video_query';
    readonly method: 'GET' | 'POST';
    readonly url: URL;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly notFoundKind: 'model' | 'operation';
  }): Promise<MiniMaxHttpTransportResponse> {
    if (this.disposed) {
      throw new MiniMaxRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    validateOfficialConnection(input.connection);
    const credential = parseCredential(input.credentials);
    validateBounds(input.body, input.maximumRequestBytes, input.maximumResponseBytes);
    return this.send({
      operation: input.operation,
      method: input.method,
      url: input.url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.apiKey}`,
        ...(input.body
          ? { 'content-type': input.headers?.['content-type'] ?? 'application/json' }
          : {}),
        ...omitContentType(input.headers)
      },
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: input.maximumRequestBytes,
      maximumResponseBytes: input.maximumResponseBytes,
      requireJson: true,
      notFoundKind: input.notFoundKind
    });
  }

  private async requestWithoutCredential(input: {
    readonly url: URL;
    readonly signal?: AbortSignal;
    readonly maximumResponseBytes: number;
  }): Promise<MiniMaxHttpTransportResponse> {
    if (this.disposed) {
      throw new MiniMaxRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    validateBounds(undefined, 1, input.maximumResponseBytes);
    return this.send({
      operation: 'video_result',
      method: 'GET',
      url: input.url,
      headers: { accept: 'video/*' },
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: input.maximumResponseBytes,
      requireJson: false,
      notFoundKind: 'operation'
    });
  }

  private async send(input: {
    readonly operation: NonNullable<MiniMaxSafeLogEvent['operation']>;
    readonly method: 'GET' | 'POST';
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly requireJson: boolean;
    readonly notFoundKind: 'model' | 'operation';
    readonly acceptClientError?: boolean;
  }): Promise<MiniMaxHttpTransportResponse> {
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new MiniMaxRuntimeError('invalid_request', 'not_retryable');
    }
    const controller = new AbortController();
    const removeExternalAbort = linkAbort(input.signal, controller);
    this.active.add(controller);
    let timedOut = false;
    const startedAt = this.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      if (controller.signal.aborted) {
        throw new MiniMaxRuntimeError('cancelled', 'not_retryable');
      }
      await input.beforeRequestStarted?.();
      this.log({
        event: 'request_started',
        operation: input.operation,
        method: input.method
      });
      const response = await this.options.transport.send({
        method: input.method,
        url: input.url.toString(),
        headers: { ...input.headers },
        body: input.body ? Uint8Array.from(input.body) : new Uint8Array(),
        signal: controller.signal,
        timeoutMs,
        maxRequestBytes: input.maximumRequestBytes,
        maxResponseBytes: input.maximumResponseBytes,
        proxy: this.options.proxy?.() ?? { kind: 'system_default' },
        redirect: 'manual'
      });
      validateDeclaredResponseSize(response.headers, input.maximumResponseBytes);
      if (response.status >= 300 && response.status < 400) {
        throw new MiniMaxRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status < 200 || response.status >= 300) {
        if (!(input.acceptClientError && response.status >= 400 && response.status < 500)) {
          throw mapHttpStatus(
            response.status,
            response.headers,
            input.notFoundKind
          );
        }
      }
      if (response.body.byteLength > input.maximumResponseBytes) {
        throw new MiniMaxRuntimeError('response_too_large', 'not_retryable');
      }
      if (input.requireJson) requireJsonContentType(response.headers);
      this.log({
        event: 'request_completed',
        operation: input.operation,
        method: input.method,
        status: response.status,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      return {
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: Uint8Array.from(response.body)
      };
    } catch (error) {
      const mapped = mapRuntimeFailure(error, controller.signal, timedOut);
      this.log({
        event: 'request_failed',
        operation: input.operation,
        method: input.method,
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

  private log(event: MiniMaxSafeLogEvent): void {
    this.options.logger?.({ ...event });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export interface MiniMaxApiKeyCredential {
  readonly apiKey: string;
}

function parseCredential(record: StructuredCredentialRecord): MiniMaxApiKeyCredential {
  if (
    record.schemaId !== MINIMAX_H3_CREDENTIAL_SCHEMA_ID ||
    record.schemaVersion !== 1 ||
    !isRecord(record.values) ||
    Object.keys(record.values).length !== 1 ||
    typeof record.values.api_key !== 'string'
  ) {
    throw new MiniMaxRuntimeError('credential_unavailable', 'not_retryable');
  }
  const apiKey = record.values.api_key.trim();
  if (
    apiKey.length < 1 ||
    apiKey.length > 4_096 ||
    /[\r\n]/u.test(apiKey)
  ) {
    throw new MiniMaxRuntimeError('credential_unavailable', 'not_retryable');
  }
  return { apiKey };
}

function validateOfficialConnection(connection: ProviderConnection): URL {
  validateSharedConnection(connection);
  if (connection.state !== 'available' || connection.credentialState !== 'valid') {
    throw new MiniMaxRuntimeError('protocol_mismatch', 'not_retryable');
  }
  return parseConnectionOrigin(connection);
}

function validateManagementConnection(connection: ProviderConnection): URL {
  validateSharedConnection(connection);
  if (connection.state === 'disabled' || connection.state === 'deleted') {
    throw new MiniMaxRuntimeError('protocol_mismatch', 'not_retryable');
  }
  if (!connection.endpoint) {
    throw new MiniMaxRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return parseConnectionOrigin(connection);
}

function validateSharedConnection(connection: ProviderConnection): void {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === MINIMAX_H3_VIDEO_ADAPTER_ID &&
      item.adapterVersion === MINIMAX_H3_VIDEO_ADAPTER_VERSION &&
      item.protocolId === MINIMAX_H3_VIDEO_PROTOCOL_ID &&
      item.protocolVersion === MINIMAX_H3_VIDEO_PROTOCOL_VERSION
  );
  if (
    connection.packageId !== MINIMAX_H3_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== MINIMAX_H3_PROVIDER_PACKAGE_VERSION ||
    !isMiniMaxH3OfficialTemplate(connection.templateId ?? '') ||
    connection.credentialSchemaId !== MINIMAX_H3_CREDENTIAL_SCHEMA_ID ||
    connection.credentialSchemaVersion !== 1 ||
    !isMiniMaxH3EndpointPolicy(connection.endpointPolicyId ?? '') ||
    connection.endpointPolicyRevision !== 1 ||
    hostForMiniMaxH3EndpointPolicy(connection.endpointPolicyId ?? '') !==
      hostForTemplate(connection.templateId ?? '') ||
    !binding
  ) {
    throw new MiniMaxRuntimeError('protocol_mismatch', 'not_retryable');
  }
}

function hostForTemplate(templateId: string): string | undefined {
  if (templateId === 'minimax-h3-official-cn') return 'api.minimaxi.com';
  if (templateId === 'minimax-h3-official-global') return 'api.minimax.io';
  return undefined;
}

function parseConnectionOrigin(connection: ProviderConnection): URL {
  const origin = parseAllowedOrigin(connection.endpoint ?? '');
  const expectedHost = hostForMiniMaxH3EndpointPolicy(connection.endpointPolicyId ?? '');
  if (!expectedHost || origin.hostname !== expectedHost) {
    throw new MiniMaxRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return origin;
}

function parseAllowedOrigin(value: string): URL {
  let result: URL;
  try {
    result = new URL(value);
  } catch {
    throw new MiniMaxRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  const hostname = result.hostname.toLowerCase();
  if (
    result.protocol !== 'https:' ||
    !(MINIMAX_H3_ALLOWED_HOSTS as readonly string[]).includes(hostname) ||
    (result.port && result.port !== '443') ||
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    !['', '/'].includes(result.pathname)
  ) {
    throw new MiniMaxRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  result.pathname = '/';
  return result;
}

function queryTaskUrl(origin: URL, providerOperationId: string): URL {
  if (
    providerOperationId.length < 1 ||
    providerOperationId.length > 512 ||
    !/^[A-Za-z0-9._-]+$/u.test(providerOperationId)
  ) {
    throw new MiniMaxRuntimeError('invalid_request', 'not_retryable');
  }
  return new URL(
    `/v2/query/video_generation/${encodeURIComponent(providerOperationId)}`,
    origin
  );
}

function parseResultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MiniMaxRuntimeError('invalid_response', 'not_retryable');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    !hostname.includes('.')
  ) {
    throw new MiniMaxRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
}

function encodeMultipartForm(
  parts: readonly {
    readonly name: string;
    readonly filename?: string;
    readonly contentType?: string;
    readonly value: Uint8Array;
  }[]
): { readonly body: Uint8Array; readonly contentType: string } {
  const boundary = `MiniMaxBoundary${randomBytes(16).toString('hex')}`;
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/u.test(part.name)) {
      throw new MiniMaxRuntimeError('invalid_request', 'not_retryable');
    }
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      if (!/^[A-Za-z0-9._-]+$/u.test(part.filename)) {
        throw new MiniMaxRuntimeError('invalid_request', 'not_retryable');
      }
      header += `; filename="${part.filename}"`;
      header += `\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}`;
    }
    header += '\r\n\r\n';
    chunks.push(encoder.encode(header), part.value, encoder.encode('\r\n'));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function omitContentType(
  headers: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-type')
  );
}

function validateBounds(
  body: Uint8Array | undefined,
  maximumRequestBytes: number,
  maximumResponseBytes: number
): void {
  if (
    !Number.isSafeInteger(maximumRequestBytes) ||
    maximumRequestBytes < 1 ||
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    (body && (body.byteLength < 1 || body.byteLength > maximumRequestBytes))
  ) {
    throw new MiniMaxRuntimeError('request_too_large', 'not_retryable');
  }
}

function requireJsonContentType(headers: Readonly<Record<string, string>>): void {
  const contentType = headerValue(headers, 'content-type')?.toLowerCase();
  if (!contentType?.startsWith('application/json')) {
    throw new MiniMaxRuntimeError('invalid_response', 'not_retryable');
  }
}

function validateDeclaredResponseSize(
  headers: Readonly<Record<string, string>>,
  maximumBytes: number
): void {
  const declared = headerValue(headers, 'content-length');
  if (!declared) return;
  const parsed = Number(declared);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MiniMaxRuntimeError('invalid_response', 'not_retryable');
  }
  if (parsed > maximumBytes) {
    throw new MiniMaxRuntimeError('response_too_large', 'not_retryable');
  }
}

function mapHttpStatus(
  status: number,
  headers: Readonly<Record<string, string>>,
  notFoundKind: 'model' | 'operation'
): MiniMaxRuntimeError {
  switch (status) {
    case 400:
      return new MiniMaxRuntimeError('invalid_request', 'not_retryable');
    case 401:
      return new MiniMaxRuntimeError('authentication_failed', 'not_retryable');
    case 403:
      return new MiniMaxRuntimeError('permission_denied', 'not_retryable');
    case 404:
    case 410:
      return new MiniMaxRuntimeError(
        notFoundKind === 'operation' ? 'operation_not_found' : 'model_not_found',
        'not_retryable'
      );
    case 408:
    case 504:
      return new MiniMaxRuntimeError('timeout', 'retryable');
    case 409:
    case 422:
      return new MiniMaxRuntimeError('invalid_parameters', 'not_retryable');
    case 413:
      return new MiniMaxRuntimeError('request_too_large', 'not_retryable');
    case 429:
      return new MiniMaxRuntimeError(
        'rate_limited',
        'retryable',
        parseRetryAfter(headers)
      );
    case 500:
    case 502:
    case 503:
      return new MiniMaxRuntimeError('provider_unavailable', 'retryable');
    default:
      return new MiniMaxRuntimeError('provider_unavailable', 'unknown');
  }
}

function mapRuntimeFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean
): MiniMaxRuntimeError {
  if (error instanceof MiniMaxRuntimeError) return error;
  if (timedOut) return new MiniMaxRuntimeError('timeout', 'retryable');
  if (signal.aborted) return new MiniMaxRuntimeError('cancelled', 'not_retryable');
  if (error instanceof MiniMaxTransportFailure) {
    switch (error.kind) {
      case 'timeout':
        return new MiniMaxRuntimeError('timeout', 'retryable');
      case 'cancelled':
        return new MiniMaxRuntimeError('cancelled', 'not_retryable');
      case 'proxy_unavailable':
        return new MiniMaxRuntimeError('proxy_unavailable', 'retryable');
      case 'request_too_large':
        return new MiniMaxRuntimeError('request_too_large', 'not_retryable');
      case 'response_too_large':
        return new MiniMaxRuntimeError('response_too_large', 'not_retryable');
      case 'network':
        return new MiniMaxRuntimeError('network_error', 'retryable');
    }
  }
  return new MiniMaxRuntimeError('network_error', 'unknown');
}

function parseRetryAfter(
  headers: Readonly<Record<string, string>>
): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function normalizedContentType(
  headers: Readonly<Record<string, string>>
): string | undefined {
  const value = headerValue(headers, 'content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return value || undefined;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === target
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

function messageForCode(code: MiniMaxRuntimeErrorCode): string {
  const messages: Record<MiniMaxRuntimeErrorCode, string> = {
    invalid_request: 'The MiniMax request is invalid',
    protocol_mismatch: 'The MiniMax protocol binding is invalid',
    endpoint_not_allowed: 'The MiniMax endpoint is not allowed',
    credential_unavailable: 'The MiniMax credential is unavailable',
    authentication_failed: 'MiniMax authentication failed',
    permission_denied: 'MiniMax denied the request',
    model_not_found: 'The configured MiniMax model endpoint was not found',
    operation_not_found: 'The MiniMax operation was not found',
    invalid_parameters: 'MiniMax rejected the request parameters',
    rate_limited: 'MiniMax rate limited the request',
    provider_unavailable: 'MiniMax is unavailable',
    timeout: 'The MiniMax request timed out',
    cancelled: 'The MiniMax request was cancelled locally',
    request_too_large: 'The MiniMax request is too large',
    response_too_large: 'The MiniMax response is too large',
    redirect_not_allowed: 'MiniMax redirects are not allowed',
    invalid_response: 'The MiniMax response is invalid',
    network_error: 'The MiniMax network request failed',
    proxy_unavailable: 'The configured proxy is unavailable',
    runtime_shutting_down: 'The MiniMax runtime is shutting down'
  };
  return messages[code];
}
