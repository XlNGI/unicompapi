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
  evaluateOpenAiCompatibleVideoGate,
  isTrustedVideoCapabilityEvidence,
  type OpenAiCompatibleVideoGateReason
} from './openai-compatible-video-capability';
import {
  isKnownUniCompApiModel,
  isUniCompApiDeepSeekModel,
  isUniCompApiPackage,
  uniCompApiVideoParameterSchema,
  uniCompApiVideoFeatures
} from './unicompapi-model-capabilities';

export type OpenAiCompatibleVideoRouteSkipReason =
  | OpenAiCompatibleVideoGateReason
  | 'not_openai_compatible'
  | 'package_template_unavailable';

/**
 * Soft video routing for OpenAI-compatible packages (NewAPI / UniCompAPI).
 *
 * Publishing a video adapter proves only that the connection has a video call
 * channel. It does NOT prove that each model behind the connection supports
 * video. A profile is therefore attached only when the capability gate finds a
 * trustworthy per-model fact:
 *
 *   - the package owns an exact model mapping (UniCompAPI capability table), or
 *   - an exact mapping entry exists for this concrete model, or
 *   - the user explicitly confirmed this model, or
 *   - non-synthetic capability evidence declares video support.
 *
 * Unknown-capability models are skipped. The router never writes the evidence
 * that authorises its own decision.
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
  readonly reason?: OpenAiCompatibleVideoRouteSkipReason;
} {
  if ((model.catalogState ?? 'present') === 'retired') {
    return { snapshot, model, state: 'skipped', reason: 'model_retired' };
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
    return { snapshot, model, state: 'skipped', reason: 'not_openai_compatible' };
  }
  if (
    connection.state !== 'available' ||
    connection.identityState !== 'verified' ||
    connection.credentialState !== 'valid'
  ) {
    return { snapshot, model, state: 'skipped', reason: 'connection_not_ready' };
  }

  let template;
  try {
    template = packages.resolveTemplate(connection.packageId, connection.templateId);
  } catch {
    return { snapshot, model, state: 'skipped', reason: 'package_template_unavailable' };
  }
  if (!template.adapters.some((adapter) => adapter.adapterId === NEWAPI_VIDEO_ADAPTER_ID)) {
    return { snapshot, model, state: 'skipped', reason: 'video_adapter_missing' };
  }

  // The closed-world UniCompAPI capability table is a package-owned exact
  // mapping. Unknown or unsupported keys yield no mapping and stay skipped.
  const packageMappingFeatures = isUniCompApiPackage(connection.packageId) &&
    !isUniCompApiDeepSeekModel(model.providerModelKey)
    ? uniCompApiVideoFeatures(model.providerModelKey)
    : undefined;
  const features = packageMappingFeatures && packageMappingFeatures.length > 0
    ? packageMappingFeatures
    : undefined;

  const gate = evaluateOpenAiCompatibleVideoGate({
    snapshot,
    model,
    modelId: model.id,
    packageId: connection.packageId,
    providerModelKey: model.providerModelKey,
    ...(features ? { exactMappingFeatures: features } : {})
  });
  if (!gate.allowed) {
    // Do not synthesise capability evidence, do not migrate, and do not touch
    // any legacy profile. Query-time invalidation handles persisted mistakes.
    return { snapshot, model, state: 'skipped', reason: gate.reason };
  }
  const trustedEvidence = gate.evidenceIds
    .map((evidenceId) => snapshot.capabilities.find((item) => item.id === evidenceId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => isTrustedVideoCapabilityEvidence(item));

  const existingVideoProfile = (snapshot.modelProfiles ?? []).find((candidate) =>
    candidate.modelId === model.id &&
    candidate.status === 'verified' &&
    candidate.adapterKey === NEWAPI_VIDEO_ADAPTER_ID &&
    candidate.features.some((feature) =>
      feature.productFeature === 'text_to_video' ||
      feature.productFeature === 'image_to_video'
    )
  );
  const definition = createOpenAiCompatibleDefaultVideoDefinition({
    packageId: connection.packageId,
    packageVersion: connection.packageVersion,
    providerModelKey: model.providerModelKey,
    ...(features ? { features } : {}),
    ...(isUniCompApiPackage(connection.packageId)
      ? {
          textToVideoParameterSchemaId: uniCompApiVideoParameterSchema(
            model.providerModelKey,
            'text_to_video'
          )?.schemaId,
          imageToVideoParameterSchemaId: uniCompApiVideoParameterSchema(
            model.providerModelKey,
            'image_to_video'
          )?.schemaId
        }
      : {})
  });
  const profileTemplate = definition.profileTemplates[0];
  if (!profileTemplate) {
    return { snapshot, model, state: 'skipped', reason: 'package_template_unavailable' };
  }
  if (existingVideoProfile) {
    const ensured = ensureAuthorisedVideoCapabilityEvidence(
      snapshot,
      model,
      now,
      gate.reason,
      trustedEvidence
    );
    const nextModel = ensured.snapshot.models.find((candidate) => candidate.id === model.id)
      ?? model;
    const needsMigration = profileTemplate.features.some((desired) =>
      existingVideoProfile.features.some((current) =>
        current.productFeature === desired.productFeature &&
        current.parameterSchemaId !== desired.parameterSchemaId
      )
    );
    if (needsMigration) {
      const nextModelRevision = nextModel.revision + 1;
      const migratedModel: ProviderModel = {
        ...nextModel,
        revision: nextModelRevision,
        updatedAt: now
      };
      const migratedProfile: ModelFeatureProfile = {
        ...existingVideoProfile,
        revision: existingVideoProfile.revision + 1,
        sourceTemplateId: profileTemplate.templateId,
        modelRevision: nextModelRevision,
        features: existingVideoProfile.features.map((current) =>
          profileTemplate.features.find(
            (desired) => desired.productFeature === current.productFeature
          ) ?? current
        ),
        recordedAt: now
      };
      const definitions = ensured.snapshot.modelDefinitions ?? [];
      return {
        snapshot: {
          ...ensured.snapshot,
          modelDefinitions: definitions.some(
            (candidate) => candidate.definitionId === definition.definitionId
          ) ? definitions : [...definitions, definition],
          models: ensured.snapshot.models.map((candidate) =>
            candidate.id === migratedModel.id ? migratedModel : candidate
          ),
          modelProfiles: (ensured.snapshot.modelProfiles ?? []).map((candidate) =>
            candidate.profileId === migratedProfile.profileId ? migratedProfile : candidate
          )
        },
        model: migratedModel,
        profileId: migratedProfile.profileId,
        state: 'already_attached'
      };
    }
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
    return { snapshot, model, state: 'skipped', reason: 'video_adapter_missing' };
  }

  const binding = ensureVideoCatalogBinding(snapshot, connection, videoAdapter, now);

  const withEvidence = ensureAuthorisedVideoCapabilityEvidence(
    {
      ...snapshot,
      protocolBindings: binding.protocolBindings
    },
    model,
    now,
    gate.reason,
    trustedEvidence
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

/**
 * Records the capability fact that the gate authorised.
 *
 * When a trustworthy per-model fact already exists (user confirmation or real
 * provider evidence) it is reused untouched — the platform must never restate
 * the user's or the provider's claim as its own. For package-owned exact
 * mappings the fact is projected once under a deterministic, mapping-scoped ID
 * so repeated routing stays idempotent.
 */
