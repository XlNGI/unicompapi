import { Readable } from 'node:stream';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toIsoTimestamp,
  validateParameterSchemaV2,
  validateParameterValues,
  type IsoTimestamp,
  type ParameterSchemaV2,
  type ParameterValue,
  type ProviderConnection,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderInvocationAttemptId,
  type ProviderSubmitOutcome,
  type ProviderUsageObservationId,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageFactV1,
  type UsageSchemaV1
} from '../../../domain';
import type {
  ProviderAsyncOperationPort,
  ProviderAsyncOperationStatus,
  ProviderCancelOutcome
} from '../provider-execution-lifecycle';
import {
  VideoResultPortError,
  type VideoRemoteCompletionFact,
  type VideoRemoteResultDescriptor,
  type VideoResultPort
} from '../../videos/video-result-port';
import {
  SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
  SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  SEEDANCE_VIDEO_ADAPTER_ID,
  SEEDANCE_VIDEO_ADAPTER_VERSION,
  SEEDANCE_VIDEO_RESULT_SCHEMA_ID,
  SEEDANCE_VIDEO_USAGE_SCHEMA_ID,
  VOLCENGINE_ENDPOINT_POLICY_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_VERSION,
  seedanceVideoUsageSchema
} from './volcengine-contracts';
import {
  VolcengineRuntimeError,
  type VolcengineSharedRuntime
} from './volcengine-runtime';

const maximumImageBytes = 30_000_000;
const maximumRequestBytes = 64_000_000;
const maximumResultBytes = 512 * 1024 * 1024;
const resultUrlLifetimeMs = 24 * 60 * 60 * 1_000;
const resultId = 'video';
const supportedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif'
]);
const supportedParameterFields = new Set([
  'resolution',
  'ratio',
  'duration',
  'frames',
  'seed',
  'camera_fixed',
  'watermark',
  'generate_audio',
  'return_last_frame'
]);

export interface SeedanceVideoCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface SeedanceVideoConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface SeedanceVideoParameterSchemaResolverPort {
  get(
    schemaId: string,
    revision: number
  ): Promise<ParameterSchemaV2 | undefined>;
}

export interface ControlledSeedanceImageV1 {
  readonly assetId: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

export interface ControlledSeedanceImagePort {
  resolve(input: {
    readonly projectId: string;
    readonly assetId: string;
  }): Promise<ControlledSeedanceImageV1>;
}

export interface SeedanceVideoUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface SeedanceVideoAdapterIdFactory {
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface SeedanceVideoDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly assetId?: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

interface ValidatedSeedanceRoute extends ProviderExecutionRouteSnapshotV1 {
  readonly productFeature: 'text_to_video' | 'image_to_video';
  readonly providerModelKey: string;
}

interface SeedanceOperationContext {
  readonly route: ValidatedSeedanceRoute;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly connection: ProviderConnection;
  usagePersisted: boolean;
}

interface SeedanceResultSnapshot {
  readonly discoveredAt: number;
  readonly url: string;
}

interface ParsedSeedanceTask {
  readonly status:
    | 'queued'
    | 'running'
    | 'cancelled'
    | 'succeeded'
    | 'failed'
    | 'expired';
  readonly videoUrl?: string;
  readonly usage?: readonly UsageFactV1[];
}

export class SeedanceVideoAdapter
  implements ProviderAsyncOperationPort, VideoResultPort {
  private readonly operations = new Map<string, SeedanceOperationContext>();
  private readonly results = new Map<string, SeedanceResultSnapshot>();
  private disposed = false;

  constructor(
    private readonly runtime: VolcengineSharedRuntime,
    private readonly connections: SeedanceVideoConnectionResolverPort,
    private readonly credentials: SeedanceVideoCredentialResolverPort,
    private readonly parameterSchemas: SeedanceVideoParameterSchemaResolverPort,
    private readonly images: ControlledSeedanceImagePort,
    private readonly usage: SeedanceVideoUsageObservationSinkPort,
    private readonly ids: SeedanceVideoAdapterIdFactory,
    private readonly nowTimestamp: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString()),
    private readonly nowMilliseconds: () => number = () => Date.now()
  ) {}

