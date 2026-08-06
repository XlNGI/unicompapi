import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toAssetId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toProviderUsageObservationId,
  toTaskId,
  validateParameterSchemaV2,
  validateParameterValues,
  type DynamicParameterValue,
  type Execution,
  type ModelCapabilityEvidence,
  type ModelFeatureProfile,
  type ParameterSchemaV2,
  type ParameterValue,
  type ProviderConnection,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderImmediateResultReference,
  type ProviderInvocationAttemptId,
  type ProviderModel,
  type ProviderProtocolBinding,
  type ProviderSubmitOutcome,
  type ProviderUsageObservationId,
  type ProviderUsageObservationV1,
  type Task,
  type UsageSchemaV1,
  type VideoDynamicParameterValue
} from '../../../domain';
import type { ProviderRegistrySnapshot } from '../provider-registry';
import type { ProviderProtocolSubmitRequest } from '../provider-operation-router';
import type {
  ProviderAsyncOperationStatus,
  ProviderCancelOutcome
} from '../provider-execution-lifecycle';
import {
  VIDU_ENDPOINT_POLICY_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
  VIDU_GEMINI_IMAGE_V2_RESULT_SCHEMA_ID,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_IMAGE_V1_ADAPTER_VERSION,
  VIDU_IMAGE_V1_RESULT_SCHEMA_ID,
  VIDU_IMAGE_VIDEO_CONSTRAINT_SET_ID,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_PROVIDER_PACKAGE_VERSION,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_RESULT_SCHEMA_ID,
  VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID,
  VIDU_TEXT_IMAGE_CONSTRAINT_SET_ID,
  VIDU_USAGE_SCHEMA_ID,
  viduPackagedParameterSchemas,
  viduUsageSchema
} from './vidu-contracts';
import {
  VIDU_IMAGE_V1_VERIFIED_OPTIONS,
  ViduGeminiImageV2Adapter,
  ViduImageV1Adapter,
  type ViduAdapterRequestControl,
  type ViduConnectionPort
} from './vidu-image-adapters';
import { readViduImmediateImageResult } from './vidu-image-result-port';
import type { ControlledImageMaterialPort } from './controlled-image-material';
import type { ViduSharedRuntime } from './vidu-shared-runtime';
import {
  ViduReferenceVideoV2Adapter,
  type ViduVideoOperationContext as ViduAdapterOperationContext
} from './vidu-video-adapter';

export interface ViduRouteRegistryPort {
  load(): Promise<ProviderRegistrySnapshot>;
}

export interface ResolvedViduExecutionRoute {
  readonly route: ProviderExecutionRouteSnapshotV1;
  readonly connection: ProviderConnection;
  readonly binding: ProviderProtocolBinding;
  readonly model: ProviderModel;
  readonly evidence: ModelCapabilityEvidence;
  readonly profile: ModelFeatureProfile;
}

export interface ViduExecutionRouteResolverPort {
  resolve(routeSnapshot: unknown): Promise<ResolvedViduExecutionRoute>;
}

