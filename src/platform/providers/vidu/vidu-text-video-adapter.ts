import { Readable } from 'node:stream';
import type {
  ProviderConnection,
  ProviderProtocolBinding,
  ProviderSubmitOutcome,
  UsageFactV1,
  VideoDynamicParameterValue
} from '../../../domain';
import type {
  ProviderAsyncOperationPort,
  ProviderAsyncOperationStatus,
  ProviderCancelOutcome
} from '../provider-execution-lifecycle';
import type {
  ProviderProtocolSubmitPort,
  ProviderProtocolSubmitRequest
} from '../provider-operation-router';
import type {
  VideoRemoteCompletionFact,
  VideoRemoteResultDescriptor,
  VideoResultPort
} from '../../videos/video-result-port';
import { VideoResultPortError } from '../../videos/video-result-port';
import type { ViduConnectionPort } from './vidu-image-adapters';
import type { ViduAdapterRequestControl } from './vidu-image-adapters';
import { ViduRuntimeError } from './vidu-runtime-errors';
import type { ViduSharedRuntime } from './vidu-shared-runtime';
import type {
  ViduVideoOperationContext,
  ViduVideoOperationContextPort
} from './vidu-video-adapter';

const maximumRequestBytes = 20 * 1024 * 1024;
const maximumResultBytes = 512 * 1024 * 1024;
const resultUrlLifetimeMs = 24 * 60 * 60 * 1_000;

export interface ViduTextVideoV2Dependencies {
  readonly runtime: ViduSharedRuntime;
  readonly connections: ViduConnectionPort;
  readonly operationContext: ViduVideoOperationContextPort;
  readonly now?: () => number;
}

interface ViduVideoResultSnapshot {
  readonly discoveredAt: number;
  readonly results: readonly {
    readonly id: string;
    readonly url: string;
  }[];
}

/**
 * Official Vidu text2video adapter.
 * POST /ent/v2/text2video — https://platform.vidu.cn/docs/text-to-video
 */
