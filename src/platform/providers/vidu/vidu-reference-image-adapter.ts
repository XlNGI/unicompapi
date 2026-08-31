import { randomUUID } from 'node:crypto';
import type {
  DynamicParameterValue,
  ProviderConnection,
  ProviderSubmitOutcome,
  UsageFactV1
} from '../../../domain';
import type {
  ProviderProtocolSubmitPort,
  ProviderProtocolSubmitRequest
} from '../provider-operation-router';
import {
  ControlledImageMaterialError,
  type ControlledImageMaterialPort
} from './controlled-image-material';
import type {
  ViduAdapterRequestControl,
  ViduConnectionPort,
  ViduImageAdapterDependencies,
  ViduImageSubmitOutcome
} from './vidu-image-adapters';
import { ViduRuntimeError } from './vidu-runtime-errors';
import type { ViduSharedRuntime } from './vidu-shared-runtime';

const maximumRequestBytes = 20 * 1024 * 1024;
const maximumPollAttempts = 120;
const initialPollDelayMs = 1_000;
const maximumPollDelayMs = 30_000;

/**
 * Official Vidu reference2image adapter (viduq2 / viduq1).
 * Uses POST /ent/v2/reference2image then short-polls creations, returning
 * completed_sync so the existing image result receiver path keeps working.
 */
export class ViduReferenceImageV2Adapter implements ProviderProtocolSubmitPort {
  constructor(private readonly dependencies: ViduImageAdapterDependencies) {}

  async submit(
    request: ProviderProtocolSubmitRequest,
    control: ViduAdapterRequestControl = {}
  ): Promise<ViduImageSubmitOutcome> {
    const providerOperationId = this.createOperationId();
    let requestStarted = false;
    try {
      validateOfficialRequest(request);
      if (request.binding.authScheme !== 'token') {
        return failedBeforeSubmission(
          'The official reference2image authorization scheme is unavailable',
          'not_retryable'
        );
      }
      const image = requireImageSubmission(request);
      const purpose = image.purpose;
      if (
        purpose !== 'reference_to_image' &&
        purpose !== 'image_generation' &&
        purpose !== 'image_editing'
      ) {
        return failedBeforeSubmission(
          'The official reference2image adapter does not support this operation',
          'not_retryable'
        );
      }
      if (
        request.evidence.capability !== purpose ||
        !request.binding.supportedPurposes.includes(purpose)
      ) {
        throw new ViduReferenceImageAdapterError(
          'The official image capability does not match the task',
          'not_retryable'
        );
      }
      const expectedInputs = purpose === 'image_generation' ? 0 : 1;
      assertSingleInputCount(request, expectedInputs);
      const connection = await requireConnection(
        this.dependencies.connections,
        request.model.connectionId
      );
      const body: Record<string, unknown> = {
        model: request.model.providerModelKey,
        prompt: requirePrompt(request),
        ...officialImageParameters(request.model.providerModelKey, image.parameters)
      };
      if (expectedInputs === 1) {
        const material = await this.dependencies.materials.resolve({
          projectId: request.task.projectId,
          assetId: request.task.submission.assetIds![0]
        });
        body.images = [
          `data:${material.mimeType};base64,${material.base64}`
        ];
      }
      const serialized = serializeBoundedJson(body);
      const createResponse = await this.dependencies.runtime.request({
        connection,
        binding: request.binding,
        method: 'POST',
        path: '/ent/v2/reference2image',
        body: serialized,
        contentType: 'application/json',
        authScheme: 'token',
        maxRequestBytes: maximumRequestBytes,
        maxResponseBytes: 2 * 1024 * 1024,
        signal: control.signal,
        beforeRequestStarted: async () => {
          await control.beforeRequestStarted?.();
          requestStarted = true;
        }
      });
      const taskId = parseTaskId(createResponse.body);
      const result = await this.pollForImageResult(
        connection,
        request,
        taskId,
        control.signal
      );
      return {
        kind: 'completed_sync',
        providerOperationId: taskId || providerOperationId,
        results: [{ kind: 'remote_url', value: result.url }],
        ...(result.credits ? { usageFacts: [creditFact(result.credits)] } : {})
      };
    } catch (error) {
      return mapSubmitFailure(error, providerOperationId, requestStarted);
    }
  }

