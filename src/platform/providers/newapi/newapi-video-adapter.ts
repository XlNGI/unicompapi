import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
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
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_VIDEO_ADAPTER_ID,
  NEWAPI_VIDEO_RESULT_SCHEMA_ID,
  NEWAPI_VIDEO_USAGE_SCHEMA_ID,
  newApiVideoUsageSchema
} from './newapi-contracts';
import {
  isOpenAiCompatibleEndpointPolicyId,
  isOpenAiCompatiblePackageId
} from './openai-compatible-identity';
import { NewApiRuntimeError, type NewApiSharedRuntime } from './newapi-runtime';

const maximumImageBytes = 50_000_000;
const maximumRequestBytes = 64 * 1024 * 1024;
const maximumResultBytes = 512 * 1024 * 1024;
const resultId = 'video';
const supportedImageMimeTypes = new Set(['image/jpeg', 'image/png']);
const supportedParameterFields = new Set([
  'duration',
  'width',
  'height',
  'fps',
  'seed'
]);

export interface NewApiVideoCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface NewApiVideoConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface NewApiVideoParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export interface ControlledNewApiImageV1 {
  readonly assetId: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

export interface ControlledNewApiImagePort {
  resolve(input: {
    readonly projectId: string;
    readonly assetId: string;
  }): Promise<ControlledNewApiImageV1>;
}

export interface NewApiVideoUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface NewApiVideoAdapterIdFactory {
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface NewApiVideoDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly assetId?: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

interface ValidatedNewApiRoute extends ProviderExecutionRouteSnapshotV1 {
  readonly productFeature: 'text_to_video' | 'image_to_video';
  readonly providerModelKey: string;
}

interface NewApiOperationContext {
  readonly route: ValidatedNewApiRoute;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly connection: ProviderConnection;
  usagePersisted: boolean;
}

interface NewApiResultSnapshot {
  readonly completed: true;
}

interface ParsedNewApiTask {
  readonly status: 'queued' | 'in_progress' | 'completed' | 'failed';
}

export class NewApiVideoAdapter
  implements ProviderAsyncOperationPort, VideoResultPort {
  private readonly operations = new Map<string, NewApiOperationContext>();
  private readonly results = new Map<string, NewApiResultSnapshot>();
  private disposed = false;

  constructor(
    private readonly runtime: NewApiSharedRuntime,
    private readonly connections: NewApiVideoConnectionResolverPort,
    private readonly credentials: NewApiVideoCredentialResolverPort,
    private readonly parameterSchemas: NewApiVideoParameterSchemaResolverPort,
    private readonly images: ControlledNewApiImagePort,
    private readonly usage: NewApiVideoUsageObservationSinkPort,
    private readonly ids: NewApiVideoAdapterIdFactory,
    private readonly nowTimestamp: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSubmitOutcome> {
    let requestStarted = false;
    let submissionContext: NewApiOperationContext | undefined;
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
      const multipart = serializeVideoRequest(route, request, image);
      const responseBody = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.requestVideoCreate({
          connection,
          credentials: credential,
          body: multipart.body,
          contentType: multipart.contentType,
          signal: input.signal,
          beforeRequestStarted: async () => {
            await input.beforeRequestStarted?.();
            requestStarted = true;
          }
        })
      );
      const providerOperationId = parseCreateResponse(
        responseBody,
        route.providerModelKey
      );
      if (this.operations.has(providerOperationId)) {
        throw invalidResponse('NewApi returned a duplicate operation ID');
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
        'newApi.operation_conflict',
        'The NewApi operation is already attached to another route'
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
      const task = parseTaskResponse(
        responseBody,
        remoteId,
        context.route.providerModelKey
      );
      if (task.status === 'queued') return { state: 'queued' };
      if (task.status === 'in_progress') return { state: 'processing' };
      await this.persistTerminalUsage(context);
      if (task.status === 'completed') {
        this.results.set(remoteId, { completed: true });
        return { state: 'completed' };
      }
      this.results.delete(remoteId);
      return {
        state: 'failed',
        message: 'NewApi reported that the video task failed',
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
    // NewAPI does not publish a video-cancellation endpoint. Keep tracking the
    // same remote operation and report that it is still processing.
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
        'The NewApi video result is unavailable'
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
      name: 'newApi-video',
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
        'The NewApi video result is unavailable'
      );
    }
    await this.loadCurrentResult(remoteId);
    const context = this.requireOperation(remoteId);
    try {
      const downloaded = await this.credentials.useCredential(
        {
          connectionId: context.route.connectionId,
          credentialVersionId: context.route.credentialVersionId
        },
        (credential) => this.runtime.downloadVideoContent({
          connection: context.connection,
          credentials: credential,
          providerOperationId: remoteId,
          maximumResponseBytes: maximumResultBytes
        })
      );
      if (
        downloaded.contentType &&
        downloaded.contentType !== 'video/mp4' &&
        !downloaded.contentType.startsWith('video/')
      ) {
        throw new VideoResultPortError(
          'not_retryable',
          'The NewApi result did not contain video bytes'
        );
      }
      return Readable.from([Buffer.from(downloaded.body)]);
    } catch (error) {
      if (error instanceof VideoResultPortError) throw error;
      throw new VideoResultPortError(
        runtimeRetryability(error),
        'The NewApi video result could not be downloaded'
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
      throw new NewApiRuntimeError('runtime_shutting_down', 'not_retryable');
    }
  }

  private requireOperation(providerOperationId: string): NewApiOperationContext {
    const context = this.operations.get(providerOperationId);
    if (!context) {
      throw invalidRequest(
        'newApi.operation_not_attached',
        'The NewApi operation must be attached with its original route snapshot'
      );
    }
    return context;
  }

  private async requireConnection(
    route: ValidatedNewApiRoute
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
        'newApi.connection_snapshot_unavailable',
        'The exact NewApi connection snapshot is unavailable'
      );
    }
    return connection;
  }

