import { Readable } from 'node:stream';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toIsoTimestamp,
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
import type {
  ProviderConnectionValidationResultV1,
  ProviderManagementAdapterPort
} from '../provider-management-framework';
import {
  VideoResultPortError,
  type VideoRemoteCompletionFact,
  type VideoRemoteResultDescriptor,
  type VideoResultPort
} from '../../videos/video-result-port';
import {
  UNICOMPAPI_STUDIO_H3_ASPECT_RATIOS,
  UNICOMPAPI_STUDIO_H3_GENERATION_MODES,
  UNICOMPAPI_STUDIO_H3_MODEL_KEY,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
  UNICOMPAPI_STUDIO_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  UNICOMPAPI_STUDIO_H3_VARIANT,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_RESULT_SCHEMA_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID,
  isUnicompapiStudioH3EndpointPolicy,
  unicompapiStudioH3VideoUsageSchema
} from './unicompapi-studio-h3-contracts';
import {
  UnicompapiStudioH3RuntimeError,
  type UnicompapiStudioH3HttpTransportResponse,
  type UnicompapiStudioH3SharedRuntime
} from './unicompapi-studio-h3-runtime';

const maximumRequestBytes = 2 * 1024 * 1024;
const maximumResultBytes = 512 * 1024 * 1024;
const resultLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const resultId = 'video';
const maximumPromptChars = 7_000;
const supportedParameterFields = new Set(['generation_mode', 'aspect_ratio', 'duration']);

export interface UnicompapiStudioH3VideoCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface UnicompapiStudioH3VideoConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface UnicompapiStudioH3VideoParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export interface UnicompapiStudioH3VideoUsageObservationSinkPort {
  append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1): Promise<void>;
}

export interface UnicompapiStudioH3VideoAdapterIdFactory {
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

interface ValidatedStudioH3Route extends ProviderExecutionRouteSnapshotV1 {
  readonly productFeature: 'text_to_video';
  readonly providerModelKey: string;
}

interface StudioH3OperationContext {
  readonly route: ValidatedStudioH3Route;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly connection: ProviderConnection;
  usagePersisted: boolean;
}

interface StudioH3ResultSnapshot {
  readonly url: string;
  readonly expiresAt: number;
}

export class UnicompapiStudioH3ManagementAdapter implements ProviderManagementAdapterPort {
  readonly identity = {
    packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
    adapterId: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
    adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
    protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
    protocolVersion: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
  } as const;

