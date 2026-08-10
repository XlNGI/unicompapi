import { randomUUID } from 'node:crypto';
import {
  createModelCapabilityEvidence,
  createProviderProtocolBinding,
  toCapabilityEvidenceId,
  toIsoTimestamp,
  toProtocolBindingId,
  type IsoTimestamp,
  type ModelCapabilityEvidence,
  type ModelFeatureProfile,
  type ProviderAdapterDescriptor,
  type ProviderConnection,
  type ProviderModel,
  type ProviderProtocolBinding
} from '../../../domain';
import type { ProviderPackageRegistry } from '../provider-package-registry';
import type { ProviderRegistrySnapshot } from '../provider-registry';
import {
  createOpenAiCompatibleDefaultVideoDefinition,
  NEWAPI_VIDEO_ADAPTER_ID
} from './newapi-contracts';
import { isOpenAiCompatiblePackageId } from './openai-compatible-identity';
import {
  isKnownUniCompApiModel,
  isUniCompApiDeepSeekModel,
  isUniCompApiPackage,
  uniCompApiVideoFeatures
} from './unicompapi-model-capabilities';

/**
 * Soft video routing for OpenAI-compatible packages (NewAPI / UniCompAPI).
 * Does not guess model names; only attaches the package-approved default
 * video profile when the package publishes a video adapter
 * (POST /v1/videos).
 */
export function routeOpenAiCompatibleVideoProfile(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  model: ProviderModel,
  now: IsoTimestamp = toIsoTimestamp(new Date().toISOString())
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly model: ProviderModel;
  readonly profileId?: string;
  readonly state: 'attached' | 'already_attached' | 'skipped';
} {
  if ((model.catalogState ?? 'present') === 'retired') {
    return { snapshot, model, state: 'skipped' };
  }
  const connection = snapshot.connections.find(
    (candidate) => candidate.id === model.connectionId
  );
  if (
    !connection ||
    connection.providerId !== model.providerId ||
    !connection.packageId ||
    !connection.packageVersion ||
    !connection.templateId ||
    !isOpenAiCompatiblePackageId(connection.packageId)
  ) {
    return { snapshot, model, state: 'skipped' };
  }
  const features = isUniCompApiPackage(connection.packageId)
    ? uniCompApiVideoFeatures(model.providerModelKey)
    : undefined;
  if (
    isUniCompApiPackage(connection.packageId) &&
    isKnownUniCompApiModel(model.providerModelKey) &&
    (!features || features.length === 0)
  ) {
    return { snapshot, model, state: 'skipped' };
  }
  if (
    isUniCompApiPackage(connection.packageId) &&
    isUniCompApiDeepSeekModel(model.providerModelKey)
  ) {
    return { snapshot, model, state: 'skipped' };
  }
  if (
    connection.state !== 'available' ||
    connection.identityState !== 'verified' ||
    connection.credentialState !== 'valid'
  ) {
    return { snapshot, model, state: 'skipped' };
  }

  let template;
  try {
    template = packages.resolveTemplate(connection.packageId, connection.templateId);
  } catch {
    return { snapshot, model, state: 'skipped' };
  }

  const existingVideoProfile = (snapshot.modelProfiles ?? []).find((candidate) =>
    candidate.modelId === model.id &&
    candidate.status === 'verified' &&
    candidate.adapterKey === NEWAPI_VIDEO_ADAPTER_ID &&
    candidate.features.some((feature) =>
      feature.productFeature === 'text_to_video' ||
      feature.productFeature === 'image_to_video'
    )
  );
  if (existingVideoProfile) {
    const ensured = ensureVideoGenerationCapabilityEvidence(snapshot, model, now);
    const nextModel = ensured.snapshot.models.find((candidate) => candidate.id === model.id)
      ?? model;
    return {
      snapshot: ensured.snapshot,
      model: nextModel,
      profileId: existingVideoProfile.profileId,
      state: 'already_attached'
    };
  }

  const videoAdapter = template.adapters.find(
    (adapter) => adapter.adapterId === NEWAPI_VIDEO_ADAPTER_ID
  );
  if (!videoAdapter) {
    return { snapshot, model, state: 'skipped' };
  }

  const binding = ensureVideoCatalogBinding(snapshot, connection, videoAdapter, now);
  const definition = createOpenAiCompatibleDefaultVideoDefinition({
    packageId: connection.packageId,
    packageVersion: connection.packageVersion,
    providerModelKey: model.providerModelKey,
    ...(features ? { features } : {})
  });
  const profileTemplate = definition.profileTemplates[0];
  if (!profileTemplate) {
    return { snapshot, model, state: 'skipped' };
  }

  const withEvidence = ensureVideoGenerationCapabilityEvidence(
    {
      ...snapshot,
      protocolBindings: binding.protocolBindings
    },
    model,
    now
  );
  const workingSnapshot = withEvidence.snapshot;
  const evidence = withEvidence.evidence;
  const currentModel = workingSnapshot.models.find((candidate) => candidate.id === model.id)
    ?? model;
  const definitions = workingSnapshot.modelDefinitions ?? [];
  const nextDefinitions = definitions.some(
    (candidate) => candidate.definitionId === definition.definitionId
  )
    ? definitions
    : [...definitions, definition];
  const nextModelRevision = currentModel.revision + 1;
  const profile: ModelFeatureProfile = {
    schemaVersion: 1,
    profileId: `profile-${randomUUID()}`,
    revision: Math.max(
      1,
      ...(workingSnapshot.modelProfiles ?? [])
        .filter((candidate) => candidate.modelId === model.id)
        .map((candidate) => candidate.revision + 1)
    ),
    packageId: definition.packageId,
    sourceTemplateId: profileTemplate.templateId,
    adapterKey: profileTemplate.adapterKey,
    modelId: model.id,
    modelRevision: nextModelRevision,
    protocolBindingId: binding.binding.id,
    status: 'verified',
    features: profileTemplate.features,
    evidenceIds: [
      ...new Set([
        ...workingSnapshot.capabilities
          .filter((candidate) => candidate.modelId === model.id)
          .map((candidate) => candidate.id),
        evidence.id
      ])
    ],
    recordedAt: now
  };
  const updatedModel: ProviderModel = {
    ...currentModel,
    capabilityEvidenceId: currentModel.capabilityEvidenceId ?? evidence.id,
    revision: nextModelRevision,
    updatedAt: now
  };
  return {
    snapshot: {
      ...workingSnapshot,
      protocolBindings: binding.protocolBindings,
      modelDefinitions: nextDefinitions,
      models: workingSnapshot.models.map((candidate) =>
        candidate.id === model.id ? updatedModel : candidate
      ),
      modelProfiles: [...(workingSnapshot.modelProfiles ?? []), profile]
    },
    model: updatedModel,
    profileId: profile.profileId,
    state: 'attached'
  };
}