  private async requireParameterSchema(
    route: ValidatedNewApiRoute
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
        'newApi.parameter_schema_unavailable',
        'The exact NewApi parameter schema is unavailable'
      );
    }
    if (
      !schema ||
      validated.schemaId !== route.parameterSchemaId ||
      validated.revision !== route.parameterSchemaRevision ||
      validated.productFeature !== route.productFeature ||
      validated.fields.some(
        (field) =>
          !supportedParameterFields.has(field.fieldId)
      )
    ) {
      throw invalidRequest(
        'newApi.parameter_schema_unavailable',
        'The exact NewApi parameter schema is unavailable'
      );
    }
    return validated;
  }

  private async persistTerminalUsage(
    context: NewApiOperationContext
  ): Promise<void> {
    if (context.usagePersisted) return;
    await this.persistUsage(context, 'not_reported', []);
  }

  private async persistUsage(
    context: NewApiOperationContext,
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
        usageSchemaId: newApiVideoUsageSchema.id,
        usageSchemaRevision: newApiVideoUsageSchema.revision,
        sourceEventKey: `newApi_video_usage_${context.invocationAttemptId}`,
        sequence: 1,
        status,
        sourceStage: 'poll',
        facts,
        observedAt: this.nowTimestamp()
      }, newApiVideoUsageSchema),
      newApiVideoUsageSchema
    );
    context.usagePersisted = true;
  }

  private async loadCurrentResult(
    providerOperationId: string
  ): Promise<NewApiResultSnapshot> {
    const existing = this.results.get(providerOperationId);
    if (existing) return existing;
    const status = await this.query(providerOperationId);
    if (status.state !== 'completed') {
      throw new VideoResultPortError(
        status.state === 'failed' ? status.retryability : 'retryable',
        'The NewApi video result is not available'
      );
    }
    const snapshot = this.results.get(providerOperationId);
    if (!snapshot) {
      throw new VideoResultPortError(
        'not_retryable',
        'The NewApi video result declaration is invalid'
      );
    }
    return snapshot;
  }
}

export function newApiVideoRecoveryDecision(state: string): {
  readonly sameOperationResumable: boolean;
  readonly action: 'attach_and_query' | 'none' | 'user_retry_required';
} {
  if (
    ['queued', 'processing', 'cancel_requested', 'cancellation_unknown']
      .includes(state)
  ) {
    return { sameOperationResumable: true, action: 'attach_and_query' };
  }
  if (state === 'submission_outcome_unknown' || state === 'unknown_outcome') {
    return { sameOperationResumable: false, action: 'user_retry_required' };
  }
  return { sameOperationResumable: false, action: 'none' };
}

