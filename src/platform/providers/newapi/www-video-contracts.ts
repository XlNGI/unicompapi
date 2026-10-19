import { createHash } from 'node:crypto';
import { createUsageSchema, toUsageSchemaId, createModelCapabilityEvidence, toCapabilityEvidenceId, createProviderProtocolBinding, toProtocolBindingId, type IsoTimestamp, type ModelFeatureProfile, type ParameterFieldSchemaV2,
  type ParameterSchemaV2, type ProductFeature, type ProviderModel, type JsonValueSchema } from '../../../domain';
import type { ProviderRegistrySnapshot } from '../provider-registry';
import { NEWAPI_ADAPTER_VERSION, NEWAPI_PROTOCOL_VERSION, NEWAPI_VIDEO_ADAPTER_ID, NEWAPI_VIDEO_PROTOCOL_ID,
  NEWAPI_VIDEO_RESULT_SCHEMA_ID } from './newapi-contracts';
import { UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, UNICOMPAPI_WWW_BASE_URL, UNICOMPAPI_WWW_ENDPOINT_POLICY_ID } from './unicompapi-contracts';
import catalog from './www-video-catalog.json';
import retainedH3 from './www-h3-contract.v1.json';
import previousCatalog from './www-video-catalog.previous.json';

export const WWW_VIDEO_CONTRACT_PREFIX = 'relay.unicompapi-www.';
export const wwwVideoUsageSchema = createUsageSchema({ id: toUsageSchemaId('usage.unicompapi-www.video'), revision: 1,
  completenessRule: 'provider_status_only', conflictPolicy: 'mark_invalid_response', metrics: [{ metricId: 'charged_amount',
    allowedUnits: ['CNY_MICRO'], numericKind: 'integer', aggregation: 'final_authoritative', requiredForComplete: false, allowedStages: ['poll'] }] });
export type WwwVideoContract = (typeof catalog.contracts)[number];
export function wwwVideoContract(key: string, revision?: number): WwwVideoContract | undefined {
  const current = catalog.contracts.find(c => c.modelKey === key);
  if (revision === undefined || current?.revision === revision) return current;
  // Retained contracts are exclusively for querying/downloading accepted tasks.
  if (key === retainedH3.modelKey && revision === retainedH3.revision) return retainedH3 as WwwVideoContract;
  const retained = previousCatalog.contracts.find(c => c.modelKey === key && c.revision === revision);
  if (retained) return retained as unknown as WwwVideoContract;
  return undefined;
}
export function wwwVideoContractFingerprint(contract: WwwVideoContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}
export function listWwwVideoContracts() { return structuredClone(catalog.contracts); }
export function wwwVideoConstraint(feature: ProductFeature): string { return `constraints.unicompapi-www.${feature}`; }

export function wwwVideoParameterSchema(contract: WwwVideoContract, feature: ProductFeature): ParameterSchemaV2 {
  if (!(contract.features as readonly string[]).includes(feature)) throw new Error('www_video_feature_mismatch');
  const fields: ParameterFieldSchemaV2[] = contract.fields.flatMap<ParameterFieldSchemaV2>(({ name, schema: raw, required: documentedRequired }) => {
    // This surface registers one video. Auxiliary images and mixed-media inputs
    // have no controlled receiver here, so their switches must not be offered.
    if (name === 'return_last_frame' || name === 'omni_reference_task_type') return [];
    const schema = raw as JsonValueSchema;
    if (name === 'generation_mode') {
      if (feature !== 'image_to_video') return [];
      const modes = (schema.enum as readonly string[]).filter(m => ['first_frame', 'first_last_frame', 'reference_images', 'last_frame'].includes(m));
      return [{ fieldId: name, labelId: `provider.parameter.${name}`, order: 10, valueType: 'enum' as const,
        exposure: 'user_required' as const, required: true, defaultPolicy: 'require_user_value' as const, options: modes }];
    }
    const options = schema.enum as readonly (string | number | boolean)[] | undefined;
    const valueType = options ? 'enum' as const : schema.type as 'integer' | 'boolean' | 'string';
    return [{ fieldId: name, labelId: `provider.parameter.${name}`, order: 20 + contract.fields.findIndex(f => f.name === name) * 10,
      valueType, required: documentedRequired === true, exposure: documentedRequired === true ? 'user_required' as const : 'user_optional' as const,
      defaultPolicy: documentedRequired === true ? 'require_user_value' as const : 'omit_use_provider_default' as const,
      validationSchema: schema, ...(options ? { options } : {}), ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}) }];
  });
  return { schemaVersion: 2, schemaId: `parameters.unicompapi-www.${contract.modelKey}.${feature}`, revision: contract.revision,
    productFeature: feature, fields };
}
export function wwwVideoFeatureContracts() {
  return catalog.contracts.flatMap(c => c.features.map(f => ({ parameterSchema: wwwVideoParameterSchema(c, f as ProductFeature),
    resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID, resultSchemaRevision: 1, usageSchema: wwwVideoUsageSchema,
    constraintSetId: wwwVideoConstraint(f as ProductFeature), constraintSetRevision: 1, featureMappingVersion: 1 })));
}