  async submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSubmitOutcome> {
    let requestStarted = false;
    let submissionContext: SeedanceOperationContext | undefined;
    try {
      this.requireActive();
      const route = validateRoute(input.routeSnapshot);
      const schema = await this.requireParameterSchema(route);
      const request = parseDispatchRequest(input.request, route, schema);
      const connection = await this.requireConnection(route);
      submissionContext = {
        route,
        invocationAttemptId: request.invocationAttemptId,
        connection,
        usagePersisted: false
      };
      const image = route.productFeature === 'image_to_video'
        ? validateImage(await this.images.resolve({
            projectId: request.projectId,
            assetId: request.assetId!
          }), request.assetId!)
        : undefined;
      const body = serializeVideoRequest(route, request, image);
      const responseBody = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.requestVideoTaskCreate({
          connection,
          credentials: credential,
          body,
          signal: input.signal,
          beforeRequestStarted: async () => {
            await input.beforeRequestStarted?.();
            requestStarted = true;
          }
        })
      );
      const providerOperationId = parseCreateResponse(responseBody);
      if (this.operations.has(providerOperationId)) {
        throw invalidResponse('Volcengine returned a duplicate operation ID');
      }
      this.operations.set(providerOperationId, {
        ...submissionContext,
        usagePersisted: false
      });
      return {
        kind: 'accepted_async',
        providerOperationId,
        state: 'queued'
      };
    } catch (error) {
      const outcome = mapSubmissionFailure(error, requestStarted);
      if (submissionContext) {
        await this.persistUsage(
          submissionContext,
          outcome.kind === 'submission_outcome_unknown'
            ? 'unknown_outcome'
            : 'not_reported',
          []
        );
      }
      return outcome;
    }
  }

  async attachOperation(input: {
    readonly routeSnapshot: unknown;
    readonly providerOperationId: string;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly usageAlreadyPersisted?: boolean;
  }): Promise<void> {
    this.requireActive();
    const route = validateRoute(input.routeSnapshot);
    await this.requireParameterSchema(route);
    const providerOperationId = requireRemoteId(input.providerOperationId);
    const invocationAttemptId = requireInvocationAttemptId(
      input.invocationAttemptId
    );
    const connection = await this.requireConnection(route);
    const existing = this.operations.get(providerOperationId);
    if (
      existing &&
      (existing.route.id !== route.id ||
        existing.invocationAttemptId !== invocationAttemptId)
    ) {
      throw invalidRequest(
        'volcengine.operation_conflict',
        'The Seedance operation is already attached to another route'
      );
    }
    this.operations.set(providerOperationId, {
      route,
      invocationAttemptId,
      connection,
      usagePersisted: Boolean(input.usageAlreadyPersisted)
    });
  }

  async query(
    providerOperationId: string,
    signal?: AbortSignal
  ): Promise<ProviderAsyncOperationStatus> {
    this.requireActive();
    const remoteId = requireRemoteId(providerOperationId);
    const context = this.requireOperation(remoteId);
    try {
      const responseBody = await this.credentials.useCredential(
        {
          connectionId: context.route.connectionId,
          credentialVersionId: context.route.credentialVersionId
        },
        (credential) => this.runtime.requestVideoTaskQuery({
          connection: context.connection,
          credentials: credential,
          providerOperationId: remoteId,
          signal
        })
      );
      const task = parseTaskResponse(responseBody, remoteId);
      if (task.status === 'queued') return { state: 'queued' };
      if (task.status === 'running') return { state: 'processing' };
      await this.persistTerminalUsage(context, task.usage);
      if (task.status === 'succeeded') {
        const previous = this.results.get(remoteId);
        this.results.set(remoteId, {
          discoveredAt: previous && previous.url === task.videoUrl
            ? previous.discoveredAt
            : this.nowMilliseconds(),
          url: task.videoUrl!
        });
        return { state: 'completed' };
      }
      this.results.delete(remoteId);
      if (task.status === 'failed') {
        return {
          state: 'failed',
          message: 'Volcengine reported that the Seedance video task failed',
          retryability: 'not_retryable'
        };
      }
      return { state: task.status };
    } catch (error) {
      if (isInvalidResponse(error) && !context.usagePersisted) {
        await this.persistUsage(context, 'invalid_response', []);
      }
      throw error;
    }
  }