export class ViduRegistryExecutionRouteResolver
  implements ViduExecutionRouteResolverPort {
  constructor(private readonly registry: ViduRouteRegistryPort) {}

  async resolve(routeSnapshot: unknown): Promise<ResolvedViduExecutionRoute> {
    const route = parseProviderExecutionRouteSnapshot(routeSnapshot);
    const snapshot = await this.registry.load();
    const provider = snapshot.providers.find(
      (candidate) => candidate.id === route.providerId
    );
    const connection = snapshot.connections.find(
      (candidate) => candidate.id === route.connectionId
    );
    const binding = snapshot.protocolBindings.find(
      (candidate) => candidate.id === route.protocolBindingId
    );
    const model = snapshot.models.find((candidate) => candidate.id === route.modelId);
    const profile = snapshot.modelProfiles?.find(
      (candidate) => candidate.profileId === route.profileId
    );
    const feature = profile?.features.find(
      (candidate) =>
        candidate.productFeature === route.productFeature &&
        candidate.internalPurpose === route.internalPurpose &&
        candidate.parameterSchemaId === route.parameterSchemaId &&
        candidate.resultSchemaId === route.resultSchemaId &&
        candidate.usageSchemaId === route.usageSchemaId &&
        candidate.constraintSetId === route.constraintSetId
    );
    const evidence = model?.capabilityEvidenceId
      ? snapshot.capabilities.find(
          (candidate) => candidate.id === model.capabilityEvidenceId
        )
      : undefined;
    const adapterBinding = connection?.adapterBindings?.find(
      (candidate) =>
        candidate.adapterId === route.adapterKey &&
        candidate.adapterVersion === route.adapterVersion &&
        candidate.protocolId === binding?.protocolId &&
        candidate.protocolVersion === binding.protocolVersion
    );
    if (
      route.packageId !== VIDU_PROVIDER_PACKAGE_ID ||
      route.packageVersion !== VIDU_PROVIDER_PACKAGE_VERSION ||
      route.endpointPolicyId !== VIDU_ENDPOINT_POLICY_ID ||
      route.endpointPolicyRevision !== 1 ||
      route.protocolBindingRevision !== 1 ||
      route.featureMappingVersion !== 1 ||
      route.parameterSchemaRevision !== 1 ||
      route.resultSchemaRevision !== 1 ||
      route.usageSchemaId !== VIDU_USAGE_SCHEMA_ID ||
      route.usageSchemaRevision !== 1 ||
      route.constraintSetRevision !== 1 ||
      !route.providerModelKey ||
      provider?.packageId !== route.packageId ||
      provider.packageVersion !== route.packageVersion ||
      !connection ||
      connection.providerId !== route.providerId ||
      connection.packageId !== route.packageId ||
      connection.packageVersion !== route.packageVersion ||
      connection.connectionRevision !== route.connectionRevision ||
      connection.connectionConfigVersionId !== route.connectionConfigVersionId ||
      connection.credentialVersionId !== route.credentialVersionId ||
      connection.endpointPolicyId !== route.endpointPolicyId ||
      connection.endpointPolicyRevision !== route.endpointPolicyRevision ||
      !adapterBinding ||
      !binding ||
      binding.providerId !== route.providerId ||
      binding.connectionId !== route.connectionId ||
      binding.adapterKind !== route.adapterKey ||
      !model ||
      model.providerId !== route.providerId ||
      model.connectionId !== route.connectionId ||
      model.protocolBindingId !== route.protocolBindingId ||
      model.providerModelKey !== route.providerModelKey ||
      model.revision !== route.modelRevision ||
      model.activeProfileId !== route.profileId ||
      !profile ||
      profile.revision !== route.profileRevision ||
      profile.modelId !== route.modelId ||
      profile.modelRevision !== route.modelRevision ||
      profile.protocolBindingId !== route.protocolBindingId ||
      profile.adapterKey !== route.adapterKey ||
      profile.packageId !== route.packageId ||
      profile.status !== 'verified' ||
      !feature ||
      !evidence ||
      evidence.modelId !== model.id ||
      evidence.capability !== route.internalPurpose
    ) {
      throw routeError(
        'vidu.route_snapshot_unavailable',
        'The exact Vidu execution route snapshot is unavailable'
      );
    }
    return { route, connection, binding, model, evidence, profile };
  }
}

export interface ViduParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export class ViduPackagedParameterSchemaResolver
  implements ViduParameterSchemaResolverPort {
  async get(
    schemaId: string,
    revision: number
  ): Promise<ParameterSchemaV2 | undefined> {
    return viduPackagedParameterSchemas.find(
      (schema) => schema.schemaId === schemaId && schema.revision === revision
    );
  }
}

