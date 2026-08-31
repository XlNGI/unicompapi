import type {
  ProviderConnection,
  ProxyMode,
  StructuredCredentialRecord
} from '../../../domain';
import { isIP } from 'node:net';
import {
  DOUBAO_VISION_ADAPTER_ID,
  DOUBAO_VISION_ADAPTER_VERSION,
  DOUBAO_VISION_PROTOCOL_ID,
  DOUBAO_VISION_PROTOCOL_VERSION,
  SEEDANCE_VIDEO_ADAPTER_ID,
  SEEDANCE_VIDEO_ADAPTER_VERSION,
  SEEDANCE_VIDEO_PROTOCOL_ID,
  SEEDANCE_VIDEO_PROTOCOL_VERSION,
  VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  VOLCENGINE_ENDPOINT_POLICY_ID,
  VOLCENGINE_OFFICIAL_BASE_URL,
  VOLCENGINE_OFFICIAL_TEMPLATE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_VERSION
} from './volcengine-contracts';

export const volcengineRuntimeErrorCodes = [
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
export type VolcengineRuntimeErrorCode =
  (typeof volcengineRuntimeErrorCodes)[number];

export class VolcengineRuntimeError extends Error {
  constructor(
    readonly code: VolcengineRuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'VolcengineRuntimeError';
  }
}

export class VolcengineTransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'request_too_large'
      | 'response_too_large'
  ) {
    super('Volcengine transport failed');
    this.name = 'VolcengineTransportFailure';
  }
}

interface VolcengineAdapterIdentity {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
}

const visionIdentity: VolcengineAdapterIdentity = {
  adapterId: DOUBAO_VISION_ADAPTER_ID,
  adapterVersion: DOUBAO_VISION_ADAPTER_VERSION,
  protocolId: DOUBAO_VISION_PROTOCOL_ID,
  protocolVersion: DOUBAO_VISION_PROTOCOL_VERSION
};

const seedanceIdentity: VolcengineAdapterIdentity = {
  adapterId: SEEDANCE_VIDEO_ADAPTER_ID,
  adapterVersion: SEEDANCE_VIDEO_ADAPTER_VERSION,
  protocolId: SEEDANCE_VIDEO_PROTOCOL_ID,
  protocolVersion: SEEDANCE_VIDEO_PROTOCOL_VERSION
};

export interface VolcengineHttpTransportRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
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

export interface VolcengineHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface VolcengineHttpTransport {
  send(
    request: VolcengineHttpTransportRequest
  ): Promise<VolcengineHttpTransportResponse>;
}

export interface VolcengineSafeLogEvent {
  readonly event:
    | 'request_started'
    | 'request_completed'
    | 'request_failed'
    | 'runtime_disposed';
  readonly operation?:
    | 'connection_probe'
    | 'vision_chat'
    | 'video_submit'
    | 'video_query'
    | 'video_cancel'
    | 'video_result';
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly status?: number;
  readonly errorCode?: VolcengineRuntimeErrorCode;
  readonly elapsedMs?: number;
}

export interface VolcengineSharedRuntimeOptions {
  readonly transport: VolcengineHttpTransport;
  readonly baseUrl?: string;
  readonly proxy?: () => ProxyMode;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxRequestBytes?: number;
  readonly defaultMaxResponseBytes?: number;
  readonly logger?: (event: VolcengineSafeLogEvent) => void;
  readonly now?: () => number;
}

