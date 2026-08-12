import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toAssetId,
  toIsoTimestamp,
  toProjectId,
  validateParameterSchemaV2,
  validateParameterValues,
  type IsoTimestamp,
  type ParameterSchemaV2,
  type ParameterValue,
  type ProviderConnection,
  type ProviderImmediateResultReference,
  type ProviderInvocationAttemptId,
  type ProviderSubmitOutcome,
  type ProviderUsageObservationId,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageFactV1,
  type UsageSchemaV1
} from '../../../domain';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_IMAGE_ADAPTER_ID,
  NEWAPI_IMAGE_CONSTRAINT_SET_ID,
  NEWAPI_IMAGE_EDIT_CONSTRAINT_SET_ID,
  NEWAPI_IMAGE_RESULT_SCHEMA_ID,
  NEWAPI_IMAGE_USAGE_SCHEMA_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_REFERENCE_IMAGE_CONSTRAINT_SET_ID,
  newApiImageUsageSchema
} from './newapi-contracts';
import {
  isOpenAiCompatibleEndpointPolicyId,
  isOpenAiCompatiblePackageId
} from './openai-compatible-identity';
import {
  NEWAPI_MAXIMUM_IMAGE_REQUEST_BYTES,
  NEWAPI_REQUEST_TOO_LARGE_MESSAGE,
  NewApiRuntimeError,
  type NewApiSharedRuntime
} from './newapi-runtime';
import type { ControlledImageMaterialPort } from '../vidu/controlled-image-material';

const maximumResultBytes = 128 * 1024 * 1024;
/** Allowlisted images/generations body fields. Edit/multi-image inputs stay excluded. */
const supportedParameterFields = new Set([
  'size',
  'n',
  'quality',
  'response_format',
  'style',
  'output_format',
  'output_compression',
  'watermark',
  'watermark_enabled',
  'background',
  'moderation',
  'partial_images',
  'user',
  'user_id',
  'extra_fields',
  'sequential_image_generation',
  'sequential_image_generation_options',
  'input_fidelity'
]);

export interface NewApiImageCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface NewApiImageConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface NewApiImageParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export interface NewApiImageUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface NewApiImageDownloadPort {
  download(input: {
    readonly url: string;
    readonly maximumResponseBytes: number;
    readonly signal?: AbortSignal;
    readonly endpointSecurity: {
      readonly allowPrivateNetwork: false;
      readonly dnsRebindingProtection: 'required';
      readonly sendCredential: false;
    };
  }): Promise<{ readonly body: Uint8Array; readonly contentType?: string }>;
}

export interface NewApiImageAdapterIdFactory {
  nextProviderOperationId(): string;
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface NewApiImageDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly assetId?: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

export class NewApiImageAdapter {
  constructor(
    private readonly runtime: NewApiSharedRuntime,
    private readonly connections: NewApiImageConnectionResolverPort,
    private readonly credentials: NewApiImageCredentialResolverPort,
    private readonly parameterSchemas: NewApiImageParameterSchemaResolverPort,
    private readonly usage: NewApiImageUsageObservationSinkPort,
    private readonly downloads: NewApiImageDownloadPort,
    private readonly ids: NewApiImageAdapterIdFactory = {
      nextProviderOperationId: () => `newapi-image-${randomUUID()}`,
      nextProviderUsageObservationId: () =>
        `newapi-image-usage-${randomUUID()}` as ProviderUsageObservationId
    },
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString()),
    private readonly materials?: ControlledImageMaterialPort
  ) {}

