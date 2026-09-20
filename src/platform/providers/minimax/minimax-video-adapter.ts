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
  frozenMiniMaxH3ModelKeys,
  MINIMAX_H3_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
  MINIMAX_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  MINIMAX_H3_VIDEO_ADAPTER_ID,
  MINIMAX_H3_VIDEO_ADAPTER_VERSION,
  MINIMAX_H3_VIDEO_PROTOCOL_ID,
  MINIMAX_H3_VIDEO_PROTOCOL_VERSION,
  MINIMAX_H3_VIDEO_RESULT_SCHEMA_ID,
  MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID,
  isMiniMaxH3EndpointPolicy,
  minimaxH3VideoUsageSchema
} from './minimax-contracts';
import {
  MiniMaxRuntimeError,
  type MiniMaxHttpTransportResponse,
  type MiniMaxSharedRuntime
} from './minimax-runtime';

const maximumImageBytes = 30_000_000;
const maximumRequestBytes = 2 * 1024 * 1024;
const maximumResultBytes = 512 * 1024 * 1024;
const resultLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const resultId = 'video';
const maximumPromptChars = 7_000;
const supportedImageMimeTypes = new Set(['image/jpeg', 'image/png']);
const supportedParameterFields = new Set(['resolution', 'aspect_ratio', 'duration']);
const authenticationStatusCodes = new Set([1004, 2013, 2049]);
const accountUnavailableStatusCodes = new Set([1008]);
const rateLimitedStatusCodes = new Set([1002]);

export interface MiniMaxVideoCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface MiniMaxVideoConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface MiniMaxVideoParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export interface ControlledMiniMaxImageV1 {
  readonly assetId: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

export interface ControlledMiniMaxImagePort {
  resolve(input: {
    readonly projectId: string;
    readonly assetId: string;
  }): Promise<ControlledMiniMaxImageV1>;
}

export interface MiniMaxVideoUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface MiniMaxVideoAdapterIdFactory {
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface MiniMaxVideoDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly assetId?: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

interface ValidatedMiniMaxRoute extends ProviderExecutionRouteSnapshotV1 {
  readonly productFeature: 'text_to_video' | 'image_to_video';
  readonly providerModelKey: string;
}

interface MiniMaxOperationContext {
  readonly route: ValidatedMiniMaxRoute;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly connection: ProviderConnection;
  usagePersisted: boolean;
}

interface MiniMaxResultSnapshot {
  readonly url: string;
  readonly expiresAt: number;
}

interface ParsedMiniMaxTask {
  readonly status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  readonly createdAtMs: number;
  readonly videoUrl?: string;
  readonly usage?: readonly UsageFactV1[];
}


export class MiniMaxManagementAdapter implements ProviderManagementAdapterPort {
  readonly identity = {
    packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
    adapterId: MINIMAX_H3_VIDEO_ADAPTER_ID,
    adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION,
    protocolId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
    protocolVersion: MINIMAX_H3_VIDEO_PROTOCOL_VERSION
  } as const;

  constructor(
    private readonly runtime: MiniMaxSharedRuntime,
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
        error instanceof MiniMaxRuntimeError &&
        error.code === 'authentication_failed';
      const adapterCode = error instanceof MiniMaxVideoAdapterError
        ? error.safeCode
        : undefined;
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState: authenticationFailed
          ? 'invalid'
          : 'verification_unavailable',
        observedAt: this.now(),
        safeCode: authenticationFailed
          ? 'authentication_failed'
          : error instanceof MiniMaxRuntimeError
            ? error.code
            : adapterCode ?? 'unknown'
      };
    }
  }
}

