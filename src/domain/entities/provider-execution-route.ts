import { InvariantViolationError } from '../errors';
import {
  toConnectionId,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toUsageSchemaId,
  type ConnectionId,
  type ModelId,
  type ProjectId,
  type ProtocolBindingId,
  type ProviderExecutionRouteSnapshotId,
  type ProviderId,
  type UsageSchemaId
} from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import { parseProductFeature, type ProductFeature } from './product-feature';

export interface ProviderExecutionRouteSnapshotV1 {
  readonly schemaVersion: 1;
  readonly id: ProviderExecutionRouteSnapshotId;
  readonly projectId: ProjectId;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly providerId: ProviderId;
  readonly providerDisplayName?: string;
  readonly connectionId: ConnectionId;
  readonly connectionDisplayName?: string;
  readonly connectionRevision: number;
  readonly connectionConfigVersionId: string;
  readonly endpointPolicyId: string;
  readonly endpointPolicyRevision: number;
  readonly credentialVersionId: string;
  readonly modelId: ModelId;
  readonly modelDisplayName?: string;
  readonly modelRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly protocolBindingId: ProtocolBindingId;
  readonly protocolBindingRevision: number;
  readonly productFeature: ProductFeature;
  readonly internalPurpose?: string;
  readonly featureMappingVersion: number;
  readonly parameterSchemaId: string;
  readonly parameterSchemaRevision: number;
  readonly resultSchemaId: string;
  readonly resultSchemaRevision: number;
  readonly usageSchemaId: UsageSchemaId;
  readonly usageSchemaRevision: number;
  readonly constraintSetId: string;
  readonly constraintSetRevision: number;
  readonly runtimePolicyId: string;
  readonly runtimePolicyRevision: number;
  readonly runtimeAuthorizationClaimId: string;
  readonly createdAt: IsoTimestamp;
}

export function createProviderExecutionRouteSnapshot(
  input: Omit<ProviderExecutionRouteSnapshotV1, 'schemaVersion'>
): ProviderExecutionRouteSnapshotV1 {
  return parseProviderExecutionRouteSnapshot({ schemaVersion: 1, ...input });
}

