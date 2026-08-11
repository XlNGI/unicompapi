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
  createOpenAiCompatibleDefaultImageEditDefinition,
  createOpenAiCompatibleDefaultImageDefinition,
  createOpenAiCompatibleDefaultReferenceImageDefinition,
  NEWAPI_IMAGE_ADAPTER_ID
} from './newapi-contracts';
import { isOpenAiCompatiblePackageId } from './openai-compatible-identity';
import {
  isKnownUniCompApiModel,
  isUniCompApiPackage,
  uniCompApiSupportsImage,
  uniCompApiSupportsImageEdit,
  uniCompApiSupportsReferenceImage
} from './unicompapi-model-capabilities';

type OpenAiCompatibleImageFeature =
  | 'text_to_image'
  | 'reference_to_image'
  | 'image_edit';

/**
 * Soft image routing for OpenAI-compatible packages (NewAPI / UniCompAPI).
 * Does not guess model names; only attaches the package-approved default
 * text_to_image profile when the package publishes an image adapter
 * (POST /v1/images/generations).
 */
export function routeOpenAiCompatibleImageProfile(
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
  return routeOpenAiCompatibleImageFeatureProfile(
    snapshot,
    packages,
    model,
    'text_to_image',
    now
  );
}

function isUniCompApiPackageForModelFeature(
  feature: OpenAiCompatibleImageFeature,
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel
): boolean {
  if (feature === 'text_to_image') return false;
  const connection = snapshot.connections.find((candidate) => candidate.id === model.connectionId);
  return Boolean(connection?.packageId && isUniCompApiPackage(connection.packageId));
}

export function routeOpenAiCompatibleImageEditProfile(
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
  return routeOpenAiCompatibleImageFeatureProfile(
    snapshot,
    packages,
    model,
    'image_edit',
    now
  );
}

export function routeOpenAiCompatibleReferenceImageProfile(
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
  return routeOpenAiCompatibleImageFeatureProfile(
    snapshot,
    packages,
    model,
    'reference_to_image',
    now
  );
}

function routeOpenAiCompatibleImageFeatureProfile(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  model: ProviderModel,
  feature: OpenAiCompatibleImageFeature,
  now: IsoTimestamp
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
  if (
    feature !== 'text_to_image' &&
    (!isUniCompApiPackageForModelFeature(feature, snapshot, model) ||
      !isKnownUniCompApiModel(model.providerModelKey))
  ) {
    return { snapshot, model, state: 'skipped' };
  }
  const supportsFeature = feature === 'text_to_image'
    ? uniCompApiSupportsImage(connection.packageId, model.providerModelKey)
    : feature === 'reference_to_image'
      ? uniCompApiSupportsReferenceImage(
          connection.packageId,
          model.providerModelKey
        )
      : uniCompApiSupportsImageEdit(connection.packageId, model.providerModelKey);
  if (!supportsFeature) {
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

  const existingImageProfile = (snapshot.modelProfiles ?? []).find((candidate) =>
    candidate.modelId === model.id &&
    candidate.status === 'verified' &&
    candidate.adapterKey === NEWAPI_IMAGE_ADAPTER_ID &&
    candidate.features.some((item) => item.productFeature === feature)
  );
  if (existingImageProfile) {
    const ensured = ensureImageCapabilityEvidence(snapshot, model, feature, now);
    const nextModel = ensured.snapshot.models.find((candidate) => candidate.id === model.id)
      ?? model;
    return {
      snapshot: ensured.snapshot,
      model: nextModel,
      profileId: existingImageProfile.profileId,
      state: 'already_attached'
    };
  }

  const imageAdapter = template.adapters.find(
    (adapter) => adapter.adapterId === NEWAPI_IMAGE_ADAPTER_ID
  );
  if (!imageAdapter) {
    return { snapshot, model, state: 'skipped' };
  }

  const binding = ensureImageCatalogBinding(snapshot, connection, imageAdapter, now);
  const definitionFactory = feature === 'text_to_image'
    ? createOpenAiCompatibleDefaultImageDefinition
    : feature === 'reference_to_image'
      ? createOpenAiCompatibleDefaultReferenceImageDefinition
      : createOpenAiCompatibleDefaultImageEditDefinition;
  const definition = definitionFactory({
    packageId: connection.packageId,
    packageVersion: connection.packageVersion,
    providerModelKey: model.providerModelKey
  });
  const profileTemplate = definition.profileTemplates[0];
  if (!profileTemplate) {
    return { snapshot, model, state: 'skipped' };
  }

  const withEvidence = ensureImageCapabilityEvidence(
    {
      ...snapshot,
      protocolBindings: binding.protocolBindings
    },
    model,
    feature,
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

export function routeOpenAiCompatibleImageProfilesForEnabledModels(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  now: IsoTimestamp = toIsoTimestamp(new Date().toISOString())
): ProviderRegistrySnapshot {
  let working = snapshot;
  for (const model of snapshot.models) {
    const latest = working.models.find((candidate) => candidate.id === model.id);
    if (!latest?.enabled || (latest.catalogState ?? 'present') !== 'present') continue;
    working = routeOpenAiCompatibleImageProfile(working, packages, latest, now).snapshot;
  }
  return working;
}

export function routeOpenAiCompatibleImageEditProfilesForEnabledModels(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  now: IsoTimestamp = toIsoTimestamp(new Date().toISOString())
): ProviderRegistrySnapshot {
  let working = snapshot;
  for (const model of snapshot.models) {
    const latest = working.models.find((candidate) => candidate.id === model.id);
    if (!latest?.enabled || (latest.catalogState ?? 'present') !== 'present') continue;
    working = routeOpenAiCompatibleImageEditProfile(
      working,
      packages,
      latest,
      now
    ).snapshot;
  }
  return working;
}

export function routeOpenAiCompatibleReferenceImageProfilesForEnabledModels(
  snapshot: ProviderRegistrySnapshot,
  packages: ProviderPackageRegistry,
  now: IsoTimestamp = toIsoTimestamp(new Date().toISOString())
): ProviderRegistrySnapshot {
  let working = snapshot;
  for (const model of snapshot.models) {
    const latest = working.models.find((candidate) => candidate.id === model.id);
    if (!latest?.enabled || (latest.catalogState ?? 'present') !== 'present') continue;
    working = routeOpenAiCompatibleReferenceImageProfile(
      working,
      packages,
      latest,
      now
    ).snapshot;
  }
  return working;
}

function ensureImageCapabilityEvidence(
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel,
  feature: OpenAiCompatibleImageFeature,
  now: IsoTimestamp
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly evidence: ModelCapabilityEvidence;
} {
  const capability = feature === 'text_to_image'
    ? 'image_generation'
    : feature === 'reference_to_image'
      ? 'reference_to_image'
      : 'image_editing';
  const existing = snapshot.capabilities.find(
    (candidate) =>
      candidate.modelId === model.id &&
      candidate.capability === capability
  );
  if (existing) {
    return { snapshot, evidence: existing };
  }
  const evidence = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(
      `capability-${model.id}-${capability}-declared-v1`
    ),
    modelId: model.id,
    revision: 1,
    capability,
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

function ensureImageCatalogBinding(
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
