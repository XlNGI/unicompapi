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
  type ModelFeatureProfile,
  type ProviderId,
  type ProviderModel,
  type ProviderProtocolBinding
} from '../../../domain';
import type {
  JsonProviderRegistryStore,
  ProviderRegistrySnapshot
} from '../provider-registry';
import {
  createUnicompapiStudioH3VideoModelContract,
  frozenUnicompapiStudioH3ModelKeys,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
  unicompapiStudioH3ProviderPackageDescriptor,
  type FrozenUnicompapiStudioH3ModelKey
} from './unicompapi-studio-h3-contracts';

export interface InstallPackagedUnicompapiStudioH3CatalogInput {
  readonly providerId: string;
  readonly connectionId: string;
  readonly now: IsoTimestamp;
}

export interface InstallPackagedUnicompapiStudioH3CatalogResult {
  readonly count: number;
}

export function applyPackagedUnicompapiStudioH3CatalogInstall(
  snapshot: ProviderRegistrySnapshot,
  input: InstallPackagedUnicompapiStudioH3CatalogInput
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly result: InstallPackagedUnicompapiStudioH3CatalogResult;
} {
  const providerId = toProviderId(input.providerId);
  const connectionId = toConnectionId(input.connectionId);
  const target = snapshot.connections.find((item) => item.id === connectionId);
  if (!target || target.providerId !== providerId) {
    throw new TypeError('UniCompAPI Studio H3 packaged catalog install requires an owned connection');
  }
  if (target.packageId !== UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID) {
    throw new TypeError('UniCompAPI Studio H3 packaged catalog install requires a Studio H3 package connection');
  }

  const siblingIds = snapshot.connections
    .filter(
      (item) =>
        item.packageId === UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID &&
        item.id !== connectionId
    )
    .map((item) => item.id);
  const connectionIds = [connectionId, ...siblingIds];

  let current = snapshot;
  let count = 0;
  for (const id of connectionIds) {
    const connection = current.connections.find((item) => item.id === id);
    if (!connection) continue;
    const installed = applyPackagedUnicompapiStudioH3CatalogInstallForConnection(current, {
      providerId: connection.providerId,
      connectionId: connection.id,
      now: input.now
    });
    current = installed.snapshot;
    if (id === connectionId) count = installed.result.count;
  }
  return { snapshot: current, result: { count } };
}