  async submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSubmitOutcome> {
    let requestStarted = false;
    let attemptId: ProviderInvocationAttemptId | undefined;
    try {
      const route = validateRoute(input.routeSnapshot);
      const [connection, schema] = await Promise.all([
        this.requireConnection(route),
        this.requireParameterSchema(route)
      ]);
      const request = parseDispatchRequest(input.request, route.projectId, schema);
      attemptId = request.invocationAttemptId;
      const body = await serializeImageRequest(
        route,
        request,
        this.materials
      );
      const response = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.requestImageGeneration({
          connection,
          credentials: credential,
          body,
          path: route.productFeature === 'image_edit'
            ? 'edits'
            : 'generations',
          signal: input.signal,
          beforeRequestStarted: async () => {
            await input.beforeRequestStarted?.();
            requestStarted = true;
          }
        })
      );
      const parsed = parseImageResponse(response);
      const providerOperationId = requireOpaqueId(
        this.ids.nextProviderOperationId(),
        'provider operation ID'
      );
      await this.persistUsage(
        request.invocationAttemptId,
        providerOperationId,
        parsed.usage
      );
      return {
        kind: 'completed_sync',
        providerOperationId,
        results: [parsed.result]
      };
    } catch (error) {
      if (attemptId) {
        await this.persistFailureUsage(attemptId, error, requestStarted)
          .catch(() => undefined);
      }
      return mapSubmissionFailure(error, requestStarted);
    }
  }

  async openResult(
    result: Extract<ProviderImmediateResultReference, { kind: 'remote_url' | 'base64' }>,
    signal?: AbortSignal
  ): Promise<Readable> {
    if (result.kind === 'base64') {
      const bytes = decodeBase64(result.value);
      if (sniffImageMime(bytes) !== result.mimeType) {
        throw new NewApiImageAdapterError(
          'newapi.invalid_result',
          'The NewAPI inline image MIME type is invalid',
          'not_retryable'
        );
      }
      return Readable.from([Buffer.from(bytes)]);
    }
    const url = requireControlledResultUrl(result.value);
    const downloaded = await this.downloads.download({
      url,
      maximumResponseBytes: maximumResultBytes,
      signal,
      endpointSecurity: {
        allowPrivateNetwork: false,
        dnsRebindingProtection: 'required',
        sendCredential: false
      }
    });
    if (!(downloaded.body instanceof Uint8Array) || downloaded.body.byteLength < 1) {
      throw invalidResponse('The NewAPI image download is empty');
    }
    const sniffed = sniffImageMime(downloaded.body);
    const declared = downloaded.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (!sniffed || (declared && declared !== sniffed)) {
      throw invalidResponse('The NewAPI image download failed MIME validation');
    }
    return Readable.from([Buffer.from(downloaded.body)]);
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
        'newapi.connection_snapshot_unavailable',
        'The exact NewAPI connection snapshot is unavailable'
      );
    }
    return connection;
  }

  private async requireParameterSchema(
    route: ReturnType<typeof validateRoute>
  ): Promise<ParameterSchemaV2> {
    const candidate = await this.parameterSchemas.get(
      route.parameterSchemaId,
      route.parameterSchemaRevision
    );
    let schema: ParameterSchemaV2;
    try {
      schema = validateParameterSchemaV2(candidate!);
    } catch {
      throw invalidRequest(
        'newapi.parameter_schema_unavailable',
        'The exact NewAPI image parameter schema is unavailable'
      );
    }
    if (
      !candidate ||
      schema.schemaId !== route.parameterSchemaId ||
      schema.revision !== route.parameterSchemaRevision ||
        (schema.productFeature !== 'text_to_image' &&
          schema.productFeature !== 'reference_to_image' &&
          schema.productFeature !== 'image_edit') ||
      schema.fields.some((field) => !supportedParameterFields.has(field.fieldId))
    ) {
      throw invalidRequest(
        'newapi.parameter_schema_unavailable',
        'The exact NewAPI image parameter schema is unavailable'
      );
    }
    return schema;
  }

  private async persistUsage(
    invocationAttemptId: ProviderInvocationAttemptId,
    providerOperationId: string,
    facts: readonly UsageFactV1[] | undefined
  ): Promise<void> {
    await this.usage.append(createProviderUsageObservation({
      id: this.ids.nextProviderUsageObservationId(),
      invocationAttemptId,
      usageSchemaId: newApiImageUsageSchema.id,
      usageSchemaRevision: newApiImageUsageSchema.revision,
      sourceEventKey: `newapi_image_usage_${providerOperationId}`,
      sequence: 1,
      status: facts ? 'reported' : 'not_reported',
      sourceStage: 'result',
      facts: facts ?? [],
      observedAt: this.now()
    }, newApiImageUsageSchema), newApiImageUsageSchema);
  }

  private async persistFailureUsage(
    invocationAttemptId: ProviderInvocationAttemptId,
    error: unknown,
    requestStarted: boolean
  ): Promise<void> {
    await this.usage.append(createProviderUsageObservation({
      id: this.ids.nextProviderUsageObservationId(),
      invocationAttemptId,
      usageSchemaId: newApiImageUsageSchema.id,
      usageSchemaRevision: newApiImageUsageSchema.revision,
      sourceEventKey: `newapi_image_usage_${invocationAttemptId}`,
      sequence: 1,
      status: error instanceof NewApiImageAdapterError
        ? requestStarted ? 'invalid_response' : 'not_reported'
        : requestStarted ? 'unknown_outcome' : 'not_reported',
      sourceStage: 'result',
      facts: [],
      observedAt: this.now()
    }, newApiImageUsageSchema), newApiImageUsageSchema);
  }
}