function validateRoute(value: unknown): ValidatedNewApiRoute {
  const route = parseProviderExecutionRouteSnapshot(value);
  const feature = route.productFeature;
  const expectedConstraint = feature === 'text_to_video'
    ? NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
    : feature === 'image_to_video'
      ? NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID
      : undefined;
  if (
    !isOpenAiCompatiblePackageId(route.packageId) ||
    route.packageVersion !== NEWAPI_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== NEWAPI_VIDEO_ADAPTER_ID ||
    route.adapterVersion !== NEWAPI_ADAPTER_VERSION ||
    !isOpenAiCompatibleEndpointPolicyId(route.endpointPolicyId) ||
    route.endpointPolicyRevision !== 1 ||
    route.resultSchemaId !== NEWAPI_VIDEO_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== NEWAPI_VIDEO_USAGE_SCHEMA_ID ||
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
      'newApi.route_mismatch',
      'The route snapshot does not select the exact NewApi video contract'
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
  route: ValidatedNewApiRoute,
  schema: ParameterSchemaV2
): NewApiVideoDispatchRequestV1 {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['assetId'],
    'NewApi video request'
  );
  const projectId = requireOpaqueRequestId(item.projectId, 'project ID');
  if (projectId !== route.projectId) {
    throw invalidRequest(
      'newApi.route_mismatch',
      'The NewApi request project does not match the route snapshot'
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
      'newApi.invalid_request',
      'The NewApi request material does not match the product feature'
    );
  }
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(schema, 'full', item.parameterValues);
  } catch {
    throw invalidRequest(
      'newApi.invalid_request',
      'The NewApi parameter projection is invalid'
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
  image: ControlledNewApiImageV1,
  expectedAssetId: string
): ControlledNewApiImageV1 {
  const mimeType = image.mimeType.toLowerCase();
  if (
    image.assetId !== expectedAssetId ||
    !supportedImageMimeTypes.has(mimeType) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 1 ||
    image.sizeBytes > maximumImageBytes ||
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength !== image.sizeBytes
  ) {
    throw invalidRequest(
      'newApi.invalid_image',
      'The controlled first-frame image does not satisfy the NewApi contract'
    );
  }
  return { ...image, mimeType, bytes: Uint8Array.from(image.bytes) };
}

function serializeVideoRequest(
  route: ValidatedNewApiRoute,
  request: NewApiVideoDispatchRequestV1,
  image: ControlledNewApiImageV1 | undefined
): { readonly body: Uint8Array; readonly contentType: string } {
  const fields: Record<string, string> = {
    model: route.providerModelKey,
    prompt: request.prompt
  };
  for (const [key, value] of Object.entries(request.parameterValues)) {
    if (
      !supportedParameterFields.has(key) ||
      (typeof value !== 'string' && typeof value !== 'number')
    ) {
      throw invalidRequest(
        'newApi.invalid_request',
        'The NewApi request contains an unsupported parameter'
      );
    }
    fields[key] = String(value);
  }
  if ((route.productFeature === 'image_to_video') !== Boolean(image)) {
    throw invalidRequest(
      'newApi.invalid_request',
      'The NewAPI image input does not match the product feature'
    );
  }
  const boundary = `unicomp-newapi-${randomBytes(18).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
      'utf8'
    ));
  }
  if (image) {
    const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="first-frame.${extension}"\r\n` +
      `Content-Type: ${image.mimeType}\r\n\r\n`,
      'utf8'
    ));
    chunks.push(Buffer.from(image.bytes));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Uint8Array.from(Buffer.concat(chunks));
  if (body.byteLength < 1 || body.byteLength > maximumRequestBytes) {
    throw invalidRequest(
      'newApi.request_too_large',
      'The serialized NewApi request exceeds 64 MB'
    );
  }
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function parseCreateResponse(body: Uint8Array, expectedModel: string): string {
  const video = parseVideoObject(body, expectedModel, 'NewAPI create response');
  if (video.status !== 'queued' && video.status !== 'in_progress') {
    throw invalidResponse('NewAPI create response status is invalid');
  }
  return video.id;
}

function parseTaskResponse(
  body: Uint8Array,
  expectedId: string,
  expectedModel: string
): ParsedNewApiTask {
  const video = parseVideoObject(body, expectedModel, 'NewAPI task response');
  if (video.id !== expectedId) {
    throw invalidResponse('NewApi returned a mismatched operation ID');
  }
  return { status: video.status };
}

