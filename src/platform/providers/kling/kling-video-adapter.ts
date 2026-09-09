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
  KLING_ENDPOINT_POLICY_ID,
  KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
  KLING_PROVIDER_PACKAGE_ID,
  KLING_PROVIDER_PACKAGE_VERSION,
  KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  KLING_VIDEO_ADAPTER_ID,
  KLING_VIDEO_ADAPTER_VERSION,
  KLING_VIDEO_PROTOCOL_ID,
  KLING_VIDEO_PROTOCOL_VERSION,
  KLING_VIDEO_RESULT_SCHEMA_ID,
  KLING_VIDEO_USAGE_SCHEMA_ID,
  klingVideoUsageSchema
} from './kling-contracts';
import { KlingRuntimeError, type KlingSharedRuntime } from './kling-runtime';

const maximumImageBytes = 50_000_000;
const maximumRequestBytes = 64 * 1024 * 1024;
const maximumResultBytes = 512 * 1024 * 1024;
const resultLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const resultId = 'video';
const supportedImageMimeTypes = new Set(['image/jpeg', 'image/png']);
const supportedParameterFields = new Set([
  'resolution',
  'aspect_ratio',
  'duration',
  'watermark'
]);

export interface KlingVideoCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface KlingVideoConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface KlingVideoParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export interface ControlledKlingImageV1 {
  readonly assetId: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

export interface ControlledKlingImagePort {
  resolve(input: {
    readonly projectId: string;
    readonly assetId: string;
  }): Promise<ControlledKlingImageV1>;
}

export interface KlingVideoUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface KlingVideoAdapterIdFactory {
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface KlingVideoDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly assetId?: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

interface ValidatedKlingRoute extends ProviderExecutionRouteSnapshotV1 {
  readonly productFeature: 'text_to_video' | 'image_to_video';
  readonly providerModelKey: string;
}

interface KlingOperationContext {
  readonly route: ValidatedKlingRoute;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly connection: ProviderConnection;
  usagePersisted: boolean;
}

interface KlingResultSnapshot {
  readonly url: string;
  readonly expiresAt: number;
}

interface ParsedKlingTask {
  readonly status: 'submitted' | 'processing' | 'succeeded' | 'failed';
  readonly createTime: number;
  readonly videoUrl?: string;
  readonly usage?: readonly UsageFactV1[];
}

export class KlingManagementAdapter implements ProviderManagementAdapterPort {
  readonly identity = {
    packageId: KLING_PROVIDER_PACKAGE_ID,
    adapterId: KLING_VIDEO_ADAPTER_ID,
    adapterVersion: KLING_VIDEO_ADAPTER_VERSION,
    protocolId: KLING_VIDEO_PROTOCOL_ID,
    protocolVersion: KLING_VIDEO_PROTOCOL_VERSION
  } as const;