export function mapNewApiImageUsage(value: unknown): readonly UsageFactV1[] {
  const usage = exactResponseRecord(
    value,
    ['input_tokens', 'output_tokens', 'total_tokens'],
    ['input_tokens_details'],
    'NewAPI image usage'
  );
  const input = nonNegativeInteger(usage.input_tokens, 'input_tokens');
  const output = nonNegativeInteger(usage.output_tokens, 'output_tokens');
  const total = nonNegativeInteger(usage.total_tokens, 'total_tokens');
  if (total !== input + output) {
    throw invalidResponse('NewAPI image token usage is inconsistent');
  }
  const facts = [
    tokenFact('input_tokens', input),
    tokenFact('output_tokens', output),
    tokenFact('total_tokens', total)
  ];
  if (usage.input_tokens_details !== undefined) {
    const details = exactResponseRecord(
      usage.input_tokens_details,
      [],
      ['text_tokens', 'image_tokens'],
      'NewAPI image input token details'
    );
    const textTokens = optionalNonNegativeInteger(details.text_tokens, 'text_tokens');
    const imageTokens = optionalNonNegativeInteger(details.image_tokens, 'image_tokens');
    if (textTokens !== undefined) facts.push(tokenFact('text_tokens', textTokens));
    if (imageTokens !== undefined) facts.push(tokenFact('image_tokens', imageTokens));
    if (
      textTokens !== undefined && imageTokens !== undefined &&
      textTokens + imageTokens !== input
    ) {
      throw invalidResponse('NewAPI image input token details are inconsistent');
    }
  }
  return facts;
}

function validateRoute(value: unknown) {
  const route = parseProviderExecutionRouteSnapshot(value);
  const expectedPurpose = route.productFeature === 'text_to_image'
    ? 'image_generation'
    : route.productFeature === 'reference_to_image'
      ? 'reference_to_image'
      : 'image_editing';
  const expectedConstraintSet = route.productFeature === 'text_to_image'
    ? NEWAPI_IMAGE_CONSTRAINT_SET_ID
    : route.productFeature === 'reference_to_image'
      ? NEWAPI_REFERENCE_IMAGE_CONSTRAINT_SET_ID
      : NEWAPI_IMAGE_EDIT_CONSTRAINT_SET_ID;
  if (
    !isOpenAiCompatiblePackageId(route.packageId) ||
    route.packageVersion !== NEWAPI_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== NEWAPI_IMAGE_ADAPTER_ID ||
    route.adapterVersion !== NEWAPI_ADAPTER_VERSION ||
    !isOpenAiCompatibleEndpointPolicyId(route.endpointPolicyId) ||
    route.endpointPolicyRevision !== 1 ||
      (route.productFeature !== 'text_to_image' &&
        route.productFeature !== 'reference_to_image' &&
        route.productFeature !== 'image_edit') ||
    route.internalPurpose !== expectedPurpose ||
    route.parameterSchemaRevision !== 1 ||
    route.resultSchemaId !== NEWAPI_IMAGE_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== NEWAPI_IMAGE_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== expectedConstraintSet ||
    route.constraintSetRevision !== 1 ||
    !validProviderModelKey(route.providerModelKey)
  ) {
    throw invalidRequest(
      'newapi.route_mismatch',
      'The route snapshot does not select the exact NewAPI image contract'
    );
  }
  return { ...route, providerModelKey: route.providerModelKey };
}

function parseDispatchRequest(
  value: unknown,
  expectedProjectId: string,
  schema: ParameterSchemaV2
): NewApiImageDispatchRequestV1 {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['taskId', 'executionId', 'assetId'],
    'NewAPI image request'
  );
  const projectId = requireOpaqueId(item.projectId, 'project ID');
  if (projectId !== expectedProjectId) {
    throw invalidRequest('newapi.route_mismatch', 'The request project does not match the route');
  }
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(schema, 'full', item.parameterValues);
  } catch {
    throw invalidRequest('newapi.invalid_request', 'The image parameter projection is invalid');
  }
  const assetId = item.assetId === undefined
    ? undefined
    : requireOpaqueId(item.assetId, 'asset ID');
  if (
    (schema.productFeature === 'text_to_image' && assetId !== undefined) ||
    (schema.productFeature !== 'text_to_image' && assetId === undefined)
  ) {
    throw invalidRequest(
      'newapi.invalid_request',
      'The NewAPI image input does not match the product feature'
    );
  }
  return {
    invocationAttemptId: requireOpaqueId(
      item.invocationAttemptId,
      'invocation attempt ID'
    ) as ProviderInvocationAttemptId,
    projectId,
    prompt: boundedUserText(item.prompt, 'prompt', 100_000),
    ...(assetId === undefined ? {} : { assetId }),
    parameterValues
  };
}