export class ViduTextVideoV2Adapter
  implements ProviderProtocolSubmitPort, ProviderAsyncOperationPort, VideoResultPort {
  private readonly results = new Map<string, ViduVideoResultSnapshot>();

  constructor(private readonly dependencies: ViduTextVideoV2Dependencies) {}

  async submit(
    request: ProviderProtocolSubmitRequest,
    control: ViduAdapterRequestControl = {}
  ): Promise<ProviderSubmitOutcome> {
    let requestSent = false;
    try {
      validateSubmitRequest(request);
      const video = request.task.submission.video!;
      const connection = await this.requireConnection(request.model.connectionId);
      const parameters = videoParameters(
        request.model.providerModelKey,
        video.parameters
      );
      const body = serializeBoundedJson({
        model: request.model.providerModelKey,
        prompt: requirePrompt(request),
        audio: parameters.audio,
        ...parameters.optional
      });
      const response = await this.dependencies.runtime.request({
        connection,
        binding: request.binding,
        method: 'POST',
        path: '/ent/v2/text2video',
        body,
        contentType: 'application/json',
        authScheme: 'token',
        maxRequestBytes: maximumRequestBytes,
        maxResponseBytes: 2 * 1024 * 1024,
        signal: control.signal,
        beforeRequestStarted: async () => {
          await control.beforeRequestStarted?.();
          requestSent = true;
        }
      });
      const providerOperationId = parseTaskId(response.body);
      this.dependencies.operationContext.remember(providerOperationId, {
        connectionId: request.model.connectionId,
        binding: request.binding
      });
      return {
        kind: 'accepted_async',
        providerOperationId,
        state: 'queued'
      };
    } catch (error) {
      return mapSubmissionFailure(error, requestSent);
    }
  }

  async query(providerOperationId: string): Promise<ProviderAsyncOperationStatus> {
    const taskId = requireRemoteId(providerOperationId);
    const response = await this.requestTask('GET', taskId, 'creations');
    const parsed = parseTaskResponse(response.body);
    if (parsed.state === 'success') {
      const previous = this.results.get(taskId);
      this.results.set(taskId, {
        discoveredAt: sameResults(previous?.results, parsed.results)
          ? previous!.discoveredAt
          : this.now(),
        results: parsed.results
      });
      return {
        state: 'completed',
        ...(parsed.credits ? { usageFacts: [creditFact(parsed.credits)] } : {})
      };
    }
    if (parsed.state === 'failed') {
      return {
        state: 'failed',
        message: 'Vidu reported that the video generation failed',
        retryability: 'not_retryable'
      };
    }
    return { state: parsed.state === 'processing' ? 'processing' : 'queued' };
  }

  async cancel(providerOperationId: string): Promise<ProviderCancelOutcome> {
    const taskId = requireRemoteId(providerOperationId);
    try {
      const response = await this.requestTask('POST', taskId, 'cancel');
      const value = parseJsonObject(response.body);
      if (Object.keys(value).length !== 0) {
        throw new ViduRuntimeError('invalid_response', 'unknown');
      }
      return { state: 'cancelled' };
    } catch (error) {
      if (error instanceof ViduRuntimeError && error.retryability === 'retryable') {
        return { state: 'unknown' };
      }
      if (error instanceof ViduRuntimeError &&
        ['invalid_response', 'permission_denied'].includes(error.code)) {
        return { state: 'processing' };
      }
      throw error;
    }
  }

  async getCompletion(
    remoteOperationId: string
  ): Promise<VideoRemoteCompletionFact | undefined> {
    const status = await this.query(remoteOperationId);
    if (status.state === 'completed') return { state: 'completed' };
    if (status.state === 'failed') {
      throw new VideoResultPortError(status.retryability, status.message);
    }
    return undefined;
  }

  async listResults(
    remoteOperationId: string
  ): Promise<readonly VideoRemoteResultDescriptor[]> {
    const taskId = requireRemoteId(remoteOperationId);
    const snapshot = await this.loadCurrentResults(taskId);
    return snapshot.results.map((result) => ({
      remoteResultId: result.id,
      name: `vidu-video-${result.id}`
    }));
  }

  async openDownload(
    remoteOperationId: string,
    remoteResultId: string
  ): Promise<Readable> {
    const taskId = requireRemoteId(remoteOperationId);
    const resultId = requireRemoteId(remoteResultId);
    const snapshot = await this.loadCurrentResults(taskId);
    if (this.now() - snapshot.discoveredAt >= resultUrlLifetimeMs) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Vidu video result URL has expired'
      );
    }
    const result = snapshot.results.find((candidate) => candidate.id === resultId);
    if (!result) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Vidu video result is unavailable'
      );
    }
    try {
      const downloaded = await this.dependencies.runtime.downloadResult({
        url: result.url,
        accept: 'video/*',
        maxResponseBytes: maximumResultBytes
      });
      if (downloaded.contentType && !downloaded.contentType.startsWith('video/')) {
        throw new VideoResultPortError(
          'not_retryable',
          'The Vidu result did not contain video bytes'
        );
      }
      return Readable.from([Buffer.from(downloaded.body)]);
    } catch (error) {
      if (error instanceof VideoResultPortError) throw error;
      throw new VideoResultPortError(
        runtimeRetryability(error),
        'The Vidu video result could not be downloaded'
      );
    }
  }

  private async loadCurrentResults(taskId: string): Promise<ViduVideoResultSnapshot> {
    const status = await this.query(taskId);
    if (status.state !== 'completed') {
      throw new VideoResultPortError(
        status.state === 'failed' ? status.retryability : 'retryable',
        'The Vidu video result is not available'
      );
    }
    const snapshot = this.results.get(taskId);
    if (!snapshot || snapshot.results.length !== 1) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Vidu video result declaration is invalid'
      );
    }
    return snapshot;
  }

  private async requestTask(
    method: 'GET' | 'POST',
    taskId: string,
    action: 'creations' | 'cancel'
  ) {
    const context = await this.dependencies.operationContext.resolve(taskId);
    if (!context) {
      throw new ViduTextVideoAdapterError(
        'The Vidu video operation context is unavailable',
        'unknown'
      );
    }
    assertViduTextVideoBinding(context.binding, context.connectionId);
    const connection = await this.requireConnection(context.connectionId);
    return this.dependencies.runtime.request({
      connection,
      binding: context.binding,
      method,
      path: `/ent/v2/tasks/${taskId}/${action}`,
      ...(method === 'POST'
        ? { body: new TextEncoder().encode('{}'), contentType: 'application/json' as const }
        : {}),
      authScheme: 'token',
      maxRequestBytes: 1_024,
      maxResponseBytes: 2 * 1024 * 1024
    });
  }

  private async requireConnection(connectionId: string): Promise<ProviderConnection> {
    const connection = await this.dependencies.connections.get(connectionId);
    if (!connection || connection.id !== connectionId) {
      throw new ViduTextVideoAdapterError(
        'The Vidu connection is unavailable',
        'not_retryable'
      );
    }
    return connection;
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}