export class MiniMaxVideoAdapter
  implements ProviderAsyncOperationPort, VideoResultPort {
  private readonly operations = new Map<string, MiniMaxOperationContext>();
  private readonly results = new Map<string, MiniMaxResultSnapshot>();
  private disposed = false;

  constructor(
    private readonly runtime: MiniMaxSharedRuntime,
    private readonly connections: MiniMaxVideoConnectionResolverPort,
    private readonly credentials: MiniMaxVideoCredentialResolverPort,
    private readonly parameterSchemas: MiniMaxVideoParameterSchemaResolverPort,
    private readonly images: ControlledMiniMaxImagePort,
    private readonly usage: MiniMaxVideoUsageObservationSinkPort,
    private readonly ids: MiniMaxVideoAdapterIdFactory,
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
    let submissionContext: MiniMaxOperationContext | undefined;
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
      const fileId = image
        ? await this.credentials.useCredential(
            {
              connectionId: route.connectionId,
              credentialVersionId: route.credentialVersionId
            },
            (credential) => this.runtime.requestFileUpload({
              connection,
              credentials: credential,
              filename: image.mimeType === 'image/jpeg'
                ? 'first-frame.jpg'
                : 'first-frame.png',
              mimeType: image.mimeType,
              bytes: image.bytes,
              signal: input.signal
            }).then(parseUploadResponse)
          )
        : undefined;
      const body = serializeVideoRequest(route, request, fileId);
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
        throw invalidResponse('MiniMax returned a duplicate operation ID');
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
        'minimax.operation_conflict',
        'The MiniMax operation is already attached to another route'
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
          expiresAt: task.createdAtMs + resultLifetimeMs
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
        message: 'MiniMax reported that the video task failed',
        retryability: 'not_retryable'
      };
    } catch (error) {
      if (isInvalidResponse(error) && !context.usagePersisted) {
        await this.persistUsage(context, 'invalid_response', []);
      }
      throw error;
    }
  }

  async cancel(providerOperationId: string): Promise<ProviderCancelOutcome> {
    this.requireActive();
    const remoteId = requireRemoteId(providerOperationId);
    this.requireOperation(remoteId);
    return { state: 'processing' };
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
        'The MiniMax video result is unavailable'
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
      name: 'minimax-video',
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
        'The MiniMax video result is unavailable'
      );
    }
    const snapshot = await this.loadCurrentResult(remoteId);
    if (this.nowMilliseconds() >= snapshot.expiresAt) {
      throw new VideoResultPortError(
        'not_retryable',
        'The MiniMax video result URL has expired'
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
          'The MiniMax result did not contain video bytes'
        );
      }
      return Readable.from([Buffer.from(downloaded.body)]);
    } catch (error) {
      if (error instanceof VideoResultPortError) throw error;
      throw new VideoResultPortError(
        runtimeRetryability(error),
        'The MiniMax video result could not be downloaded'
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
      throw new MiniMaxRuntimeError('runtime_shutting_down', 'not_retryable');
    }
  }

  private requireOperation(providerOperationId: string): MiniMaxOperationContext {
    const context = this.operations.get(providerOperationId);
    if (!context) {
      throw invalidRequest(
        'minimax.operation_not_attached',
        'The MiniMax operation must be attached with its original route snapshot'
      );
    }
    return context;
  }

  private async requireConnection(
    route: ValidatedMiniMaxRoute
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
        'minimax.connection_snapshot_unavailable',
        'The exact MiniMax connection snapshot is unavailable'
      );
    }
    return connection;
  }

  private async requireParameterSchema(
    route: ValidatedMiniMaxRoute
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
        'minimax.parameter_schema_unavailable',
        'The exact MiniMax parameter schema is unavailable'
      );
    }
    if (
      !schema ||
      validated.schemaId !== route.parameterSchemaId ||
      validated.revision !== route.parameterSchemaRevision ||
      validated.productFeature !== route.productFeature ||
      validated.fields.some(
        (field) =>
          !supportedParameterFields.has(field.fieldId) ||
          (route.productFeature === 'image_to_video' &&
            field.fieldId === 'aspect_ratio')
      )
    ) {
      throw invalidRequest(
        'minimax.parameter_schema_unavailable',
        'The exact MiniMax parameter schema is unavailable'
      );
    }
    return validated;
  }

  private async persistTerminalUsage(
    context: MiniMaxOperationContext,
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
    context: MiniMaxOperationContext,
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
        usageSchemaId: minimaxH3VideoUsageSchema.id,
        usageSchemaRevision: minimaxH3VideoUsageSchema.revision,
        sourceEventKey: `minimax_h3_video_usage_${context.invocationAttemptId}`,
        sequence: 1,
        status,
        sourceStage: 'poll',
        facts,
        observedAt: this.nowTimestamp()
      }, minimaxH3VideoUsageSchema),
      minimaxH3VideoUsageSchema
    );
    context.usagePersisted = true;
  }

  private async loadCurrentResult(
    providerOperationId: string
  ): Promise<MiniMaxResultSnapshot> {
    const status = await this.query(providerOperationId);
    if (status.state !== 'completed') {
      throw new VideoResultPortError(
        status.state === 'failed' ? status.retryability : 'retryable',
        'The MiniMax video result is not available'
      );
    }
    const snapshot = this.results.get(providerOperationId);
    if (!snapshot) {
      throw new VideoResultPortError(
        'not_retryable',
        'The MiniMax video result declaration is invalid'
      );
    }
    return snapshot;
  }
}