  constructor(
    private readonly runtime: UnicompapiStudioH3SharedRuntime,
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async validateConnection(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<ProviderConnectionValidationResultV1> {
    try {
      const response = await this.runtime.requestCredentialProbe(input);
      return interpretProbeResponse(response, this.now());
    } catch (error) {
      const authenticationFailed =
        error instanceof UnicompapiStudioH3RuntimeError &&
        error.code === 'authentication_failed';
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState: authenticationFailed ? 'invalid' : 'verification_unavailable',
        observedAt: this.now(),
        safeCode: authenticationFailed
          ? 'authentication_failed'
          : error instanceof UnicompapiStudioH3RuntimeError
            ? error.code
            : 'unknown'
      };
    }
  }
}

export class UnicompapiStudioH3VideoAdapter
  implements ProviderAsyncOperationPort, VideoResultPort {
  private readonly operations = new Map<string, StudioH3OperationContext>();
  private readonly results = new Map<string, StudioH3ResultSnapshot>();
  private disposed = false;

  constructor(
    private readonly runtime: UnicompapiStudioH3SharedRuntime,
    private readonly connections: UnicompapiStudioH3VideoConnectionResolverPort,
    private readonly credentials: UnicompapiStudioH3VideoCredentialResolverPort,
    private readonly parameterSchemas: UnicompapiStudioH3VideoParameterSchemaResolverPort,
    private readonly usage: UnicompapiStudioH3VideoUsageObservationSinkPort,
    private readonly ids: UnicompapiStudioH3VideoAdapterIdFactory,
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
    let submissionContext: StudioH3OperationContext | undefined;
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
      const body = serializeVideoRequest(request);
      const responseBody = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.requestVideoCreate({
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
        throw invalidResponse('UniCompAPI Studio H3 returned a duplicate operation ID');
      }
      this.operations.set(providerOperationId, submissionContext);
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
          outcome.kind === 'submission_outcome_unknown' ? 'unknown_outcome' : 'not_reported',
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
    const invocationAttemptId = requireInvocationAttemptId(input.invocationAttemptId);
    const connection = await this.requireConnection(route);
    const existing = this.operations.get(providerOperationId);
    if (
      existing &&
      (existing.route.id !== route.id || existing.invocationAttemptId !== invocationAttemptId)
    ) {
      throw invalidRequest(
        'unicompapi.studio-h3.operation_conflict',
        'The UniCompAPI Studio H3 operation is already attached to another route'
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
        (credential) => this.runtime.requestVideoQuery({
          connection: context.connection,
          credentials: credential,
          providerOperationId: remoteId,
          signal
        })
      );
      const task = parseTaskResponse(responseBody, remoteId);
      if (task.status === 'queued') return { state: 'queued' };
      if (task.status === 'processing') return { state: 'processing' };
      await this.persistTerminalUsage(context, task.usage);
      if (task.status === 'succeeded') {
        this.results.set(remoteId, {
          url: task.videoUrl!,
          expiresAt: this.nowMilliseconds() + resultLifetimeMs
        });
        return {
          state: 'completed',
          ...(task.usage ? { usageFacts: task.usage } : {})
        };
      }
      this.results.delete(remoteId);
      if (task.status === 'cancelled') return { state: 'cancelled' };
      return {
        state: 'failed',
        message: task.message ?? 'UniCompAPI Studio H3 reported that the video task failed',
        retryability: 'not_retryable'
      };
    } catch (error) {
      if (
        error instanceof UnicompapiStudioH3RuntimeError &&
        error.code === 'invalid_response' &&
        !context.usagePersisted
      ) {
        await this.persistUsage(context, 'invalid_response', []);
      }
      throw error;
    }
  }

  async cancel(providerOperationId: string): Promise<ProviderCancelOutcome> {
    this.requireActive();
    const remoteId = requireRemoteId(providerOperationId);
    const context = this.requireOperation(remoteId);
    try {
      const response = await this.credentials.useCredential(
        {
          connectionId: context.route.connectionId,
          credentialVersionId: context.route.credentialVersionId
        },
        (credential) => this.runtime.requestVideoCancel({
          connection: context.connection,
          credentials: credential,
          providerOperationId: remoteId
        })
      );
      if (response.status === 409) return { state: 'processing' };
      if (response.body.byteLength > 0) {
        const task = parseTaskResponse(response.body, remoteId);
        if (task.status === 'cancelled') return { state: 'cancelled' };
        if (task.status === 'succeeded' || task.status === 'failed') return { state: 'unknown' };
      }
      return { state: 'processing' };
    } catch (error) {
      if (
        error instanceof UnicompapiStudioH3RuntimeError &&
        (error.code === 'provider_unavailable' || error.code === 'content_moderation_pending')
      ) {
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
    if (status.state === 'cancelled' || status.state === 'expired') {
      throw new VideoResultPortError(
        'not_retryable',
        'The UniCompAPI Studio H3 video result is unavailable'
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
      name: 'unicompapi-studio-h3-video',
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
        'The UniCompAPI Studio H3 video result is unavailable'
      );
    }
    const snapshot = await this.loadCurrentResult(remoteId);
    if (this.nowMilliseconds() >= snapshot.expiresAt) {
      throw new VideoResultPortError(
        'not_retryable',
        'The UniCompAPI Studio H3 video result URL has expired'
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
        !downloaded.contentType.startsWith('video/') &&
        downloaded.contentType !== 'application/octet-stream'
      ) {
        throw new VideoResultPortError(
          'not_retryable',
          'The UniCompAPI Studio H3 result did not contain video bytes'
        );
      }
      return Readable.from([Buffer.from(downloaded.body)]);
    } catch (error) {
      if (error instanceof VideoResultPortError) throw error;
      throw new VideoResultPortError(
        runtimeRetryability(error),
        'The UniCompAPI Studio H3 video result could not be downloaded'
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

  knowsOperation(providerOperationId: string): boolean {
    return this.operations.has(providerOperationId);
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new UnicompapiStudioH3RuntimeError('runtime_shutting_down', 'not_retryable');
    }
  }

  private requireOperation(providerOperationId: string): StudioH3OperationContext {
    const context = this.operations.get(providerOperationId);
    if (!context) {
      throw invalidRequest(
        'unicompapi.studio-h3.operation_not_attached',
        'The UniCompAPI Studio H3 operation must be attached with its original route snapshot'
      );
    }
    return context;
  }

  private async requireConnection(
    route: ValidatedStudioH3Route
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
        'unicompapi.studio-h3.connection_snapshot_unavailable',
        'The exact UniCompAPI Studio H3 connection snapshot is unavailable'
      );
    }
    return connection;
  }

  private async requireParameterSchema(
    route: ValidatedStudioH3Route
  ): Promise<ParameterSchemaV2> {
    const schema = await this.parameterSchemas.get(
      route.parameterSchemaId,
      route.parameterSchemaRevision
    );
    if (!schema) {
      throw invalidRequest(
        'unicompapi.studio-h3.invalid_request',
        'The UniCompAPI Studio H3 parameter schema is unavailable'
      );
    }
    return schema;
  }

  private async loadCurrentResult(providerOperationId: string): Promise<StudioH3ResultSnapshot> {
    const status = await this.query(providerOperationId);
    if (status.state !== 'completed') {
      throw new VideoResultPortError(
        'not_retryable',
        'The UniCompAPI Studio H3 video result is not ready'
      );
    }
    const snapshot = this.results.get(providerOperationId);
    if (!snapshot) {
      throw new VideoResultPortError(
        'not_retryable',
        'The UniCompAPI Studio H3 video result declaration is invalid'
      );
    }
    return snapshot;
  }

  private async persistTerminalUsage(
    context: StudioH3OperationContext,
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
    context: StudioH3OperationContext,
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
        usageSchemaId: unicompapiStudioH3VideoUsageSchema.id,
        usageSchemaRevision: unicompapiStudioH3VideoUsageSchema.revision,
        sourceEventKey: `unicompapi_studio_h3_video_usage_${context.invocationAttemptId}`,
        sequence: 1,
        status,
        sourceStage: 'poll',
        facts,
        observedAt: this.nowTimestamp()
      }, unicompapiStudioH3VideoUsageSchema),
      unicompapiStudioH3VideoUsageSchema
    );
    context.usagePersisted = true;
  }

}

export class UnicompapiStudioH3VideoAdapterError extends Error {
  constructor(
    readonly safeCode: string,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown' = 'not_retryable'
  ) {
    super(message);
    this.name = 'UnicompapiStudioH3VideoAdapterError';
  }
}

function interpretProbeResponse(
  response: UnicompapiStudioH3HttpTransportResponse,
  observedAt: IsoTimestamp
): ProviderConnectionValidationResultV1 {
  if (response.status === 401) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid',
      observedAt,
      safeCode: 'authentication_failed'
    };
  }
  if (response.status === 429) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'verification_unavailable',
      observedAt,
      safeCode: 'rate_limited'
    };
  }
  if (response.status >= 500) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'verification_unavailable',
      observedAt,
      safeCode: 'provider_unavailable'
    };
  }
  if (response.status !== 200 || !catalogContainsStudioH3(response.body)) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'verification_unavailable',
      observedAt,
      safeCode: 'invalid_response'
    };
  }
  return {
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    observedAt
  };
}