class ViduTextVideoAdapterError extends Error {
  constructor(
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'ViduTextVideoAdapterError';
  }
}

function assertViduTextVideoBinding(
  binding: ProviderProtocolBinding,
  connectionId: string
): void {
  if (
    binding.protocolId !== 'vidu.ent.v2.text2video' ||
    binding.adapterKind !== 'vidu_text_video_v2' ||
    binding.mediaKind !== 'video' ||
    binding.authScheme !== 'token' ||
    binding.executionLifecycle !== 'asynchronous_polling' ||
    binding.connectionId !== connectionId
  ) {
    throw new ViduTextVideoAdapterError(
      'The Vidu text video protocol binding is invalid',
      'not_retryable'
    );
  }
}

function validateSubmitRequest(
  request: ProviderProtocolSubmitRequest
): void {
  const video = request.task.submission.video;
  const assetIds = request.task.submission.assetIds;
  if (
    request.execution.taskId !== request.task.id ||
    request.execution.state !== 'submitting' ||
    request.model.mediaKind !== 'video' ||
    request.binding.mediaKind !== 'video' ||
    request.binding.protocolId !== 'vidu.ent.v2.text2video' ||
    request.binding.adapterKind !== 'vidu_text_video_v2' ||
    request.binding.executionLifecycle !== 'asynchronous_polling' ||
    request.binding.authScheme !== 'token' ||
    request.model.protocolBindingId !== request.binding.id ||
    request.model.providerId !== request.binding.providerId ||
    request.model.connectionId !== request.binding.connectionId ||
    request.evidence.modelId !== request.model.id ||
    request.evidence.capability !== 'video_generation' ||
    !request.binding.supportedPurposes.includes('video_generation') ||
    !video ||
    video.modelId !== request.model.id ||
    video.capabilityEvidenceId !== request.evidence.id ||
    video.providerId !== request.model.providerId ||
    video.connectionId !== request.model.connectionId ||
    video.materials.length !== 0 ||
    (assetIds !== undefined && assetIds.length !== 0) ||
    !['viduq3-pro', 'viduq3-turbo'].includes(request.model.providerModelKey)
  ) {
    throw new ViduTextVideoAdapterError(
      'The video operation does not match the Vidu text2video protocol',
      'not_retryable'
    );
  }
}

function videoParameters(
  modelKey: string,
  values: Readonly<Record<string, VideoDynamicParameterValue>>
): { readonly audio: boolean; readonly optional: Readonly<Record<string, unknown>> } {
  const allowed = new Set([
    'audio',
    'duration',
    'resolution',
    'aspect_ratio',
    'seed'
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw new ViduTextVideoAdapterError(
      'The Vidu video request contains an unsupported parameter',
      'not_retryable'
    );
  }
  // Official text2video default for audio is true (q3).
  const audio = values.audio ?? true;
  if (typeof audio !== 'boolean') {
    throw new ViduTextVideoAdapterError('The Vidu audio option is invalid', 'not_retryable');
  }
  const optional: Record<string, unknown> = {};
  if (values.duration !== undefined) {
    const duration = values.duration;
    const range = durationRange(modelKey);
    if (!Number.isSafeInteger(duration) ||
      typeof duration !== 'number' ||
      duration < range.minimum ||
      duration > range.maximum) {
      throw new ViduTextVideoAdapterError(
        'The Vidu video duration is outside the approved model range',
        'not_retryable'
      );
    }
    optional.duration = duration;
  }
  for (const key of ['resolution', 'aspect_ratio'] as const) {
    const value = values[key];
    if (value !== undefined) {
      const normalized = typeof value === 'string' ? value.trim() : '';
      const options = key === 'resolution'
        ? ['540p', '720p', '1080p']
        : ['16:9', '9:16', '3:4', '4:3', '1:1'];
      if (!options.includes(normalized)) {
        throw new ViduTextVideoAdapterError(
          'The Vidu video parameter is outside the official option set',
          'not_retryable'
        );
      }
      optional[key] = normalized;
    }
  }
  if (values.seed !== undefined) {
    const seed = values.seed;
    if (
      typeof seed !== 'number' ||
      !Number.isSafeInteger(seed) ||
      seed < 0 ||
      seed > 2_147_483_647
    ) {
      throw new ViduTextVideoAdapterError(
        'The Vidu seed is outside the official range',
        'not_retryable'
      );
    }
    if (seed !== 0) optional.seed = seed;
  }
  return { audio, optional };
}

function durationRange(modelKey: string): { minimum: number; maximum: number } {
  if (modelKey === 'viduq3-pro' || modelKey === 'viduq3-turbo') {
    return { minimum: 1, maximum: 16 };
  }
  throw new ViduTextVideoAdapterError(
    'The Vidu text2video model is unavailable',
    'not_retryable'
  );
}

function requirePrompt(request: ProviderProtocolSubmitRequest): string {
  const prompt = request.task.submission.prompt?.finalPrompt.trim();
  if (!prompt || prompt.length > 5_000) {
    throw new ViduTextVideoAdapterError('The Vidu video prompt is invalid', 'not_retryable');
  }
  return prompt;
}

function serializeBoundedJson(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > maximumRequestBytes) {
    throw new ViduTextVideoAdapterError(
      'The serialized Vidu video request exceeds 20 MB',
      'not_retryable'
    );
  }
  return bytes;
}

