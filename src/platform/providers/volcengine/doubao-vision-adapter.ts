import { randomUUID } from 'node:crypto';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toIsoTimestamp,
  validateParameterValues,
  type ImageObservationSet,
  type IsoTimestamp,
  type ParameterValue,
  type PromptSupplement,
  type ProviderConnection,
  type ProviderInvocationAttemptId,
  type ProviderUsageObservationId,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageFactV1,
  type UsageSchemaV1
} from '../../../domain';
import {
  DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID,
  DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID,
  DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID,
  DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID,
  DOUBAO_VISION_ADAPTER_ID,
  DOUBAO_VISION_ADAPTER_VERSION,
  DOUBAO_VISION_CONSTRAINT_SET_ID,
  DOUBAO_VISION_USAGE_SCHEMA_ID,
  VOLCENGINE_ENDPOINT_POLICY_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_VERSION,
  doubaoImageToPromptParameterSchema,
  doubaoImageUnderstandingParameterSchema,
  doubaoVisionUsageSchema
} from './volcengine-contracts';
import {
  VolcengineRuntimeError,
  type VolcengineSharedRuntime
} from './volcengine-runtime';

const maximumImageBytes = 10_000_000;
const maximumRequestBytes = 64_000_000;
const maximumObservationItems = 64;
const supportedMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp'
]);

export interface DoubaoVisionCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface DoubaoVisionConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface ControlledVisionImageV1 {
  readonly assetId: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

export interface ControlledVisionImagePort {
  resolve(input: {
    readonly projectId: string;
    readonly assetId: string;
  }): Promise<ControlledVisionImageV1>;
}

export interface DoubaoVisionUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface DoubaoVisionAdapterIdFactory {
  nextProviderOperationId(): string;
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface DoubaoVisionTerminalObserverPort {
  completed?(input: {
    readonly providerOperationId: string;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly productFeature: 'image_understanding' | 'image_to_prompt';
  }): Promise<void>;
  failed?(input: {
    readonly providerOperationId: string;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly safeCode: string;
  }): Promise<void>;
  cancelled?(input: {
    readonly providerOperationId: string;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
  }): Promise<void>;
  interrupted?(input: {
    readonly providerOperationId: string;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly reason: 'application_shutdown';
  }): Promise<void>;
}

export interface DoubaoVisionRegionV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DoubaoVisionDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly assetId: string;
  readonly purpose?: string;
  readonly requirements: readonly string[];
  readonly region?: DoubaoVisionRegionV1;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

export interface DoubaoImageToPromptDraftV1 {
  readonly finalPrompt: string;
  readonly systemSupplements: readonly PromptSupplement[];
}

export interface DoubaoVisionResultV1 {
  readonly schemaVersion: 1;
  readonly productFeature: 'image_understanding' | 'image_to_prompt';
  readonly observations: ImageObservationSet;
  readonly promptDraft?: DoubaoImageToPromptDraftV1;
}

export type DoubaoVisionTerminalResult =
  | {
      readonly state: 'completed';
      readonly providerOperationId: string;
      readonly result: DoubaoVisionResultV1;
      readonly usageAvailability: 'reported' | 'not_reported';
    }
  | {
      readonly state: 'failed';
      readonly providerOperationId: string;
      readonly safeCode: string;
    }
  | {
      readonly state: 'cancelled';
      readonly providerOperationId: string;
    }
  | {
      readonly state: 'interrupted';
      readonly providerOperationId: string;
      readonly reason: 'application_shutdown';
    };

export interface DoubaoVisionOperationHandle {
  readonly providerOperationId: string;
  readonly completion: Promise<DoubaoVisionTerminalResult>;
}

interface ActiveOperation {
  readonly providerOperationId: string;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly productFeature: 'image_understanding' | 'image_to_prompt';
  readonly controller: AbortController;
  readonly removeExternalAbort: () => void;
  requestStarted: boolean;
  cancelReason?: 'user' | 'application_shutdown';
  completion?: Promise<DoubaoVisionTerminalResult>;
}

interface ParsedVisionResponse {
  readonly observations?: ImageObservationSet;
  readonly usage?: readonly UsageFactV1[];
  readonly terminalSafeCode?: string;
}

export class DoubaoVisionAdapter {
  private readonly active = new Map<string, ActiveOperation>();
  private disposed = false;