  constructor(
    private readonly runtime: KlingSharedRuntime,
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async validateConnection(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<ProviderConnectionValidationResultV1> {
    try {
      const body = await this.runtime.requestAccountCosts(input);
      parseAccountCostsEnvelope(body);
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: this.now()
      };
    } catch (error) {
      const businessCode = accountCostsBusinessCode(error);
      const authenticationFailed =
        (error instanceof KlingRuntimeError &&
          error.code === 'authentication_failed') ||
        businessCode === 1000 ||
        businessCode === 1001 ||
        businessCode === 1002;
      const adapterCode = error instanceof KlingVideoAdapterError
        ? error.safeCode
        : undefined;
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState: authenticationFailed
          ? 'invalid'
          : businessCode !== undefined
            ? 'valid'
            : 'verification_unavailable',
        observedAt: this.now(),
        safeCode: authenticationFailed
          ? 'authentication_failed'
          : businessCode !== undefined
            ? 'account_unavailable'
            : error instanceof KlingRuntimeError
              ? error.code
              : adapterCode ?? 'unknown'
      };
    }
  }
}

export class KlingVideoAdapter
  implements ProviderAsyncOperationPort, VideoResultPort {
  private readonly operations = new Map<string, KlingOperationContext>();
  private readonly results = new Map<string, KlingResultSnapshot>();
  private disposed = false;

  constructor(
    private readonly runtime: KlingSharedRuntime,
    private readonly connections: KlingVideoConnectionResolverPort,
    private readonly credentials: KlingVideoCredentialResolverPort,
    private readonly parameterSchemas: KlingVideoParameterSchemaResolverPort,
    private readonly images: ControlledKlingImagePort,
    private readonly usage: KlingVideoUsageObservationSinkPort,
    private readonly ids: KlingVideoAdapterIdFactory,
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
    let submissionContext: KlingOperationContext | undefined;
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
          feature: route.productFeature,
          providerModelKey: route.providerModelKey,
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
        throw invalidResponse('Kling returned a duplicate operation ID');
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
        'kling.operation_conflict',
        'The Kling operation is already attached to another route'
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
      if (task.status === 'submitted') return { state: 'queued' };
      if (task.status === 'processing') return { state: 'processing' };
      await this.persistTerminalUsage(context, task.usage);
      if (task.status === 'succeeded') {
        this.results.set(remoteId, {
          url: task.videoUrl!,
          expiresAt: task.createTime + resultLifetimeMs
        });
        return { state: 'completed' };
      }
      this.results.delete(remoteId);
      return {
        state: 'failed',
        message: 'Kling reported that the video task failed',
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
    // API 2.0 does not publish a task-cancellation endpoint. Keep tracking the
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
        'The Kling video result is unavailable'
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
      name: 'kling-video',
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
        'The Kling video result is unavailable'
      );
    }
    const snapshot = await this.loadCurrentResult(remoteId);
    if (this.nowMilliseconds() >= snapshot.expiresAt) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Kling video result URL has expired'
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
          'The Kling result did not contain video bytes'
        );
      }
      return Readable.from([Buffer.from(downloaded.body)]);
    } catch (error) {
      if (error instanceof VideoResultPortError) throw error;
      throw new VideoResultPortError(
        runtimeRetryability(error),
        'The Kling video result could not be downloaded'
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
      throw new KlingRuntimeError('runtime_shutting_down', 'not_retryable');
    }
  }

  private requireOperation(providerOperationId: string): KlingOperationContext {
    const context = this.operations.get(providerOperationId);
    if (!context) {
      throw invalidRequest(
        'kling.operation_not_attached',
        'The Kling operation must be attached with its original route snapshot'
      );
    }
    return context;
  }

  private async requireConnection(
    route: ValidatedKlingRoute
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
        'kling.connection_snapshot_unavailable',
        'The exact Kling connection snapshot is unavailable'
      );
    }
    return connection;
  }

  private async requireParameterSchema(
    route: ValidatedKlingRoute
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
        'kling.parameter_schema_unavailable',
        'The exact Kling parameter schema is unavailable'
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
        'kling.parameter_schema_unavailable',
        'The exact Kling parameter schema is unavailable'
      );
    }
    return validated;
  }

  private async persistTerminalUsage(
    context: KlingOperationContext,
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
    context: KlingOperationContext,
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
        usageSchemaId: klingVideoUsageSchema.id,
        usageSchemaRevision: klingVideoUsageSchema.revision,
        sourceEventKey: `kling_video_usage_${context.invocationAttemptId}`,
        sequence: 1,
        status,
        sourceStage: 'poll',
        facts,
        observedAt: this.nowTimestamp()
      }, klingVideoUsageSchema),
      klingVideoUsageSchema
    );
    context.usagePersisted = true;
  }

  private async loadCurrentResult(
    providerOperationId: string
  ): Promise<KlingResultSnapshot> {
    const status = await this.query(providerOperationId);
    if (status.state !== 'completed') {
      throw new VideoResultPortError(
        status.state === 'failed' ? status.retryability : 'retryable',
        'The Kling video result is not available'
      );
    }
    const snapshot = this.results.get(providerOperationId);
    if (!snapshot) {
      throw new VideoResultPortError(
        'not_retryable',
        'The Kling video result declaration is invalid'
      );
    }
    return snapshot;
  }
}