function parseTaskId(body: Uint8Array): string {
  return requireRemoteId(parseJsonObject(body).task_id);
}

function parseTaskResponse(body: Uint8Array): {
  readonly state: 'created' | 'queueing' | 'processing' | 'success' | 'failed';
  readonly results: readonly { readonly id: string; readonly url: string }[];
  readonly credits?: string;
} {
  const value = parseJsonObject(body);
  const state = value.state;
  if (!['created', 'queueing', 'processing', 'success', 'failed'].includes(String(state))) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  if (state !== 'success') {
    return { state: state as 'created' | 'queueing' | 'processing' | 'failed', results: [] };
  }
  if (!Array.isArray(value.creations) || value.creations.length !== 1) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const creation = requireRecord(value.creations[0]);
  return {
    state: 'success',
    results: [{
      id: requireRemoteId(creation.id),
      url: requireHttpsUrl(creation.url)
    }],
    ...parseCreditAmount(value)
  };
}

function parseCreditAmount(
  value: Record<string, unknown>
): { readonly credits?: string } {
  const raw = firstCreditCandidate([
    value.credits,
    value.credit,
    value.credit_amount,
    recordValue(value.usage, 'credits'),
    recordValue(value.usage, 'credit'),
    recordValue(value.usage, 'credit_amount')
  ]);
  if (raw === undefined) return {};
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return { credits: String(raw) };
  }
  if (typeof raw === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/u.test(raw.trim())) {
    return { credits: raw.trim() };
  }
  throw new ViduRuntimeError('invalid_response', 'unknown');
}

function firstCreditCandidate(values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function recordValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function creditFact(quantity: string): UsageFactV1 {
  return {
    metricId: 'credit_amount',
    quantity,
    unit: 'credit',
    source: 'provider_body'
  };
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body)
    );
    return requireRecord(value);
  } catch (error) {
    if (error instanceof ViduRuntimeError) throw error;
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  return value as Record<string, unknown>;
}

function requireRemoteId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new ViduRuntimeError('invalid_response', 'not_retryable');
  }
  return value;
}

function requireHttpsUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ViduRuntimeError('invalid_response', 'not_retryable');
  }
  return url.toString();
}

function mapSubmissionFailure(
  error: unknown,
  requestSent: boolean
): ProviderSubmitOutcome {
  if (error instanceof ViduTextVideoAdapterError) {
    return {
      kind: 'failed_before_submission',
      message: error.message,
      retryability: error.retryability
    };
  }
  if (error instanceof ViduRuntimeError && (
    ['timeout', 'network_error', 'provider_unavailable', 'cancelled'].includes(error.code) ||
    (requestSent && error.code === 'invalid_response')
  )) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The Vidu video submission outcome is unknown'
    };
  }
  if (error instanceof ViduRuntimeError) {
    return {
      kind: 'failed_before_submission',
      message: error.message,
      retryability: error.retryability
    };
  }
  return {
    kind: 'failed_before_submission',
    message: 'The Vidu video request could not be prepared',
    retryability: 'unknown'
  };
}

function sameResults(
  left: ViduVideoResultSnapshot['results'] | undefined,
  right: ViduVideoResultSnapshot['results']
): boolean {
  return left?.length === right.length && left.every((item, index) =>
    item.id === right[index]?.id && item.url === right[index]?.url
  );
}

function runtimeRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  return error instanceof ViduRuntimeError ? error.retryability : 'unknown';
}

export type { ViduVideoOperationContext };
