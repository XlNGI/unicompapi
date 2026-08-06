import { randomUUID } from 'node:crypto';
import {
  createModelCapabilityEvidence,
  createProviderModel,
  createProviderProtocolBinding,
  toCapabilityEvidenceId,
  toConnectionId,
  toModelId,
  toProtocolBindingId,
  toProviderId,
  type ConnectionId,
  type IsoTimestamp,
  type ModelCapabilityEvidence,
  type ModelFeatureProfile,
  type ProviderModel,
  type ProviderModelDefinition,
  type ProviderOperationPurpose,
  type ProviderProtocolBinding,
  type ProviderId
} from '../../../domain';
import type {
  JsonProviderRegistryStore,
  ProviderRegistrySnapshot
} from '../provider-registry';
import {
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
  VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_IMAGE_V1_PROTOCOL_ID,
  VIDU_IMAGE_V1_PROTOCOL_VERSION,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
  VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
  VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
  createViduModelContract,
  frozenViduGeminiImageModelKeys,
  frozenViduLegacyGeminiImageModelKeys,
  frozenViduModelKeys,
  frozenViduOfficialImageModelKeys,
  frozenViduVideoModelKeys,
  viduProviderPackageDescriptor,
  type FrozenViduModelKey
} from './vidu-contracts';

export interface InstallPackagedViduCatalogInput {
  readonly providerId: string;
  readonly connectionId: string;
  readonly now: IsoTimestamp;
}

export interface InstallPackagedViduCatalogResult {
  readonly count: number;
}

/**
 * Idempotently installs the packaged Vidu model catalog onto one connection,
 * then remounts every other Vidu connection in the same snapshot (including
 * deleted ones that still retain models/profiles). Model definitions are
 * package-global; remounting only one connection would leave sibling profiles
 * pointing at stale Gemini adapters and fail registry reference validation.
 */
export function applyPackagedViduCatalogInstall(
  snapshot: ProviderRegistrySnapshot,
  input: InstallPackagedViduCatalogInput
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly result: InstallPackagedViduCatalogResult;
} {
  const providerId = toProviderId(input.providerId);
  const connectionId = toConnectionId(input.connectionId);
  const target = snapshot.connections.find((item) => item.id === connectionId);
  if (!target || target.providerId !== providerId) {
    throw new TypeError('Vidu packaged catalog install requires an owned connection');
  }
  if (target.packageId !== VIDU_PROVIDER_PACKAGE_ID) {
    throw new TypeError('Vidu packaged catalog install requires a Vidu package connection');
  }

  const siblingIds = snapshot.connections
    .filter(
      (item) =>
        item.packageId === VIDU_PROVIDER_PACKAGE_ID &&
        item.id !== connectionId
    )
    .map((item) => item.id);
  const connectionIds = [connectionId, ...siblingIds];

  let current = snapshot;
  let count = 0;
  for (const id of connectionIds) {
    const connection = current.connections.find((item) => item.id === id);
    if (!connection) continue;
    const installed = applyPackagedViduCatalogInstallForConnection(current, {
      providerId: connection.providerId,
      connectionId: connection.id,
      now: input.now
    });
    current = installed.snapshot;
    if (id === connectionId) count = installed.result.count;
  }
  return { snapshot: current, result: { count } };
}