export function mapKlingVideoBilling(value: unknown): readonly UsageFactV1[] {
  if (!Array.isArray(value)) {
    throw invalidResponse('Kling billing must be an array');
  }
  let cashAmount = '0';
  let cashListPrice = '0';
  let packageUnitAmount = '0';
  let hasCash = false;
  let hasPackageUnits = false;
  for (const item of value) {
    const billing = exactResponseRecord(
      item,
      ['charge_type', 'amount'],
      ['cash_type', 'package_type', 'list_price'],
      'Kling billing entry'
    );
    const amount = nonNegativeDecimal(billing.amount, 'billing amount');
    if (billing.charge_type === 'cash') {
      if (
        billing.package_type !== undefined ||
        billing.list_price === undefined ||
        (billing.cash_type !== undefined &&
          billing.cash_type !== 'balance' &&
          billing.cash_type !== 'test_balance')
      ) {
        throw invalidResponse('Kling cash billing entry is invalid');
      }
      cashAmount = addDecimals(cashAmount, amount);
      cashListPrice = addDecimals(
        cashListPrice,
        nonNegativeDecimal(billing.list_price, 'billing list price')
      );
      hasCash = true;
    } else if (billing.charge_type === 'unit') {
      if (
        billing.package_type !== 'video' ||
        billing.cash_type !== undefined ||
        billing.list_price !== undefined
      ) {
        throw invalidResponse('Kling package billing entry is invalid');
      }
      packageUnitAmount = addDecimals(packageUnitAmount, amount);
      hasPackageUnits = true;
    } else {
      throw invalidResponse('Kling billing charge type is invalid');
    }
  }
  return [
    usageFact('billing_entry_count', String(value.length), 'entry'),
    ...(hasCash
      ? [
          usageFact('cash_amount', cashAmount, 'currency_amount'),
          usageFact('cash_list_price', cashListPrice, 'currency_amount')
        ]
      : []),
    ...(hasPackageUnits
      ? [usageFact('package_unit_amount', packageUnitAmount, 'provider_unit')]
      : [])
  ];
}