  private async pollForImageResult(
    connection: ProviderConnection,
    request: ProviderProtocolSubmitRequest,
    taskId: string,
    signal?: AbortSignal
  ): Promise<{ readonly url: string; readonly credits?: string }> {
    let delayMs = initialPollDelayMs;
    for (let attempt = 0; attempt < maximumPollAttempts; attempt += 1) {
      if (signal?.aborted) {
        throw new ViduRuntimeError('cancelled', 'not_retryable');
      }
      const response = await this.dependencies.runtime.request({
        connection,
        binding: request.binding,
        method: 'GET',
        path: `/ent/v2/tasks/${taskId}/creations`,
        authScheme: 'token',
        maxResponseBytes: 2 * 1024 * 1024,
        signal
      });
      const parsed = parseTaskResponse(response.body);
      if (parsed.state === 'success') {
        if (!parsed.url) {
          throw new ViduRuntimeError('invalid_response', 'unknown');
        }
        return {
          url: parsed.url,
          ...(parsed.credits ? { credits: parsed.credits } : {})
        };
      }
      if (parsed.state === 'failed') {
        throw new ViduReferenceImageAdapterError(
          'Vidu reported that the image generation failed',
          'not_retryable'
        );
      }
      await sleep(delayMs, signal);
      delayMs = Math.min(
        maximumPollDelayMs,
        Math.floor(delayMs * 1.5) + Math.floor(Math.random() * 250)
      );
    }
    throw new ViduRuntimeError('timeout', 'retryable');
  }

  private createOperationId(): string {
    return (
      this.dependencies.createProviderOperationId?.() ??
      `vidu-reference-image-v2-${randomUUID()}`
    );
  }
}

class ViduReferenceImageAdapterError extends Error {
  constructor(
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'ViduReferenceImageAdapterError';
  }
}

function validateOfficialRequest(request: ProviderProtocolSubmitRequest): void {
  if (
    request.execution.taskId !== request.task.id ||
    request.execution.state !== 'submitting' ||
    request.model.mediaKind !== 'image' ||
    request.binding.mediaKind !== 'image' ||
    request.binding.executionLifecycle !== 'synchronous_completed' ||
    request.binding.protocolId !== 'vidu.ent.v2.reference2image' ||
    request.binding.adapterKind !== 'vidu_reference_image_v2' ||
    request.model.protocolBindingId !== request.binding.id ||
    request.model.providerId !== request.binding.providerId ||
    request.model.connectionId !== request.binding.connectionId ||
    request.evidence.modelId !== request.model.id ||
    request.task.submission.image?.modelId !== request.model.id ||
    request.task.submission.image.capabilityEvidenceId !== request.evidence.id ||
    request.task.submission.image.providerId !== request.model.providerId ||
    request.task.submission.image.connectionId !== request.model.connectionId
  ) {
    throw new ViduReferenceImageAdapterError(
      'The image operation does not match the protocol binding',
      'not_retryable'
    );
  }
}

function requireImageSubmission(request: ProviderProtocolSubmitRequest) {
  const image = request.task.submission.image;
  if (!image || !request.task.submission.assetIds) {
    throw new ViduReferenceImageAdapterError(
      'The image task is invalid',
      'not_retryable'
    );
  }
  return image;
}

function assertSingleInputCount(
  request: ProviderProtocolSubmitRequest,
  expected: 0 | 1
): void {
  const assetIds = request.task.submission.assetIds;
  if (!assetIds || assetIds.length !== expected || new Set(assetIds).size !== expected) {
    throw new ViduReferenceImageAdapterError(
      expected === 1
        ? 'Exactly one controlled image input is required'
        : 'This image operation does not accept input images',
      'not_retryable'
    );
  }
}

function requirePrompt(request: ProviderProtocolSubmitRequest): string {
  const prompt = request.task.submission.prompt?.finalPrompt.trim();
  if (!prompt || prompt.length > 2_000) {
    throw new ViduReferenceImageAdapterError(
      'The final prompt is required and must be at most 2000 characters',
      'not_retryable'
    );
  }
  return prompt;
}

async function requireConnection(
  connections: ViduConnectionPort,
  connectionId: string
): Promise<ProviderConnection> {
  const connection = await connections.get(connectionId);
  if (!connection || connection.id !== connectionId) {
    throw new ViduReferenceImageAdapterError(
      'The Vidu connection is unavailable',
      'not_retryable'
    );
  }
  return connection;
}