  async cancel(
    providerOperationId: string,
    signal?: AbortSignal
  ): Promise<ProviderCancelOutcome> {
    this.requireActive();
    const remoteId = requireRemoteId(providerOperationId);
    const context = this.requireOperation(remoteId);
    try {
      await this.credentials.useCredential(
        {
          connectionId: context.route.connectionId,
          credentialVersionId: context.route.credentialVersionId
        },
        (credential) => this.runtime.requestVideoTaskDelete({
          connection: context.connection,
          credentials: credential,
          providerOperationId: remoteId,
          signal
        })
      );
      await this.persistUsage(context, 'not_reported', []);
      return { state: 'cancelled' };
    } catch (error) {
      if (error instanceof VolcengineRuntimeError) {
        if (error.code === 'invalid_parameters') return { state: 'processing' };
        if (error.retryability === 'retryable' || error.retryability === 'unknown') {
          return { state: 'unknown' };
        }
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
    if (status.state === 'cancelled' || status.state === 'expired') {
      throw new VideoResultPortError(
        'not_retryable',
        'The Seedance video result is unavailable'
      );
    }
    return undefined;
  }

  async listResults(
    remoteOperationId: string
  ): Promise<readonly VideoRemoteResultDescriptor[]> {
    const remoteId = requireRemoteId(remoteOperationId);
    await this.loadCurrentResult(remoteId);
    return [{
      remoteResultId: resultId,
      name: 'volcengine-seedance-video',
      declaredMimeType: 'video/mp4',
      declaredContainer: 'mp4'
    }];
  }

  async openDownload(
    remoteOperationId: string,
    remoteResultId: string
  ): Promise<Readable> {
    const remoteId = requireRemoteId(remoteOperationId);
    if (remoteResultId !== resultId) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Seedance video result is unavailable'
      );
    }
    const snapshot = await this.loadCurrentResult(remoteId);
    if (this.nowMilliseconds() - snapshot.discoveredAt >= resultUrlLifetimeMs) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Seedance video result URL has expired'
      );
    }
    try {
      const downloaded = await this.runtime.downloadVideoResult({
        url: snapshot.url,
        maximumResponseBytes: maximumResultBytes
      });
      if (
        downloaded.contentType &&
        downloaded.contentType !== 'video/mp4' &&
        !downloaded.contentType.startsWith('video/')
      ) {
        throw new VideoResultPortError(
          'not_retryable',
          'The Seedance result did not contain video bytes'
        );
      }
      return Readable.from([Buffer.from(downloaded.body)]);
    } catch (error) {
      if (error instanceof VideoResultPortError) throw error;
      throw new VideoResultPortError(
        runtimeRetryability(error),
        'The Seedance video result could not be downloaded'
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.operations.clear();
    this.results.clear();
    this.runtime.dispose();
  }

  get attachedOperationCount(): number {
    return this.operations.size;
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new VolcengineRuntimeError('runtime_shutting_down', 'not_retryable');
    }
  }

  private requireOperation(providerOperationId: string): SeedanceOperationContext {
    const context = this.operations.get(providerOperationId);
    if (!context) {
      throw invalidRequest(
        'volcengine.operation_not_attached',
        'The Seedance operation must be attached with its original route snapshot'
      );
    }
    return context;
  }

  private async requireConnection(
    route: ValidatedSeedanceRoute
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

  private async requireParameterSchema(
    route: ValidatedSeedanceRoute
  ): Promise<ParameterSchemaV2> {
    const schema = await this.parameterSchemas.get(
      route.parameterSchemaId,
      route.parameterSchemaRevision
    );
    let validated: ParameterSchemaV2;
    try {
      validated = validateParameterSchemaV2(schema!);
    } catch {
      throw invalidRequest(
        'volcengine.parameter_schema_unavailable',
        'The exact Seedance parameter schema is unavailable'
      );
    }
    if (
      !schema ||
      validated.schemaId !== route.parameterSchemaId ||
      validated.revision !== route.parameterSchemaRevision ||
      validated.productFeature !== route.productFeature ||
      validated.fields.some((field) => !supportedParameterFields.has(field.fieldId))
    ) {
      throw invalidRequest(
        'volcengine.parameter_schema_unavailable',
        'The exact Seedance parameter schema is unavailable'
      );
    }
    return validated;
  }

  private async persistTerminalUsage(
    context: SeedanceOperationContext,
    facts: readonly UsageFactV1[] | undefined
  ): Promise<void> {
    if (context.usagePersisted) return;
    await this.persistUsage(
      context,
      facts ? 'reported' : 'not_reported',
      facts ?? []
    );
  }

  private async persistUsage(
    context: SeedanceOperationContext,
    status:
      | 'reported'
      | 'not_reported'
      | 'invalid_response'
      | 'unknown_outcome',
    facts: readonly UsageFactV1[]
  ): Promise<void> {
    await this.usage.append(
      createProviderUsageObservation({
        id: this.ids.nextProviderUsageObservationId(),
        invocationAttemptId: context.invocationAttemptId,
        usageSchemaId: seedanceVideoUsageSchema.id,
        usageSchemaRevision: seedanceVideoUsageSchema.revision,
        sourceEventKey: `volcengine_seedance_usage_${context.invocationAttemptId}`,
        sequence: 1,
        status,
        sourceStage: 'poll',
        facts,
        observedAt: this.nowTimestamp()
      }, seedanceVideoUsageSchema),
      seedanceVideoUsageSchema
    );
    context.usagePersisted = true;
  }

  private async loadCurrentResult(
    providerOperationId: string
  ): Promise<SeedanceResultSnapshot> {
    const status = await this.query(providerOperationId);
    if (status.state !== 'completed') {
      throw new VideoResultPortError(
        status.state === 'failed' ? status.retryability : 'retryable',
        'The Seedance video result is not available'
      );
    }
    const snapshot = this.results.get(providerOperationId);
    if (!snapshot) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Seedance video result declaration is invalid'
      );
    }
    return snapshot;
  }
}

