import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  ProviderConnection,
  ProxyMode,
  StructuredCredentialRecord
} from '../../../domain';
import {
  KLING_CREDENTIAL_SCHEMA_ID,
  KLING_ENDPOINT_POLICY_ID,
  KLING_OFFICIAL_BASE_URL,
  KLING_OFFICIAL_TEMPLATE_ID,
  KLING_PROVIDER_PACKAGE_ID,
  KLING_PROVIDER_PACKAGE_VERSION,
  KLING_VIDEO_ADAPTER_ID,
  KLING_VIDEO_ADAPTER_VERSION,
  KLING_VIDEO_PROTOCOL_ID,
  KLING_VIDEO_PROTOCOL_VERSION
} from './kling-contracts';

export const klingRuntimeErrorCodes = [
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
export type KlingRuntimeErrorCode = (typeof klingRuntimeErrorCodes)[number];

export class KlingRuntimeError extends Error {
  constructor(
    readonly code: KlingRuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'KlingRuntimeError';
  }
}

export class KlingTransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'request_too_large'
      | 'response_too_large'
  ) {
    super('Kling transport failed');
    this.name = 'KlingTransportFailure';
  }
}

export interface KlingHttpTransportRequest {
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

export interface KlingHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface KlingHttpTransport {
  send(request: KlingHttpTransportRequest): Promise<KlingHttpTransportResponse>;
}

export interface KlingSafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly operation?: 'video_submit' | 'video_query' | 'video_result' | 'account_costs';
  readonly method?: 'GET' | 'POST';
  readonly status?: number;
  readonly errorCode?: KlingRuntimeErrorCode;
  readonly elapsedMs?: number;
}

export interface KlingSharedRuntimeOptions {
  readonly transport: KlingHttpTransport;
  readonly baseUrl?: string;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly logger?: (event: KlingSafeLogEvent) => void;
  readonly now?: () => number;
}