function parseVideoObject(
  body: Uint8Array,
  expectedModel: string,
  label: string
): { readonly id: string; readonly status: ParsedNewApiTask['status'] } {
  const item = exactResponseRecord(
    parseJsonObject(body, label),
    ['id', 'object', 'created_at', 'status', 'model'],
    [
      'completed_at', 'error', 'expires_at', 'progress', 'prompt',
      'remixed_from_video_id', 'seconds', 'size'
    ],
    label
  );
  const id = requireRemoteId(item.id);
  const status = taskStatus(item.status);
  if (
    item.object !== 'video' ||
    !Number.isSafeInteger(item.created_at) ||
    Number(item.created_at) < 0 ||
    item.model !== expectedModel
  ) {
    throw invalidResponse(`${label} metadata is invalid`);
  }
  for (const timestamp of [item.completed_at, item.expires_at]) {
    if (timestamp !== undefined && timestamp !== null) {
      nonNegativeInteger(timestamp, 'video timestamp');
    }
  }
  if (
    item.progress !== undefined &&
    (typeof item.progress !== 'number' || !Number.isFinite(item.progress) ||
      item.progress < 0 || item.progress > 100)
  ) {
    throw invalidResponse(`${label} progress is invalid`);
  }
  for (const key of ['prompt', 'remixed_from_video_id', 'size'] as const) {
    if (item[key] !== undefined && item[key] !== null) {
      optionalRemoteText(item[key], key);
    }
  }
  if (item.seconds !== undefined && item.seconds !== null) {
    if (typeof item.seconds !== 'string' && typeof item.seconds !== 'number') {
      throw invalidResponse(`${label} seconds is invalid`);
    }
  }
  if (status === 'failed') {
    const error = exactResponseRecord(
      item.error,
      ['code', 'message'],
      ['param', 'type'],
      'NewAPI video error'
    );
    optionalRemoteText(error.code, 'error code');
    optionalRemoteText(error.message, 'error message');
    if (error.param !== undefined && error.param !== null) optionalRemoteText(error.param, 'error param');
    if (error.type !== undefined && error.type !== null) optionalRemoteText(error.type, 'error type');
  } else if (item.error !== undefined && item.error !== null) {
    throw invalidResponse(`${label} contains an unexpected error`);
  }
  return { id, status };
}

function mapSubmissionFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted && submissionOutcomeIsUnknown(error)) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The NewApi video submission outcome is unknown'
    };
  }
  return {
    kind: 'failed_before_submission',
    message: safeSubmissionMessage(error),
    retryability: runtimeRetryability(error)
  };
}

function submissionOutcomeIsUnknown(error: unknown): boolean {
  if (error instanceof NewApiVideoAdapterError) {
    return error.safeCode === 'newApi.invalid_response';
  }
  return error instanceof NewApiRuntimeError && [
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
  if (error instanceof NewApiVideoAdapterError) return error.message;
  if (error instanceof NewApiRuntimeError) {
    return 'The NewApi video request was rejected before acceptance';
  }
  return 'The NewApi video request could not be prepared';
}

function runtimeRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (error instanceof NewApiRuntimeError) return error.retryability;
  if (error instanceof NewApiVideoAdapterError) return error.retryability;
  return 'unknown';
}

function isInvalidResponse(error: unknown): boolean {
  return (
    error instanceof NewApiVideoAdapterError &&
    error.safeCode === 'newApi.invalid_response'
  ) || (
    error instanceof NewApiRuntimeError &&
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
    throw invalidRequest('newApi.invalid_request', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(
      'newApi.invalid_request',
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
    throw invalidRequest('newApi.invalid_request', `${label} is invalid`);
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
    throw invalidResponse('NewApi operation ID is invalid');
  }
  return value;
}

function optionalRemoteText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse(`NewApi ${label} is invalid`);
  }
  return value.trim();
}

function boundedPrompt(
  value: unknown
): string {
  if (typeof value !== 'string') {
    throw invalidRequest('newApi.invalid_request', 'NewApi prompt is invalid');
  }
  const prompt = value.trim();
  if (prompt.length < 1 || prompt.length > 100_000) {
    throw invalidRequest('newApi.invalid_request', 'NewApi prompt is invalid');
  }
  return prompt;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidResponse(`NewApi ${label} must be a non-negative integer`);
  }
  return Number(value);
}

function taskStatus(value: unknown): ParsedNewApiTask['status'] {
  if (
    value === 'queued' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  throw invalidResponse('NewApi task status is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class NewApiVideoAdapterError extends Error {
  constructor(
    readonly safeCode: string,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'NewApiVideoAdapterError';
  }
}

function invalidRequest(safeCode: string, message: string) {
  return new NewApiVideoAdapterError(safeCode, message, 'not_retryable');
}

function invalidResponse(message: string) {
  return new NewApiVideoAdapterError('newApi.invalid_response', message, 'unknown');
}