export function mapSeedanceVideoUsage(value: unknown): readonly UsageFactV1[] {
  const usage = exactResponseRecord(
    value,
    ['completion_tokens', 'total_tokens'],
    ['tool_usage'],
    'Seedance usage'
  );
  const completionTokens = nonNegativeInteger(
    usage.completion_tokens,
    'completion_tokens'
  );
  const totalTokens = nonNegativeInteger(usage.total_tokens, 'total_tokens');
  if (completionTokens !== totalTokens) {
    throw invalidResponse('Seedance total token usage is inconsistent');
  }
  const facts: UsageFactV1[] = [
    usageFact('completion_tokens', completionTokens, 'token'),
    usageFact('total_tokens', totalTokens, 'token')
  ];
  if (usage.tool_usage !== undefined) {
    const tools = exactResponseRecord(
      usage.tool_usage,
      [],
      ['web_search'],
      'Seedance tool usage'
    );
    if (tools.web_search !== undefined) {
      facts.push(usageFact(
        'web_search_calls',
        nonNegativeInteger(tools.web_search, 'web_search'),
        'request'
      ));
    }
  }
  return facts;
}

export function seedanceVideoRecoveryDecision(state: string): {
  readonly sameOperationResumable: boolean;
  readonly action: 'attach_and_query' | 'none' | 'user_retry_required';
} {
  if (['queued', 'processing', 'cancel_requested', 'cancellation_unknown'].includes(state)) {
    return { sameOperationResumable: true, action: 'attach_and_query' };
  }
  if (state === 'submission_outcome_unknown' || state === 'unknown_outcome') {
    return { sameOperationResumable: false, action: 'user_retry_required' };
  }
  return { sameOperationResumable: false, action: 'none' };
}

