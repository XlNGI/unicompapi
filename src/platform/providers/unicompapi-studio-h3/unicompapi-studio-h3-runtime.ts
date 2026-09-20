import type {
  ProviderConnection,
  ProxyMode,
  StructuredCredentialRecord
} from '../../../domain';
import {
  isUnicompapiStudioH3EndpointPolicy,
  isUnicompapiStudioH3OfficialTemplate,
  UNICOMPAPI_STUDIO_H3_ALLOWED_HOSTS,
  UNICOMPAPI_STUDIO_H3_BASE_URL,
  UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_STUDIO_H3_PATH_PREFIX,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
} from './unicompapi-studio-h3-contracts';

export const unicompapiStudioH3RuntimeErrorCodes = [
  'invalid_request',
  'protocol_mismatch',
  'endpoint_not_allowed',
  'credential_unavailable',
  'authentication_failed',
  'permission_denied',
  'model_not_found',
  'operation_not_found',
  'invalid_parameters',
  'content_moderation_pending',
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
export type UnicompapiStudioH3RuntimeErrorCode =
  (typeof unicompapiStudioH3RuntimeErrorCodes)[number];

export class UnicompapiStudioH3RuntimeError extends Error {
  constructor(
    readonly code: UnicompapiStudioH3RuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'UnicompapiStudioH3RuntimeError';
  }
}

export class UnicompapiStudioH3TransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'request_too_large'
      | 'response_too_large'
  ) {
    super('UniCompAPI Studio H3 transport failed');
    this.name = 'UnicompapiStudioH3TransportFailure';
  }
}

export interface UnicompapiStudioH3HttpTransportRequest {
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

export interface UnicompapiStudioH3HttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface UnicompapiStudioH3HttpTransport {
  send(
    request: UnicompapiStudioH3HttpTransportRequest
  ): Promise<UnicompapiStudioH3HttpTransportResponse>;
}

export interface UnicompapiStudioH3SafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly operation?:
    | 'credential_probe'
    | 'video_submit'
    | 'video_query'
    | 'video_cancel'
    | 'video_result';
  readonly method?: 'GET' | 'POST';
  readonly status?: number;
  readonly errorCode?: UnicompapiStudioH3RuntimeErrorCode;
  readonly elapsedMs?: number;
}

export interface UnicompapiStudioH3SharedRuntimeOptions {
  readonly transport: UnicompapiStudioH3HttpTransport;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly logger?: (event: UnicompapiStudioH3SafeLogEvent) => void;
  readonly now?: () => number;
}