  constructor(
    private readonly runtime: VolcengineSharedRuntime,
    private readonly connections: DoubaoVisionConnectionResolverPort,
    private readonly credentials: DoubaoVisionCredentialResolverPort,
    private readonly images: ControlledVisionImagePort,
    private readonly usage: DoubaoVisionUsageObservationSinkPort,
    private readonly ids: DoubaoVisionAdapterIdFactory = {
      nextProviderOperationId: () => `doubao-vision-${randomUUID()}`,
      nextProviderUsageObservationId: () =>
        `doubao-vision-usage-${randomUUID()}` as ProviderUsageObservationId
    },
    private readonly terminalObserver: DoubaoVisionTerminalObserverPort = {},
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<DoubaoVisionOperationHandle> {
    if (this.disposed) {
      throw new VolcengineRuntimeError(
        'runtime_shutting_down',
        'not_retryable'
      );
    }
    const route = validateRoute(input.routeSnapshot);
    const request = parseDispatchRequest(input.request, route.productFeature);
    const [connection, image] = await Promise.all([
      this.requireConnection(route),
      this.images.resolve({
        projectId: request.projectId,
        assetId: request.assetId
      })
    ]);
    const body = serializeVisionRequest(route, request, validateImage(image, request));
    const providerOperationId = requireOpaqueId(
      this.ids.nextProviderOperationId(),
      'provider operation ID'
    );
    if (this.active.has(providerOperationId)) {
      throw invalidRequest(
        'volcengine.operation_id_conflict',
        'Volcengine operation IDs must be unique'
      );
    }
    const controller = new AbortController();
    let operation: ActiveOperation;
    const onExternalAbort = () => {
      operation.cancelReason ??= 'user';
      controller.abort();
    };
    const removeExternalAbort = () =>
      input.signal?.removeEventListener('abort', onExternalAbort);
    operation = {
      providerOperationId,
      invocationAttemptId: request.invocationAttemptId,
      productFeature: route.productFeature,
      controller,
      removeExternalAbort,
      requestStarted: false
    };
    if (input.signal?.aborted) onExternalAbort();
    else input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    this.active.set(providerOperationId, operation);
    const completion = this.execute(
      operation,
      route,
      request,
      connection,
      body,
      input.beforeRequestStarted
    );
    operation.completion = completion;
    return { providerOperationId, completion };
  }

  async cancel(providerOperationId: string): Promise<boolean> {
    const operation = this.active.get(
      requireOpaqueId(providerOperationId, 'provider operation ID')
    );
    if (!operation) return false;
    operation.cancelReason ??= 'user';
    operation.controller.abort();
    await operation.completion;
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const operations = [...this.active.values()];
    for (const operation of operations) {
      operation.cancelReason = 'application_shutdown';
      operation.controller.abort();
    }
    await Promise.all(operations.map((operation) => operation.completion));
    this.runtime.dispose();
  }

  get activeOperationCount(): number {
    return this.active.size;
  }

  private async execute(
    operation: ActiveOperation,
    route: ReturnType<typeof validateRoute>,
    request: DoubaoVisionDispatchRequestV1,
    connection: ProviderConnection,
    body: Uint8Array,
    beforeRequestStarted?: () => Promise<void>
  ): Promise<DoubaoVisionTerminalResult> {
    let usagePersisted = false;
    try {
      const responseBody = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.requestVisionChat({
          connection,
          credentials: credential,
          body,
          signal: operation.controller.signal,
          beforeRequestStarted: async () => {
            operation.requestStarted = true;
            await beforeRequestStarted?.();
          }
        })
      );
      const response = parseVisionResponse(
        responseBody,
        route.providerModelKey!
      );
      await this.persistUsage(
        operation,
        response.usage ? 'reported' : 'not_reported',
        response.usage ?? []
      );
      usagePersisted = true;
      if (response.terminalSafeCode) {
        await this.terminalObserver.failed?.({
          providerOperationId: operation.providerOperationId,
          invocationAttemptId: operation.invocationAttemptId,
          safeCode: response.terminalSafeCode
        });
        return {
          state: 'failed',
          providerOperationId: operation.providerOperationId,
          safeCode: response.terminalSafeCode
        };
      }
      if (!response.observations) {
        throw invalidResponse('Volcengine did not return image observations');
      }
      const result = createResult(
        route.productFeature,
        response.observations,
        request
      );
      await this.terminalObserver.completed?.({
        providerOperationId: operation.providerOperationId,
        invocationAttemptId: operation.invocationAttemptId,
        productFeature: route.productFeature
      });
      return {
        state: 'completed',
        providerOperationId: operation.providerOperationId,
        result,
        usageAvailability: response.usage ? 'reported' : 'not_reported'
      };
    } catch (error) {
      if (operation.cancelReason === 'user') {
        if (!usagePersisted) {
          await this.persistUsage(operation, 'not_reported', []).catch(
            () => undefined
          );
        }
        await this.terminalObserver.cancelled?.({
          providerOperationId: operation.providerOperationId,
          invocationAttemptId: operation.invocationAttemptId
        });
        return {
          state: 'cancelled',
          providerOperationId: operation.providerOperationId
        };
      }
      if (operation.cancelReason === 'application_shutdown') {
        if (!usagePersisted) {
          await this.persistUsage(operation, 'unknown_outcome', []).catch(
            () => undefined
          );
        }
        await this.terminalObserver.interrupted?.({
          providerOperationId: operation.providerOperationId,
          invocationAttemptId: operation.invocationAttemptId,
          reason: 'application_shutdown'
        });
        return {
          state: 'interrupted',
          providerOperationId: operation.providerOperationId,
          reason: 'application_shutdown'
        };
      }
      if (!usagePersisted) {
        const status = isInvalidResponse(error)
          ? 'invalid_response'
          : operation.requestStarted
            ? 'unknown_outcome'
            : 'not_reported';
        await this.persistUsage(operation, status, []).catch(() => undefined);
      }
      const safeCode = safeCodeForError(error);
      await this.terminalObserver.failed?.({
        providerOperationId: operation.providerOperationId,
        invocationAttemptId: operation.invocationAttemptId,
        safeCode
      });
      return {
        state: 'failed',
        providerOperationId: operation.providerOperationId,
        safeCode
      };
    } finally {
      operation.removeExternalAbort();
      this.active.delete(operation.providerOperationId);
    }
  }