export class VolcengineSharedRuntime {
  private readonly baseUrl: URL;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: VolcengineSharedRuntimeOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl ?? VOLCENGINE_OFFICIAL_BASE_URL);
  }

  async requestVisionChat(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      identity: visionIdentity,
      operation: 'vision_chat',
      method: 'POST',
      path: '/chat/completions',
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes:
        this.options.defaultMaxRequestBytes ?? 64 * 1024 * 1024,
      maximumResponseBytes:
        this.options.defaultMaxResponseBytes ?? 4 * 1024 * 1024,
      responseKind: 'json'
    });
    return Uint8Array.from(response.body);
  }

  async requestVideoTaskCreate(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      identity: seedanceIdentity,
      operation: 'video_submit',
      method: 'POST',
      path: '/contents/generations/tasks',
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: 64 * 1024 * 1024,
      maximumResponseBytes: 2 * 1024 * 1024,
      responseKind: 'json'
    });
    return Uint8Array.from(response.body);
  }

  async requestVideoTaskQuery(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<Uint8Array> {
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      identity: seedanceIdentity,
      operation: 'video_query',
      method: 'GET',
      path: videoTaskPath(input.providerOperationId),
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: 1,
      maximumResponseBytes: 4 * 1024 * 1024,
      responseKind: 'json'
    });
    return Uint8Array.from(response.body);
  }

  async requestVideoTaskDelete(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly providerOperationId: string;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
  }): Promise<void> {
    const response = await this.requestOfficialApi({
      connection: input.connection,
      credentials: input.credentials,
      identity: seedanceIdentity,
      operation: 'video_cancel',
      method: 'DELETE',
      path: videoTaskPath(input.providerOperationId),
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted,
      maximumRequestBytes: 1,
      maximumResponseBytes: 1_024,
      responseKind: 'empty'
    });
    if (response.body.byteLength !== 0) {
      throw new VolcengineRuntimeError('invalid_response', 'not_retryable');
    }
  }

  /**
   * Save-time connectivity probe: GET a synthetic video task id.
   * 401 => invalid API key; 404/operation_not_found => auth accepted (no generation).
   */
  async requestConnectivityProbe(input: {
    readonly connection: ProviderConnection;
    readonly credentials: StructuredCredentialRecord;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (this.disposed) {
      throw new VolcengineRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    validateManagementConnection(input.connection, this.baseUrl, seedanceIdentity);
    const credential = parseCredential(input.credentials);
    const path = videoTaskPath('unicomp-connectivity-probe');
    const url = resolveOfficialPath(this.baseUrl, path);
    const timeoutMs = this.options.defaultTimeoutMs ?? 30_000;
    const maximumResponseBytes = 256 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new VolcengineRuntimeError('invalid_request', 'not_retryable');
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
        throw new VolcengineRuntimeError('cancelled', 'not_retryable');
      }
      this.log({
        event: 'request_started',
        operation: 'connection_probe',
        method: 'GET'
      });
      const response = await this.options.transport.send({
        method: 'GET',
        url: url.toString(),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credential}`
        },
        body: new Uint8Array(),
        signal: controller.signal,
        timeoutMs,
        maxRequestBytes: 1,
        maxResponseBytes: maximumResponseBytes,
        proxy: this.options.proxy?.() ?? { kind: 'system_default' },
        redirect: 'manual'
      });
      validateDeclaredResponseSize(response.headers, maximumResponseBytes);
      if (response.status >= 300 && response.status < 400) {
        throw new VolcengineRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status === 401) {
        throw new VolcengineRuntimeError('authentication_failed', 'not_retryable');
      }
      if (response.status === 404 || response.status === 410) {
        this.log({
          event: 'request_completed',
          operation: 'connection_probe',
          method: 'GET',
          status: response.status,
          elapsedMs: Math.max(0, this.now() - startedAt)
        });
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(response.status, response.headers, true);
      }
      if (response.body.byteLength > maximumResponseBytes) {
        throw new VolcengineRuntimeError('response_too_large', 'not_retryable');
      }
      this.log({
        event: 'request_completed',
        operation: 'connection_probe',
        method: 'GET',
        status: response.status,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
    } catch (error) {
      const mapped = mapRuntimeFailure(error, controller.signal, timedOut);
      this.log({
        event: 'request_failed',
        operation: 'connection_probe',
        method: 'GET',
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

  async downloadVideoResult(input: {
    readonly url: string;
    readonly signal?: AbortSignal;
    readonly maximumResponseBytes?: number;
  }): Promise<{ readonly body: Uint8Array; readonly contentType?: string }> {
    const url = parseResultUrl(input.url);
    const response = await this.requestWithoutCredential({
      operation: 'video_result',
      method: 'GET',
      url,
      signal: input.signal,
      maximumResponseBytes: input.maximumResponseBytes ?? 512 * 1024 * 1024,
      accept: 'video/*'
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
    readonly identity: VolcengineAdapterIdentity;
    readonly operation: Exclude<VolcengineSafeLogEvent['operation'], 'video_result' | undefined>;
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly path: string;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly maximumRequestBytes: number;
    readonly maximumResponseBytes: number;
    readonly responseKind: 'json' | 'empty';
  }): Promise<VolcengineHttpTransportResponse> {
    if (this.disposed) {
      throw new VolcengineRuntimeError(
        'runtime_shutting_down',
        'not_retryable'
      );
    }
    validateOfficialConnection(input.connection, this.baseUrl, input.identity);
    const credential = parseCredential(input.credentials);
    if (
      !Number.isSafeInteger(input.maximumRequestBytes) ||
      input.maximumRequestBytes < 1 ||
      !Number.isSafeInteger(input.maximumResponseBytes) ||
      input.maximumResponseBytes < 1 ||
      (input.body && (
        input.body.byteLength < 1 ||
        input.body.byteLength > input.maximumRequestBytes
      ))
    ) {
      throw new VolcengineRuntimeError('request_too_large', 'not_retryable');
    }
    const url = resolveOfficialPath(this.baseUrl, input.path);
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new VolcengineRuntimeError('invalid_request', 'not_retryable');
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
        throw new VolcengineRuntimeError('cancelled', 'not_retryable');
      }
      await input.beforeRequestStarted?.();
      this.log({
        event: 'request_started',
        operation: input.operation,
        method: input.method
      });
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${credential}`
      };
      if (input.body) headers['content-type'] = 'application/json';
      const response = await this.options.transport.send({
        method: input.method,
        url: url.toString(),
        headers,
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
        throw new VolcengineRuntimeError(
          'redirect_not_allowed',
          'not_retryable'
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(
          response.status,
          response.headers,
          input.operation.startsWith('video_')
        );
      }
      if (response.body.byteLength > input.maximumResponseBytes) {
        throw new VolcengineRuntimeError('response_too_large', 'not_retryable');
      }
      if (input.responseKind === 'json') requireJsonContentType(response.headers);
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

  private async requestWithoutCredential(input: {
    readonly operation: 'video_result';
    readonly method: 'GET';
    readonly url: URL;
    readonly signal?: AbortSignal;
    readonly maximumResponseBytes: number;
    readonly accept: 'video/*';
  }): Promise<VolcengineHttpTransportResponse> {
    if (this.disposed) {
      throw new VolcengineRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    if (
      !Number.isSafeInteger(input.maximumResponseBytes) ||
      input.maximumResponseBytes < 1
    ) {
      throw new VolcengineRuntimeError('invalid_request', 'not_retryable');
    }
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
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
      this.log({
        event: 'request_started',
        operation: input.operation,
        method: input.method
      });
      const response = await this.options.transport.send({
        method: input.method,
        url: input.url.toString(),
        headers: { accept: input.accept },
        body: new Uint8Array(),
        signal: controller.signal,
        timeoutMs,
        maxRequestBytes: 1,
        maxResponseBytes: input.maximumResponseBytes,
        proxy: this.options.proxy?.() ?? { kind: 'system_default' },
        redirect: 'manual'
      });
      validateDeclaredResponseSize(response.headers, input.maximumResponseBytes);
      if (response.status >= 300 && response.status < 400) {
        throw new VolcengineRuntimeError('redirect_not_allowed', 'not_retryable');
      }
      if (response.status < 200 || response.status >= 300) {
        throw mapHttpStatus(response.status, response.headers, true);
      }
      if (response.body.byteLength > input.maximumResponseBytes) {
        throw new VolcengineRuntimeError('response_too_large', 'not_retryable');
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

  private log(event: VolcengineSafeLogEvent): void {
    this.options.logger?.({ ...event });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function parseCredential(record: StructuredCredentialRecord): string {
  if (
    record.schemaId !== VOLCENGINE_CREDENTIAL_SCHEMA_ID ||
    record.schemaVersion !== 1 ||
    !isRecord(record.values) ||
    Object.keys(record.values).length !== 1 ||
    typeof record.values.api_key !== 'string'
  ) {
    throw new VolcengineRuntimeError(
      'credential_unavailable',
      'not_retryable'
    );
  }
  const value = record.values.api_key.trim();
  if (value.length < 1 || value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new VolcengineRuntimeError(
      'credential_unavailable',
      'not_retryable'
    );
  }
  return value;
}

function validateOfficialConnection(
  connection: ProviderConnection,
  baseUrl: URL,
  identity: VolcengineAdapterIdentity
): void {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === identity.adapterId &&
      item.adapterVersion === identity.adapterVersion &&
      item.protocolId === identity.protocolId &&
      item.protocolVersion === identity.protocolVersion
  );
  if (
    connection.packageId !== VOLCENGINE_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== VOLCENGINE_PROVIDER_PACKAGE_VERSION ||
    connection.templateId !== VOLCENGINE_OFFICIAL_TEMPLATE_ID ||
    connection.credentialSchemaId !== VOLCENGINE_CREDENTIAL_SCHEMA_ID ||
    connection.credentialSchemaVersion !== 1 ||
    connection.endpointPolicyId !== VOLCENGINE_ENDPOINT_POLICY_ID ||
    connection.endpointPolicyRevision !== 1 ||
    connection.state !== 'available' ||
    connection.credentialState !== 'valid' ||
    !binding
  ) {
    throw new VolcengineRuntimeError('protocol_mismatch', 'not_retryable');
  }
  const endpoint = parseBaseUrl(connection.endpoint ?? '');
  if (
    endpoint.origin !== baseUrl.origin ||
    trimTrailingSlash(endpoint.pathname) !== trimTrailingSlash(baseUrl.pathname)
  ) {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
}

function validateManagementConnection(
  connection: ProviderConnection,
  baseUrl: URL,
  identity: VolcengineAdapterIdentity
): void {
  const binding = connection.adapterBindings?.find(
    (item) =>
      item.adapterId === identity.adapterId &&
      item.adapterVersion === identity.adapterVersion &&
      item.protocolId === identity.protocolId &&
      item.protocolVersion === identity.protocolVersion
  );
  if (
    connection.packageId !== VOLCENGINE_PROVIDER_PACKAGE_ID ||
    connection.packageVersion !== VOLCENGINE_PROVIDER_PACKAGE_VERSION ||
    connection.templateId !== VOLCENGINE_OFFICIAL_TEMPLATE_ID ||
    connection.credentialSchemaId !== VOLCENGINE_CREDENTIAL_SCHEMA_ID ||
    connection.credentialSchemaVersion !== 1 ||
    connection.endpointPolicyId !== VOLCENGINE_ENDPOINT_POLICY_ID ||
    connection.endpointPolicyRevision !== 1 ||
    connection.state === 'disabled' ||
    connection.state === 'deleted' ||
    !binding
  ) {
    throw new VolcengineRuntimeError('protocol_mismatch', 'not_retryable');
  }
  if (!connection.endpoint) {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  const endpoint = parseBaseUrl(connection.endpoint);
  if (
    endpoint.origin !== baseUrl.origin ||
    trimTrailingSlash(endpoint.pathname) !== trimTrailingSlash(baseUrl.pathname)
  ) {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
}

function parseBaseUrl(value: string): URL {
  let result: URL;
  try {
    result = new URL(value);
  } catch {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  if (
    result.protocol !== 'https:' ||
    result.hostname !== 'ark.cn-beijing.volces.com' ||
    (result.port && result.port !== '443') ||
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    trimTrailingSlash(result.pathname) !== '/api/v3'
  ) {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return result;
}

function resolveOfficialPath(baseUrl: URL, path: string): URL {
  if (!path.startsWith('/') || path.includes('..') || /[?#]/u.test(path)) {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  const url = new URL(`${trimTrailingSlash(baseUrl.pathname)}${path}`, baseUrl.origin);
  if (url.origin !== baseUrl.origin) {
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
}

function videoTaskPath(providerOperationId: string): string {
  if (
    providerOperationId.length < 1 ||
    providerOperationId.length > 512 ||
    !/^[A-Za-z0-9._-]+$/u.test(providerOperationId)
  ) {
    throw new VolcengineRuntimeError('invalid_request', 'not_retryable');
  }
  return `/contents/generations/tasks/${providerOperationId}`;
}

function parseResultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VolcengineRuntimeError('invalid_response', 'not_retryable');
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
    throw new VolcengineRuntimeError('endpoint_not_allowed', 'not_retryable');
  }
  return url;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '') || '/';
}

function requireJsonContentType(
  headers: Readonly<Record<string, string>>
): void {
  const contentType = headerValue(headers, 'content-type')?.toLowerCase();
  if (!contentType?.startsWith('application/json')) {
    throw new VolcengineRuntimeError('invalid_response', 'not_retryable');
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
    throw new VolcengineRuntimeError('invalid_response', 'not_retryable');
  }
  if (parsed > maximumBytes) {
    throw new VolcengineRuntimeError('response_too_large', 'not_retryable');
  }
}

function mapHttpStatus(
  status: number,
  headers: Readonly<Record<string, string>>,
  videoOperation = false
): VolcengineRuntimeError {
  switch (status) {
    case 400:
      return new VolcengineRuntimeError('invalid_request', 'not_retryable');
    case 401:
      return new VolcengineRuntimeError(
        'authentication_failed',
        'not_retryable'
      );
    case 403:
      return new VolcengineRuntimeError('permission_denied', 'not_retryable');
    case 404:
    case 410:
      return new VolcengineRuntimeError(
        videoOperation ? 'operation_not_found' : 'model_not_found',
        'not_retryable'
      );
    case 408:
    case 504:
      return new VolcengineRuntimeError('timeout', 'retryable');
    case 413:
      return new VolcengineRuntimeError('request_too_large', 'not_retryable');
    case 422:
    case 409:
      return new VolcengineRuntimeError('invalid_parameters', 'not_retryable');
    case 429:
      return new VolcengineRuntimeError(
        'rate_limited',
        'retryable',
        parseRetryAfter(headers)
      );
    case 500:
    case 502:
    case 503:
      return new VolcengineRuntimeError('provider_unavailable', 'retryable');
    default:
      return new VolcengineRuntimeError('provider_unavailable', 'unknown');
  }
}

function mapRuntimeFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean
): VolcengineRuntimeError {
  if (error instanceof VolcengineRuntimeError) return error;
  if (timedOut) return new VolcengineRuntimeError('timeout', 'retryable');
  if (signal.aborted) {
    return new VolcengineRuntimeError('cancelled', 'not_retryable');
  }
  if (error instanceof VolcengineTransportFailure) {
    switch (error.kind) {
      case 'timeout':
        return new VolcengineRuntimeError('timeout', 'retryable');
      case 'cancelled':
        return new VolcengineRuntimeError('cancelled', 'not_retryable');
      case 'proxy_unavailable':
        return new VolcengineRuntimeError('proxy_unavailable', 'retryable');
      case 'request_too_large':
        return new VolcengineRuntimeError(
          'request_too_large',
          'not_retryable'
        );
      case 'response_too_large':
        return new VolcengineRuntimeError(
          'response_too_large',
          'not_retryable'
        );
      case 'network':
        return new VolcengineRuntimeError('network_error', 'retryable');
    }
  }
  return new VolcengineRuntimeError('network_error', 'unknown');
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

function messageForCode(code: VolcengineRuntimeErrorCode): string {
  const messages: Record<VolcengineRuntimeErrorCode, string> = {
    invalid_request: 'The Volcengine request is invalid',
    protocol_mismatch: 'The Volcengine protocol binding is invalid',
    endpoint_not_allowed: 'The Volcengine endpoint is not allowed',
    credential_unavailable: 'The Volcengine credential is unavailable',
    authentication_failed: 'Volcengine authentication failed',
    permission_denied: 'Volcengine denied the request',
    model_not_found: 'The configured Volcengine Endpoint/Model ID was not found',
    operation_not_found: 'The Volcengine operation was not found',
    invalid_parameters: 'Volcengine rejected the request parameters',
    rate_limited: 'Volcengine rate limited the request',
    provider_unavailable: 'Volcengine is unavailable',
    timeout: 'The Volcengine request timed out',
    cancelled: 'The Volcengine request was cancelled',
    request_too_large: 'The Volcengine request is too large',
    response_too_large: 'The Volcengine response is too large',
    redirect_not_allowed: 'Volcengine redirects are not allowed',
    invalid_response: 'The Volcengine response is invalid',
    network_error: 'The Volcengine network request failed',
    proxy_unavailable: 'The configured proxy is unavailable',
    runtime_shutting_down: 'The Volcengine runtime is shutting down'
  };
  return messages[code];
}