async function serializeImageRequest(
  route: ReturnType<typeof validateRoute>,
  request: NewApiImageDispatchRequestV1,
  materials: ControlledImageMaterialPort | undefined
): Promise<Uint8Array> {
  const body = {
    model: route.providerModelKey,
    prompt: request.prompt,
    ...request.parameterValues
  };
  if (route.productFeature !== 'text_to_image') {
    if (!request.assetId || !materials) {
      throw invalidRequest(
        'newapi.invalid_request',
        'Reference image generation requires one controlled input image'
      );
    }
    const material = await materials.resolve({
      projectId: toProjectId(request.projectId),
      assetId: toAssetId(request.assetId)
    });
    if (!material || !material.mimeType.startsWith('image/')) {
      throw invalidRequest(
        'newapi.invalid_request',
        'Reference image generation requires one controlled image asset'
      );
    }
    (body as Record<string, unknown>).image =
      `data:${material.mimeType};base64,${material.base64}`;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > NEWAPI_MAXIMUM_IMAGE_REQUEST_BYTES
  ) {
    throw invalidRequest(
      'newapi.request_too_large',
      NEWAPI_REQUEST_TOO_LARGE_MESSAGE
    );
  }
  return bytes;
}

function parseImageResponse(body: Uint8Array): {
  readonly result:
    | { readonly kind: 'remote_url'; readonly value: string }
    | { readonly kind: 'base64'; readonly value: string; readonly mimeType: string };
  readonly usage?: readonly UsageFactV1[];
} {
  const value = parseJsonObject(body, 'NewAPI image response');
  if (isRecord(value.error)) {
    throw invalidRequest(
      'newapi.invalid_request',
      'The NewAPI request is invalid'
    );
  }
  const data = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.images)
      ? value.images
      : undefined;
  if (data === undefined) {
    throw invalidResponse('The NewAPI response was invalid');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'created')) {
    nonNegativeInteger(value.created, 'created');
  }
  if (data.length < 1) {
    throw invalidResponse('The NewAPI response was invalid');
  }
  const item = data[0];
  if (typeof item === 'string' && item.length > 0) {
    return { result: inlineResult(item) };
  }
  if (!isRecord(item)) {
    throw invalidResponse('The NewAPI response was invalid');
  }
  const base64Candidate =
    (typeof item.b64_json === 'string' && item.b64_json) ||
    (typeof item.b64 === 'string' && item.b64) ||
    (typeof item.base64 === 'string' && item.base64) ||
    undefined;
  const urlCandidate = typeof item.url === 'string' ? item.url : undefined;
  const hasBase64 = typeof base64Candidate === 'string' && base64Candidate.length > 0;
  const hasUrl = typeof urlCandidate === 'string' && urlCandidate.length > 0;
  if (hasBase64 === hasUrl) {
    throw invalidResponse('The NewAPI response was invalid');
  }
  const result = hasUrl
    ? { kind: 'remote_url' as const, value: requireControlledResultUrl(urlCandidate) }
    : inlineResult(base64Candidate);
  let usage: readonly UsageFactV1[] | undefined;
  if (value.usage !== undefined) {
    try {
      usage = mapNewApiImageUsage(value.usage);
    } catch {
      usage = undefined;
    }
  }
  return {
    result,
    ...(usage ? { usage } : {})
  };
}