export class KlingSharedRuntime {
  private readonly baseUrl: URL;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: KlingSharedRuntimeOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl ?? KLING_OFFICIAL_BASE_URL);
  }

  async requestVideoTaskCreate(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly feature: 'text_to_video' | 'image_to_video';
    readonly providerModelKey: string;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_submit',
      method: 'POST',
      url: createTaskUrl(
        this.baseUrl,
        input.feature,
        input.providerModelKey
      ),
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: 64 * 1024 * 1024,
      maximumResponseBytes: 2 * 1024 * 1024,
      notFoundKind: 'model'
    });
    return Uint8Array.from(response.body);
  }

  async requestVideoTaskQuery(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_query',
      method: 'GET',
      url: queryTaskUrl(this.baseUrl, input.providerOperationId),
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 4 * 1024 * 1024,
      notFoundKind: 'operation'
    });
    return Uint8Array.from(response.body);
  }

  async requestAccountCosts(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    if (this.disposed) {
      throw new KlingRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    validateManagementConnection(input.connection, this.baseUrl);
    const credential = parseCredential(input.credentials);
    validateBounds(undefined, 1, 256 * 1024);
    const endMs = this.now();
    const startMs = Math.max(0, endMs - 24 * 60 * 60 * 1_000);
    const url = new URL('/v1/account/costs', this.baseUrl.origin);
    url.searchParams.set('start_time', String(startMs));
    url.searchParams.set('end_time', String(endMs));
    const response = await this.send({
      operation: 'account_costs',
      method: 'GET',
      url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${mintKlingApiToken(credential, endMs)}`
      },
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 256 * 1024,
      requireJson: true,
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
    readonly operation: 'video_submit' | 'video_query';
    readonly method: 'GET' | 'POST';
    readonly url: URL;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly notFoundKind: 'model' | 'operation';
  }): Promise<KlingHttpTransportResponse> {
    if (this.disposed) {
      throw new KlingRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    validateOfficialConnection(input.connection, this.baseUrl);
    const credential = parseCredential(input.credentials);
    validateBounds(input.body, input.maximumRequestBytes, input.maximumResponseBytes);
    return this.send({
      operation: input.operation,
      method: input.method,
      url: input.url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${mintKlingApiToken(credential, this.now())}`,
        ...(input.body ? { 'content-type': 'application/json' } : {})
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
  }): Promise<KlingHttpTransportResponse> {
    if (this.disposed) {
      throw new KlingRuntimeError('runtime_shutting_down', 'not_retryable');
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
    readonly operation: NonNullable<KlingSafeLogEvent['operation']>;
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
  }): Promise<KlingHttpTransportResponse> {
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new KlingRuntimeError('invalid_request', 'not_retryable');
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
        throw new KlingRuntimeError('cancelled', 'not_retryable');
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
        throw new KlingRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(
          response.status,
          response.headers,
          input.notFoundKind
        );
      }
      if (response.body.byteLength > input.maximumResponseBytes) {
        throw new KlingRuntimeError('response_too_large', 'not_retryable');
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

  private log(event: KlingSafeLogEvent): void {
    this.options.logger?.({ ...event });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export interface KlingCredentialPair {
  readonly accessKey: string;
  readonly secretKey: string;
}

function parseCredential(record: StructuredCredentialRecord): KlingCredentialPair {
  if (
    record.schemaId !== KLING_CREDENTIAL_SCHEMA_ID ||
    record.schemaVersion !== 1 ||
    !isRecord(record.values) ||
    Object.keys(record.values).length !== 2 ||
    typeof record.values.access_key !== 'string' ||
    typeof record.values.secret_key !== 'string'
  ) {
    throw new KlingRuntimeError('credential_unavailable', 'not_retryable');
  }
  const accessKey = record.values.access_key.trim();
  const secretKey = record.values.secret_key.trim();
  if (
    accessKey.length < 1 ||
    accessKey.length > 1_024 ||
    secretKey.length < 1 ||
    secretKey.length > 4_096 ||
    /[\r\n]/u.test(accessKey) ||
    /[\r\n]/u.test(secretKey)
  ) {
    throw new KlingRuntimeError('credential_unavailable', 'not_retryable');
  }
  return { accessKey, secretKey };
}

export function mintKlingApiToken(
  credential: KlingCredentialPair,
  nowMs: number
): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new KlingRuntimeError('invalid_request', 'not_retryable');
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: credential.accessKey,
    exp: nowSeconds + 1_800,
    nbf: nowSeconds - 5
  });
  const signature = createHmac('sha256', credential.secretKey)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function validateOfficialConnection(
  connection: ProviderConnection,
  baseUrl: URL
): void {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === KLING_VIDEO_ADAPTER_ID &&
      item.adapterVersion === KLING_VIDEO_ADAPTER_VERSION &&
      item.protocolId === KLING_VIDEO_PROTOCOL_ID &&
      item.protocolVersion === KLING_VIDEO_PROTOCOL_VERSION
  );
  if (
    connection.packageId !== KLING_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== KLING_PROVIDER_PACKAGE_VERSION ||
    connection.templateId !== KLING_OFFICIAL_TEMPLATE_ID ||
    connection.credentialSchemaId !== KLING_CREDENTIAL_SCHEMA_ID ||
    connection.credentialSchemaVersion !== 1 ||
    connection.endpointPolicyId !== KLING_ENDPOINT_POLICY_ID ||
    connection.endpointPolicyRevision !== 1 ||
    connection.state !== 'available' ||
    connection.credentialState !== 'valid' ||
    !binding
  ) {
    throw new KlingRuntimeError('protocol_mismatch', 'not_retryable');
  }
  const endpoint = parseBaseUrl(connection.endpoint ?? '');
  if (endpoint.origin !== baseUrl.origin || endpoint.pathname !== baseUrl.pathname) {
    throw new KlingRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
}

function validateManagementConnection(
  connection: ProviderConnection,
  baseUrl: URL
): void {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === KLING_VIDEO_ADAPTER_ID &&
      item.adapterVersion === KLING_VIDEO_ADAPTER_VERSION &&
      item.protocolId === KLING_VIDEO_PROTOCOL_ID &&
      item.protocolVersion === KLING_VIDEO_PROTOCOL_VERSION
  );
  if (
    connection.packageId !== KLING_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== KLING_PROVIDER_PACKAGE_VERSION ||
    connection.templateId !== KLING_OFFICIAL_TEMPLATE_ID ||
    connection.credentialSchemaId !== KLING_CREDENTIAL_SCHEMA_ID ||
    connection.credentialSchemaVersion !== 1 ||
    connection.endpointPolicyId !== KLING_ENDPOINT_POLICY_ID ||
    connection.endpointPolicyRevision !== 1 ||
    connection.state === 'disabled' ||
    connection.state === 'deleted' ||
    !binding
  ) {
    throw new KlingRuntimeError('protocol_mismatch', 'not_retryable');
  }
  if (!connection.endpoint) {
    throw new KlingRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  const endpoint = parseBaseUrl(connection.endpoint);
  if (endpoint.origin !== baseUrl.origin) {
    throw new KlingRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
}

function parseBaseUrl(value: string): URL {
  let result: URL;
  try {
    result = new URL(value);
  } catch {
    throw new KlingRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  if (
    result.protocol !== 'https:' ||
    result.hostname !== 'api-beijing.klingai.com' ||
    (result.port && result.port !== '443') ||
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    !['', '/'].includes(result.pathname)
  ) {
    throw new KlingRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  result.pathname = '/';
  return result;
}

function createTaskUrl(
  baseUrl: URL,
  feature: 'text_to_video' | 'image_to_video',
  providerModelKey: string
): URL {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(providerModelKey)) {
    throw new KlingRuntimeError('invalid_request', 'not_retryable');
  }
  const featurePath = feature === 'text_to_video'
    ? 'text-to-video'
    : 'image-to-video';
  return new URL(`/${featurePath}/${providerModelKey}`, baseUrl.origin);
}

function queryTaskUrl(baseUrl: URL, providerOperationId: string): URL {
  if (
    providerOperationId.length < 1 ||
    providerOperationId.length > 512 ||
    !/^[A-Za-z0-9._-]+$/u.test(providerOperationId)
  ) {
    throw new KlingRuntimeError('invalid_request', 'not_retryable');
  }
  const url = new URL('/tasks', baseUrl.origin);
  url.searchParams.set('task_ids', providerOperationId);
  return url;
}

function parseResultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KlingRuntimeError('invalid_response', 'not_retryable');
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
    throw new KlingRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
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
    throw new KlingRuntimeError('request_too_large', 'not_retryable');
  }
}

function requireJsonContentType(headers: Readonly<Record<string, string>>): void {
  const contentType = headerValue(headers, 'content-type')?.toLowerCase();
  if (!contentType?.startsWith('application/json')) {
    throw new KlingRuntimeError('invalid_response', 'not_retryable');
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
    throw new KlingRuntimeError('invalid_response', 'not_retryable');
  }
  if (parsed > maximumBytes) {
    throw new KlingRuntimeError('response_too_large', 'not_retryable');
  }
}

function mapHttpStatus(
  status: number,
  headers: Readonly<Record<string, string>>,
  notFoundKind: 'model' | 'operation'
): KlingRuntimeError {
  switch (status) {
    case 400:
      return new KlingRuntimeError('invalid_request', 'not_retryable');
    case 401:
      return new KlingRuntimeError('authentication_failed', 'not_retryable');
    case 403:
      return new KlingRuntimeError('permission_denied', 'not_retryable');
    case 404:
    case 410:
      return new KlingRuntimeError(
        notFoundKind === 'operation' ? 'operation_not_found' : 'model_not_found',
        'not_retryable'
      );
    case 408:
    case 504:
      return new KlingRuntimeError('timeout', 'retryable');
    case 409:
    case 422:
      return new KlingRuntimeError('invalid_parameters', 'not_retryable');
    case 413:
      return new KlingRuntimeError('request_too_large', 'not_retryable');
    case 429:
      return new KlingRuntimeError(
        'rate_limited',
        'retryable',
        parseRetryAfter(headers)
      );
    case 500:
    case 502:
    case 503:
      return new KlingRuntimeError('provider_unavailable', 'retryable');
    default:
      return new KlingRuntimeError('provider_unavailable', 'unknown');
  }
}

function mapRuntimeFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean
): KlingRuntimeError {
  if (error instanceof KlingRuntimeError) return error;
  if (timedOut) return new KlingRuntimeError('timeout', 'retryable');
  if (signal.aborted) return new KlingRuntimeError('cancelled', 'not_retryable');
  if (error instanceof KlingTransportFailure) {
    switch (error.kind) {
      case 'timeout':
        return new KlingRuntimeError('timeout', 'retryable');
      case 'cancelled':
        return new KlingRuntimeError('cancelled', 'not_retryable');
      case 'proxy_unavailable':
        return new KlingRuntimeError('proxy_unavailable', 'retryable');
      case 'request_too_large':
        return new KlingRuntimeError('request_too_large', 'not_retryable');
      case 'response_too_large':
        return new KlingRuntimeError('response_too_large', 'not_retryable');
      case 'network':
        return new KlingRuntimeError('network_error', 'retryable');
    }
  }
  return new KlingRuntimeError('network_error', 'unknown');
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

function messageForCode(code: KlingRuntimeErrorCode): string {
  const messages: Record<KlingRuntimeErrorCode, string> = {
    invalid_request: 'The Kling request is invalid',
    protocol_mismatch: 'The Kling protocol binding is invalid',
    endpoint_not_allowed: 'The Kling endpoint is not allowed',
    credential_unavailable: 'The Kling credential is unavailable',
    authentication_failed: 'Kling authentication failed',
    permission_denied: 'Kling denied the request',
    model_not_found: 'The configured Kling model endpoint was not found',
    operation_not_found: 'The Kling operation was not found',
    invalid_parameters: 'Kling rejected the request parameters',
    rate_limited: 'Kling rate limited the request',
    provider_unavailable: 'Kling is unavailable',
    timeout: 'The Kling request timed out',
    cancelled: 'The Kling request was cancelled locally',
    request_too_large: 'The Kling request is too large',
    response_too_large: 'The Kling response is too large',
    redirect_not_allowed: 'Kling redirects are not allowed',
    invalid_response: 'The Kling response is invalid',
    network_error: 'The Kling network request failed',
    proxy_unavailable: 'The configured proxy is unavailable',
    runtime_shutting_down: 'The Kling runtime is shutting down'
  };
  return messages[code];
}