function officialImageParameters(
  modelKey: string,
  parameters: Readonly<Record<string, DynamicParameterValue>>
): Record<string, string | number> {
  const allowed = new Set(['aspect_ratio', 'resolution', 'seed']);
  for (const key of Object.keys(parameters)) {
    if (!allowed.has(key)) {
      throw new ViduReferenceImageAdapterError(
        'The official image request contains an unsupported parameter',
        'not_retryable'
      );
    }
  }
  const result: Record<string, string | number> = {};
  const aspect = parameters.aspect_ratio;
  if (aspect !== undefined) {
    const normalized = typeof aspect === 'string' ? aspect.trim() : '';
    if (!aspectOptions(modelKey).includes(normalized)) {
      throw new ViduReferenceImageAdapterError(
        'The official image aspect ratio is outside the option set',
        'not_retryable'
      );
    }
    result.aspect_ratio = normalized;
  }
  const resolution = parameters.resolution;
  if (resolution !== undefined) {
    const normalized = typeof resolution === 'string' ? resolution.trim() : '';
    if (!resolutionOptions(modelKey).includes(normalized)) {
      throw new ViduReferenceImageAdapterError(
        'The official image resolution is outside the option set',
        'not_retryable'
      );
    }
    result.resolution = normalized;
  }
  const seed = parameters.seed;
  if (seed !== undefined) {
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) {
      throw new ViduReferenceImageAdapterError(
        'The official image parameter is invalid',
        'not_retryable'
      );
    }
    result.seed = seed;
  }
  return result;
}

function aspectOptions(modelKey: string): readonly string[] {
  if (modelKey === 'viduq1') return ['16:9', '9:16', '1:1', '3:4', '4:3'];
  return [
    '16:9',
    '9:16',
    '1:1',
    '3:4',
    '4:3',
    '21:9',
    '2:3',
    '3:2',
    'auto'
  ];
}

function resolutionOptions(modelKey: string): readonly string[] {
  return modelKey === 'viduq1' ? ['1080p'] : ['1080p', '2K', '4K'];
}

function serializeBoundedJson(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > maximumRequestBytes) {
    throw new ViduReferenceImageAdapterError(
      'The serialized Vidu image request exceeds 20 MB',
      'not_retryable'
    );
  }
  return bytes;
}

function parseTaskId(body: Uint8Array): string {
  const value = parseJsonObject(body);
  const taskId = value.task_id;
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new ViduRuntimeError('invalid_response', 'not_retryable');
  }
  return taskId;
}

function parseTaskResponse(body: Uint8Array): {
  readonly state: 'created' | 'queueing' | 'processing' | 'success' | 'failed';
  readonly url?: string;
  readonly credits?: string;
} {
  const value = parseJsonObject(body);
  const state = value.state;
  if (
    !['created', 'queueing', 'processing', 'success', 'failed'].includes(
      String(state)
    )
  ) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  if (state !== 'success') {
    return {
      state: state as 'created' | 'queueing' | 'processing' | 'failed'
    };
  }
  if (!Array.isArray(value.creations) || value.creations.length !== 1) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const creation = value.creations[0];
  if (typeof creation !== 'object' || creation === null || Array.isArray(creation)) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const url = (creation as Record<string, unknown>).url;
  if (typeof url !== 'string') {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ViduRuntimeError('invalid_response', 'not_retryable');
  }
  return {
    state: 'success',
    url: parsed.toString(),
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
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ViduRuntimeError('invalid_response', 'unknown');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ViduRuntimeError) throw error;
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
}

function mapSubmitFailure(
  error: unknown,
  providerOperationId: string,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted) {
    const message =
      error instanceof ViduRuntimeError ||
      error instanceof ViduReferenceImageAdapterError ||
      error instanceof ControlledImageMaterialError
        ? error.message
        : 'The official Vidu image submission outcome is unknown';
    return {
      kind: 'submission_outcome_unknown',
      providerOperationId,
      message
    };
  }
  if (error instanceof ViduReferenceImageAdapterError) {
    return failedBeforeSubmission(error.message, error.retryability);
  }
  if (error instanceof ControlledImageMaterialError) {
    return failedBeforeSubmission(error.message, 'not_retryable');
  }
  if (error instanceof ViduRuntimeError) {
    return failedBeforeSubmission(error.message, error.retryability);
  }
  return failedBeforeSubmission(
    'The official Vidu image request could not be prepared',
    'unknown'
  );
}

function failedBeforeSubmission(
  message: string,
  retryability: 'retryable' | 'not_retryable' | 'unknown'
): ProviderSubmitOutcome {
  return { kind: 'failed_before_submission', message, retryability };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ViduRuntimeError('cancelled', 'not_retryable'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ViduRuntimeError('cancelled', 'not_retryable'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Re-export material port type for package wiring convenience.
export type { ControlledImageMaterialPort, ViduSharedRuntime };