function inlineResult(value: unknown): {
  readonly kind: 'base64';
  readonly value: string;
  readonly mimeType: string;
} {
  if (typeof value !== 'string' || value.length < 4 || value.length > 180_000_000) {
    throw invalidResponse('The NewAPI response was invalid');
  }
  const stripped = value.startsWith('data:')
    ? value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/u, '')
    : value;
  if (stripped.length < 4 || stripped === value && value.startsWith('data:')) {
    throw invalidResponse('The NewAPI response was invalid');
  }
  const bytes = decodeBase64(stripped);
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) throw invalidResponse('The NewAPI response was invalid');
  return {
    kind: 'base64',
    value: Buffer.from(bytes).toString('base64'),
    mimeType
  };
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw invalidResponse('NewAPI inline image encoding is invalid');
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  if (bytes.byteLength < 1 || bytes.byteLength > maximumResultBytes) {
    throw invalidResponse('NewAPI inline image size is invalid');
  }
  return bytes;
}

function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return undefined;
}

function requireControlledResultUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) {
    throw invalidResponse('NewAPI image result URL is invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse('NewAPI image result URL is invalid');
  }
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
    url.hostname === '127.0.0.1' || url.hostname === '::1';
  const privateAddress = isPrivateAddress(url.hostname);
  if (
    url.username || url.password || url.hash ||
    privateAddress || url.hostname.endsWith('.local') ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw invalidResponse('NewAPI image result URL is not allowed');
  }
  return url.toString();
}

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254);
  }
  if (family === 6) {
    return host === '::' || host.startsWith('fc') || host.startsWith('fd') ||
      /^fe[89ab]/u.test(host);
  }
  return false;
}

function mapSubmissionFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  // Parsed HTTP responses with an unusable body are known failures, not billing-unknown.
  if (
    requestStarted &&
    error instanceof NewApiImageAdapterError &&
    error.safeCode === 'newapi.invalid_response'
  ) {
    return {
      kind: 'failed_before_submission',
      message: 'The NewAPI response was invalid',
      retryability: 'not_retryable'
    };
  }
  if (
    requestStarted &&
    error instanceof NewApiImageAdapterError &&
    error.safeCode === 'newapi.invalid_request'
  ) {
    return {
      kind: 'failed_before_submission',
      message: 'The NewAPI request is invalid',
      retryability: 'not_retryable'
    };
  }
  if (requestStarted && submissionOutcomeIsUnknown(error)) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The NewAPI image submission outcome is unknown'
    };
  }
  if (error instanceof NewApiRuntimeError) {
    return {
      kind: 'failed_before_submission',
      message: error.message,
      retryability: error.retryability
    };
  }
  return {
    kind: 'failed_before_submission',
    message: error instanceof NewApiImageAdapterError
      ? error.message
      : 'The NewAPI image request could not be prepared',
    retryability: error instanceof NewApiImageAdapterError
      ? error.retryability
      : 'unknown'
  };
}

function submissionOutcomeIsUnknown(error: unknown): boolean {
  if (error instanceof NewApiImageAdapterError) {
    return error.safeCode !== 'newapi.invalid_response';
  }
  return error instanceof NewApiRuntimeError && [
    'timeout', 'network_error', 'provider_unavailable', 'cancelled',
    'proxy_unavailable', 'response_too_large', 'invalid_response'
  ].includes(error.code);
}

function parseJsonObject(body: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body)
    );
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw invalidResponse(`${label} is not valid JSON`);
  }
}

function exactResponseRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) throw invalidResponse(`${label} contains unsupported fields`);
  return value;
}

function exactRequestRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest('newapi.invalid_request', `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) throw invalidRequest('newapi.invalid_request', `${label} contains unsupported fields`);
  return value;
}

function boundedUserText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum || /\u0000/u.test(value)) {
    throw invalidRequest('newapi.invalid_request', `NewAPI ${label} is invalid`);
  }
  return value.trim();
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || value.trim() !== value ||
    value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw invalidRequest('newapi.invalid_request', `${label} is invalid`);
  return value;
}

function validProviderModelKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidResponse(`NewAPI ${label} is invalid`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}

function tokenFact(metricId: string, quantity: number): UsageFactV1 {
  return { metricId, quantity: String(quantity), unit: 'token', source: 'provider_body' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class NewApiImageAdapterError extends Error {
  constructor(
    readonly safeCode: string,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'NewApiImageAdapterError';
  }
}

function invalidRequest(safeCode: string, message: string): NewApiImageAdapterError {
  return new NewApiImageAdapterError(safeCode, message, 'not_retryable');
}

function invalidResponse(message: string): NewApiImageAdapterError {
  return new NewApiImageAdapterError(
    'newapi.invalid_response',
    message === 'The NewAPI response was invalid'
      ? message
      : 'The NewAPI response was invalid',
    'not_retryable'
  );
}