function catalogContainsStudioH3(body: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    const items = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : [];
    return items.some(
      (item) => isRecord(item) && item.id === UNICOMPAPI_STUDIO_H3_MODEL_KEY
    );
  } catch {
    return false;
  }
}

function validateRoute(value: unknown): ValidatedStudioH3Route {
  const route = parseProviderExecutionRouteSnapshot(value);
  if (
    route.packageId !== UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID ||
    route.adapterVersion !== UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION ||
    !isUnicompapiStudioH3EndpointPolicy(route.endpointPolicyId) ||
    route.endpointPolicyRevision !== 1 ||
    route.resultSchemaId !== UNICOMPAPI_STUDIO_H3_VIDEO_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== UNICOMPAPI_STUDIO_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID ||
    route.constraintSetRevision !== 1 ||
    route.parameterSchemaRevision !== 1 ||
    route.providerModelKey !== UNICOMPAPI_STUDIO_H3_MODEL_KEY ||
    route.productFeature !== 'text_to_video' ||
    route.internalPurpose !== 'video_generation'
  ) {
    throw invalidRequest(
      'unicompapi.studio-h3.route_mismatch',
      'The route snapshot does not select the exact UniCompAPI Studio H3 video contract'
    );
  }
  return {
    ...route,
    productFeature: 'text_to_video',
    providerModelKey: route.providerModelKey
  };
}