function ensureAuthorisedVideoCapabilityEvidence(
  snapshot: ProviderRegistrySnapshot,
  model: ProviderModel,
  now: IsoTimestamp,
  gateReason: OpenAiCompatibleVideoGateReason,
  trustedEvidence: readonly ModelCapabilityEvidence[]
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly evidence: ModelCapabilityEvidence;
} {
  const existing = trustedEvidence[0];
  if (existing) {
    return { snapshot, evidence: existing };
  }
  const projection = gateReason === 'package_closed_world_mapping'
    ? 'package-mapping-v1'
    : 'exact-mapping-v1';
  const id = toCapabilityEvidenceId(
    `capability-${model.id}-video_generation-${projection}`
  );
  const current = snapshot.capabilities.find((candidate) => candidate.id === id);
  if (current) {
    return { snapshot, evidence: current };
  }
  const evidence = createModelCapabilityEvidence({
    id,
    modelId: model.id,
    revision: 1,
    capability: 'video_generation',
    state: 'declared_supported',
    source: 'provider_declared',
    recordedAt: now
  });
  const currentModel = snapshot.models.find((candidate) => candidate.id === model.id) ?? model;
  const updatedModel: ProviderModel = currentModel.capabilityEvidenceId
    ? currentModel
    : {
        ...currentModel,
        capabilityEvidenceId: evidence.id,
        revision: currentModel.revision + 1,
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