export function klingVideoRecoveryDecision(state: string): {
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

function validateRoute(value: unknown): ValidatedKlingRoute {
  const route = parseProviderExecutionRouteSnapshot(value);
  const feature = route.productFeature;
  const expectedConstraint = feature === 'text_to_video'
    ? KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
    : feature === 'image_to_video'
      ? KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
      : undefined;
  if (
    route.packageId !== KLING_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== KLING_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== KLING_VIDEO_ADAPTER_ID ||
    route.adapterVersion !== KLING_VIDEO_ADAPTER_VERSION ||
    route.endpointPolicyId !== KLING_ENDPOINT_POLICY_ID ||
    route.endpointPolicyRevision !== 1 ||
    route.resultSchemaId !== KLING_VIDEO_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== KLING_VIDEO_USAGE_SCHEMA_ID ||
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
      'kling.route_mismatch',
      'The route snapshot does not select the exact Kling video contract'
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
  route: ValidatedKlingRoute,
  schema: ParameterSchemaV2
): KlingVideoDispatchRequestV1 {
  const item = exactRequestRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['assetId'],
    'Kling video request'
  );
  const projectId = requireOpaqueRequestId(item.projectId, 'project ID');
  if (projectId !== route.projectId) {
    throw invalidRequest(
      'kling.route_mismatch',
      'The Kling request project does not match the route snapshot'
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
      'kling.invalid_request',
      'The Kling request material does not match the product feature'
    );
  }
  let parameterValues: Readonly<Record<string, ParameterValue>>;
  try {
    parameterValues = validateParameterValues(schema, 'full', item.parameterValues);
  } catch {
    throw invalidRequest(
      'kling.invalid_request',
      'The Kling parameter projection is invalid'
    );
  }
  return {
    invocationAttemptId: requireInvocationAttemptId(item.invocationAttemptId),
    projectId,
    prompt: boundedPrompt(item.prompt, route.productFeature),
    ...(assetId ? { assetId } : {}),
    parameterValues
  };
}

function validateImage(
  image: ControlledKlingImageV1,
  expectedAssetId: string
): ControlledKlingImageV1 {
  const mimeType = image.mimeType.toLowerCase();
  const aspectRatio = image.width / image.height;
  if (
    image.assetId !== expectedAssetId ||
    !supportedImageMimeTypes.has(mimeType) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 300 ||
    image.height < 300 ||
    aspectRatio < 0.4 ||
    aspectRatio > 2.5 ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 1 ||
    image.sizeBytes > maximumImageBytes ||
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength !== image.sizeBytes
  ) {
    throw invalidRequest(
      'kling.invalid_image',
      'The controlled first-frame image does not satisfy the Kling contract'
    );
  }
  return { ...image, mimeType, bytes: Uint8Array.from(image.bytes) };
}

function serializeVideoRequest(
  route: ValidatedKlingRoute,
  request: KlingVideoDispatchRequestV1,
  image: ControlledKlingImageV1 | undefined
): Uint8Array {
  const settings: Record<string, ParameterValue> = {};
  let watermark: boolean | undefined;
  for (const [key, value] of Object.entries(request.parameterValues)) {
    if (!supportedParameterFields.has(key)) {
      throw invalidRequest(
        'kling.invalid_request',
        'The Kling request contains an unsupported parameter'
      );
    }
    if (key === 'watermark') watermark = value as boolean;
    else settings[key] = value;
  }
  const body: Record<string, unknown> = route.productFeature === 'text_to_video'
    ? { prompt: request.prompt }
    : {
        contents: [
          { type: 'prompt', text: request.prompt },
          {
            type: 'first_frame',
            url: `data:${image!.mimeType};base64,${Buffer.from(image!.bytes).toString('base64')}`
          }
        ]
      };
  if (Object.keys(settings).length > 0) body.settings = settings;
  if (watermark !== undefined) {
    body.options = { watermark_info: { enabled: watermark } };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength < 1 || bytes.byteLength > maximumRequestBytes) {
    throw invalidRequest(
      'kling.request_too_large',
      'The serialized Kling request exceeds 64 MB'
    );
  }
  return bytes;
}

function parseCreateResponse(body: Uint8Array): string {
  const envelope = parseEnvelope(body, 'Kling create response');
  const data = exactResponseRecord(
    envelope.data,
    ['id', 'status', 'create_time', 'update_time'],
    ['external_id'],
    'Kling create response data'
  );
  const status = taskStatus(data.status);
  if (status !== 'submitted' && status !== 'processing') {
    throw invalidResponse('Kling create response status is invalid');
  }
  validateTaskTimes(data.create_time, data.update_time);
  if (data.external_id !== undefined) optionalRemoteText(data.external_id, 'external ID');
  return requireRemoteId(data.id);
}

function parseTaskResponse(
  body: Uint8Array,
  expectedId: string
): ParsedKlingTask {
  const envelope = parseEnvelope(body, 'Kling task response');
  if (!Array.isArray(envelope.data) || envelope.data.length !== 1) {
    throw invalidResponse('Kling task response must contain one task');
  }
  const task = exactResponseRecord(
    envelope.data[0],
    ['id', 'status', 'create_time', 'update_time'],
    ['message', 'external_id', 'outputs', 'billing'],
    'Kling task'
  );
  if (requireRemoteId(task.id) !== expectedId) {
    throw invalidResponse('Kling returned a mismatched operation ID');
  }
  const status = taskStatus(task.status);
  const createTime = validateTaskTimes(task.create_time, task.update_time);
  if (task.external_id !== undefined) {
    optionalRemoteText(task.external_id, 'external ID');
  }
  if (task.message !== undefined) optionalRemoteText(task.message, 'task message');
  const videoUrl = parseOutputs(task.outputs, status);
  const usage = task.billing === undefined
    ? undefined
    : mapKlingVideoBilling(task.billing);
  return {
    status,
    createTime,
    ...(videoUrl ? { videoUrl } : {}),
    ...(usage ? { usage } : {})
  };
}

function parseEnvelope(
  body: Uint8Array,
  label: string
): Record<string, unknown> & { readonly data: unknown } {
  const envelope = exactResponseRecord(
    parseJsonObject(body, label),
    ['code', 'message', 'request_id', 'data'],
    [],
    label
  );
  if (!Number.isSafeInteger(envelope.code) || envelope.code !== 0) {
    throw invalidResponse(`${label} code is invalid`);
  }
  optionalRemoteText(envelope.message, 'response message');
  requireRemoteText(envelope.request_id, 'request ID');
  return envelope as Record<string, unknown> & { readonly data: unknown };
}

function parseOutputs(
  value: unknown,
  status: ParsedKlingTask['status']
): string | undefined {
  if (status !== 'succeeded') {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 0) {
      throw invalidResponse('Kling non-success task outputs are invalid');
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw invalidResponse('Kling succeeded task must contain one video output');
  }
  const output = exactResponseRecord(
    value[0],
    ['type', 'url'],
    ['id', 'watermark_url', 'duration'],
    'Kling video output'
  );
  if (output.type !== 'video') {
    throw invalidResponse('Kling output type is invalid');
  }
  if (output.id !== undefined) requireRemoteId(output.id);
  if (output.watermark_url !== undefined) {
    requireHttpsResultUrl(output.watermark_url, 'watermark URL');
  }
  if (output.duration !== undefined) {
    nonNegativeDecimal(output.duration, 'video duration');
  }
  return requireHttpsResultUrl(output.url, 'video URL');
}

function validateTaskTimes(createTime: unknown, updateTime: unknown): number {
  const created = nonNegativeInteger(createTime, 'create time');
  const updated = nonNegativeInteger(updateTime, 'update time');
  if (updated < created) {
    throw invalidResponse('Kling task timestamps are inconsistent');
  }
  return created;
}

function mapSubmissionFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted && submissionOutcomeIsUnknown(error)) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The Kling video submission outcome is unknown'
    };
  }
  return {
    kind: 'failed_before_submission',
    message: safeSubmissionMessage(error),
    retryability: runtimeRetryability(error)
  };
}