  private async requireConnection(
    route: ReturnType<typeof validateRoute>
  ): Promise<ProviderConnection> {
    const connection = await this.connections.get(route.connectionId);
    if (
      !connection ||
      connection.id !== route.connectionId ||
      connection.connectionRevision !== route.connectionRevision ||
      connection.connectionConfigVersionId !== route.connectionConfigVersionId ||
      connection.credentialVersionId !== route.credentialVersionId
    ) {
      throw invalidRequest(
        'volcengine.connection_snapshot_unavailable',
        'The exact Volcengine connection snapshot is unavailable'
      );
    }
    return connection;
  }

  private async persistUsage(
    operation: ActiveOperation,
    status: 'reported' | 'not_reported' | 'invalid_response' | 'unknown_outcome',
    facts: readonly UsageFactV1[]
  ): Promise<void> {
    await this.usage.append(
      createProviderUsageObservation({
        id: this.ids.nextProviderUsageObservationId(),
        invocationAttemptId: operation.invocationAttemptId,
        usageSchemaId: doubaoVisionUsageSchema.id,
        usageSchemaRevision: doubaoVisionUsageSchema.revision,
        sourceEventKey: `volcengine_usage_${operation.providerOperationId}`,
        sequence: 1,
        status,
        sourceStage: 'result',
        facts,
        observedAt: this.now()
      }, doubaoVisionUsageSchema),
      doubaoVisionUsageSchema
    );
  }
}

export function mapVolcengineChatUsage(value: unknown): readonly UsageFactV1[] {
  const usage = exactRecord(
    value,
    ['completion_tokens', 'prompt_tokens', 'total_tokens'],
    ['prompt_tokens_details', 'completion_tokens_details'],
    'Volcengine usage'
  );
  const completionTokens = nonNegativeInteger(
    usage.completion_tokens,
    'completion_tokens'
  );
  const promptTokens = nonNegativeInteger(
    usage.prompt_tokens,
    'prompt_tokens'
  );
  const totalTokens = nonNegativeInteger(usage.total_tokens, 'total_tokens');
  if (totalTokens !== promptTokens + completionTokens) {
    throw invalidResponse('Volcengine total token usage is inconsistent');
  }
  const facts: UsageFactV1[] = [
    tokenFact('completion_tokens', completionTokens),
    tokenFact('prompt_tokens', promptTokens),
    tokenFact('total_tokens', totalTokens)
  ];
  if (usage.prompt_tokens_details !== undefined) {
    const details = exactRecord(
      usage.prompt_tokens_details,
      [],
      ['cached_tokens'],
      'Volcengine prompt token details'
    );
    const cachedTokens = optionalNonNegativeInteger(
      details.cached_tokens,
      'cached_tokens'
    );
    if (cachedTokens !== undefined) {
      if (cachedTokens > promptTokens) {
        throw invalidResponse('Volcengine cached token usage is inconsistent');
      }
      facts.push(tokenFact('cached_tokens', cachedTokens));
    }
  }
  if (usage.completion_tokens_details !== undefined) {
    const details = exactRecord(
      usage.completion_tokens_details,
      [],
      ['reasoning_tokens'],
      'Volcengine completion token details'
    );
    const reasoningTokens = optionalNonNegativeInteger(
      details.reasoning_tokens,
      'reasoning_tokens'
    );
    if (reasoningTokens !== undefined) {
      if (reasoningTokens > completionTokens) {
        throw invalidResponse(
          'Volcengine reasoning token usage is inconsistent'
        );
      }
      facts.push(tokenFact('reasoning_tokens', reasoningTokens));
    }
  }
  return facts;
}

export function buildDoubaoImageToPromptDraft(input: {
  readonly purpose: string;
  readonly requirements: readonly string[];
  readonly observations: ImageObservationSet;
}): DoubaoImageToPromptDraftV1 {
  const purpose = boundedUserText(input.purpose, 'purpose', 500, true);
  const requirements = parseRequirements(input.requirements);
  const sections = [
    `目标用途：${purpose}`,
    listSection('画面中可直接确认的内容', input.observations.visibleFacts),
    listSection('可参考的构图、风格与语义推断', input.observations.modelInferences),
    requirements.length > 0
      ? `补充要求：${requirements.join('；')}`
      : undefined
  ].filter((value): value is string => Boolean(value));
  const finalPrompt = sections.join('\n');
  if (finalPrompt.length > 3_000) {
    throw invalidResponse('The derived image prompt exceeds the local contract');
  }
  const systemSupplements: PromptSupplement[] = [
    ...input.observations.uncertainties.map((item) => ({
      source: 'model_format' as const,
      content: `需人工确认：${item.content}`
    })),
    ...input.observations.unrecognized.map((item) => ({
      source: 'model_format' as const,
      content: `模型无法确认：${item.content}`
    }))
  ];
  return { finalPrompt, systemSupplements };
}

export function doubaoVisionRecoveryDecision(state: string): {
  readonly sameOperationResumable: false;
  readonly action: 'none' | 'user_retry_required';
} {
  return {
    sameOperationResumable: false,
    action: state === 'interrupted' || state === 'unknown_outcome'
      ? 'user_retry_required'
      : 'none'
  };
}

function validateRoute(value: unknown) {
  const route = parseProviderExecutionRouteSnapshot(value);
  const feature = route.productFeature;
  if (
    route.packageId !== VOLCENGINE_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== VOLCENGINE_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== DOUBAO_VISION_ADAPTER_ID ||
    route.adapterVersion !== DOUBAO_VISION_ADAPTER_VERSION ||
    route.endpointPolicyId !== VOLCENGINE_ENDPOINT_POLICY_ID ||
    route.endpointPolicyRevision !== 1 ||
    route.usageSchemaId !== DOUBAO_VISION_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== DOUBAO_VISION_CONSTRAINT_SET_ID ||
    route.constraintSetRevision !== 1 ||
    !route.providerModelKey ||
    !['image_understanding', 'image_to_prompt'].includes(feature)
  ) {
    throw invalidRequest(
      'volcengine.route_mismatch',
      'The route snapshot does not select the exact Doubao vision contract'
    );
  }
  const expected = feature === 'image_understanding'
    ? {
        purpose: 'image_understanding',
        parameterSchemaId: DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID,
        resultSchemaId: DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID
      }
    : {
        purpose: 'image_to_prompt',
        parameterSchemaId: DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID,
        resultSchemaId: DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID
      };
  if (
    route.internalPurpose !== expected.purpose ||
    route.parameterSchemaId !== expected.parameterSchemaId ||
    route.parameterSchemaRevision !== 1 ||
    route.resultSchemaId !== expected.resultSchemaId ||
    route.resultSchemaRevision !== 1
  ) {
    throw invalidRequest(
      'volcengine.route_mismatch',
      'The Doubao vision route schemas do not match the product feature'
    );
  }
  return {
    ...route,
    productFeature: feature as 'image_understanding' | 'image_to_prompt'
  };
}

function parseDispatchRequest(
  value: unknown,
  feature: 'image_understanding' | 'image_to_prompt'
): DoubaoVisionDispatchRequestV1 {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'assetId', 'requirements', 'parameterValues'],
    ['purpose', 'region'],
    'Doubao vision request'
  );
  const purpose = item.purpose === undefined
    ? undefined
    : boundedUserText(item.purpose, 'purpose', 500, false);
  if (feature === 'image_to_prompt' && !purpose) {
    throw invalidRequest(
      'volcengine.invalid_request',
      'Image-to-prompt requires an explicit purpose'
    );
  }
  const requirements = parseRequirements(item.requirements);
  if (feature === 'image_understanding' && requirements.length > 0) {
    throw invalidRequest(
      'volcengine.invalid_request',
      'Image understanding does not accept prompt requirements'
    );
  }
  const schema = feature === 'image_understanding'
    ? doubaoImageUnderstandingParameterSchema
    : doubaoImageToPromptParameterSchema;
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(
      schema,
      'full',
      item.parameterValues
    );
  } catch {
    throw invalidRequest(
      'volcengine.invalid_request',
      'The Doubao vision parameter projection is invalid'
    );
  }
  return {
    invocationAttemptId: requireOpaqueId(
      item.invocationAttemptId,
      'invocation attempt ID'
    ) as ProviderInvocationAttemptId,
    projectId: requireOpaqueId(item.projectId, 'project ID'),
    assetId: requireOpaqueId(item.assetId, 'asset ID'),
    purpose,
    requirements,
    ...(item.region === undefined ? {} : { region: parseRegion(item.region) }),
    parameterValues
  };
}