export function routeOpenAiCompatibleVideoProfilesForEnabledModels(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  now: IsoTimestamp = toIsoTimestamp(new Date().toISOString())
): ProviderRegistrySnapshot {
  let working = snapshot;
  for (const model of snapshot.models) {
    const latest = working.models.find((candidate) => candidate.id === model.id);
    if (!latest?.enabled || (latest.catalogState ?? 'present') !== 'present') continue;
    working = routeOpenAiCompatibleVideoProfile(working, packages, latest, now).snapshot;
  }
  return working;
}

function ensureVideoGenerationCapabilityEvidence(
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel,
  now: IsoTimestamp
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly evidence: ModelCapabilityEvidence;
} {
  const existing = snapshot.capabilities.find(
    (candidate) =>
      candidate.modelId === model.id &&
      candidate.capability === 'video_generation'
  );
  if (existing) {
    return { snapshot, evidence: existing };
  }
  const evidence = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(
      `capability-${model.id}-video_generation-declared-v1`
    ),
    modelId: model.id,
    revision: 1,
    capability: 'video_generation',
    state: 'declared_supported',
    source: 'provider_declared',
    recordedAt: now
  });
  const updatedModel: ProviderModel = model.capabilityEvidenceId
    ? model
    : {
        ...model,
        capabilityEvidenceId: evidence.id,
        revision: model.revision + 1,
        updatedAt: now
      };
  return {
    snapshot: {
      ...snapshot,
      capabilities: [...snapshot.capabilities, evidence],
      models: snapshot.models.map((candidate) =>
        candidate.id === model.id ? updatedModel : candidate
      )
    },
    evidence
  };
}

function ensureVideoCatalogBinding(
  snapshot: ProviderRegistrySnapshot,
  connection: ProviderConnection,
  descriptor: ProviderAdapterDescriptor,
  now: IsoTimestamp
): {
  readonly binding: ProviderProtocolBinding;
  readonly protocolBindings: readonly ProviderProtocolBinding[];
} {
  const matches = snapshot.protocolBindings.filter((binding) =>
    binding.connectionId === connection.id &&
    binding.providerId === connection.providerId &&
    binding.protocolId === descriptor.protocolId &&
    binding.protocolVersion === descriptor.protocolVersion &&
    binding.adapterKind === descriptor.adapterId
  );
  if (matches.length > 1) {
    return { binding: matches[0], protocolBindings: snapshot.protocolBindings };
  }
  if (matches[0]) {
    return { binding: matches[0], protocolBindings: snapshot.protocolBindings };
  }
  const binding = createProviderProtocolBinding({
    id: toProtocolBindingId(`protocol-binding-catalog-${randomUUID()}`),
    providerId: connection.providerId,
    connectionId: connection.id,
    protocolId: descriptor.protocolId,
    protocolVersion: descriptor.protocolVersion,
    mediaKind: 'unknown',
    adapterKind: descriptor.adapterId,
    authScheme: 'unknown',
    executionLifecycle: 'unknown',
    supportedPurposes: [],
    createdAt: now,
    updatedAt: now
  });
  return { binding, protocolBindings: [...snapshot.protocolBindings, binding] };
}