function applyPackagedViduCatalogInstallForConnection(
  snapshot: ProviderRegistrySnapshot,
  input: InstallPackagedViduCatalogInput
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly result: InstallPackagedViduCatalogResult;
} {
  const providerId = toProviderId(input.providerId);
  const connectionId = toConnectionId(input.connectionId);
  const connection = snapshot.connections.find((item) => item.id === connectionId);
  if (!connection || connection.providerId !== providerId) {
    throw new TypeError('Vidu packaged catalog install requires an owned connection');
  }
  if (connection.packageId !== VIDU_PROVIDER_PACKAGE_ID) {
    throw new TypeError('Vidu packaged catalog install requires a Vidu package connection');
  }

  let protocolBindings = [...snapshot.protocolBindings];
  const bindings = ensureProtocolBindings(
    protocolBindings,
    providerId,
    connectionId,
    input.now
  );
  protocolBindings = bindings.protocolBindings;

  let models = [...snapshot.models];
  let capabilities = [...snapshot.capabilities];
  let modelDefinitions = [...(snapshot.modelDefinitions ?? [])];
  let modelProfiles = [...(snapshot.modelProfiles ?? [])];

  for (const providerModelKey of frozenViduModelKeys) {
    const binding = bindingForModelKey(bindings.byKind, providerModelKey);
    const purposes = purposesForModelKey(providerModelKey);
    // Image V1 remains unverified; keep it installed but disabled so
    // text-to-image candidates prefer official viduq2 instead.
    const enabled = providerModelKey !== 'viduimage-2';
    const profileStatus = enabled ? ('verified' as const) : ('disabled' as const);

    let model = models.find(
      (candidate) =>
        candidate.connectionId === connectionId &&
        candidate.providerModelKey === providerModelKey
    );

    if (!model) {
      const modelId = toModelId(`model-vidu-${connectionId}-${providerModelKey}-${randomUUID()}`);
      const evidence = purposes.map((purpose) =>
        createModelCapabilityEvidence({
          id: toCapabilityEvidenceId(
            `capability-${modelId}-${purpose}-declared-v1`
          ),
          modelId,
          revision: 1,
          capability: purpose,
          state: 'declared_supported',
          source: 'provider_declared',
          recordedAt: input.now
        })
      );
      capabilities.push(...evidence);
      model = createProviderModel({
        id: modelId,
        providerId,
        connectionId,
        protocolBindingId: binding.id,
        providerModelKey,
        mediaKind: binding.mediaKind,
        revision: 1,
        catalogState: 'present',
        displayName: providerModelKey,
        capabilityEvidenceId: evidence[0]?.id,
        enabled,
        createdAt: input.now,
        updatedAt: input.now
      });
      models.push(model);
    } else {
      const missingPurposes = purposes.filter(
        (purpose) =>
          !capabilities.some(
            (evidence) =>
              evidence.modelId === model!.id && evidence.capability === purpose
          )
      );
      for (const purpose of missingPurposes) {
        capabilities.push(
          createModelCapabilityEvidence({
            id: toCapabilityEvidenceId(
              `capability-${model.id}-${purpose}-declared-v1`
            ),
            modelId: model.id,
            revision: 1,
            capability: purpose,
            state: 'declared_supported',
            source: 'provider_declared',
            recordedAt: input.now
          })
        );
      }
      const bindingNeedsUpdate = model.protocolBindingId !== binding.id;
      const enabledNeedsUpdate = model.enabled !== enabled;
      if (bindingNeedsUpdate || enabledNeedsUpdate) {
        const updated: ProviderModel = {
          ...model,
          protocolBindingId: binding.id,
          mediaKind: binding.mediaKind,
          catalogState: 'present',
          enabled,
          revision: model.revision + 1,
          updatedAt: input.now
        };
        models = models.map((candidate) =>
          candidate.id === model!.id ? updated : candidate
        );
        model = updated;
      }
    }

    const contract = createViduModelContract(providerModelKey);
    const existingDefinitionIndex = modelDefinitions.findIndex(
      (definition) => definition.definitionId === contract.definition.definitionId
    );
    if (existingDefinitionIndex < 0) {
      modelDefinitions.push(contract.definition);
    } else {
      modelDefinitions[existingDefinitionIndex] = contract.definition;
    }

    const template = contract.definition.profileTemplates[0];
    const existingProfile = model.activeProfileId
      ? modelProfiles.find(
          (profile) =>
            profile.modelId === model!.id &&
            profile.profileId === model!.activeProfileId
        )
      : undefined;
    if (!existingProfile) {
      const nextModelRevision = model.revision + 1;
      const priorRevisions = modelProfiles
        .filter((candidate) => candidate.modelId === model!.id)
        .map((candidate) => candidate.revision + 1);
      const profile: ModelFeatureProfile = {
        schemaVersion: 1,
        profileId: `profile-vidu-${model.id}-${randomUUID()}`,
        revision: Math.max(1, ...priorRevisions),
        packageId: VIDU_PROVIDER_PACKAGE_ID,
        sourceTemplateId: template.templateId,
        adapterKey: template.adapterKey,
        modelId: model.id,
        modelRevision: nextModelRevision,
        protocolBindingId: model.protocolBindingId,
        status: profileStatus,
        features: template.features,
        evidenceIds: capabilities
          .filter((evidence) => evidence.modelId === model!.id)
          .map((evidence) => evidence.id),
        recordedAt: input.now
      };
      modelProfiles.push(profile);
      const updated: ProviderModel = {
        ...model,
        activeProfileId: profile.profileId,
        revision: nextModelRevision,
        updatedAt: input.now
      };
      models = models.map((candidate) =>
        candidate.id === model!.id ? updated : candidate
      );
    } else {
      // Refresh declared features/evidence when packaged contracts expand
      // (e.g. viduq2 gaining text_to_image) without recreating the profile id.
      // Also promote restricted/disabled packaged profiles to the install target
      // status so official models become selectable after sync.
      const nextFeatures = template.features;
      const nextEvidenceIds = capabilities
        .filter((evidence) => evidence.modelId === model!.id)
        .map((evidence) => evidence.id);
      const featuresChanged =
        JSON.stringify(existingProfile.features) !== JSON.stringify(nextFeatures);
      const evidenceChanged =
        JSON.stringify(existingProfile.evidenceIds) !== JSON.stringify(nextEvidenceIds);
      const bindingChanged =
        existingProfile.protocolBindingId !== model!.protocolBindingId ||
        existingProfile.adapterKey !== template.adapterKey;
      const modelRevisionChanged =
        existingProfile.modelRevision !== model!.revision;
      const statusChanged = existingProfile.status !== profileStatus;
      if (
        featuresChanged ||
        evidenceChanged ||
        bindingChanged ||
        modelRevisionChanged ||
        statusChanged
      ) {
        modelProfiles = modelProfiles.map((profile) =>
          profile.profileId === existingProfile.profileId
            ? {
                ...profile,
                features: nextFeatures,
                evidenceIds: nextEvidenceIds,
                sourceTemplateId: template.templateId,
                adapterKey: template.adapterKey,
                protocolBindingId: model!.protocolBindingId,
                modelRevision: model!.revision,
                status: profileStatus,
                recordedAt: input.now
              }
            : profile
        );
      }
    }
  }

  const requiredAdapterBindings = viduProviderPackageDescriptor.adapters.map(
    (adapter) => ({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocolId: adapter.protocolId,
      protocolVersion: adapter.protocolVersion
    })
  );
  const connections = snapshot.connections.map((item) => {
    if (item.id !== connectionId) return item;
    const existing = item.adapterBindings ?? [];
    const missing = requiredAdapterBindings.filter(
      (required) =>
        !existing.some(
          (binding) =>
            binding.adapterId === required.adapterId &&
            binding.adapterVersion === required.adapterVersion &&
            binding.protocolId === required.protocolId &&
            binding.protocolVersion === required.protocolVersion
        )
    );
    if (missing.length === 0) return item;
    return {
      ...item,
      adapterBindings: [...existing, ...missing],
      updatedAt: input.now
    };
  });

  const count = models.filter(
    (model) =>
      model.connectionId === connectionId &&
      frozenViduModelKeys.includes(model.providerModelKey as FrozenViduModelKey)
  ).length;

  return {
    snapshot: {
      ...snapshot,
      connections,
      protocolBindings,
      models,
      capabilities,
      modelDefinitions,
      modelProfiles
    },
    result: { count }
  };
}