/** Exact gateway catalog declaration. Never claims that a live model call was verified. */
export function routeWwwVideoProfile(snapshot: ProviderRegistrySnapshot, model: ProviderModel, now: IsoTimestamp) {
  const connection = snapshot.connections.find(c => c.id === model.connectionId && c.providerId === model.providerId);
  const contract = wwwVideoContract(model.providerModelKey);
  if (!connection || connection.packageId !== UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID || connection.packageVersion !== '1.0.0' ||
      connection.endpoint !== UNICOMPAPI_WWW_BASE_URL || connection.endpointPolicyId !== UNICOMPAPI_WWW_ENDPOINT_POLICY_ID || connection.identityState !== 'verified' ||
      !connection.connectionConfigVersionId || !connection.credentialVersionId || !contract || model.catalogState !== 'present' ||
      connection.state !== 'available' || connection.credentialState !== 'valid') return { snapshot, model, state: 'skipped' as const };
  const active = snapshot.modelProfiles?.find(p => p.profileId === model.activeProfileId);
  // Never replace a user's different binding or a restricted/disabled profile during migration.
  if (active && (active.status === 'restricted' || active.status === 'disabled' || active.apiContract && active.apiContract.contractId !== contract.id)) {
    return { snapshot, model, state: 'skipped' as const };
  }
  if (active?.apiContract?.contractId === contract.id && active.apiContract.contractFingerprint === wwwVideoContractFingerprint(contract) &&
      active.apiContractConnectionPin?.credentialVersionId === connection.credentialVersionId &&
      active.apiContractConnectionPin?.connectionConfigVersionId === connection.connectionConfigVersionId) {
    return { snapshot, model, profileId: active.profileId, state: 'already_attached' as const };
  }
  const adapter = { adapterId: NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION,
    protocolId: NEWAPI_VIDEO_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION };
  const nextConnection = { ...connection, adapterBindings: [...(connection.adapterBindings ?? []).filter(a => a.adapterId !== adapter.adapterId), adapter] };
  const bindingId = toProtocolBindingId(`binding-www-video-${connection.id}`);
  const binding = createProviderProtocolBinding({ id: bindingId, providerId: model.providerId, connectionId: connection.id,
    protocolId: adapter.protocolId, protocolVersion: adapter.protocolVersion, mediaKind: 'video', executionLifecycle: 'asynchronous_polling',
    supportedPurposes: ['video_generation', 'reference_to_video'], adapterKind: adapter.adapterId, authScheme: 'bearer', createdAt: now, updatedAt: now });
  const revision = model.revision + 1;
  const profileId = `profile-www-video-${model.id}-${revision}`;
  const features = contract.features.map(f => { const feature = f as ProductFeature; return { productFeature: feature,
    internalPurpose: feature === 'text_to_video' ? 'video_generation' : 'reference_to_video', parameterSchemaId: wwwVideoParameterSchema(contract, feature).schemaId,
    resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID, usageSchemaId: wwwVideoUsageSchema.id, constraintSetId: wwwVideoConstraint(feature) }; });
  const sourceTemplateId = `template-www-video-${contract.modelKey}`;
  const evidence = [...new Set(features.map(f => f.internalPurpose))].filter(purpose =>
    !snapshot.capabilities.some(e => e.modelId === model.id && e.capability === purpose)).map(purpose => createModelCapabilityEvidence({
      id: toCapabilityEvidenceId(`capability-www-${model.id}-${purpose}`), modelId: model.id, revision: 1,
      capability: purpose, state: 'declared_supported', source: 'provider_declared', recordedAt: now
    }));
  const profile: ModelFeatureProfile = { schemaVersion: 1, profileId, revision: 1, packageId: connection.packageId,
    sourceTemplateId, adapterKey: adapter.adapterId, modelId: model.id, modelRevision: revision, protocolBindingId: bindingId,
    status: 'declared', features, evidenceIds: evidence.map(e => e.id), recordedAt: now,
    apiContract: { schemaVersion: 1, contractId: contract.id, contractRevision: contract.revision, contractFingerprint: wwwVideoContractFingerprint(contract), rules: [] },
    apiContractConnectionPin: { connectionConfigVersionId: connection.connectionConfigVersionId!, credentialVersionId: connection.credentialVersionId! } };
  const nextModel = { ...model, revision, activeProfileId: profileId,
    capabilityEvidenceId: model.capabilityEvidenceId ?? evidence[0]?.id, updatedAt: now };
  return { snapshot: { ...snapshot, models: snapshot.models.map(m => m.id === model.id ? nextModel : m),
    connections: snapshot.connections.map(c => c.id === connection.id ? nextConnection : c),
    protocolBindings: [...snapshot.protocolBindings.filter(b => b.id !== bindingId), binding],
    modelProfiles: [...(snapshot.modelProfiles ?? []), profile],
    capabilities: [...snapshot.capabilities, ...evidence],
    modelDefinitions: [...(snapshot.modelDefinitions ?? []).filter(d => d.definitionId !== sourceTemplateId), { schemaVersion: 1 as const,
      definitionId: sourceTemplateId, packageId: connection.packageId, packageVersion: connection.packageVersion!, providerModelKey: model.providerModelKey,
      profileTemplates: [{ templateId: sourceTemplateId, adapterKey: adapter.adapterId, protocolDefinitionId: adapter.protocolId,
        features, sourceDocumentRevision: `${contract.id}@${contract.revision}` }] }] }, model: nextModel, profileId, state: 'attached' as const };
}