function submissionOutcomeIsUnknown(error: unknown): boolean {
  if (error instanceof KlingVideoAdapterError) {
    return error.safeCode === 'kling.invalid_response';
  }
  return error instanceof KlingRuntimeError && [
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
  if (error instanceof KlingVideoAdapterError) return error.message;
  if (error instanceof KlingRuntimeError) {
    return 'The Kling video request was rejected before acceptance';
  }
  return 'The Kling video request could not be prepared';
}

function runtimeRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (error instanceof KlingRuntimeError) return error.retryability;
  if (error instanceof KlingVideoAdapterError) return error.retryability;
  return 'unknown';
}

function isInvalidResponse(error: unknown): boolean {
  return (
    error instanceof KlingVideoAdapterError &&
    error.safeCode === 'kling.invalid_response'
  ) || (
    error instanceof KlingRuntimeError &&
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
    throw invalidRequest('kling.invalid_request', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(
      'kling.invalid_request',
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
    throw invalidRequest('kling.invalid_request', `${label} is invalid`);
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
    throw invalidResponse('Kling operation ID is invalid');
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
    throw invalidResponse(`Kling ${label} is invalid`);
  }
  return value.trim();
}

function optionalRemoteText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse(`Kling ${label} is invalid`);
  }
  return value.trim();
}

function requireHttpsResultUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`Kling ${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse(`Kling ${label} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname.includes('.')
  ) {
    throw invalidResponse(`Kling ${label} is invalid`);
  }
  return url.toString();
}

function boundedPrompt(
  value: unknown,
  feature: 'text_to_video' | 'image_to_video'
): string {
  if (typeof value !== 'string') {
    throw invalidRequest('kling.invalid_request', 'Kling prompt is invalid');
  }
  const prompt = value.trim();
  const maximum = feature === 'text_to_video' ? 3_072 : 2_500;
  if (prompt.length < 1 || prompt.length > maximum) {
    throw invalidRequest('kling.invalid_request', 'Kling prompt is invalid');
  }
  return prompt;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidResponse(`Kling ${label} must be a non-negative integer`);
  }
  return Number(value);
}

function nonNegativeDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw invalidResponse(`Kling ${label} must be a non-negative decimal`);
  }
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function addDecimals(left: string, right: string): string {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftInteger = BigInt(`${leftWhole}${leftFraction.padEnd(scale, '0')}`);
  const rightInteger = BigInt(`${rightWhole}${rightFraction.padEnd(scale, '0')}`);
  const digits = (leftInteger + rightInteger).toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const normalized = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    .replace(/\.0+$/u, '')
    .replace(/(\.\d*?)0+$/u, '$1');
  return normalized;
}

function taskStatus(value: unknown): ParsedKlingTask['status'] {
  if (
    value === 'submitted' ||
    value === 'processing' ||
    value === 'succeeded' ||
    value === 'failed'
  ) {
    return value;
  }
  throw invalidResponse('Kling task status is invalid');
}

function usageFact(
  metricId: string,
  quantity: string,
  unit: string
): UsageFactV1 {
  return { metricId, quantity, unit, source: 'provider_body' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class KlingAccountCostsError extends Error {
  constructor(
    readonly businessCode: number | undefined,
    message: string
  ) {
    super(message);
    this.name = 'KlingAccountCostsError';
  }
}

function parseAccountCostsEnvelope(body: Uint8Array): void {
  const envelope = exactResponseRecord(
    parseJsonObject(body, 'Kling account costs response'),
    ['code'],
    ['message', 'request_id', 'data'],
    'Kling account costs response'
  );
  if (!Number.isSafeInteger(envelope.code)) {
    throw invalidResponse('Kling account costs response code is invalid');
  }
  if (envelope.message !== undefined) {
    optionalRemoteText(envelope.message, 'account costs message');
  }
  if (envelope.request_id !== undefined) {
    requireRemoteText(envelope.request_id, 'account costs request ID');
  }
  if (envelope.data !== undefined && !isRecord(envelope.data)) {
    throw invalidResponse('Kling account costs response data is invalid');
  }
  if (envelope.code !== 0) {
    throw new KlingAccountCostsError(
      Number(envelope.code),
      `Kling account costs rejected with business code ${Number(envelope.code)}`
    );
  }
}

function accountCostsBusinessCode(error: unknown): number | undefined {
  return error instanceof KlingAccountCostsError
    ? error.businessCode
    : undefined;
}

class KlingVideoAdapterError extends Error {
  constructor(
    readonly safeCode: string,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown'
  ) {
    super(message);
    this.name = 'KlingVideoAdapterError';
  }
}

function invalidRequest(safeCode: string, message: string) {
  return new KlingVideoAdapterError(safeCode, message, 'not_retryable');
}

function invalidResponse(message: string) {
  return new KlingVideoAdapterError('kling.invalid_response', message, 'unknown');
}
