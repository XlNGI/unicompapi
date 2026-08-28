import { randomUUID } from 'node:crypto';
import type {
  DynamicParameterValue,
  ProviderConnection,
  ProviderImmediateResultReference,
  ProviderSubmitOutcome,
  UsageFactV1
} from '../../../domain';
import type { ProviderProtocolSubmitPort, ProviderProtocolSubmitRequest } from '../provider-operation-router';
import {
  ControlledImageMaterialError,
  type ControlledImageMaterial,
  type ControlledImageMaterialPort
} from './controlled-image-material';
import { ViduRuntimeError } from './vidu-runtime-errors';
import type { ViduSharedRuntime } from './vidu-shared-runtime';

const maximumRequestBytes = 20 * 1024 * 1024;

export interface ViduConnectionPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface ViduImageAdapterDependencies {
  readonly runtime: ViduSharedRuntime;
  readonly connections: ViduConnectionPort;
  readonly materials: ControlledImageMaterialPort;
  readonly createProviderOperationId?: () => string;
}

export interface ViduImageV1AdapterOptions {
  readonly imageInputShape?: 'string_array' | 'image_url_object_array';
  readonly base64Encoding?: 'raw' | 'data_url';
}

/** Frozen Image2 JSON contract: Bearer + images[{image_url}] data URLs. */
export const VIDU_IMAGE_V1_VERIFIED_OPTIONS: Required<ViduImageV1AdapterOptions> = {
  imageInputShape: 'image_url_object_array',
  base64Encoding: 'data_url'
};

export interface ViduAdapterRequestControl {
  readonly beforeRequestStarted?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export type ViduImageSubmitOutcome = ProviderSubmitOutcome & {
  readonly usageFacts?: readonly UsageFactV1[];
};

export class ViduImageV1Adapter implements ProviderProtocolSubmitPort {
  private readonly options: Required<ViduImageV1AdapterOptions>;

  constructor(
    private readonly dependencies: ViduImageAdapterDependencies,
    options: ViduImageV1AdapterOptions = VIDU_IMAGE_V1_VERIFIED_OPTIONS
  ) {
    this.options = {
      imageInputShape: options.imageInputShape ?? VIDU_IMAGE_V1_VERIFIED_OPTIONS.imageInputShape,
      base64Encoding: options.base64Encoding ?? VIDU_IMAGE_V1_VERIFIED_OPTIONS.base64Encoding
    };
  }

  async submit(
    request: ProviderProtocolSubmitRequest,
    control: ViduAdapterRequestControl = {}
  ): Promise<ViduImageSubmitOutcome> {
    const providerOperationId = this.createOperationId();
    let requestStarted = false;
    try {
      validateCommonRequest(request, 'vidu.ent.v1.images', 'vidu_image_v1');
      if (request.binding.authScheme !== 'bearer') {
        return failedBeforeSubmission(
          'The Image V1 authorization scheme must be bearer',
          'not_retryable'
        );
      }
      const image = requireImageSubmission(request);
      const purpose = image.purpose;
      if (purpose !== 'image_generation' && purpose !== 'image_editing') {
        return failedBeforeSubmission(
          'The Image V1 adapter does not support this operation',
          'not_retryable'
        );
      }
      if (
        request.evidence.capability !== purpose ||
        !request.binding.supportedPurposes.includes(purpose)
      ) {
        throw new ViduImageAdapterError(
          'The Image V1 capability does not match the task',
          'not_retryable'
        );
      }
      const expectedInputs = purpose === 'image_editing' ? 1 : 0;
      assertSingleInputCount(request, expectedInputs);
      const connection = await requireConnection(
        this.dependencies.connections,
        request.model.connectionId
      );
      const body: Record<string, unknown> = {
        prompt: requirePrompt(request),
        ...imageV1Parameters(image.parameters),
        n: 1
      };
      if (purpose === 'image_editing') {
        const material = await this.dependencies.materials.resolve({
          projectId: request.task.projectId,
          assetId: request.task.submission.assetIds![0]
        });
        body.images = this.encodeImageInput(material);
      }
      const serialized = serializeBoundedJson(body);
      const response = await this.dependencies.runtime.request({
        connection,
        binding: request.binding,
        method: 'POST',
        path: purpose === 'image_editing'
          ? '/ent/v1/images/edits'
          : '/ent/v1/images/generations',
        body: serialized,
        contentType: 'application/json',
        authScheme: 'bearer',
        maxRequestBytes: maximumRequestBytes,
        maxResponseBytes: 2 * 1024 * 1024,
        signal: control.signal,
        beforeRequestStarted: async () => {
          await control.beforeRequestStarted?.();
          requestStarted = true;
        }
      });
      const parsed = parseImageV1Response(response.body);
      return {
        kind: 'completed_sync',
        providerOperationId,
        results: [parsed.result],
        ...(parsed.credits ? { usageFacts: [creditFact(parsed.credits)] } : {})
      };
    } catch (error) {
      return mapSubmitFailure(error, providerOperationId, requestStarted);
    }
  }