function validateRoute(value: unknown): ValidatedSeedanceRoute {
  const route = parseProviderExecutionRouteSnapshot(value);
  const feature = route.productFeature;
  const expectedConstraint = feature === 'text_to_video'
    ? SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
    : feature === 'image_to_video'
      ? SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
      : undefined;
  if (
    route.packageId !== VOLCENGINE_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== VOLCENGINE_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== SEEDANCE_VIDEO_ADAPTER_ID ||
    route.adapterVersion !== SEEDANCE_VIDEO_ADAPTER_VERSION ||
    route.endpointPolicyId !== VOLCENGINE_ENDPOINT_POLICY_ID ||
    route.endpointPolicyRevision !== 1 ||
    route.resultSchemaId !== SEEDANCE_VIDEO_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== SEEDANCE_VIDEO_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== expectedConstraint ||
    route.constraintSetRevision !== 1 ||
    route.parameterSchemaRevision !== 1 ||
    !route.providerModelKey ||
    route.internalPurpose !== (feature === 'text_to_video'
      ? 'video_generation'
      : 'reference_to_video') ||
    !expectedConstraint
  ) {
    throw invalidRequest(
      'volcengine.route_mismatch',
      'The route snapshot does not select the exact Seedance video contract'
    );
  }
  return {
    ...route,
    productFeature: feature as 'text_to_video' | 'image_to_video',
    providerModelKey: route.providerModelKey
  };
}

function parseDispatchRequest(
  value: unknown,
  route: ValidatedSeedanceRoute,
  schema: ParameterSchemaV2
): SeedanceVideoDispatchRequestV1 {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['assetId'],
    'Seedance video request'
  );
  const projectId = requireOpaqueRequestId(item.projectId, 'project ID');
  if (projectId !== route.projectId) {
    throw invalidRequest(
      'volcengine.route_mismatch',
      'The Seedance request project does not match the route snapshot'
    );
  }
  const assetId = item.assetId === undefined
    ? undefined
    : requireOpaqueRequestId(item.assetId, 'asset ID');
  if (
    (route.productFeature === 'image_to_video' && !assetId) ||
    (route.productFeature === 'text_to_video' && assetId)
  ) {
    throw invalidRequest(
      'volcengine.invalid_request',
      'The Seedance request material does not match the product feature'
    );
  }
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(schema, 'full', item.parameterValues);
  } catch {
    throw invalidRequest(
      'volcengine.invalid_request',
      'The Seedance parameter projection is invalid'
    );
  }
  if (
    parameterValues.duration !== undefined &&
    parameterValues.frames !== undefined
  ) {
    throw invalidRequest(
      'volcengine.invalid_request',
      'Seedance duration and frames are mutually exclusive'
    );
  }
  return {
    invocationAttemptId: requireInvocationAttemptId(item.invocationAttemptId),
    projectId,
    prompt: boundedPrompt(item.prompt),
    ...(assetId ? { assetId } : {}),
    parameterValues
  };
}

function validateImage(
  image: ControlledSeedanceImageV1,
  expectedAssetId: string
): ControlledSeedanceImageV1 {
  const mimeType = image.mimeType.toLowerCase();
  const aspectRatio = image.width / image.height;
  if (
    image.assetId !== expectedAssetId ||
    !supportedImageMimeTypes.has(mimeType) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 300 ||
    image.width > 6_000 ||
    image.height < 300 ||
    image.height > 6_000 ||
    aspectRatio < 0.4 ||
    aspectRatio > 2.5 ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 1 ||
    image.sizeBytes >= maximumImageBytes ||
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength !== image.sizeBytes
  ) {
    throw invalidRequest(
      'volcengine.invalid_image',
      'The controlled first-frame image does not satisfy the Seedance contract'
    );
  }
  return { ...image, mimeType, bytes: Uint8Array.from(image.bytes) };
}