export interface ViduUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface ViduRouteAdapterIdFactory {
  nextProviderOperationId(): string;
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface ViduRouteDispatchRequestV1 {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly projectId: string;
  readonly prompt: string;
  readonly assetId?: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

export interface ViduRouteSubmitInput {
  readonly request: unknown;
  readonly beforeRequestStarted?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ViduImmediateResultReferenceV1 {
  readonly providerOperationId: string;
  readonly result: ProviderImmediateResultReference;
  readonly signal?: AbortSignal;
}

export interface ViduVideoResultReferenceV1 {
  readonly providerOperationId: string;
  readonly remoteResultId: string;
  readonly signal?: AbortSignal;
}

interface ViduRouteAdapterDependencies {
  readonly runtime: ViduSharedRuntime;
  readonly routes: ViduExecutionRouteResolverPort;
  readonly parameterSchemas: ViduParameterSchemaResolverPort;
  readonly materials: ControlledImageMaterialPort;
  readonly usage: ViduUsageObservationSinkPort;
  readonly ids?: ViduRouteAdapterIdFactory;
  readonly now?: () => string;
}

export class ViduImageRouteAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly operations = ['submit', 'receive_result'] as const;
  private readonly ids: ViduRouteAdapterIdFactory;
  private readonly results = new Map<string, {
    readonly routeId: string;
    readonly result: ProviderImmediateResultReference;
  }>();

  constructor(
    private readonly kind: 'image_v1' | 'gemini_image_v2',
    private readonly dependencies: ViduRouteAdapterDependencies
  ) {
    this.adapterKey = kind === 'image_v1'
      ? VIDU_IMAGE_V1_ADAPTER_ID
      : VIDU_GEMINI_IMAGE_V2_ADAPTER_ID;
    this.adapterVersion = kind === 'image_v1'
      ? VIDU_IMAGE_V1_ADAPTER_VERSION
      : VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION;
    this.ids = dependencies.ids ?? defaultIds();
  }

  async submit(
    routeSnapshot: ProviderExecutionRouteSnapshotV1,
    input: ViduRouteSubmitInput
  ): Promise<ProviderSubmitOutcome> {
    let request: ViduRouteDispatchRequestV1 | undefined;
    let requestStarted = false;
    try {
      const resolved = await this.resolve(routeSnapshot);
      const schema = await requireParameterSchema(
        this.dependencies.parameterSchemas,
        resolved.route
      );
      request = parseDispatchRequest(
        input.request,
        resolved.route,
        schema,
        this.kind === 'gemini_image_v2'
      );
      const dependencies = {
        runtime: this.dependencies.runtime,
        connections: fixedConnection(resolved.connection),
        materials: this.dependencies.materials,
        createProviderOperationId: () => this.ids.nextProviderOperationId()
      };
      const adapter = this.kind === 'image_v1'
        ? new ViduImageV1Adapter(dependencies, VIDU_IMAGE_V1_VERIFIED_OPTIONS)
        : new ViduGeminiImageV2Adapter(dependencies);
      const outcome = await adapter.submit(
        legacyImageRequest(resolved, request),
        control(input, () => { requestStarted = true; })
      );
      if (outcome.kind === 'completed_sync' && outcome.results.length === 1) {
        this.results.set(outcome.providerOperationId, {
          routeId: resolved.route.id,
          result: outcome.results[0]
        });
      }
      await this.persistUsage(request.invocationAttemptId, outcome, requestStarted);
      return outcome;
    } catch (error) {
      if (request) {
        await this.persistUsage(
          request.invocationAttemptId,
          mapRouteFailure(error, requestStarted),
          requestStarted
        ).catch(() => undefined);
      }
      return mapRouteFailure(error, requestStarted);
    }
  }

  async receiveResult(
    routeSnapshot: ProviderExecutionRouteSnapshotV1,
    reference: ViduImmediateResultReferenceV1
  ): Promise<Readable> {
    const resolved = await this.resolve(routeSnapshot);
    const parsed = parseImmediateResult(reference);
    const attached = this.results.get(parsed.providerOperationId);
    if (
      !attached ||
      attached.routeId !== resolved.route.id ||
      !sameImmediateResult(attached.result, parsed.result)
    ) {
      throw routeError(
        'vidu.result_route_unavailable',
        'The Vidu image result has no matching persisted route attachment'
      );
    }
    const bytes = await readViduImmediateImageResult(
      parsed.result,
      this.dependencies.runtime,
      128 * 1024 * 1024,
      reference.signal
    );
    return Readable.from([Buffer.from(bytes)]);
  }

  async attachResult(input: {
    readonly routeSnapshot: unknown;
    readonly providerOperationId: string;
    readonly result: ProviderImmediateResultReference;
  }): Promise<void> {
    const resolved = await this.resolve(input.routeSnapshot);
    const parsed = parseImmediateResult({
      providerOperationId: input.providerOperationId,
      result: input.result
    });
    const existing = this.results.get(parsed.providerOperationId);
    if (
      existing &&
      (existing.routeId !== resolved.route.id ||
        !sameImmediateResult(existing.result, parsed.result))
    ) {
      throw routeError(
        'vidu.result_conflict',
        'The Vidu image result is already attached to another route'
      );
    }
    this.results.set(parsed.providerOperationId, {
      routeId: resolved.route.id,
      result: parsed.result
    });
  }

  private async resolve(routeSnapshot: unknown): Promise<ResolvedViduExecutionRoute> {
    const resolved = await this.dependencies.routes.resolve(routeSnapshot);
    validateRouteIdentity(
      resolved.route,
      this.kind === 'image_v1'
        ? {
            adapterKey: this.adapterKey,
            adapterVersion: this.adapterVersion,
            features: ['text_to_image', 'image_edit'],
            resultSchemaId: VIDU_IMAGE_V1_RESULT_SCHEMA_ID,
            constraintSetIds: [
              VIDU_TEXT_IMAGE_CONSTRAINT_SET_ID,
              VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID
            ]
          }
        : {
            adapterKey: this.adapterKey,
            adapterVersion: this.adapterVersion,
            features: ['reference_to_image'],
            resultSchemaId: VIDU_GEMINI_IMAGE_V2_RESULT_SCHEMA_ID,
            constraintSetIds: [VIDU_SINGLE_IMAGE_CONSTRAINT_SET_ID]
          }
    );
    return resolved;
  }

  private async persistUsage(
    attemptId: ProviderInvocationAttemptId,
    outcome: ProviderSubmitOutcome,
    requestStarted: boolean
  ): Promise<void> {
    const operationId = 'providerOperationId' in outcome
      ? outcome.providerOperationId ?? 'unknown'
      : 'not-started';
    const status = outcome.kind === 'submission_outcome_unknown'
      ? 'unknown_outcome'
      : 'not_reported';
    if (!requestStarted && outcome.kind === 'failed_before_submission') return;
    await this.dependencies.usage.append(createProviderUsageObservation({
      id: this.ids.nextProviderUsageObservationId(),
      invocationAttemptId: attemptId,
      usageSchemaId: viduUsageSchema.id,
      usageSchemaRevision: viduUsageSchema.revision,
      sourceEventKey: sourceEventKey('vidu_image', operationId),
      sequence: 1,
      status,
      sourceStage: 'result',
      facts: [],
      observedAt: this.now()
    }, viduUsageSchema), viduUsageSchema);
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }
}

interface ViduVideoOperationContext {
  readonly routeId: string;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  usagePersisted: boolean;
}

export class ViduVideoRouteAdapter {
  readonly adapterKey = VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID;
  readonly adapterVersion = VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION;
  readonly operations = ['submit', 'query', 'cancel', 'receive_result'] as const;
  private readonly contexts = new Map<string, ViduVideoOperationContext>();
  private readonly ids: ViduRouteAdapterIdFactory;

  constructor(private readonly dependencies: ViduRouteAdapterDependencies) {
    this.ids = dependencies.ids ?? defaultIds();
  }

  async submit(
    routeSnapshot: ProviderExecutionRouteSnapshotV1,
    input: ViduRouteSubmitInput
  ): Promise<ProviderSubmitOutcome> {
    let request: ViduRouteDispatchRequestV1 | undefined;
    let requestStarted = false;
    try {
      const resolved = await this.resolve(routeSnapshot);
      const schema = await requireParameterSchema(
        this.dependencies.parameterSchemas,
        resolved.route
      );
      request = parseDispatchRequest(input.request, resolved.route, schema, true);
      const adapter = this.legacyAdapter(resolved);
      const outcome = await adapter.submit(
        legacyVideoRequest(resolved, request),
        control(input, () => { requestStarted = true; })
      );
      if (outcome.kind === 'accepted_async') {
        this.contexts.set(outcome.providerOperationId, {
          routeId: resolved.route.id,
          invocationAttemptId: request.invocationAttemptId,
          usagePersisted: false
        });
      } else if (outcome.kind === 'submission_outcome_unknown') {
        await this.persistUsage(
          request.invocationAttemptId,
          outcome.providerOperationId ?? 'unknown',
          'unknown_outcome'
        );
      } else if (requestStarted) {
        await this.persistUsage(
          request.invocationAttemptId,
          'providerOperationId' in outcome
            ? outcome.providerOperationId ?? 'unknown'
            : 'unknown',
          'not_reported'
        );
      }
      return outcome;
    } catch (error) {
      const outcome = mapRouteFailure(error, requestStarted);
      if (request && requestStarted) {
        await this.persistUsage(
          request.invocationAttemptId,
          'unknown',
          outcome.kind === 'submission_outcome_unknown'
            ? 'unknown_outcome'
            : 'not_reported'
        ).catch(() => undefined);
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
    const resolved = await this.resolve(input.routeSnapshot);
    const operationId = requireOpaqueId(input.providerOperationId, 'operation ID');
    const existing = this.contexts.get(operationId);
    if (
      existing &&
      (existing.routeId !== resolved.route.id ||
        existing.invocationAttemptId !== input.invocationAttemptId)
    ) {
      throw routeError(
        'vidu.operation_conflict',
        'The Vidu operation is already attached to another route'
      );
    }
    this.contexts.set(operationId, {
      routeId: resolved.route.id,
      invocationAttemptId: input.invocationAttemptId,
      usagePersisted: Boolean(input.usageAlreadyPersisted)
    });
  }

  async query(
    routeSnapshot: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string
  ): Promise<ProviderAsyncOperationStatus> {
    const resolved = await this.resolve(routeSnapshot);
    const operationId = this.requireAttached(resolved.route, providerOperationId);
    const status = await this.legacyAdapter(resolved).query(operationId);
    if (status.state === 'completed' || status.state === 'failed') {
      await this.persistTerminal(operationId);
    }
    return status;
  }

  async cancel(
    routeSnapshot: ProviderExecutionRouteSnapshotV1,
    providerOperationId: string
  ): Promise<ProviderCancelOutcome> {
    const resolved = await this.resolve(routeSnapshot);
    const operationId = this.requireAttached(resolved.route, providerOperationId);
    const outcome = await this.legacyAdapter(resolved).cancel(operationId);
    if (outcome.state === 'cancelled') await this.persistTerminal(operationId);
    return outcome;
  }

  async receiveResult(
    routeSnapshot: ProviderExecutionRouteSnapshotV1,
    reference: ViduVideoResultReferenceV1
  ): Promise<Readable> {
    const resolved = await this.resolve(routeSnapshot);
    const parsed = parseVideoResult(reference);
    const operationId = this.requireAttached(
      resolved.route,
      parsed.providerOperationId
    );
    const stream = await this.legacyAdapter(resolved).openDownload(
      operationId,
      parsed.remoteResultId
    );
    await this.persistTerminal(operationId);
    return stream;
  }

  private async resolve(routeSnapshot: unknown): Promise<ResolvedViduExecutionRoute> {
    const resolved = await this.dependencies.routes.resolve(routeSnapshot);
    validateRouteIdentity(resolved.route, {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      features: ['image_to_video'],
      resultSchemaId: VIDU_REFERENCE_VIDEO_V2_RESULT_SCHEMA_ID,
      constraintSetIds: [VIDU_IMAGE_VIDEO_CONSTRAINT_SET_ID]
    });
    return resolved;
  }

  private legacyAdapter(
    resolved: ResolvedViduExecutionRoute
  ): ViduReferenceVideoV2Adapter {
    const remembered = new Map<string, ViduAdapterOperationContext>();
    return new ViduReferenceVideoV2Adapter({
      runtime: this.dependencies.runtime,
      connections: fixedConnection(resolved.connection),
      materials: this.dependencies.materials,
      operationContext: {
        remember: (taskId, context) => {
          remembered.set(taskId, context);
        },
        resolve: async (taskId) =>
          remembered.get(taskId) ??
          (this.contexts.has(taskId)
            ? {
                connectionId: resolved.connection.id,
                binding: resolved.binding
              }
            : undefined)
      }
    });
  }

  private requireAttached(
    route: ProviderExecutionRouteSnapshotV1,
    value: string
  ): string {
    const operationId = requireOpaqueId(value, 'operation ID');
    const context = this.contexts.get(operationId);
    if (!context || context.routeId !== route.id) {
      throw routeError(
        'vidu.operation_route_unavailable',
        'The Vidu operation has no matching persisted route attachment'
      );
    }
    return operationId;
  }

  private async persistTerminal(operationId: string): Promise<void> {
    const context = this.contexts.get(operationId);
    if (!context || context.usagePersisted) return;
    await this.persistUsage(
      context.invocationAttemptId,
      operationId,
      'not_reported'
    );
    context.usagePersisted = true;
  }

  private async persistUsage(
    attemptId: ProviderInvocationAttemptId,
    operationId: string,
    status: 'not_reported' | 'unknown_outcome'
  ): Promise<void> {
    await this.dependencies.usage.append(createProviderUsageObservation({
      id: this.ids.nextProviderUsageObservationId(),
      invocationAttemptId: attemptId,
      usageSchemaId: viduUsageSchema.id,
      usageSchemaRevision: viduUsageSchema.revision,
      sourceEventKey: sourceEventKey('vidu_video', operationId),
      sequence: 1,
      status,
      sourceStage: status === 'unknown_outcome' ? 'submit' : 'result',
      facts: [],
      observedAt: toIsoTimestamp(
        this.dependencies.now?.() ?? new Date().toISOString()
      )
    }, viduUsageSchema), viduUsageSchema);
  }
}

interface RouteExpectation {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly features: readonly ProviderExecutionRouteSnapshotV1['productFeature'][];
  readonly resultSchemaId: string;
  readonly constraintSetIds: readonly string[];
}

function validateRouteIdentity(
  routeSnapshot: unknown,
  expected: RouteExpectation
): ProviderExecutionRouteSnapshotV1 {
  const route = parseProviderExecutionRouteSnapshot(routeSnapshot);
  if (
    route.packageId !== VIDU_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== VIDU_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== expected.adapterKey ||
    route.adapterVersion !== expected.adapterVersion ||
    route.endpointPolicyId !== VIDU_ENDPOINT_POLICY_ID ||
    route.endpointPolicyRevision !== 1 ||
    !expected.features.includes(route.productFeature) ||
    route.resultSchemaId !== expected.resultSchemaId ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== VIDU_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    !expected.constraintSetIds.includes(route.constraintSetId) ||
    route.constraintSetRevision !== 1 ||
    route.featureMappingVersion !== 1
  ) {
    throw routeError(
      'vidu.route_contract_mismatch',
      'The Vidu route does not match the selected adapter contract'
    );
  }
  return route;
}

async function requireParameterSchema(
  resolver: ViduParameterSchemaResolverPort,
  route: ProviderExecutionRouteSnapshotV1
): Promise<ParameterSchemaV2> {
  const candidate = await resolver.get(
    route.parameterSchemaId,
    route.parameterSchemaRevision
  );
  let schema: ParameterSchemaV2;
  try {
    schema = validateParameterSchemaV2(candidate!);
  } catch {
    throw routeError(
      'vidu.parameter_schema_unavailable',
      'The exact Vidu parameter schema is unavailable'
    );
  }
  if (
    !candidate ||
    schema.schemaId !== route.parameterSchemaId ||
    schema.revision !== route.parameterSchemaRevision ||
    schema.productFeature !== route.productFeature
  ) {
    throw routeError(
      'vidu.parameter_schema_unavailable',
      'The exact Vidu parameter schema is unavailable'
    );
  }
  return schema;
}

function parseDispatchRequest(
  value: unknown,
  route: ProviderExecutionRouteSnapshotV1,
  schema: ParameterSchemaV2,
  requireAsset: boolean
): ViduRouteDispatchRequestV1 {
  const item = exactRecord(
    value,
    ['invocationAttemptId', 'projectId', 'prompt', 'parameterValues'],
    ['assetId', 'taskId', 'executionId'],
    'Vidu dispatch request'
  );
  const projectId = requireOpaqueId(item.projectId, 'project ID');
  const prompt = requireText(item.prompt, 'prompt', 5_000);
  const assetId = item.assetId === undefined
    ? undefined
    : requireOpaqueId(item.assetId, 'asset ID');
  const parameterValues = plainRecord(
    item.parameterValues,
    'parameter values'
  ) as Readonly<Record<string, ParameterValue>>;
  if (
    projectId !== route.projectId ||
    (requireAsset && !assetId) ||
    (!requireAsset && assetId !== undefined)
  ) {
    throw routeError(
      'vidu.dispatch_request_mismatch',
      'The Vidu dispatch request does not match its route snapshot'
    );
  }
  validateParameterValues(schema, 'full', parameterValues);
  return {
    invocationAttemptId: requireOpaqueId(
      item.invocationAttemptId,
      'invocation attempt ID'
    ) as ProviderInvocationAttemptId,
    projectId,
    prompt,
    ...(assetId ? { assetId } : {}),
    parameterValues
  };
}

function legacyImageRequest(
  resolved: ResolvedViduExecutionRoute,
  request: ViduRouteDispatchRequestV1
): ProviderProtocolSubmitRequest {
  const feature = resolved.route.productFeature;
  const purpose = feature === 'reference_to_image'
    ? 'reference_to_image'
    : feature === 'image_edit'
      ? 'image_editing'
      : 'image_generation';
  const taskId = toTaskId(`task-${resolved.route.id}`);
  const evidence = resolved.evidence;
  const assetIds = request.assetId ? [toAssetId(request.assetId)] : [];
  const task: Task = {
    schemaVersion: 1,
    id: taskId,
    projectId: resolved.route.projectId,
    sourceDraftId: toDraftId(`draft-${resolved.route.id}`),
    submission: {
      kind: feature === 'image_edit' ? 'image_editing' : 'image_generation',
      prompt: promptSnapshot(request.prompt),
      assetIds,
      confirmedAt: resolved.route.createdAt,
      image: {
        mode: feature === 'image_edit'
          ? 'image_editing'
          : request.assetId
            ? 'professional_image'
            : 'quick_image',
        purpose,
        modelId: resolved.model.id,
        capabilityEvidenceId: evidence.id,
        providerId: resolved.model.providerId,
        connectionId: resolved.model.connectionId,
        recipientName: 'Vidu',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: scalarParameters(request.parameterValues),
        confirmations: confirmedImageFields()
      }
    },
    executionIds: [],
    createdAt: resolved.route.createdAt
  };
  return {
    task,
    execution: submittingExecution(taskId, resolved.route),
    model: resolved.model,
    binding: resolved.binding,
    evidence
  };
}

function legacyVideoRequest(
  resolved: ResolvedViduExecutionRoute,
  request: ViduRouteDispatchRequestV1
): ProviderProtocolSubmitRequest {
  const taskId = toTaskId(`task-${resolved.route.id}`);
  const assetId = toAssetId(request.assetId!);
  const task: Task = {
    schemaVersion: 1,
    id: taskId,
    projectId: resolved.route.projectId,
    sourceDraftId: toDraftId(`draft-${resolved.route.id}`),
    submission: {
      kind: 'video_generation',
      prompt: promptSnapshot(request.prompt),
      assetIds: [assetId],
      confirmedAt: resolved.route.createdAt,
      video: {
        mode: 'image_to_video',
        purpose: 'video_generation',
        modelId: resolved.model.id,
        capabilityEvidenceId: resolved.evidence.id,
        providerId: resolved.model.providerId,
        connectionId: resolved.model.connectionId,
        recipientName: 'Vidu',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: videoParameters(request.parameterValues),
        materials: [{
          assetId,
          mediaKind: 'image',
          role: 'first_frame',
          target: { kind: 'slot', slotId: 'first_frame' }
        }],
        contextReferences: [],
        input: {
          mode: 'image_to_video',
          mustKeep: [],
          allowedChanges: [],
          prohibited: [],
          subjectAction: '',
          cameraMovement: '',
          pace: '',
          depthOfField: ''
        },
        confirmations: {
          recipient: true,
          outboundScope: true,
          materials: true,
          costPrivacyRegion: true,
          finalPrompt: true,
          model: true
        }
      }
    },
    executionIds: [],
    createdAt: resolved.route.createdAt
  };
  return {
    task,
    execution: submittingExecution(taskId, resolved.route),
    model: resolved.model,
    binding: resolved.binding,
    evidence: resolved.evidence
  };
}

function submittingExecution(
  taskId: Task['id'],
  route: ProviderExecutionRouteSnapshotV1
): Execution {
  return {
    schemaVersion: 1,
    id: toExecutionId(`execution-${route.id}`),
    taskId,
    attempt: 1,
    state: 'submitting',
    createdAt: route.createdAt,
    updatedAt: route.createdAt
  };
}

function fixedConnection(connection: ProviderConnection): ViduConnectionPort {
  return {
    get: async (connectionId) =>
      connectionId === connection.id ? connection : undefined
  };
}

function control(
  input: ViduRouteSubmitInput,
  markStarted: () => void
): ViduAdapterRequestControl {
  return {
    signal: input.signal,
    beforeRequestStarted: async () => {
      await input.beforeRequestStarted?.();
      markStarted();
    }
  };
}

function promptSnapshot(prompt: string) {
  return { originalInput: prompt, systemSupplements: [], finalPrompt: prompt };
}

function confirmedImageFields() {
  return {
    recipient: true as const,
    outboundScope: true as const,
    cost: true as const,
    finalPrompt: true as const,
    model: true as const
  };
}

function scalarParameters(
  values: Readonly<Record<string, ParameterValue>>
): Readonly<Record<string, DynamicParameterValue>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw routeError(
        'vidu.parameter_value_invalid',
        `Vidu parameter ${key} must be a scalar value`
      );
    }
    return [key, value as DynamicParameterValue];
  }));
}