function parseDispatchRequest(
  value: unknown,
  route: ValidatedStudioH3Route,
  schema: ParameterSchemaV2
): {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
} {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['taskId', 'executionId'],
    'UniCompAPI Studio H3 video request'
  );
  const projectId = requireOpaqueRequestId(item.projectId, 'project ID');
  if (projectId !== route.projectId) {
    throw invalidRequest(
      'unicompapi.studio-h3.route_mismatch',
      'The UniCompAPI Studio H3 request project does not match the route snapshot'
    );
  }
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(schema, 'full', item.parameterValues);
  } catch {
    throw invalidRequest(
      'unicompapi.studio-h3.invalid_request',
      'The UniCompAPI Studio H3 parameter projection is invalid'
    );
  }
  return {
    invocationAttemptId: requireInvocationAttemptId(item.invocationAttemptId),
    projectId,
    prompt: boundedPrompt(item.prompt),
    parameterValues
  };
}

function serializeVideoRequest(request: {
  readonly prompt: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}): Uint8Array {
  const settings: Record<string, ParameterValue> = {};
  for (const [key, value] of Object.entries(request.parameterValues)) {
    if (!supportedParameterFields.has(key)) {
      throw invalidRequest(
        'unicompapi.studio-h3.invalid_request',
        'The UniCompAPI Studio H3 request contains an unsupported parameter'
      );
    }
    settings[key] = value;
  }
  if (
    typeof settings.generation_mode !== 'string' ||
    !(UNICOMPAPI_STUDIO_H3_GENERATION_MODES as readonly string[]).includes(settings.generation_mode)
  ) {
    throw invalidRequest(
      'unicompapi.studio-h3.invalid_request',
      'UniCompAPI Studio H3 requires a generation mode'
    );
  }
  if (
    typeof settings.aspect_ratio !== 'string' ||
    !(UNICOMPAPI_STUDIO_H3_ASPECT_RATIOS as readonly string[]).includes(settings.aspect_ratio)
  ) {
    throw invalidRequest(
      'unicompapi.studio-h3.invalid_request',
      'UniCompAPI Studio H3 requires an aspect ratio'
    );
  }
  if (
    typeof settings.duration !== 'number' ||
    !Number.isSafeInteger(settings.duration) ||
    settings.duration < 4 ||
    settings.duration > 15
  ) {
    throw invalidRequest(
      'unicompapi.studio-h3.invalid_request',
      'UniCompAPI Studio H3 requires a duration'
    );
  }
  const body = {
    model: UNICOMPAPI_STUDIO_H3_MODEL_KEY,
    variant: UNICOMPAPI_STUDIO_H3_VARIANT,
    prompt: request.prompt,
    duration_seconds: settings.duration,
    aspect_ratio: settings.aspect_ratio,
    generation_mode: settings.generation_mode
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength < 1 || bytes.byteLength > maximumRequestBytes) {
    throw invalidRequest(
      'unicompapi.studio-h3.request_too_large',
      'The serialized UniCompAPI Studio H3 request exceeds 2 MB'
    );
  }
  return bytes;
}

function parseCreateResponse(body: Uint8Array): string {
  const envelope = parseJsonObject(body, 'UniCompAPI Studio H3 create response');
  rejectStudioError(envelope, 'UniCompAPI Studio H3 create response');
  return requireRemoteId(envelope.id);
}

function parseTaskResponse(
  body: Uint8Array,
  expectedId: string
): {
  readonly status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  readonly videoUrl?: string;
  readonly usage?: readonly UsageFactV1[];
  readonly message?: string;
} {
  const envelope = parseJsonObject(body, 'UniCompAPI Studio H3 task response');
  rejectStudioError(envelope, 'UniCompAPI Studio H3 task response');
  if (typeof envelope.id === 'string' && envelope.id !== expectedId) {
    throw invalidResponse('UniCompAPI Studio H3 returned a mismatched operation ID');
  }
  const status = taskStatus(envelope.status);
  const usage = mapUsage(envelope.duration_seconds);
  if (status !== 'succeeded') {
    return {
      status,
      usage,
      message: typeof envelope.error_message === 'string' ? envelope.error_message : undefined
    };
  }
  return {
    status,
    videoUrl: requireHttpsResultUrl(envelope.result_url, 'video URL'),
    usage
  };
}