function validateImage(
  image: ControlledVisionImageV1,
  request: DoubaoVisionDispatchRequestV1
): ControlledVisionImageV1 {
  if (
    image.assetId !== request.assetId ||
    !supportedMimeTypes.has(image.mimeType.toLowerCase()) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.width <= 14 ||
    image.height <= 14 ||
    image.width * image.height < 196 ||
    image.width * image.height > 36_000_000 ||
    image.width / image.height < 1 / 150 ||
    image.width / image.height > 150 ||
    image.sizeBytes < 1 ||
    image.sizeBytes >= maximumImageBytes ||
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength !== image.sizeBytes
  ) {
    throw invalidRequest(
      'volcengine.invalid_image',
      'The controlled image does not satisfy the Doubao vision contract'
    );
  }
  return {
    ...image,
    mimeType: image.mimeType.toLowerCase(),
    bytes: Uint8Array.from(image.bytes)
  };
}

function serializeVisionRequest(
  route: ReturnType<typeof validateRoute>,
  request: DoubaoVisionDispatchRequestV1,
  image: ControlledVisionImageV1
): Uint8Array {
  const imageUrl: Record<string, unknown> = {
    url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`
  };
  const detail = request.parameterValues.detail;
  if (detail !== undefined) imageUrl.detail = detail;
  const body: Record<string, unknown> = {
    model: route.providerModelKey,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: imageUrl },
          {
            type: 'text',
            text: buildControlledInstruction(route.productFeature, request)
          }
        ]
      }
    ],
    stream: false,
    thinking: { type: 'disabled' },
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'unicomp_image_observations',
        strict: true,
        schema: observationJsonSchema
      }
    }
  };
  if (request.parameterValues.max_tokens !== undefined) {
    body.max_tokens = request.parameterValues.max_tokens;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > maximumRequestBytes) {
    throw invalidRequest(
      'volcengine.request_too_large',
      'The serialized Doubao vision request exceeds 64 MB'
    );
  }
  return bytes;
}

const observationJsonSchema = {
  type: 'object',
  properties: {
    visibleFacts: { type: 'array', items: { type: 'string' } },
    modelInferences: { type: 'array', items: { type: 'string' } },
    uncertainties: { type: 'array', items: { type: 'string' } },
    unrecognized: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'visibleFacts',
    'modelInferences',
    'uncertainties',
    'unrecognized'
  ],
  additionalProperties: false
} as const;

function buildControlledInstruction(
  feature: 'image_understanding' | 'image_to_prompt',
  request: DoubaoVisionDispatchRequestV1
): string {
  const task = feature === 'image_understanding'
    ? 'Analyze the single image. Separate directly visible facts from model inferences, uncertainties, and content that cannot be recognized.'
    : 'Analyze the single image for a local image-prompt drafting workflow. Return observations only; do not write the final prompt and do not turn uncertainty into fact.';
  const parts = [
    'Follow the supplied strict JSON schema and return no text outside the JSON value.',
    task,
    request.purpose ? `User-stated purpose: ${request.purpose}` : undefined,
    request.requirements.length > 0
      ? `User-stated requirements: ${request.requirements.join(' | ')}`
      : undefined,
    request.region
      ? `Focus region in normalized coordinates: x=${request.region.x}, y=${request.region.y}, width=${request.region.width}, height=${request.region.height}. Do not claim that pixels outside this region were cropped.`
      : 'Analyze the full image.'
  ];
  return parts.filter((value): value is string => Boolean(value)).join('\n');
}

function parseVisionResponse(
  body: Uint8Array,
  expectedModelKey: string
): ParsedVisionResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw invalidResponse('Volcengine returned invalid JSON');
  }
  const value = exactRecord(
    parsed,
    ['id', 'choices', 'created', 'model', 'object'],
    ['usage', 'service_status'],
    'Volcengine chat response'
  );
  requireOpaqueRemoteString(value.id, 'response ID');
  nonNegativeInteger(value.created, 'created');
  requireOpaqueRemoteString(value.model, 'response model');
  if (value.object !== 'chat.completion' || !Array.isArray(value.choices)) {
    throw invalidResponse('Volcengine chat response metadata is invalid');
  }
  const usage = value.usage === undefined
    ? undefined
    : mapVolcengineChatUsage(value.usage);
  if (hasFallback(value.service_status, expectedModelKey)) {
    return { usage, terminalSafeCode: 'volcengine.model_fallback' };
  }
  if (value.choices.length !== 1) {
    throw invalidResponse('Volcengine must return exactly one choice');
  }
  const choice = exactRecord(
    value.choices[0],
    ['index', 'message', 'finish_reason'],
    ['logprobs', 'moderation_hit_type'],
    'Volcengine choice'
  );
  if (choice.index !== 0 || choice.logprobs !== undefined && choice.logprobs !== null) {
    throw invalidResponse('Volcengine choice metadata is invalid');
  }
  if (
    choice.moderation_hit_type !== undefined &&
    choice.moderation_hit_type !== null
  ) {
    requireOpaqueRemoteString(
      choice.moderation_hit_type,
      'moderation hit type'
    );
    return { usage, terminalSafeCode: 'volcengine.content_filtered' };
  }
  const finishReason = parseFinishReason(choice.finish_reason);
  if (finishReason !== 'stop') {
    return {
      usage,
      terminalSafeCode: `volcengine.finish.${finishReason}`
    };
  }
  const message = exactRecord(
    choice.message,
    ['role', 'content'],
    [],
    'Volcengine assistant message'
  );
  if (message.role !== 'assistant' || typeof message.content !== 'string') {
    throw invalidResponse('Volcengine assistant content is invalid');
  }
  return {
    usage,
    observations: parseObservationContent(message.content)
  };
}

function hasFallback(value: unknown, expectedModelKey: string): boolean {
  if (value === undefined) return false;
  const serviceStatus = exactRecord(
    value,
    [],
    ['model_fallback'],
    'Volcengine service status'
  );
  if (serviceStatus.model_fallback === undefined) return false;
  const fallback = exactRecord(
    serviceStatus.model_fallback,
    ['fallback_triggered'],
    ['original_model'],
    'Volcengine model fallback'
  );
  if (typeof fallback.fallback_triggered !== 'boolean') {
    throw invalidResponse('Volcengine fallback status is invalid');
  }
  if (fallback.original_model !== undefined) {
    requireOpaqueRemoteString(fallback.original_model, 'original model');
  }
  void expectedModelKey;
  return fallback.fallback_triggered;
}

function parseObservationContent(content: string): ImageObservationSet {
  if (content.length < 1 || content.length > 256 * 1024) {
    throw invalidResponse('Volcengine observation content is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidResponse('Volcengine structured observations are invalid JSON');
  }
  const value = exactRecord(
    parsed,
    ['visibleFacts', 'modelInferences', 'uncertainties', 'unrecognized'],
    [],
    'Volcengine observations'
  );
  const groups = {
    visibleFacts: observationStrings(value.visibleFacts, 'visibleFacts'),
    modelInferences: observationStrings(
      value.modelInferences,
      'modelInferences'
    ),
    uncertainties: observationStrings(value.uncertainties, 'uncertainties'),
    unrecognized: observationStrings(value.unrecognized, 'unrecognized')
  };
  const total = Object.values(groups).reduce(
    (count, items) => count + items.length,
    0
  );
  if (total > maximumObservationItems) {
    throw invalidResponse('Volcengine returned too many observations');
  }
  return {
    visibleFacts: toObservations('visible-fact', groups.visibleFacts),
    modelInferences: toObservations('model-inference', groups.modelInferences),
    uncertainties: toObservations('uncertainty', groups.uncertainties),
    unrecognized: toObservations('unrecognized', groups.unrecognized)
  };
}

function observationStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalidResponse(`Volcengine ${label} observations are invalid`);
  }
  return value.map((item, index) =>
    boundedRemoteText(item, `${label}[${index}]`, 1_000)
  );
}

function toObservations(prefix: string, values: readonly string[]) {
  return values.map((content, index) => ({
    id: `${prefix}-${index + 1}`,
    content
  }));
}

function createResult(
  feature: 'image_understanding' | 'image_to_prompt',
  observations: ImageObservationSet,
  request: DoubaoVisionDispatchRequestV1
): DoubaoVisionResultV1 {
  if (feature === 'image_understanding') {
    return { schemaVersion: 1, productFeature: feature, observations };
  }
  return {
    schemaVersion: 1,
    productFeature: feature,
    observations,
    promptDraft: buildDoubaoImageToPromptDraft({
      purpose: request.purpose!,
      requirements: request.requirements,
      observations
    })
  };
}

function parseRequirements(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw invalidRequest(
      'volcengine.invalid_request',
      'Doubao vision requirements are invalid'
    );
  }
  return value.map((item, index) =>
    boundedUserText(item, `requirements[${index}]`, 500, true)
  );
}

function parseRegion(value: unknown): DoubaoVisionRegionV1 {
  const item = exactRequestRecord(
    value,
    ['x', 'y', 'width', 'height'],
    [],
    'Doubao vision region'
  );
  const region = {
    x: normalizedNumber(item.x, 'region.x'),
    y: normalizedNumber(item.y, 'region.y'),
    width: normalizedNumber(item.width, 'region.width'),
    height: normalizedNumber(item.height, 'region.height')
  };
  if (
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1 ||
    region.y + region.height > 1
  ) {
    throw invalidRequest(
      'volcengine.invalid_request',
      'Doubao vision region bounds are invalid'
    );
  }
  return region;
}

function parseFinishReason(
  value: unknown
): 'stop' | 'length' | 'content_filter' | 'tool_calls' {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'content_filter' ||
    value === 'tool_calls'
  ) {
    return value;
  }
  throw invalidResponse('Volcengine finish reason is invalid');
}

function listSection(
  title: string,
  observations: ImageObservationSet['visibleFacts']
): string | undefined {
  return observations.length > 0
    ? `${title}：${observations.map((item) => item.content).join('；')}`
    : undefined;
}

function safeCodeForError(error: unknown): string {
  if (error instanceof DoubaoVisionAdapterError) return error.safeCode;
  if (error instanceof VolcengineRuntimeError) {
    return `volcengine.${error.code}`;
  }
  return 'volcengine.operation_failed';
}

function isInvalidResponse(error: unknown): boolean {
  return (
    error instanceof DoubaoVisionAdapterError &&
    error.safeCode === 'volcengine.invalid_response'
  ) || (
    error instanceof VolcengineRuntimeError &&
    error.code === 'invalid_response'
  );
}

class DoubaoVisionAdapterError extends Error {
  constructor(readonly safeCode: string, message: string) {
    super(message);
    this.name = 'DoubaoVisionAdapterError';
  }
}

function invalidRequest(safeCode: string, message: string) {
  return new DoubaoVisionAdapterError(safeCode, message);
}

function invalidResponse(message: string) {
  return new DoubaoVisionAdapterError(
    'volcengine.invalid_response',
    message
  );
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw invalidResponse(`${label} contains unsupported fields`);
  }
  return value;
}

function exactRequestRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidRequest('volcengine.invalid_request', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(
      'volcengine.invalid_request',
      `${label} contains unsupported fields`
    );
  }
  return value;
}

function boundedUserText(
  value: unknown,
  label: string,
  maximum: number,
  required: boolean
): string {
  if (typeof value !== 'string') {
    throw invalidRequest('volcengine.invalid_request', `${label} is invalid`);
  }
  const trimmed = value.trim();
  if ((required && trimmed.length < 1) || trimmed.length > maximum) {
    throw invalidRequest('volcengine.invalid_request', `${label} is invalid`);
  }
  return trimmed;
}

function boundedRemoteText(
  value: unknown,
  label: string,
  maximum: number
): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`${label} is invalid`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maximum) {
    throw invalidResponse(`${label} is invalid`);
  }
  return trimmed;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidRequest('volcengine.invalid_request', `${label} is invalid`);
  }
  return value.trim();
}

function requireOpaqueRemoteString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse(`${label} is invalid`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidResponse(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(
  value: unknown,
  label: string
): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}

function normalizedNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidRequest('volcengine.invalid_request', `${label} is invalid`);
  }
  return value;
}

function tokenFact(metricId: string, quantity: number): UsageFactV1 {
  return {
    metricId,
    quantity: String(quantity),
    unit: 'token',
    source: 'provider_body'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