export function parseProviderExecutionRouteSnapshot(
  value: unknown
): ProviderExecutionRouteSnapshotV1 {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'id',
      'projectId',
      'packageId',
      'packageVersion',
      'adapterKey',
      'adapterVersion',
      'providerId',
      'connectionId',
      'connectionRevision',
      'connectionConfigVersionId',
      'endpointPolicyId',
      'endpointPolicyRevision',
      'credentialVersionId',
      'modelId',
      'modelRevision',
      'profileId',
      'profileRevision',
      'protocolBindingId',
      'protocolBindingRevision',
      'productFeature',
      'featureMappingVersion',
      'parameterSchemaId',
      'parameterSchemaRevision',
      'resultSchemaId',
      'resultSchemaRevision',
      'usageSchemaId',
      'usageSchemaRevision',
      'constraintSetId',
      'constraintSetRevision',
      'runtimePolicyId',
      'runtimePolicyRevision',
      'runtimeAuthorizationClaimId',
      'createdAt'
    ],
    [
      'internalPurpose',
      'providerDisplayName',
      'connectionDisplayName',
      'modelDisplayName'
    ],
    'provider execution route snapshot'
  );
  if (item.schemaVersion !== 1) {
    throw new InvariantViolationError('provider execution route snapshot is invalid');
  }
  const internalPurpose = item.internalPurpose === undefined
    ? undefined
    : safeKey(item.internalPurpose, 'route.internalPurpose');
  return {
    schemaVersion: 1,
    id: toProviderExecutionRouteSnapshotId(nonBlank(item.id, 'route.id')),
    projectId: toProjectId(nonBlank(item.projectId, 'route.projectId')),
    packageId: opaqueId(item.packageId, 'route.packageId'),
    packageVersion: version(item.packageVersion, 'route.packageVersion'),
    adapterKey: safeKey(item.adapterKey, 'route.adapterKey'),
    adapterVersion: version(item.adapterVersion, 'route.adapterVersion'),
    providerId: toProviderId(nonBlank(item.providerId, 'route.providerId')),
    ...(item.providerDisplayName === undefined
      ? {}
      : { providerDisplayName: displayName(item.providerDisplayName, 'route.providerDisplayName') }),
    connectionId: toConnectionId(nonBlank(item.connectionId, 'route.connectionId')),
    ...(item.connectionDisplayName === undefined
      ? {}
      : {
          connectionDisplayName: displayName(
            item.connectionDisplayName,
            'route.connectionDisplayName'
          )
        }),
    connectionRevision: positiveInteger(item.connectionRevision, 'route.connectionRevision'),
    connectionConfigVersionId: opaqueId(
      item.connectionConfigVersionId,
      'route.connectionConfigVersionId'
    ),
    endpointPolicyId: opaqueId(item.endpointPolicyId, 'route.endpointPolicyId'),
    endpointPolicyRevision: positiveInteger(
      item.endpointPolicyRevision,
      'route.endpointPolicyRevision'
    ),
    credentialVersionId: opaqueId(item.credentialVersionId, 'route.credentialVersionId'),
    modelId: toModelId(nonBlank(item.modelId, 'route.modelId')),
    ...(item.modelDisplayName === undefined
      ? {}
      : { modelDisplayName: displayName(item.modelDisplayName, 'route.modelDisplayName') }),
    modelRevision: positiveInteger(item.modelRevision, 'route.modelRevision'),
    profileId: opaqueId(item.profileId, 'route.profileId'),
    profileRevision: positiveInteger(item.profileRevision, 'route.profileRevision'),
    protocolBindingId: toProtocolBindingId(
      nonBlank(item.protocolBindingId, 'route.protocolBindingId')
    ),
    protocolBindingRevision: positiveInteger(
      item.protocolBindingRevision,
      'route.protocolBindingRevision'
    ),
    productFeature: parseProductFeature(item.productFeature),
    ...(internalPurpose ? { internalPurpose } : {}),
    featureMappingVersion: positiveInteger(
      item.featureMappingVersion,
      'route.featureMappingVersion'
    ),
    parameterSchemaId: opaqueId(item.parameterSchemaId, 'route.parameterSchemaId'),
    parameterSchemaRevision: positiveInteger(
      item.parameterSchemaRevision,
      'route.parameterSchemaRevision'
    ),
    resultSchemaId: opaqueId(item.resultSchemaId, 'route.resultSchemaId'),
    resultSchemaRevision: positiveInteger(
      item.resultSchemaRevision,
      'route.resultSchemaRevision'
    ),
    usageSchemaId: toUsageSchemaId(nonBlank(item.usageSchemaId, 'route.usageSchemaId')),
    usageSchemaRevision: positiveInteger(
      item.usageSchemaRevision,
      'route.usageSchemaRevision'
    ),
    constraintSetId: opaqueId(item.constraintSetId, 'route.constraintSetId'),
    constraintSetRevision: positiveInteger(
      item.constraintSetRevision,
      'route.constraintSetRevision'
    ),
    runtimePolicyId: opaqueId(item.runtimePolicyId, 'route.runtimePolicyId'),
    runtimePolicyRevision: positiveInteger(
      item.runtimePolicyRevision,
      'route.runtimePolicyRevision'
    ),
    runtimeAuthorizationClaimId: opaqueId(
      item.runtimeAuthorizationClaimId,
      'route.runtimeAuthorizationClaimId'
    ),
    createdAt: toIsoTimestamp(String(item.createdAt))
  };
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError(`${label} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in item)) ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw new InvariantViolationError(`${label} contains unsupported fields`);
  }
  return item;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InvariantViolationError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${label} cannot be empty`);
  }
  return value.trim();
}

function safeKey(value: unknown, label: string): string {
  const key = nonBlank(value, label);
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(key)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return key;
}

function displayName(value: unknown, label: string): string {
  const name = nonBlank(value, label);
  if (name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return name;
}

function opaqueId(value: unknown, label: string): string {
  const id = nonBlank(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return id;
}

function version(value: unknown, label: string): string {
  const result = nonBlank(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(result)) {
    throw new InvariantViolationError(`${label} is invalid`);
  }
  return result;
}