export async function installPackagedViduCatalog(
  registry: JsonProviderRegistryStore,
  input: InstallPackagedViduCatalogInput
): Promise<InstallPackagedViduCatalogResult> {
  return registry.mutate((snapshot) => applyPackagedViduCatalogInstall(snapshot, input));
}

type BindingKind =
  | 'referenceVideoV2'
  | 'imageV1'
  | 'geminiImageV2'
  | 'referenceImageV2';

function ensureProtocolBindings(
  existing: readonly ProviderProtocolBinding[],
  providerId: ProviderId,
  connectionId: ConnectionId,
  now: IsoTimestamp
): {
  readonly byKind: Record<BindingKind, ProviderProtocolBinding>;
  readonly protocolBindings: ProviderProtocolBinding[];
} {
  const specs: readonly {
    readonly kind: BindingKind;
    readonly protocolId: string;
    readonly protocolVersion: string;
    readonly mediaKind: 'video' | 'image';
    readonly adapterKind: string;
    readonly endpointTemplate: string;
    readonly authScheme: 'token' | 'bearer';
    readonly executionLifecycle: 'asynchronous_polling' | 'synchronous_completed';
    readonly supportedPurposes: readonly ProviderOperationPurpose[];
  }[] = [
    {
      kind: 'referenceVideoV2',
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
      mediaKind: 'video',
      adapterKind: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      endpointTemplate: 'https://api.vidu.cn/ent/v2/reference2video',
      authScheme: 'token',
      executionLifecycle: 'asynchronous_polling',
      supportedPurposes: ['reference_to_video']
    },
    {
      kind: 'imageV1',
      protocolId: VIDU_IMAGE_V1_PROTOCOL_ID,
      protocolVersion: VIDU_IMAGE_V1_PROTOCOL_VERSION,
      mediaKind: 'image',
      adapterKind: VIDU_IMAGE_V1_ADAPTER_ID,
      endpointTemplate: 'https://api.vidu.cn/ent/v1/images/{operation}',
      authScheme: 'bearer',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['image_generation', 'image_editing']
    },
    {
      kind: 'geminiImageV2',
      protocolId: VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
      mediaKind: 'image',
      adapterKind: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      endpointTemplate:
        'https://api.vidu.cn/ent/v2/image/reference2image/{providerModelKey}',
      authScheme: 'token',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['reference_to_image']
    },
    {
      kind: 'referenceImageV2',
      protocolId: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
      mediaKind: 'image',
      adapterKind: VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
      endpointTemplate: 'https://api.vidu.cn/ent/v2/reference2image',
      authScheme: 'token',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: [
        'reference_to_image',
        'image_generation',
        'image_editing'
      ]
    }
  ];

  const protocolBindings = [...existing];
  const byKind = {} as Record<BindingKind, ProviderProtocolBinding>;
  for (const spec of specs) {
    const found = protocolBindings.find(
      (binding) =>
        binding.connectionId === connectionId &&
        binding.providerId === providerId &&
        binding.protocolId === spec.protocolId &&
        binding.protocolVersion === spec.protocolVersion &&
        binding.adapterKind === spec.adapterKind
    );
    if (found) {
      const purposesMatch =
        found.supportedPurposes.length === spec.supportedPurposes.length &&
        spec.supportedPurposes.every((purpose) =>
          found.supportedPurposes.includes(purpose)
        );
      if (
        found.authScheme !== spec.authScheme ||
        !purposesMatch ||
        found.endpointTemplate !== spec.endpointTemplate ||
        found.executionLifecycle !== spec.executionLifecycle
      ) {
        const upgraded: ProviderProtocolBinding = {
          ...found,
          authScheme: spec.authScheme,
          supportedPurposes: [...spec.supportedPurposes],
          endpointTemplate: spec.endpointTemplate,
          executionLifecycle: spec.executionLifecycle,
          updatedAt: now
        };
        const index = protocolBindings.findIndex((item) => item.id === found.id);
        protocolBindings[index] = upgraded;
        byKind[spec.kind] = upgraded;
      } else {
        byKind[spec.kind] = found;
      }
      continue;
    }
    const created = createProviderProtocolBinding({
      id: toProtocolBindingId(
        `protocol-binding-vidu-${spec.kind}-${connectionId}-${randomUUID()}`
      ),
      providerId,
      connectionId,
      protocolId: spec.protocolId,
      protocolVersion: spec.protocolVersion,
      mediaKind: spec.mediaKind,
      adapterKind: spec.adapterKind,
      endpointTemplate: spec.endpointTemplate,
      authScheme: spec.authScheme,
      executionLifecycle: spec.executionLifecycle,
      supportedPurposes: [...spec.supportedPurposes],
      createdAt: now,
      updatedAt: now
    });
    protocolBindings.push(created);
    byKind[spec.kind] = created;
  }
  return { byKind, protocolBindings };
}