function applyPackagedUnicompapiStudioH3CatalogInstallForConnection(
  snapshot: ProviderRegistrySnapshot,
  input: InstallPackagedUnicompapiStudioH3CatalogInput
): {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly result: InstallPackagedUnicompapiStudioH3CatalogResult;
} {
  const providerId = toProviderId(input.providerId);
  const connectionId = toConnectionId(input.connectionId);
  const connection = snapshot.connections.find((item) => item.id === connectionId);
  if (!connection || connection.providerId !== providerId) {
    throw new TypeError('UniCompAPI Studio H3 packaged catalog install requires an owned connection');
  }
  if (connection.packageId !== UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID) {
    throw new TypeError('UniCompAPI Studio H3 packaged catalog install requires a Studio H3 package connection');
  }

  let protocolBindings = [...snapshot.protocolBindings];
  const binding = ensureVideoProtocolBinding(
    protocolBindings,
    providerId,
    connectionId,
    endpointTemplateFor(connection.endpoint),
    input.now
  );
  protocolBindings = binding.protocolBindings;

  let models = [...snapshot.models];
  let capabilities = [...snapshot.capabilities];
  let modelDefinitions = [...(snapshot.modelDefinitions ?? [])];
  let modelProfiles = [...(snapshot.modelProfiles ?? [])];

  for (const providerModelKey of frozenUnicompapiStudioH3ModelKeys) {
    const purposes = ['video_generation'] as const;
    let model = models.find(
      (candidate) =>
        candidate.connectionId === connectionId &&
        candidate.providerModelKey === providerModelKey
    );

    if (!model) {
      const modelId = toModelId(
        `model-unicompapi-studio-h3-${connectionId}-${providerModelKey}-${randomUUID()}`
      );
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
        protocolBindingId: binding.video.id,
        providerModelKey,
        mediaKind: 'video',
        revision: 1,
        catalogState: 'present',
        displayName: providerModelKey,
        capabilityEvidenceId: evidence[0]?.id,
        enabled: true,
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
      if (
        model.protocolBindingId !== binding.video.id ||
        model.enabled !== true ||
        model.mediaKind !== 'video'
      ) {
        const updated: ProviderModel = {
          ...model,
          protocolBindingId: binding.video.id,
          mediaKind: 'video',
          catalogState: 'present',
          enabled: true,
          revision: model.revision + 1,
          updatedAt: input.now
        };
        models = models.map((candidate) =>
          candidate.id === model!.id ? updated : candidate
        );
        model = updated;
      }
    }

    const contract = createUnicompapiStudioH3VideoModelContract(providerModelKey);
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
        profileId: `profile-unicompapi-studio-h3-${model.id}-${randomUUID()}`,
        revision: Math.max(1, ...priorRevisions),
        packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
        sourceTemplateId: template.templateId,
        adapterKey: template.adapterKey,
        modelId: model.id,
        modelRevision: nextModelRevision,
        protocolBindingId: model.protocolBindingId,
        status: 'verified',
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
      const nextFeatures = template.features;
      const nextEvidenceIds = capabilities
        .filter((evidence) => evidence.modelId === model!.id)
        .map((evidence) => evidence.id);
      const featuresChanged =
        JSON.stringify(existingProfile.features) !== JSON.stringify(nextFeatures);
      const evidenceChanged =
        JSON.stringify(existingProfile.evidenceIds) !== JSON.stringify(nextEvidenceIds);
      const bindingChanged =
        existingProfile.protocolBindingId !== model.protocolBindingId ||
        existingProfile.adapterKey !== template.adapterKey;
      const modelRevisionChanged = existingProfile.modelRevision !== model.revision;
      const statusChanged = existingProfile.status !== 'verified';
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
                status: 'verified' as const,
                recordedAt: input.now
              }
            : profile
        );
      }
    }
  }

  const requiredAdapterBindings = unicompapiStudioH3ProviderPackageDescriptor.adapters.map(
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
          (candidate) =>
            candidate.adapterId === required.adapterId &&
            candidate.adapterVersion === required.adapterVersion &&
            candidate.protocolId === required.protocolId &&
            candidate.protocolVersion === required.protocolVersion
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
      frozenUnicompapiStudioH3ModelKeys.includes(
        model.providerModelKey as FrozenUnicompapiStudioH3ModelKey
      )
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

export async function installPackagedUnicompapiStudioH3Catalog(
  registry: JsonProviderRegistryStore,
  input: InstallPackagedUnicompapiStudioH3CatalogInput
): Promise<InstallPackagedUnicompapiStudioH3CatalogResult> {
  return registry.mutate((snapshot) =>
    applyPackagedUnicompapiStudioH3CatalogInstall(snapshot, input)
  );
}

function ensureVideoProtocolBinding(
  existing: readonly ProviderProtocolBinding[],
  providerId: ProviderId,
  connectionId: ConnectionId,
  endpointTemplate: string,
  now: IsoTimestamp
): {
  readonly video: ProviderProtocolBinding;
  readonly protocolBindings: ProviderProtocolBinding[];
} {
  const protocolBindings = [...existing];
  const found = protocolBindings.find(
    (binding) =>
      binding.connectionId === connectionId &&
      binding.providerId === providerId &&
      binding.protocolId === UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID &&
      binding.protocolVersion === UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION &&
      binding.adapterKind === UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID
  );
  const supportedPurposes = ['video_generation'] as const;
  if (found) {
    const purposesMatch =
      found.supportedPurposes.length === supportedPurposes.length &&
      supportedPurposes.every((purpose) => found.supportedPurposes.includes(purpose));
    if (
      found.authScheme !== 'bearer' ||
      !purposesMatch ||
      found.endpointTemplate !== endpointTemplate ||
      found.executionLifecycle !== 'asynchronous_polling'
    ) {
      const upgraded: ProviderProtocolBinding = {
        ...found,
        authScheme: 'bearer',
        supportedPurposes: [...supportedPurposes],
        endpointTemplate,
        executionLifecycle: 'asynchronous_polling',
        updatedAt: now
      };
      const index = protocolBindings.findIndex((item) => item.id === found.id);
      protocolBindings[index] = upgraded;
      return { video: upgraded, protocolBindings };
    }
    return { video: found, protocolBindings };
  }
  const created = createProviderProtocolBinding({
    id: toProtocolBindingId(
      `protocol-binding-unicompapi-studio-h3-${connectionId}-${randomUUID()}`
    ),
    providerId,
    connectionId,
    protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
    protocolVersion: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
    mediaKind: 'video',
    adapterKind: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
    endpointTemplate,
    authScheme: 'bearer',
    executionLifecycle: 'asynchronous_polling',
    supportedPurposes: [...supportedPurposes],
    createdAt: now,
    updatedAt: now
  });
  protocolBindings.push(created);
  return { video: created, protocolBindings };
}

function endpointTemplateFor(endpoint: string | undefined): string {
  if (!endpoint) {
    throw new TypeError('UniCompAPI Studio H3 packaged catalog requires a connection endpoint');
  }
  let origin: URL;
  try {
    origin = new URL(endpoint);
  } catch {
    throw new TypeError('UniCompAPI Studio H3 packaged catalog connection endpoint is invalid');
  }
  return `${origin.origin}/studio/h3/v1/videos`;
}