function videoParameters(
  values: Readonly<Record<string, ParameterValue>>
): Readonly<Record<string, VideoDynamicParameterValue>> {
  return scalarParameters(values) as Readonly<Record<
    string,
    VideoDynamicParameterValue
  >>;
}

function parseImmediateResult(
  value: ViduImmediateResultReferenceV1
): ViduImmediateResultReferenceV1 {
  requireOpaqueId(value.providerOperationId, 'provider operation ID');
  if (!value.result || !['remote_url', 'base64', 'file_uri'].includes(value.result.kind)) {
    throw routeError('vidu.result_reference_invalid', 'The Vidu image result is invalid');
  }
  requireText(value.result.value, 'result reference', 16 * 1024 * 1024);
  if (value.result.kind === 'base64') {
    requireText(value.result.mimeType, 'result MIME type', 128);
  }
  return value;
}

function parseVideoResult(
  value: ViduVideoResultReferenceV1
): ViduVideoResultReferenceV1 {
  return {
    ...value,
    providerOperationId: requireOpaqueId(
      value.providerOperationId,
      'provider operation ID'
    ),
    remoteResultId: requireOpaqueId(value.remoteResultId, 'remote result ID')
  };
}

function sameImmediateResult(
  left: ProviderImmediateResultReference,
  right: ProviderImmediateResultReference
): boolean {
  return left.kind === right.kind &&
    left.value === right.value &&
    (left.kind !== 'base64' ||
      (right.kind === 'base64' && left.mimeType === right.mimeType));
}