function bindingForModelKey(
  byKind: Record<BindingKind, ProviderProtocolBinding>,
  providerModelKey: FrozenViduModelKey
): ProviderProtocolBinding {
  if ((frozenViduVideoModelKeys as readonly string[]).includes(providerModelKey)) {
    return byKind.referenceVideoV2;
  }
  if (providerModelKey === 'viduimage-2') return byKind.imageV1;
  if (
    (frozenViduOfficialImageModelKeys as readonly string[]).includes(
      providerModelKey
    )
  ) {
    return byKind.referenceImageV2;
  }
  if (
    (frozenViduLegacyGeminiImageModelKeys as readonly string[]).includes(
      providerModelKey
    ) ||
    (frozenViduGeminiImageModelKeys as readonly string[]).includes(providerModelKey)
  ) {
    return byKind.geminiImageV2;
  }
  throw new TypeError(`Unsupported Vidu model key: ${providerModelKey}`);
}

function purposesForModelKey(
  providerModelKey: FrozenViduModelKey
): readonly ProviderOperationPurpose[] {
  if ((frozenViduVideoModelKeys as readonly string[]).includes(providerModelKey)) {
    return ['reference_to_video'];
  }
  if (providerModelKey === 'viduimage-2') {
    return ['image_generation', 'image_editing'];
  }
  // Official reference2image models from Vidu docs.
  if (providerModelKey === 'viduq2') {
    return ['image_generation', 'reference_to_image', 'image_editing'];
  }
  if (providerModelKey === 'viduq1') {
    return ['reference_to_image'];
  }
  return ['reference_to_image'];
}