  private encodeImageInput(material: ControlledImageMaterial): readonly unknown[] {
    const value = this.options.base64Encoding === 'data_url'
      ? `data:${material.mimeType};base64,${material.base64}`
      : material.base64;
    return this.options.imageInputShape === 'string_array'
      ? [value]
      : [{ image_url: value }];
  }

  private createOperationId(): string {
    return requireNonBlank(
      this.dependencies.createProviderOperationId?.() ??
        `vidu-image-v1-${randomUUID()}`,
      'provider operation ID'
    );
  }
}

export class ViduGeminiImageV2Adapter implements ProviderProtocolSubmitPort {
  constructor(private readonly dependencies: ViduImageAdapterDependencies) {}

  async submit(
    request: ProviderProtocolSubmitRequest,
    control: ViduAdapterRequestControl = {}
  ): Promise<ViduImageSubmitOutcome> {
    const providerOperationId = this.createOperationId();
    let requestStarted = false;
    try {
      validateCommonRequest(
        request,
        'vidu.ent.v2.image.reference2image',
        'vidu_gemini_image_v2'
      );
      if (request.binding.authScheme !== 'token') {
        return failedBeforeSubmission(
          'The Gemini Image V2 authorization scheme is unavailable',
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
          'The Gemini Image V2 adapter does not support this operation',
          'not_retryable'
        );
      }
      if (
        request.evidence.capability !== purpose ||
        !request.binding.supportedPurposes.includes(purpose)
      ) {
        throw new ViduImageAdapterError(
          'The Gemini image capability does not match the task',
          'not_retryable'
        );
      }
      const expectedInputs =
        purpose === 'image_generation' ? 0 : 1;
      assertSingleInputCount(request, expectedInputs);
      const connection = await requireConnection(
        this.dependencies.connections,
        request.model.connectionId
      );
      const generationConfig = geminiGenerationConfig(image.parameters);
      const parts: Array<Record<string, unknown>> = [
        { text: requirePrompt(request) }
      ];
      if (expectedInputs === 1) {
        const material = await this.dependencies.materials.resolve({
          projectId: request.task.projectId,
          assetId: request.task.submission.assetIds![0]
        });
        parts.push({
          inlineData: {
            mimeType: material.mimeType,
            data: material.base64
          }
        });
      }
      const body = {
        content: [{
          role: 'user',
          part: parts
        }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          ...(generationConfig ? { imageConfig: generationConfig } : {})
        }
      };
      const serialized = serializeBoundedJson(body);
      const modelKey = requireModelPathSegment(request.model.providerModelKey);
      const response = await this.dependencies.runtime.request({
        connection,
        binding: request.binding,
        method: 'POST',
        path: `/ent/v2/image/reference2image/${modelKey}`,
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
      const parsed = parseGeminiImageResponse(response.body);
      return {
        kind: 'completed_sync',
        providerOperationId,
        results: [{ kind: 'file_uri', value: parsed.fileUri }],
        ...(parsed.credits ? { usageFacts: [creditFact(parsed.credits)] } : {})
      };
    } catch (error) {
      return mapSubmitFailure(error, providerOperationId, requestStarted);
    }
  }

  private createOperationId(): string {
    return requireNonBlank(
      this.dependencies.createProviderOperationId?.() ??
        `vidu-gemini-image-v2-${randomUUID()}`,
      'provider operation ID'
    );
  }
}

class ViduImageAdapterError extends Error {
  constructor(
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'ViduImageAdapterError';
  }
}

function validateCommonRequest(
  request: ProviderProtocolSubmitRequest,
  protocolId: string,
  adapterKind: string
): void {
  if (
    request.execution.taskId !== request.task.id ||
    request.execution.state !== 'submitting' ||
    request.model.mediaKind !== 'image' ||
    request.binding.mediaKind !== 'image' ||
    request.binding.executionLifecycle !== 'synchronous_completed' ||
    request.binding.protocolId !== protocolId ||
    request.binding.adapterKind !== adapterKind ||
    request.model.protocolBindingId !== request.binding.id ||
    request.model.providerId !== request.binding.providerId ||
    request.model.connectionId !== request.binding.connectionId ||
    request.evidence.modelId !== request.model.id ||
    request.task.submission.image?.modelId !== request.model.id ||
    request.task.submission.image.capabilityEvidenceId !== request.evidence.id ||
    request.task.submission.image.providerId !== request.model.providerId ||
    request.task.submission.image.connectionId !== request.model.connectionId
  ) {
    throw new ViduImageAdapterError(
      'The image operation does not match the protocol binding',
      'not_retryable'
    );
  }
}

function requireImageSubmission(request: ProviderProtocolSubmitRequest) {
  const image = request.task.submission.image;
  if (!image || !request.task.submission.assetIds) {
    throw new ViduImageAdapterError('The image task is invalid', 'not_retryable');
  }
  return image;
}

function assertSingleInputCount(
  request: ProviderProtocolSubmitRequest,
  expected: 0 | 1
): void {
  const assetIds = request.task.submission.assetIds;
  if (!assetIds || assetIds.length !== expected || new Set(assetIds).size !== expected) {
    throw new ViduImageAdapterError(
      expected === 1
        ? 'Exactly one controlled image input is required'
        : 'This image operation does not accept input images',
      'not_retryable'
    );
  }
}

function requirePrompt(request: ProviderProtocolSubmitRequest): string {
  const prompt = request.task.submission.prompt?.finalPrompt.trim();
  if (!prompt) {
    throw new ViduImageAdapterError('The final prompt is required', 'not_retryable');
  }
  return prompt;
}

async function requireConnection(
  connections: ViduConnectionPort,
  connectionId: string
): Promise<ProviderConnection> {
  const connection = await connections.get(connectionId);
  if (!connection || connection.id !== connectionId) {
    throw new ViduImageAdapterError(
      'The Vidu connection is unavailable',
      'not_retryable'
    );
  }
  return connection;
}

function imageV1Parameters(
  parameters: Readonly<Record<string, DynamicParameterValue>>
): Record<string, unknown> {
  const allowed = new Set([
    'background',
    'output_compression',
    'output_format',
    'quality',
    'response_format',
    'size',
    'input_fidelity',
    'n'
  ]);
  for (const key of Object.keys(parameters)) {
    if (!allowed.has(key)) {
      throw new ViduImageAdapterError(
        'The image request contains an unsupported parameter',
        'not_retryable'
      );
    }
  }
  if (parameters.n !== undefined && parameters.n !== 1) {
    throw new ViduImageAdapterError('Only one image output is allowed', 'not_retryable');
  }
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key !== 'n' && parameters[key] !== undefined) {
      result[key] = parameters[key];
    }
  }
  return result;
}

function geminiGenerationConfig(
  parameters: Readonly<Record<string, DynamicParameterValue>>
): Record<string, string> | undefined {
  const aliases: Readonly<Record<string, string>> = {
    aspectRatio: 'aspectRatio',
    imageSize: 'imageSize',
    aspect_ratio: 'aspectRatio',
    resolution: 'imageSize'
  };
  const ignored = new Set(['seed']);
  for (const key of Object.keys(parameters)) {
    if (!aliases[key] && !ignored.has(key)) {
      throw new ViduImageAdapterError(
        'The Gemini image request contains an unsupported parameter',
        'not_retryable'
      );
    }
  }
  const result: Record<string, string> = {};
  for (const [inputKey, outputKey] of Object.entries(aliases)) {
    const value = parameters[inputKey];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Official docs expose seed as int; ignore for Gemini imageConfig.
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ViduImageAdapterError(
        'The Gemini image parameter is invalid',
        'not_retryable'
      );
    }
    result[outputKey] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function serializeBoundedJson(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > maximumRequestBytes) {
    throw new ViduImageAdapterError(
      'The serialized image request exceeds 20 MB',
      'not_retryable'
    );
  }
  return bytes;
}

function parseImageV1Response(body: Uint8Array): {
  readonly result: ProviderImmediateResultReference;
  readonly credits?: string;
} {
  const value = parseJsonObject(body);
  if (!Array.isArray(value.data) || value.data.length !== 1) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const result = requireRecord(value.data[0]);
  const url = optionalNonBlank(result.url);
  const base64 = optionalNonBlank(result.b64_json);
  if ((url ? 1 : 0) + (base64 ? 1 : 0) !== 1) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const outputFormat = optionalNonBlank(value.output_format)?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    webp: 'image/webp'
  };
  if (url) {
    return {
      result: { kind: 'remote_url', value: url },
      ...parseCreditAmount(value)
    };
  }
  const mimeType = outputFormat ? mimeTypes[outputFormat] : undefined;
  if (!mimeType) throw new ViduRuntimeError('invalid_response', 'unknown');
  return {
    result: { kind: 'base64', value: base64!, mimeType },
    ...parseCreditAmount(value)
  };
}