export class UnicompapiStudioH3SharedRuntime {
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: UnicompapiStudioH3SharedRuntimeOptions) {}

  async requestCredentialProbe(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly signal?: AbortSignal;
  }): Promise<UnicompapiStudioH3HttpTransportResponse> {
    const base = validateManagementConnection(input.connection);
    return this.requestJson({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'credential_probe',
      method: 'GET',
      url: new URL('models', base),
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 256 * 1024,
      requireReadyConnection: false,
      acceptClientError: true,
      notFoundKind: 'model'
    });
  }

  async requestVideoCreate(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const base = validateOfficialConnection(input.connection);
    const response = await this.requestJson({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_submit',
      method: 'POST',
      url: new URL('videos', base),
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: 2 * 1024 * 1024,
      maximumResponseBytes: 256 * 1024,
      requireReadyConnection: true,
      acceptClientError: false,
      notFoundKind: 'model',
      acceptedStatuses: [200, 202]
    });
    return response.body;
  }

  async requestVideoQuery(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const base = validateOfficialConnection(input.connection);
    const response = await this.requestJson({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_query',
      method: 'GET',
      url: new URL(`videos/${input.providerOperationId}`, base),
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 256 * 1024,
      requireReadyConnection: true,
      acceptClientError: false,
      notFoundKind: 'operation'
    });
    return response.body;
  }

  async requestVideoCancel(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
  }): Promise<UnicompapiStudioH3HttpTransportResponse> {
    const base = validateOfficialConnection(input.connection);
    return this.requestJson({
      connection: input.connection,
      credentials: input.credentials,
      operation: 'video_cancel',
      method: 'POST',
      url: new URL(`videos/${input.providerOperationId}/cancel`, base),
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: 256 * 1024,
      requireReadyConnection: true,
      acceptClientError: true,
      notFoundKind: 'operation'
    });
  }

  async downloadVideoResult(input: {
    readonly url: string;
    readonly maximumResponseBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<UnicompapiStudioH3HttpTransportResponse & { readonly contentType?: string }> {
    const url = parseResultUrl(input.url);
    const response = await this.send({
      operation: 'video_result',
      method: 'GET',
      url,
      headers: { accept: 'video/*,application/octet-stream' },
      signal: input.signal,
      maximumRequestBytes: 1,
      maximumResponseBytes: input.maximumResponseBytes,
      requireJson: false,
      notFoundKind: 'operation'
    });
    return {
      ...response,
      contentType: headerValue(response.headers, 'content-type')
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    this.log({ event: 'runtime_disposed' });
  }

  private async requestJson(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly operation: NonNullable<UnicompapiStudioH3SafeLogEvent['operation']>;
    readonly method: 'GET' | 'POST';
    readonly url: URL;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly requireReadyConnection: boolean;
    readonly acceptClientError: boolean;
    readonly notFoundKind: 'model' | 'operation';
    readonly acceptedStatuses?: readonly number[];
  }): Promise<UnicompapiStudioH3HttpTransportResponse> {
    if (this.disposed) {
      throw new UnicompapiStudioH3RuntimeError('runtime_shutting_down', 'not_retryable');
    }
    if (input.requireReadyConnection) validateOfficialConnection(input.connection);
    const credential = parseCredential(input.credentials);
    validateBounds(input.body, input.maximumRequestBytes, input.maximumResponseBytes);
    return this.send({
      operation: input.operation,
      method: input.method,
      url: input.url,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.apiKey}`,
        ...(input.body ? { 'content-type': 'application/json' } : {})
      },
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: input.maximumRequestBytes,
      maximumResponseBytes: input.maximumResponseBytes,
      requireJson: true,
      notFoundKind: input.notFoundKind,
      acceptClientError: input.acceptClientError,
      acceptedStatuses: input.acceptedStatuses
    });
  }

  private async send(input: {
    readonly operation: NonNullable<UnicompapiStudioH3SafeLogEvent['operation']>;
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
    readonly acceptedStatuses?: readonly number[];
  }): Promise<UnicompapiStudioH3HttpTransportResponse> {
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new UnicompapiStudioH3RuntimeError('invalid_request', 'not_retryable');
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
        throw new UnicompapiStudioH3RuntimeError('cancelled', 'not_retryable');
      }
      await input.beforeRequestStarted?.();
      this.log({ event: 'request_started', operation: input.operation, method: input.method });
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
      if (response.status >= 300 && response.status < 400) {
        throw new UnicompapiStudioH3RuntimeError('redirect_not_allowed', 'not_retryable');
      }
      const accepted = input.acceptedStatuses ?? [200];
      if (
        !input.acceptClientError &&
        (response.status < 200 || response.status >= 300) &&
        !accepted.includes(response.status)
      ) {
        throw mapHttpError(response, input.notFoundKind);
      }
      if (response.body.byteLength > input.maximumResponseBytes) {
        throw new UnicompapiStudioH3RuntimeError('response_too_large', 'not_retryable');
      }
      if (input.requireJson && response.body.byteLength > 0) {
        requireJsonContentType(response.headers);
      }
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

  private log(event: UnicompapiStudioH3SafeLogEvent): void {
    this.options.logger?.({ ...event });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function parseCredential(
  record: StructuredCredentialRecord
): { readonly apiKey: string } {
  if (
    record.schemaId !== UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID ||
    record.schemaVersion !== 1 ||
    !isRecord(record.values) ||
    Object.keys(record.values).length !== 1 ||
    typeof record.values.api_key !== 'string'
  ) {
    throw new UnicompapiStudioH3RuntimeError('credential_unavailable', 'not_retryable');
  }
  const apiKey = record.values.api_key.trim();
  if (apiKey.length < 1 || apiKey.length > 4_096 || /[\r\n]/u.test(apiKey)) {
    throw new UnicompapiStudioH3RuntimeError('credential_unavailable', 'not_retryable');
  }
  return { apiKey };
}

function validateOfficialConnection(connection: ProviderConnection): URL {
  validateSharedConnection(connection);
  if (connection.state !== 'available' || connection.credentialState !== 'valid') {
    throw new UnicompapiStudioH3RuntimeError('protocol_mismatch', 'not_retryable');
  }
  return parseConnectionBase(connection);
}

function validateManagementConnection(connection: ProviderConnection): URL {
  validateSharedConnection(connection);
  if (connection.state === 'disabled' || connection.state === 'deleted') {
    throw new UnicompapiStudioH3RuntimeError('protocol_mismatch', 'not_retryable');
  }
  return parseConnectionBase(connection);
}

function validateSharedConnection(connection: ProviderConnection): void {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID &&
      item.adapterVersion === UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION &&
      item.protocolId === UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID &&
      item.protocolVersion === UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
  );
  if (
    connection.packageId !== UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION ||
    !isUnicompapiStudioH3OfficialTemplate(connection.templateId ?? '') ||
    connection.credentialSchemaId !== UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID ||
    connection.credentialSchemaVersion !== 1 ||
    !isUnicompapiStudioH3EndpointPolicy(connection.endpointPolicyId ?? '') ||
    connection.endpointPolicyRevision !== 1 ||
    !binding
  ) {
    throw new UnicompapiStudioH3RuntimeError('protocol_mismatch', 'not_retryable');
  }
}

function parseConnectionBase(connection: ProviderConnection): URL {
  if (!connection.endpoint) {
    throw new UnicompapiStudioH3RuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  let result: URL;
  try {
    result = new URL(connection.endpoint);
  } catch {
    throw new UnicompapiStudioH3RuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  const hostname = result.hostname.toLowerCase();
  const path = result.pathname.replace(/\/+$/u, '') || '/';
  if (
    result.protocol !== 'https:' ||
    !(UNICOMPAPI_STUDIO_H3_ALLOWED_HOSTS as readonly string[]).includes(hostname) ||
    (result.port && result.port !== '443') ||
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    path !== UNICOMPAPI_STUDIO_H3_PATH_PREFIX
  ) {
    throw new UnicompapiStudioH3RuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return new URL(`${UNICOMPAPI_STUDIO_H3_BASE_URL}/`);
}

function parseResultUrl(value: string): URL {
  let result: URL;
  try {
    result = new URL(value);
  } catch {
    throw new UnicompapiStudioH3RuntimeError('invalid_response', 'not_retryable');
  }
  if (
    result.protocol !== 'https:' ||
    result.hostname.toLowerCase() !== 'unicompapi.com' ||
    result.username ||
    result.password ||
    result.hash
  ) {
    throw new UnicompapiStudioH3RuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return result;
}

function mapHttpError(
  response: UnicompapiStudioH3HttpTransportResponse,
  notFoundKind: 'model' | 'operation'
): UnicompapiStudioH3RuntimeError {
  const payload = tryJson(response.body);
  const code = studioErrorCode(payload);
  if (response.status === 401 || code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN') {
    return new UnicompapiStudioH3RuntimeError('authentication_failed', 'not_retryable');
  }
  if (response.status === 403) {
    return new UnicompapiStudioH3RuntimeError('permission_denied', 'not_retryable');
  }
  if (response.status === 404) {
    return new UnicompapiStudioH3RuntimeError(
      notFoundKind === 'operation' ? 'operation_not_found' : 'model_not_found',
      'not_retryable'
    );
  }
  if (response.status === 409 && code === 'CONTENT_MODERATION_PENDING') {
    return new UnicompapiStudioH3RuntimeError('content_moderation_pending', 'retryable');
  }
  if (response.status === 409) {
    return new UnicompapiStudioH3RuntimeError('provider_unavailable', 'retryable');
  }
  if (response.status === 422 || code === 'INVALID_REQUEST') {
    return new UnicompapiStudioH3RuntimeError('invalid_parameters', 'not_retryable');
  }
  if (response.status === 429) {
    return new UnicompapiStudioH3RuntimeError('rate_limited', 'retryable');
  }
  if (response.status >= 500) {
    return new UnicompapiStudioH3RuntimeError('provider_unavailable', 'retryable');
  }
  return new UnicompapiStudioH3RuntimeError('provider_unavailable', 'unknown');
}

function mapRuntimeFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean
): UnicompapiStudioH3RuntimeError {
  if (error instanceof UnicompapiStudioH3RuntimeError) return error;
  if (timedOut) return new UnicompapiStudioH3RuntimeError('timeout', 'retryable');
  if (signal.aborted) return new UnicompapiStudioH3RuntimeError('cancelled', 'not_retryable');
  if (error instanceof UnicompapiStudioH3TransportFailure) {
    switch (error.kind) {
      case 'timeout':
        return new UnicompapiStudioH3RuntimeError('timeout', 'retryable');
      case 'cancelled':
        return new UnicompapiStudioH3RuntimeError('cancelled', 'not_retryable');
      case 'proxy_unavailable':
        return new UnicompapiStudioH3RuntimeError('proxy_unavailable', 'retryable');
      case 'request_too_large':
        return new UnicompapiStudioH3RuntimeError('request_too_large', 'not_retryable');
      case 'response_too_large':
        return new UnicompapiStudioH3RuntimeError('response_too_large', 'not_retryable');
      case 'network':
        return new UnicompapiStudioH3RuntimeError('network_error', 'retryable');
    }
  }
  return new UnicompapiStudioH3RuntimeError('network_error', 'unknown');
}

function studioErrorCode(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (isRecord(payload.error) && typeof payload.error.code === 'string') {
    return payload.error.code;
  }
  if (isRecord(payload.detail) && typeof payload.detail.code === 'string') {
    return payload.detail.code;
  }
  return undefined;
}

function tryJson(body: Uint8Array): Record<string, unknown> | undefined {
  if (body.byteLength < 1) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validateBounds(
  body: Uint8Array | undefined,
  maximumRequestBytes: number,
  maximumResponseBytes: number
): void {
  if ((body?.byteLength ?? 0) > maximumRequestBytes) {
    throw new UnicompapiStudioH3RuntimeError('request_too_large', 'not_retryable');
  }
  if (maximumResponseBytes < 1) {
    throw new UnicompapiStudioH3RuntimeError('invalid_request', 'not_retryable');
  }
}

function requireJsonContentType(headers: Readonly<Record<string, string>>): void {
  const value = headerValue(headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (value && value !== 'application/json') {
    throw new UnicompapiStudioH3RuntimeError('invalid_response', 'not_retryable');
  }
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
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageForCode(code: UnicompapiStudioH3RuntimeErrorCode): string {
  const messages: Record<UnicompapiStudioH3RuntimeErrorCode, string> = {
    invalid_request: 'The UniCompAPI Studio H3 request is invalid',
    protocol_mismatch: 'The UniCompAPI Studio H3 protocol binding is invalid',
    endpoint_not_allowed: 'The UniCompAPI Studio H3 endpoint is not allowed',
    credential_unavailable: 'The UniCompAPI Studio H3 credential is unavailable',
    authentication_failed: 'UniCompAPI Studio H3 authentication failed',
    permission_denied: 'UniCompAPI Studio H3 denied the request',
    model_not_found: 'The configured UniCompAPI Studio H3 model was not found',
    operation_not_found: 'The UniCompAPI Studio H3 operation was not found',
    invalid_parameters: 'UniCompAPI Studio H3 rejected the request parameters',
    content_moderation_pending: 'UniCompAPI Studio H3 is still moderating the request',
    rate_limited: 'UniCompAPI Studio H3 rate limited the request',
    provider_unavailable: 'UniCompAPI Studio H3 is unavailable',
    timeout: 'The UniCompAPI Studio H3 request timed out',
    cancelled: 'The UniCompAPI Studio H3 request was cancelled locally',
    request_too_large: 'The UniCompAPI Studio H3 request is too large',
    response_too_large: 'The UniCompAPI Studio H3 response is too large',
    redirect_not_allowed: 'UniCompAPI Studio H3 redirects are not allowed',
    invalid_response: 'The UniCompAPI Studio H3 response is invalid',
    network_error: 'The UniCompAPI Studio H3 network request failed',
    proxy_unavailable: 'The configured proxy is unavailable',
    runtime_shutting_down: 'The UniCompAPI Studio H3 runtime is shutting down'
  };
  return messages[code];
}