function mapUsage(duration: unknown): readonly UsageFactV1[] | undefined {
  if (duration === undefined) return undefined;
  if (!Number.isSafeInteger(duration) || Number(duration) < 0) {
    throw invalidResponse('UniCompAPI Studio H3 duration must be a non-negative integer');
  }
  return [{
    metricId: 'output_seconds',
    quantity: String(duration),
    unit: 'second',
    source: 'provider_body'
  }];
}

function taskStatus(
  value: unknown
): 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled' {
  if (value === 'queued') return 'queued';
  if (value === 'running' || value === 'processing' || value === 'in_progress') {
    return 'processing';
  }
  if (value === 'succeeded' || value === 'success') return 'succeeded';
  if (value === 'failed' || value === 'failure') return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  throw invalidResponse('UniCompAPI Studio H3 task status is invalid');
}

function rejectStudioError(value: Record<string, unknown>, label: string): void {
  if (isRecord(value.error) || isRecord(value.detail)) {
    throw invalidResponse(`${label} was rejected`);
  }
}

function mapSubmissionFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted && submissionOutcomeIsUnknown(error)) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The UniCompAPI Studio H3 video submission outcome is unknown'
    };
  }
  return {
    kind: 'failed_before_submission',
    message: safeSubmissionMessage(error),
    retryability: runtimeRetryability(error)
  };
}

function submissionOutcomeIsUnknown(error: unknown): boolean {
  return error instanceof UnicompapiStudioH3RuntimeError && [
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
  if (error instanceof UnicompapiStudioH3VideoAdapterError) return error.message;
  if (error instanceof UnicompapiStudioH3RuntimeError) {
    if (error.code === 'content_moderation_pending') {
      return 'UniCompAPI Studio H3 is still moderating the request';
    }
    if (error.code === 'authentication_failed') {
      return 'The UniCompAPI Studio H3 video request was rejected before acceptance';
    }
    return 'The UniCompAPI Studio H3 video request was rejected before acceptance';
  }
  return 'The UniCompAPI Studio H3 video request could not be prepared';
}

function runtimeRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (error instanceof UnicompapiStudioH3RuntimeError) return error.retryability;
  if (error instanceof UnicompapiStudioH3VideoAdapterError) return error.retryability;
  return 'unknown';
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

function exactRequestRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidRequest('unicompapi.studio-h3.invalid_request', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(
      'unicompapi.studio-h3.invalid_request',
      `${label} contains unsupported fields`
    );
  }
  return value;
}

function requireInvocationAttemptId(value: unknown): ProviderInvocationAttemptId {
  return requireOpaqueRequestId(value, 'invocation attempt ID') as ProviderInvocationAttemptId;
}

function requireOpaqueRequestId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidRequest('unicompapi.studio-h3.invalid_request', `${label} is invalid`);
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
    throw invalidResponse('UniCompAPI Studio H3 operation ID is invalid');
  }
  return value;
}

function requireHttpsResultUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`UniCompAPI Studio H3 ${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse(`UniCompAPI Studio H3 ${label} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.hostname.toLowerCase() !== 'unicompapi.com'
  ) {
    throw invalidResponse(`UniCompAPI Studio H3 ${label} is invalid`);
  }
  return url.toString();
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('unicompapi.studio-h3.invalid_request', 'UniCompAPI Studio H3 prompt is invalid');
  }
  const prompt = value.trim();
  if (prompt.length < 1 || prompt.length > maximumPromptChars) {
    throw invalidRequest('unicompapi.studio-h3.invalid_request', 'UniCompAPI Studio H3 prompt is invalid');
  }
  return prompt;
}

function invalidRequest(safeCode: string, message: string): UnicompapiStudioH3VideoAdapterError {
  return new UnicompapiStudioH3VideoAdapterError(safeCode, message, 'not_retryable');
}

function invalidResponse(message: string): UnicompapiStudioH3VideoAdapterError {
  return new UnicompapiStudioH3VideoAdapterError(
    'unicompapi.studio-h3.invalid_response',
    message,
    'not_retryable'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