function parseGeminiImageResponse(body: Uint8Array): {
  readonly fileUri: string;
  readonly credits?: string;
} {
  const value = parseJsonObject(body);
  if (!Array.isArray(value.candidates) || value.candidates.length !== 1) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const candidate = requireRecord(value.candidates[0]);
  const content = requireRecord(candidate.content);
  if (!Array.isArray(content.parts)) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  const fileUris = content.parts.flatMap((part) => {
    if (!isRecord(part) || !isRecord(part.fileData)) return [];
    const uri = optionalNonBlank(part.fileData.fileUri);
    const mimeType = optionalNonBlank(part.fileData.mimeType)?.toLowerCase();
    return uri && mimeType?.startsWith('image/') ? [uri] : [];
  });
  if (fileUris.length !== 1) {
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
  return {
    fileUri: fileUris[0],
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
  return isRecord(value) ? value[key] : undefined;
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
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return requireRecord(value);
  } catch (error) {
    if (error instanceof ViduRuntimeError) throw error;
    throw new ViduRuntimeError('invalid_response', 'unknown');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ViduRuntimeError('invalid_response', 'unknown');
  return value;
}

function requireModelPathSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new ViduImageAdapterError('The provider model key is invalid', 'not_retryable');
  }
  return value;
}

function mapSubmitFailure(
  error: unknown,
  providerOperationId: string,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted) {
    // Request bytes were already handed to transport: preserve a safe, code-derived
    // message so the UI can show remote feedback without leaking response bodies.
    const message = error instanceof ViduRuntimeError ||
      error instanceof ViduImageAdapterError ||
      error instanceof ControlledImageMaterialError
      ? error.message
      : 'The synchronous Vidu submission outcome is unknown';
    return {
      kind: 'submission_outcome_unknown',
      providerOperationId,
      message
    };
  }
  if (error instanceof ViduImageAdapterError) {
    return failedBeforeSubmission(error.message, error.retryability);
  }
  if (error instanceof ControlledImageMaterialError) {
    return failedBeforeSubmission(error.message, 'not_retryable');
  }
  if (error instanceof ViduRuntimeError) {
    return failedBeforeSubmission(error.message, error.retryability);
  }
  return failedBeforeSubmission(
    'The Vidu image request could not be prepared',
    'unknown'
  );
}

function failedBeforeSubmission(
  message: string,
  retryability: 'retryable' | 'not_retryable' | 'unknown'
): ProviderSubmitOutcome {
  return { kind: 'failed_before_submission', message, retryability };
}

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} is required`);
  return trimmed;
}

function optionalNonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