function serializeVideoRequest(
  route: ValidatedSeedanceRoute,
  request: SeedanceVideoDispatchRequestV1,
  image: ControlledSeedanceImageV1 | undefined
): Uint8Array {
  const content: Record<string, unknown>[] = [
    { type: 'text', text: request.prompt }
  ];
  if (image) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`
      },
      role: 'first_frame'
    });
  }
  const body: Record<string, unknown> = {
    model: route.providerModelKey,
    content
  };
  for (const [key, value] of Object.entries(request.parameterValues)) {
    if (!supportedParameterFields.has(key)) {
      throw invalidRequest(
        'volcengine.invalid_request',
        'The Seedance request contains an unsupported parameter'
      );
    }
    body[key] = value;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength < 1 || bytes.byteLength > maximumRequestBytes) {
    throw invalidRequest(
      'volcengine.request_too_large',
      'The serialized Seedance request exceeds 64 MB'
    );
  }
  return bytes;
}

function parseCreateResponse(body: Uint8Array): string {
  const value = parseJsonObject(body, 'Seedance create response');
  const exact = exactResponseRecord(
    value,
    ['id'],
    [],
    'Seedance create response'
  );
  return requireRemoteId(exact.id);
}

function parseTaskResponse(
  body: Uint8Array,
  expectedId: string
): ParsedSeedanceTask {
  const value = exactResponseRecord(
    parseJsonObject(body, 'Seedance task response'),
    ['id', 'model', 'status', 'error', 'created_at', 'updated_at', 'content'],
    [
      'seed',
      'resolution',
      'ratio',
      'duration',
      'frames',
      'framespersecond',
      'generate_audio',
      'priority',
      'draft',
      'draft_task_id',
      'service_tier',
      'execution_expires_after',
      'usage'
    ],
    'Seedance task response'
  );
  if (requireRemoteId(value.id) !== expectedId) {
    throw invalidResponse('Seedance returned a mismatched operation ID');
  }
  requireRemoteText(value.model, 'model');
  const status = oneOfStatus(value.status);
  nonNegativeInteger(value.created_at, 'created_at');
  nonNegativeInteger(value.updated_at, 'updated_at');
  if (
    value.duration !== undefined &&
    value.frames !== undefined
  ) {
    throw invalidResponse('Seedance returned both duration and frames');
  }
  validateOptionalGenerationFacts(value);
  const content = exactResponseRecord(
    value.content,
    [],
    ['video_url', 'last_frame_url'],
    'Seedance task content'
  );
  const videoUrl = content.video_url === undefined
    ? undefined
    : requireHttpsResultUrl(content.video_url, 'video URL');
  if (content.last_frame_url !== undefined) {
    requireHttpsResultUrl(content.last_frame_url, 'last-frame URL');
  }
  if (status === 'succeeded') {
    if (value.error !== null || !videoUrl) {
      throw invalidResponse('Seedance succeeded task content is invalid');
    }
  } else if (status === 'failed') {
    validateProviderError(value.error);
    if (videoUrl) throw invalidResponse('Seedance failed task contains a video URL');
  } else if (value.error !== null || videoUrl) {
    throw invalidResponse('Seedance nonterminal task content is invalid');
  }
  const usage = value.usage === undefined
    ? undefined
    : mapSeedanceVideoUsage(value.usage);
  return { status, ...(videoUrl ? { videoUrl } : {}), ...(usage ? { usage } : {}) };
}

function validateOptionalGenerationFacts(value: Record<string, unknown>): void {
  for (const key of [
    'seed',
    'duration',
    'frames',
    'framespersecond',
    'priority',
    'execution_expires_after'
  ]) {
    if (value[key] !== undefined) nonNegativeInteger(value[key], key);
  }
  for (const key of ['resolution', 'ratio', 'draft_task_id', 'service_tier']) {
    if (value[key] !== undefined) requireRemoteText(value[key], key);
  }
  for (const key of ['generate_audio', 'draft']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw invalidResponse(`Seedance ${key} is invalid`);
    }
  }
}

function validateProviderError(value: unknown): void {
  const error = exactResponseRecord(
    value,
    ['code', 'message'],
    [],
    'Seedance task error'
  );
  requireRemoteText(error.code, 'error code');
  requireRemoteText(error.message, 'error message');
}

function mapSubmissionFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted && submissionOutcomeIsUnknown(error)) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The Seedance video submission outcome is unknown'
    };
  }
  return {
    kind: 'failed_before_submission',
    message: safeSubmissionMessage(error),
    retryability: runtimeRetryability(error)
  };
}

function submissionOutcomeIsUnknown(error: unknown): boolean {
  if (error instanceof SeedanceVideoAdapterError) {
    return error.safeCode === 'volcengine.invalid_response';
  }
  return error instanceof VolcengineRuntimeError && [
    'timeout',
    'network_error',
    'provider_unavailable',
    'cancelled',
    'proxy_unavailable',
    'response_too_large',
    'invalid_response'
  ].includes(error.code);
}

function safeSubmissionMessage(error: unknown): string {
  if (error instanceof SeedanceVideoAdapterError) return error.message;
  if (error instanceof VolcengineRuntimeError) {
    return 'The Seedance video request was rejected before acceptance';
  }
  return 'The Seedance video request could not be prepared';
}

function runtimeRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (error instanceof VolcengineRuntimeError) return error.retryability;
  if (error instanceof SeedanceVideoAdapterError) return error.retryability;
  return 'unknown';
}

function isInvalidResponse(error: unknown): boolean {
  return (
    error instanceof SeedanceVideoAdapterError &&
    error.safeCode === 'volcengine.invalid_response'
  ) || (
    error instanceof VolcengineRuntimeError &&
    error.code === 'invalid_response'
  );
}

function parseJsonObject(body: Uint8Array, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body)
    );
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
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
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(
      'volcengine.invalid_request',
      `${label} contains unsupported fields`
    );
  }
  return value;
}

function requireInvocationAttemptId(value: unknown): ProviderInvocationAttemptId {
  return requireOpaqueRequestId(
    value,
    'invocation attempt ID'
  ) as ProviderInvocationAttemptId;
}

function requireOpaqueRequestId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidRequest('volcengine.invalid_request', `${label} is invalid`);
  }
  return value;
}

function requireRemoteId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw invalidResponse('Seedance operation ID is invalid');
  }
  return value;
}

function requireRemoteText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse(`Seedance ${label} is invalid`);
  }
  return value.trim();
}

function requireHttpsResultUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`Seedance ${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse(`Seedance ${label} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname.includes('.')
  ) {
    throw invalidResponse(`Seedance ${label} is invalid`);
  }
  return url.toString();
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('volcengine.invalid_request', 'Seedance prompt is invalid');
  }
  const prompt = value.trim();
  if (prompt.length < 1 || prompt.length > 5_000) {
    throw invalidRequest('volcengine.invalid_request', 'Seedance prompt is invalid');
  }
  return prompt;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidResponse(`Seedance ${label} must be a non-negative integer`);
  }
  return Number(value);
}

function oneOfStatus(value: unknown): ParsedSeedanceTask['status'] {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'cancelled' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'expired'
  ) {
    return value;
  }
  throw invalidResponse('Seedance task status is invalid');
}

function usageFact(
  metricId: string,
  quantity: number,
  unit: string
): UsageFactV1 {
  return {
    metricId,
    quantity: String(quantity),
    unit,
    source: 'provider_body'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class SeedanceVideoAdapterError extends Error {
  constructor(
    readonly safeCode: string,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'SeedanceVideoAdapterError';
  }
}

function invalidRequest(safeCode: string, message: string) {
  return new SeedanceVideoAdapterError(safeCode, message, 'not_retryable');
}

function invalidResponse(message: string) {
  return new SeedanceVideoAdapterError(
    'volcengine.invalid_response',
    message,
    'unknown'
  );
}