function interpretProbeResponse(
  response: MiniMaxHttpTransportResponse,
  observedAt: IsoTimestamp
): ProviderConnectionValidationResultV1 {
  const statusCode = extractStatusCode(response);
  const authenticationFailed =
    response.status === 401 ||
    (statusCode !== undefined && authenticationStatusCodes.has(statusCode));
  if (authenticationFailed) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid',
      observedAt,
      safeCode: 'authentication_failed'
    };
  }
  if (
    response.status === 429 ||
    (statusCode !== undefined && rateLimitedStatusCodes.has(statusCode))
  ) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'verification_unavailable',
      observedAt,
      safeCode: 'rate_limited'
    };
  }
  if (statusCode !== undefined && accountUnavailableStatusCodes.has(statusCode)) {
    return {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'valid',
      observedAt,
      safeCode: 'account_unavailable'
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
  return {
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    observedAt
  };
}

function extractStatusCode(response: MiniMaxHttpTransportResponse): number | undefined {
  if (response.body.byteLength < 1) return undefined;
  try {
    const parsed = parseJsonObject(response.body, 'MiniMax probe response');
    const fromBase = recordValue(parsed.base_resp, 'status_code');
    if (typeof fromBase === 'number' && Number.isSafeInteger(fromBase)) return fromBase;
    if (typeof parsed.status_code === 'number' && Number.isSafeInteger(parsed.status_code)) {
      return parsed.status_code;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function validateRoute(value: unknown): ValidatedMiniMaxRoute {
  const route = parseProviderExecutionRouteSnapshot(value);
  const feature = route.productFeature;
  const expectedConstraint = feature === 'text_to_video'
    ? MINIMAX_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
    : feature === 'image_to_video'
      ? MINIMAX_H3_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
      : undefined;
  if (
    route.packageId !== MINIMAX_H3_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== MINIMAX_H3_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== MINIMAX_H3_VIDEO_ADAPTER_ID ||
    route.adapterVersion !== MINIMAX_H3_VIDEO_ADAPTER_VERSION ||
    !isMiniMaxH3EndpointPolicy(route.endpointPolicyId) ||
    route.endpointPolicyRevision !== 1 ||
    route.resultSchemaId !== MINIMAX_H3_VIDEO_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== expectedConstraint ||
    route.constraintSetRevision !== 1 ||
    route.parameterSchemaRevision !== 1 ||
    !route.providerModelKey ||
    !(frozenMiniMaxH3ModelKeys as readonly string[]).includes(route.providerModelKey) ||
    route.internalPurpose !== (feature === 'text_to_video'
      ? 'video_generation'
      : 'reference_to_video') ||
    !expectedConstraint
  ) {
    throw invalidRequest(
      'minimax.route_mismatch',
      'The route snapshot does not select the exact MiniMax H3 video contract'
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
  route: ValidatedMiniMaxRoute,
  schema: ParameterSchemaV2
): MiniMaxVideoDispatchRequestV1 {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['assetId', 'taskId', 'executionId'],
    'MiniMax video request'
  );
  const projectId = requireOpaqueRequestId(item.projectId, 'project ID');
  if (projectId !== route.projectId) {
    throw invalidRequest(
      'minimax.route_mismatch',
      'The MiniMax request project does not match the route snapshot'
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
      'minimax.invalid_request',
      'The MiniMax request material does not match the product feature'
    );
  }
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(schema, 'full', item.parameterValues);
  } catch {
    throw invalidRequest(
      'minimax.invalid_request',
      'The MiniMax parameter projection is invalid'
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
  image: ControlledMiniMaxImageV1,
  expectedAssetId: string
): ControlledMiniMaxImageV1 {
  const mimeType = image.mimeType.toLowerCase();
  const aspectRatio = image.width / image.height;
  if (
    image.assetId !== expectedAssetId ||
    !supportedImageMimeTypes.has(mimeType) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 256 ||
    image.height < 256 ||
    image.width > 5_760 ||
    image.height > 5_760 ||
    aspectRatio < 0.4 ||
    aspectRatio > 2.5 ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 1 ||
    image.sizeBytes > maximumImageBytes ||
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength !== image.sizeBytes
  ) {
    throw invalidRequest(
      'minimax.invalid_image',
      'The controlled first-frame image does not satisfy the MiniMax H3 contract'
    );
  }
  return { ...image, mimeType, bytes: Uint8Array.from(image.bytes) };
}

function serializeVideoRequest(
  route: ValidatedMiniMaxRoute,
  request: MiniMaxVideoDispatchRequestV1,
  fileId: string | undefined
): Uint8Array {
  const settings: Record<string, ParameterValue> = {};
  for (const [key, value] of Object.entries(request.parameterValues)) {
    if (!supportedParameterFields.has(key)) {
      throw invalidRequest(
        'minimax.invalid_request',
        'The MiniMax request contains an unsupported parameter'
      );
    }
    if (route.productFeature === 'image_to_video' && key === 'aspect_ratio') {
      throw invalidRequest(
        'minimax.invalid_request',
        'MiniMax image-to-video cannot send a ratio'
      );
    }
    settings[key] = value;
  }
  const content: Record<string, unknown>[] = [
    { type: 'text', text: request.prompt }
  ];
  if (route.productFeature === 'image_to_video') {
    content.push({
      type: 'image_url',
      image_url: { url: `mm_file://${fileId}` },
      role: 'first_frame'
    });
  }
  const body: Record<string, unknown> = {
    model: route.providerModelKey,
    content,
    duration: settings.duration,
    resolution: settings.resolution
  };
  if (route.productFeature === 'text_to_video') {
    if (typeof settings.aspect_ratio !== 'string') {
      throw invalidRequest(
        'minimax.invalid_request',
        'MiniMax text-to-video requires an aspect ratio'
      );
    }
    body.ratio = settings.aspect_ratio;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength < 1 || bytes.byteLength > maximumRequestBytes) {
    throw invalidRequest(
      'minimax.request_too_large',
      'The serialized MiniMax request exceeds 2 MB'
    );
  }
  return bytes;
}


function parseUploadResponse(body: Uint8Array): string {
  const envelope = parseJsonObject(body, 'MiniMax upload response');
  rejectBusinessError(envelope, 'MiniMax upload response');
  const file = isRecord(envelope.file) ? envelope.file : envelope;
  const fileId = file.file_id ?? file.id;
  return requireRemoteId(fileId === undefined ? fileId : String(fileId));
}

function parseCreateResponse(body: Uint8Array): string {
  const envelope = parseJsonObject(body, 'MiniMax create response');
  rejectBusinessError(envelope, 'MiniMax create response');
  const taskId = envelope.task_id
    ?? recordValue(envelope.task, 'id')
    ?? recordValue(envelope.task, 'task_id');
  return requireRemoteId(taskId === undefined ? taskId : String(taskId));
}

function parseTaskResponse(
  body: Uint8Array,
  expectedId: string
): ParsedMiniMaxTask {
  const envelope = parseJsonObject(body, 'MiniMax task response');
  rejectBusinessError(envelope, 'MiniMax task response');
  const task = isRecord(envelope.task) ? envelope.task : envelope;
  const taskId = task.task_id ?? task.id;
  if (taskId !== undefined && requireRemoteId(String(taskId)) !== expectedId) {
    throw invalidResponse('MiniMax returned a mismatched operation ID');
  }
  const status = taskStatus(task.status);
  const createdAtMs = createdAtMilliseconds(task);
  const videoUrl = parseTaskContent(task.content, status);
  const usage = task.usage === undefined ? undefined : mapMiniMaxVideoUsage(task.usage);
  return {
    status,
    createdAtMs,
    ...(videoUrl ? { videoUrl } : {}),
    ...(usage ? { usage } : {})
  };
}

function parseTaskContent(
  value: unknown,
  status: ParsedMiniMaxTask['status']
): string | undefined {
  if (status !== 'succeeded') {
    if (value === undefined || isRecord(value)) return undefined;
    throw invalidResponse('MiniMax non-success task content is invalid');
  }
  if (!isRecord(value)) {
    throw invalidResponse('MiniMax succeeded task must contain video content');
  }
  return requireHttpsResultUrl(value.url, 'video URL');
}

function createdAtMilliseconds(task: Record<string, unknown>): number {
  const value = task.created_at ?? task.create_time;
  if (value === undefined) return Date.now();
  if (!Number.isFinite(Number(value))) {
    throw invalidResponse('MiniMax task timestamp is invalid');
  }
  const numeric = Number(value);
  return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
}

function mapMiniMaxVideoUsage(value: unknown): readonly UsageFactV1[] {
  if (!isRecord(value)) {
    throw invalidResponse('MiniMax usage must be an object');
  }
  const facts: UsageFactV1[] = [];
  pushIntegerUsage(facts, value, 'output_seconds', 'second', true);
  pushIntegerUsage(facts, value, 'input_seconds', 'second', false);
  pushIntegerUsage(facts, value, 'total_seconds', 'second', false);
  pushIntegerUsage(facts, value, 'input_image_count', 'count', false);
  pushIntegerUsage(facts, value, 'prompt_tokens', 'token', false);
  pushIntegerUsage(facts, value, 'completion_tokens', 'token', false);
  pushIntegerUsage(facts, value, 'total_tokens', 'token', false);
  return facts;
}

function pushIntegerUsage(
  facts: UsageFactV1[],
  value: Record<string, unknown>,
  metricId: string,
  unit: string,
  required: boolean
): void {
  const raw = value[metricId];
  if (raw === undefined) {
    if (required) throw invalidResponse(`MiniMax usage is missing ${metricId}`);
    return;
  }
  if (!Number.isSafeInteger(raw) || Number(raw) < 0) {
    throw invalidResponse(`MiniMax ${metricId} must be a non-negative integer`);
  }
  facts.push(usageFact(metricId, String(raw), unit));
}

function rejectBusinessError(value: Record<string, unknown>, label: string): void {
  const statusCode = recordValue(value.base_resp, 'status_code');
  if (statusCode === undefined) return;
  if (!Number.isSafeInteger(statusCode)) {
    throw invalidResponse(`${label} business status is invalid`);
  }
  if (statusCode === 0) return;
  if (authenticationStatusCodes.has(Number(statusCode))) {
    throw new MiniMaxRuntimeError('authentication_failed', 'not_retryable');
  }
  if (rateLimitedStatusCodes.has(Number(statusCode))) {
    throw new MiniMaxRuntimeError('rate_limited', 'retryable');
  }
  if (accountUnavailableStatusCodes.has(Number(statusCode))) {
    throw new MiniMaxRuntimeError('permission_denied', 'not_retryable');
  }
  throw invalidResponse(`${label} was rejected`);
}

function mapSubmissionFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted && submissionOutcomeIsUnknown(error)) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The MiniMax video submission outcome is unknown'
    };
  }
  return {
    kind: 'failed_before_submission',
    message: safeSubmissionMessage(error),
    retryability: runtimeRetryability(error)
  };
}

function submissionOutcomeIsUnknown(error: unknown): boolean {
  if (error instanceof MiniMaxVideoAdapterError) {
    return error.safeCode === 'minimax.invalid_response';
  }
  return error instanceof MiniMaxRuntimeError && [
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
  if (error instanceof MiniMaxVideoAdapterError) return error.message;
  if (error instanceof MiniMaxRuntimeError) {
    return 'The MiniMax video request was rejected before acceptance';
  }
  return 'The MiniMax video request could not be prepared';
}

function runtimeRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (error instanceof MiniMaxRuntimeError) return error.retryability;
  if (error instanceof MiniMaxVideoAdapterError) return error.retryability;
  return 'unknown';
}

function isInvalidResponse(error: unknown): boolean {
  return (
    error instanceof MiniMaxVideoAdapterError &&
    error.safeCode === 'minimax.invalid_response'
  ) || (
    error instanceof MiniMaxRuntimeError &&
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

function exactRequestRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidRequest('minimax.invalid_request', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(
      'minimax.invalid_request',
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
    throw invalidRequest('minimax.invalid_request', `${label} is invalid`);
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
    throw invalidResponse('MiniMax operation ID is invalid');
  }
  return value;
}

function requireHttpsResultUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`MiniMax ${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse(`MiniMax ${label} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname.includes('.')
  ) {
    throw invalidResponse(`MiniMax ${label} is invalid`);
  }
  return url.toString();
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('minimax.invalid_request', 'MiniMax prompt is invalid');
  }
  const prompt = value.trim();
  if (prompt.length < 1 || prompt.length > maximumPromptChars) {
    throw invalidRequest('minimax.invalid_request', 'MiniMax prompt is invalid');
  }
  return prompt;
}

function taskStatus(value: unknown): ParsedMiniMaxTask['status'] {
  if (value === 'queued') return 'queued';
  if (value === 'running' || value === 'processing') return 'processing';
  if (value === 'succeeded' || value === 'success' || value === 'Success') {
    return 'succeeded';
  }
  if (value === 'failed' || value === 'Fail' || value === 'failure') return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  throw invalidResponse('MiniMax task status is invalid');
}

function usageFact(
  metricId: string,
  quantity: string,
  unit: string
): UsageFactV1 {
  return { metricId, quantity, unit, source: 'provider_body' };
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MiniMaxVideoAdapterError extends Error {
  constructor(
    readonly safeCode: string,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'MiniMaxVideoAdapterError';
  }
}

function invalidRequest(safeCode: string, message: string) {
  return new MiniMaxVideoAdapterError(safeCode, message, 'not_retryable');
}

function invalidResponse(message: string) {
  return new MiniMaxVideoAdapterError('minimax.invalid_response', message, 'unknown');
}