function mapRouteFailure(
  error: unknown,
  requestStarted: boolean
): ProviderSubmitOutcome {
  if (requestStarted) {
    return {
      kind: 'submission_outcome_unknown',
      message: 'The Vidu submission outcome is unknown'
    };
  }
  return {
    kind: 'failed_before_submission',
    message: error instanceof ViduRouteAdapterError
      ? error.message
      : 'The Vidu route request could not be prepared',
    retryability: 'not_retryable'
  };
}

export class ViduRouteAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ViduRouteAdapterError';
  }
}

function routeError(code: string, message: string): ViduRouteAdapterError {
  return new ViduRouteAdapterError(code, message);
}

function defaultIds(): ViduRouteAdapterIdFactory {
  return {
    nextProviderOperationId: () => `vidu-operation-${randomUUID()}`,
    nextProviderUsageObservationId: () =>
      toProviderUsageObservationId(`vidu-usage-${randomUUID()}`)
  };
}

function sourceEventKey(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  const item = plainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in item)) ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw routeError('vidu.request_invalid', `${label} contains unsupported fields`);
  }
  return item;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw routeError('vidu.request_invalid', `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw routeError('vidu.request_invalid', `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000\u007f]/u.test(value)
  ) {
    throw routeError('vidu.request_invalid', `${label} is invalid`);
  }
  return value.trim();
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw routeError('vidu.request_invalid', `${label} is invalid`);
  }
  return value;
}
