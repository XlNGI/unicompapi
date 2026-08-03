import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  catalogStates,
  capabilityEvidenceSources,
  capabilityStates,
  cloneVideoGenerationCapabilitySchema,
  connectionStates,
  credentialStates,
  dynamicParameterKinds,
  providerAccessCategories,
  providerAuthSchemes,
  providerExecutionLifecycles,
  providerIdentityStates,
  providerMediaKinds,
  providerOperationPurposes,
  providerTemplateKinds,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProviderId,
  toRoutingPreferenceId,
  modelProfileStatuses,
  parseProductFeature,
  type DynamicParameterSchema,
  type ModelCapabilityEvidence,
  type ModelFeatureProfile,
  type ModelFeatureProfileFeature,
  type ModelFeatureProfileTemplate,
  type ProviderModelDefinition,
  type Provider,
  type ProviderConnection,
  type ProviderConnectionAdapterBinding,
  type ProviderMediaKind,
  type ProviderModel,
  type ProviderOperationPurpose,
  type ProviderProtocolBinding,
  type RoutingPreference,
  type VideoGenerationCapabilitySchema
} from '../../domain';
import type {
  ProviderIpcResult,
  ProviderRegistryDto
} from '../../shared/provider-ipc';
import { sharedFileWriteCoordinator } from '../storage';
import { createFrozenViduRegistryRecords } from './vidu-protocol-catalog';

export interface ProviderRegistrySnapshot {
  readonly schemaVersion: 2;
  readonly registryRevision?: number;
  readonly providers: readonly Provider[];
  readonly connections: readonly ProviderConnection[];
  readonly protocolBindings: readonly ProviderProtocolBinding[];
  readonly models: readonly ProviderModel[];
  readonly capabilities: readonly ModelCapabilityEvidence[];
  readonly routingPreferences: readonly RoutingPreference[];
  readonly modelDefinitions?: readonly ProviderModelDefinition[];
  readonly modelProfiles?: readonly ModelFeatureProfile[];
}

export interface ProviderRegistryMutation<T> {
  readonly snapshot: ProviderRegistrySnapshot;
  readonly result: T;
}

export class ProviderRegistryConflictError extends Error {
  readonly actualRevision: number;

  constructor(actualRevision: number) {
    super('Provider registry changed before the requested update was applied');
    this.name = 'ProviderRegistryConflictError';
    this.actualRevision = actualRevision;
  }
}

interface LegacyProviderModel {
  readonly schemaVersion: 1;
  readonly id: ProviderModel['id'];
  readonly providerId: ProviderModel['providerId'];
  readonly connectionId: ProviderModel['connectionId'];
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly createdAt: ProviderModel['createdAt'];
  readonly updatedAt: ProviderModel['updatedAt'];
}

interface LegacyCapabilityEvidence {
  readonly schemaVersion: 1;
  readonly id: ModelCapabilityEvidence['id'];
  readonly modelId: ModelCapabilityEvidence['modelId'];
  readonly capability: string;
  readonly state: ModelCapabilityEvidence['state'];
  readonly source: ModelCapabilityEvidence['source'];
  readonly constraint?: string;
  readonly parameterSchema?: DynamicParameterSchema;
  readonly videoGenerationSchema?: VideoGenerationCapabilitySchema;
  readonly observedAt?: ModelCapabilityEvidence['observedAt'];
  readonly updatedAt: ModelCapabilityEvidence['recordedAt'];
}

export class JsonProviderRegistryStore {
  constructor(private readonly registryPath: string) {}

  async load(): Promise<ProviderRegistrySnapshot> {
    return (await this.readDisk()) ?? emptySnapshot();
  }

  async loadBackup(): Promise<ProviderRegistrySnapshot | undefined> {
    return this.readDiskAt(`${this.registryPath}.bak`);
  }

  async restoreBackup(): Promise<boolean> {
    return sharedFileWriteCoordinator.runExclusive(this.registryPath, async () => {
      const backup = await this.readDiskAt(`${this.registryPath}.bak`);
      if (!backup) return false;
      const current = await this.readDisk();
      const restored = {
        ...backup,
        registryRevision: Math.max(
          registryRevision(backup),
          current ? registryRevision(current) : 0
        ) + 1
      };
      await writeJsonAtomically(this.registryPath, restored);
      return true;
    });
  }

  async save(snapshot: ProviderRegistrySnapshot): Promise<void> {
    const validated = parseSnapshot(snapshot);
    const expectedRevision = registryRevision(validated);
    await sharedFileWriteCoordinator.runExclusive(this.registryPath, async () => {
      const current = await this.readDisk();
      if (current && registryRevision(current) !== expectedRevision) {
        throw new ProviderRegistryConflictError(registryRevision(current));
      }
      const nextRevision = current
        ? registryRevision(current) + 1
        : expectedRevision;
      await this.write(
        { ...validated, registryRevision: nextRevision },
        current
      );
    });
  }

  async mutate<T>(
    mutator: (
      snapshot: ProviderRegistrySnapshot
    ) => ProviderRegistryMutation<T> | Promise<ProviderRegistryMutation<T>>
  ): Promise<T> {
    return sharedFileWriteCoordinator.runExclusive(this.registryPath, async () => {
      const current = await this.readDisk();
      const base = current ?? emptySnapshot();
      const mutation = await mutator(base);
      const next = parseSnapshot({
        ...mutation.snapshot,
        registryRevision: current
          ? registryRevision(current) + 1
          : registryRevision(base)
      });
      await this.write(next, current);
      return mutation.result;
    });
  }

  async ensureFrozenViduCatalog(): Promise<void> {
    const current = await this.load();
    const next = mergeMissingFrozenViduRecords(current);
    if (next === current) return;
    await this.save(next);
  }

  private async readDisk(): Promise<ProviderRegistrySnapshot | undefined> {
    return this.readDiskAt(this.registryPath);
  }

  private async readDiskAt(
    targetPath: string
  ): Promise<ProviderRegistrySnapshot | undefined> {
    try {
      return parseSnapshot(JSON.parse(await readFile(targetPath, 'utf8')));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(
    snapshot: ProviderRegistrySnapshot,
    current: ProviderRegistrySnapshot | undefined
  ): Promise<void> {
    if (current) assertCapabilityHistoryPreserved(current, snapshot);
    if (current) {
      await writeJsonAtomically(`${this.registryPath}.bak`, current);
    }
    await writeJsonAtomically(this.registryPath, snapshot);
  }
}

async function writeJsonAtomically(targetPath: string, value: unknown): Promise<void> {
  const parent = path.dirname(targetPath);
  const temporary = path.join(
    parent,
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`
  );
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, targetPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function mergeMissingFrozenViduRecords(
  current: ProviderRegistrySnapshot
): ProviderRegistrySnapshot {
  const frozen = createFrozenViduRegistryRecords();
  const frozenProvider = frozen.providers[0];
  const frozenConnection = frozen.connections[0];
  const appendedProviders = appendMissingById(current.providers, frozen.providers);
  const providers = appendedProviders.map((provider) =>
    provider.id === frozenProvider.id && provider.packageId === undefined
      ? {
          ...provider,
          packageId: frozenProvider.packageId,
          packageVersion: frozenProvider.packageVersion
        }
      : provider
  );
  const providerOwned = providers.some(
    (provider) =>
      provider.id === frozenProvider.id &&
      provider.packageId === frozenProvider.packageId &&
      provider.packageVersion === frozenProvider.packageVersion
  );
  const appendedConnections = appendMissingById(
    current.connections,
    frozen.connections
  );
  const connections = appendedConnections.map((connection) =>
    providerOwned &&
    connection.id === frozenConnection.id &&
    connection.packageId === undefined
      ? {
          ...connection,
          endpoint: connection.endpoint ?? frozenConnection.endpoint,
          packageId: frozenConnection.packageId,
          packageVersion: frozenConnection.packageVersion,
          templateId: frozenConnection.templateId,
          templateKind: frozenConnection.templateKind,
          credentialSchemaId: frozenConnection.credentialSchemaId,
          credentialSchemaVersion: frozenConnection.credentialSchemaVersion,
          credentialVersionId: frozenConnection.credentialVersionId,
          connectionPolicyId: frozenConnection.connectionPolicyId,
          connectionPolicyRevision: frozenConnection.connectionPolicyRevision,
          discoveryPolicyId: frozenConnection.discoveryPolicyId,
          discoveryPolicyRevision: frozenConnection.discoveryPolicyRevision,
          endpointPolicyId: frozenConnection.endpointPolicyId,
          endpointPolicyRevision: frozenConnection.endpointPolicyRevision,
          connectionConfigVersionId: frozenConnection.connectionConfigVersionId,
          connectionRevision: frozenConnection.connectionRevision,
          adapterBindings: frozenConnection.adapterBindings
        }
      : connection
  );
  const connectionOwned = connections.some(
    (connection) =>
      connection.id === frozenConnection.id &&
      connection.packageId === frozenConnection.packageId &&
      connection.packageVersion === frozenConnection.packageVersion
  );
  const protocolBindings = appendMissingById(
    current.protocolBindings,
    frozen.protocolBindings
  );
  const capabilities = appendMissingById(
    current.capabilities,
    frozen.capabilities
  );
  const appendedModels = appendMissingById(current.models, frozen.models);
  const frozenModelsById = new Map(
    frozen.models.map((model) => [model.id, model] as const)
  );
  const frozenProfilesByModel = new Map(
    frozen.modelProfiles.map((profile) => [profile.modelId, profile] as const)
  );
  const models = appendedModels.map((model) => {
    const frozenModel = frozenModelsById.get(model.id);
    const frozenProfile = frozenProfilesByModel.get(model.id);
    const binding = protocolBindings.find(
      (candidate) => candidate.id === model.protocolBindingId
    );
    if (
      !providerOwned ||
      !connectionOwned ||
      !frozenModel ||
      !frozenProfile ||
      model.activeProfileId !== undefined ||
      model.providerId !== frozenModel.providerId ||
      model.connectionId !== frozenModel.connectionId ||
      model.providerModelKey !== frozenModel.providerModelKey ||
      binding?.adapterKind !== frozenProfile.adapterKey
    ) {
      return model;
    }
    return {
      ...model,
      activeProfileId: frozenProfile.profileId,
      revision: model.revision + 1,
      updatedAt: toIsoTimestamp(frozenProfile.recordedAt)
    };
  });
  const modelDefinitions = providerOwned
    ? appendMissingByKey(
        current.modelDefinitions ?? [],
        frozen.modelDefinitions,
        (definition) => definition.definitionId
      )
    : current.modelDefinitions ?? [];
  const profileCandidates = connectionOwned
    ? models.flatMap((model) => {
        const frozenProfile = frozenProfilesByModel.get(model.id);
        if (!frozenProfile || model.activeProfileId !== frozenProfile.profileId) {
          return [];
        }
        return [{
          ...frozenProfile,
          modelRevision: model.revision,
          evidenceIds: capabilities
            .filter((evidence) => evidence.modelId === model.id)
            .map((evidence) => evidence.id)
        }];
      })
    : [];
  const modelProfiles = appendMissingByKey(
    current.modelProfiles ?? [],
    profileCandidates,
    (profile) => profile.profileId
  );
  if (
    sameRecordList(providers, current.providers) &&
    sameRecordList(connections, current.connections) &&
    protocolBindings === current.protocolBindings &&
    sameRecordList(models, current.models) &&
    capabilities === current.capabilities &&
    modelDefinitions === (current.modelDefinitions ?? []) &&
    modelProfiles === (current.modelProfiles ?? [])
  ) {
    return current;
  }
  return {
    ...current,
    providers,
    connections,
    protocolBindings,
    models,
    capabilities,
    modelDefinitions,
    modelProfiles
  };
}

function appendMissingById<T extends { readonly id: string }>(
  current: readonly T[],
  frozen: readonly T[]
): readonly T[] {
  const existingIds = new Set(current.map((record) => record.id));
  const missing = frozen.filter((record) => !existingIds.has(record.id));
  return missing.length === 0 ? current : [...current, ...missing];
}

function appendMissingByKey<T>(
  current: readonly T[],
  frozen: readonly T[],
  key: (value: T) => string
): readonly T[] {
  const existing = new Set(current.map(key));
  const missing = frozen.filter((record) => !existing.has(key(record)));
  return missing.length === 0 ? current : [...current, ...missing];
}

function sameRecordList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every(
    (item, index) => item === right[index]
  );
}

export class ProviderRegistryController {
  constructor(private readonly store: JsonProviderRegistryStore) {}

  async getRegistry(): Promise<ProviderIpcResult<ProviderRegistryDto>> {
    try {
      const snapshot = await this.store.load();
      return {
        ok: true,
        value: {
          registryRevision: registryRevision(snapshot),
          providers: snapshot.providers.map((provider) => ({
            providerId: provider.id,
            name: provider.name,
            accessCategory: provider.accessCategory,
            identityState: provider.identityState
          })),
          connections: snapshot.connections.map((connection) => ({
            connectionId: connection.id,
            providerId: connection.providerId,
            name: connection.name,
            state: connection.state,
            identityState: connection.identityState,
            credentialState: connection.credentialState,
            endpointConfigured: connection.endpoint !== undefined,
            lastConnectionValidationAt: connection.lastConnectionValidationAt
          })),
          protocolBindings: snapshot.protocolBindings.map((binding) => ({
            protocolBindingId: binding.id,
            providerId: binding.providerId,
            connectionId: binding.connectionId,
            protocolId: binding.protocolId,
            protocolVersion: binding.protocolVersion,
            mediaKind: binding.mediaKind,
            executionLifecycle: binding.executionLifecycle,
            supportedPurposes: binding.supportedPurposes
          })),
          models: snapshot.models.map((model) => ({
            modelId: model.id,
            providerId: model.providerId,
            connectionId: model.connectionId,
            protocolBindingId: model.protocolBindingId,
            name: model.providerModelKey,
            providerModelKey: model.providerModelKey,
            mediaKind: model.mediaKind,
            revision: model.revision,
            capabilityEvidenceId: model.capabilityEvidenceId,
            activeProfileId: model.activeProfileId,
            catalogState: model.catalogState ?? 'present',
            catalogRevision: model.catalogRevision,
            lastSeenAt: model.lastSeenAt,
            displayName: model.displayName,
            enabled: model.enabled
          })),
          capabilities: snapshot.capabilities.map((capability) => ({
            evidenceId: capability.id,
            modelId: capability.modelId,
            revision: capability.revision,
            capability: capability.capability,
            state: capability.state,
            source: capability.source,
            supersedesEvidenceId: capability.supersedesEvidenceId,
            constraint: capability.constraint,
            parameterSchema: capability.parameterSchema,
            videoGenerationSchema: capability.videoGenerationSchema,
            observedAt: capability.observedAt,
            recordedAt: capability.recordedAt
          })),
          routingPreferences: snapshot.routingPreferences.map((preference) => ({
            preferenceId: preference.id,
            purpose: preference.purpose,
            modelId: preference.modelId,
            priority: preference.priority,
            enabled: preference.enabled
          }))
        }
      };
    } catch {
      return {
        ok: false,
        error: {
          code: 'provider_registry_failed',
          message: 'The local provider registry could not be loaded'
        }
      };
    }
  }
}

function emptySnapshot(): ProviderRegistrySnapshot {
  const vidu = createFrozenViduRegistryRecords();
  return {
    schemaVersion: 2,
    registryRevision: 1,
    providers: vidu.providers,
    connections: vidu.connections,
    protocolBindings: vidu.protocolBindings,
    models: vidu.models,
    capabilities: vidu.capabilities,
    routingPreferences: [],
    modelDefinitions: [],
    modelProfiles: []
  };
}

export function migrateProviderRegistrySnapshot(value: unknown): unknown {
  if (!isRecord(value) || value.schemaVersion !== 1) return value;
  if (
    !Array.isArray(value.providers) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.routingPreferences)
  ) {
    throw new TypeError('Provider registry has an unsupported schema');
  }

  const providers = value.providers.map(parseProvider);
  const connections = value.connections.map(parseConnection);
  const legacyModels = value.models.map(parseLegacyModel);
  const legacyCapabilities = value.capabilities.map(parseLegacyCapability);
  const routingPreferences = value.routingPreferences.map(parseRouting);
  const migratedCapabilities = migrateLegacyCapabilities(legacyCapabilities);
  const protocolBindings = legacyModels.map((model) => {
    const purposes = purposesForLegacyModel(
      model.id,
      legacyCapabilities,
      routingPreferences
    );
    return {
      schemaVersion: 1 as const,
      id: toProtocolBindingId(`protocol-binding-legacy-${model.id}`),
      providerId: model.providerId,
      connectionId: model.connectionId,
      protocolId: 'legacy.unclassified',
      protocolVersion: '1',
      mediaKind: mediaKindForPurposes(purposes),
      adapterKind: 'legacy_unavailable',
      authScheme: 'unknown' as const,
      executionLifecycle: 'unknown' as const,
      supportedPurposes: purposes,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt
    };
  });
  const bindingsByModel = new Map(
    legacyModels.map((model, index) => [model.id, protocolBindings[index]])
  );
  const models = legacyModels.map((model) => {
    const binding = bindingsByModel.get(model.id);
    if (!binding) throw new TypeError('Legacy model binding is missing');
    const latestEvidence = migratedCapabilities
      .filter((evidence) => evidence.modelId === model.id)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
    return {
      schemaVersion: 2 as const,
      id: model.id,
      providerId: model.providerId,
      connectionId: model.connectionId,
      protocolBindingId: binding.id,
      providerModelKey: model.name,
      mediaKind: binding.mediaKind,
      revision: 1,
      displayName: model.displayName,
      capabilityEvidenceId: latestEvidence?.id,
      enabled: model.enabled,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt
    };
  });

  return {
    schemaVersion: 2,
    registryRevision: 1,
    providers,
    connections,
    protocolBindings,
    models,
    capabilities: migratedCapabilities,
    routingPreferences,
    modelDefinitions: [],
    modelProfiles: []
  };
}

function parseSnapshot(value: unknown): ProviderRegistrySnapshot {
  const migrated = migrateProviderRegistrySnapshot(value);
  if (
    !isRecord(migrated) ||
    migrated.schemaVersion !== 2 ||
    !Array.isArray(migrated.providers) ||
    !Array.isArray(migrated.connections) ||
    !Array.isArray(migrated.protocolBindings) ||
    !Array.isArray(migrated.models) ||
    !Array.isArray(migrated.capabilities) ||
    !Array.isArray(migrated.routingPreferences)
  ) {
    throw new TypeError('Provider registry has an unsupported schema');
  }

  const providers = migrated.providers.map(parseProvider);
  const connections = migrated.connections.map(parseConnection);
  const protocolBindings = migrated.protocolBindings.map(parseProtocolBinding);
  const models = migrated.models.map(parseModel);
  const capabilities = migrated.capabilities.map(parseCapability);
  const routingPreferences = migrated.routingPreferences.map(parseRouting);
  const modelDefinitions = Array.isArray(migrated.modelDefinitions)
    ? migrated.modelDefinitions.map(parseModelDefinition)
    : [];
  const modelProfiles = Array.isArray(migrated.modelProfiles)
    ? migrated.modelProfiles.map(parseModelProfile)
    : [];
  const revision = parseRegistryRevision(migrated.registryRevision);

  assertUnique(providers.map((item) => item.id), 'provider');
  assertUnique(connections.map((item) => item.id), 'connection');
  assertUnique(protocolBindings.map((item) => item.id), 'protocol binding');
  assertUnique(models.map((item) => item.id), 'model');
  assertUnique(capabilities.map((item) => item.id), 'capability evidence');
  assertUnique(routingPreferences.map((item) => item.id), 'routing preference');
  assertUnique(
    modelDefinitions.map((item) => item.definitionId),
    'model definition'
  );
  assertUnique(
    modelDefinitions.flatMap((definition) =>
      definition.profileTemplates.map(
        (template) => `${definition.packageId}:${template.templateId}`
      )
    ),
    'package profile template'
  );
  assertUnique(modelProfiles.map((item) => item.profileId), 'model profile');
  assertUnique(
    connections.flatMap((item) =>
      item.connectionConfigVersionId ? [item.connectionConfigVersionId] : []
    ),
    'connection config version'
  );
  assertUnique(
    connections.flatMap((item) =>
      item.credentialVersionId ? [item.credentialVersionId] : []
    ),
    'credential version'
  );

  const providersById = new Map(providers.map((item) => [item.id, item]));
  const connectionsById = new Map(connections.map((item) => [item.id, item]));
  const bindingsById = new Map(protocolBindings.map((item) => [item.id, item]));
  const modelsById = new Map(models.map((item) => [item.id, item]));
  const capabilitiesById = new Map(capabilities.map((item) => [item.id, item]));
  const profilesById = new Map(modelProfiles.map((item) => [item.profileId, item]));

  if (
    connections.some((item) => {
      const provider = providersById.get(item.providerId);
      return (
        !provider ||
        (item.packageId !== undefined &&
          (provider.packageId !== item.packageId ||
            provider.packageVersion !== item.packageVersion))
      );
    }) ||
    protocolBindings.some((item) => {
      const connection = connectionsById.get(item.connectionId);
      return (
        !providersById.has(item.providerId) ||
        !connection ||
        connection.providerId !== item.providerId
      );
    }) ||
    models.some((item) => {
      const binding = bindingsById.get(item.protocolBindingId);
      return (
        !providersById.has(item.providerId) ||
        !connectionsById.has(item.connectionId) ||
        !binding ||
        binding.providerId !== item.providerId ||
        binding.connectionId !== item.connectionId ||
        binding.mediaKind !== item.mediaKind
      );
    }) ||
    capabilities.some((item) => !modelsById.has(item.modelId)) ||
    routingPreferences.some((item) => !modelsById.has(item.modelId)) ||
    modelProfiles.some((profile) => {
      const model = modelsById.get(profile.modelId as ProviderModel['id']);
      const provider = model ? providersById.get(model.providerId) : undefined;
      const binding = model
        ? bindingsById.get(model.protocolBindingId)
        : undefined;
      const definition = modelDefinitions.find(
        (candidate) =>
          candidate.packageId === profile.packageId &&
          candidate.providerModelKey === model?.providerModelKey &&
          candidate.profileTemplates.some(
            (template) => template.templateId === profile.sourceTemplateId
          )
      );
      const template = definition?.profileTemplates.find(
        (candidate) => candidate.templateId === profile.sourceTemplateId
      );
      return (
        !model ||
        model.protocolBindingId !== profile.protocolBindingId ||
        profile.modelRevision > model.revision ||
        !provider ||
        provider.packageId !== profile.packageId ||
        !binding ||
        binding.adapterKind !== profile.adapterKey ||
        !definition ||
        !template ||
        template.adapterKey !== profile.adapterKey ||
        template.protocolDefinitionId !== binding.protocolId ||
        profile.evidenceIds.some((evidenceId) => {
          const evidence = capabilitiesById.get(toCapabilityEvidenceId(evidenceId));
          return !evidence || evidence.modelId !== model.id;
        })
      );
    })
  ) {
    throw new TypeError('Provider registry contains invalid references');
  }

  for (const model of models) {
    if (!model.capabilityEvidenceId) continue;
    const evidence = capabilitiesById.get(model.capabilityEvidenceId);
    if (!evidence || evidence.modelId !== model.id) {
      throw new TypeError('Provider model capability pointer is invalid');
    }
  }
  for (const model of models) {
    if (!model.activeProfileId) continue;
    const profile = profilesById.get(model.activeProfileId);
    if (!profile || profile.modelId !== model.id) {
      throw new TypeError('Provider model profile pointer is invalid');
    }
  }
  validateCapabilityHistory(capabilities, capabilitiesById);

  return {
    schemaVersion: 2,
    registryRevision: revision,
    providers,
    connections,
    protocolBindings,
    models,
    capabilities,
    routingPreferences,
    modelDefinitions,
    modelProfiles
  };
}

function parseProvider(value: unknown): Provider {
  const item = requireRecord(value);
  requireVersionAndName(item);
  requireOneOf(item.accessCategory, providerAccessCategories);
  requireOneOf(item.identityState, providerIdentityStates);
  const packageId = optionalStableString(item.packageId);
  const packageVersion = optionalVersionString(item.packageVersion);
  if ((packageId === undefined) !== (packageVersion === undefined)) {
    throw new TypeError('Provider package ownership is incomplete');
  }
  return {
    schemaVersion: 1,
    id: toProviderId(String(item.id)),
    name: String(item.name),
    packageId,
    packageVersion,
    accessCategory: item.accessCategory as Provider['accessCategory'],
    identityState: item.identityState as Provider['identityState'],
    createdAt: toIsoTimestamp(String(item.createdAt)),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function parseConnection(value: unknown): ProviderConnection {
  const item = requireRecord(value);
  requireVersionAndName(item);
  requireOneOf(item.state, connectionStates);
  requireOneOf(item.identityState, providerIdentityStates);
  requireOneOf(item.credentialState, credentialStates);
  const packageFields = parseConnectionPackageFields(item);
  return {
    schemaVersion: 1,
    id: toConnectionId(String(item.id)),
    providerId: toProviderId(String(item.providerId)),
    name: String(item.name),
    endpoint: optionalString(item.endpoint),
    ...packageFields,
    state: item.state as ProviderConnection['state'],
    identityState: item.identityState as ProviderConnection['identityState'],
    credentialState: item.credentialState as ProviderConnection['credentialState'],
    credentialReference: optionalString(item.credentialReference),
    lastConnectionValidationAt: optionalTimestamp(
      item.lastConnectionValidationAt
    ),
    createdAt: toIsoTimestamp(String(item.createdAt)),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function parseConnectionPackageFields(
  item: Record<string, unknown>
): Partial<ProviderConnection> {
  const fieldNames = [
    'packageId',
    'packageVersion',
    'templateId',
    'templateKind',
    'credentialSchemaId',
    'credentialSchemaVersion',
    'credentialVersionId',
    'connectionPolicyId',
    'connectionPolicyRevision',
    'discoveryPolicyId',
    'discoveryPolicyRevision',
    'endpointPolicyId',
    'endpointPolicyRevision',
    'connectionConfigVersionId',
    'connectionRevision',
    'adapterBindings'
  ] as const;
  const present = fieldNames.filter((field) => item[field] !== undefined);
  if (present.length === 0) return {};
  if (present.length !== fieldNames.length) {
    throw new TypeError('Provider connection package binding is incomplete');
  }
  requireOneOf(item.templateKind, providerTemplateKinds);
  if (!Array.isArray(item.adapterBindings) || item.adapterBindings.length === 0) {
    throw new TypeError('Provider connection adapter bindings are invalid');
  }
  const adapterBindings = item.adapterBindings.map(parseConnectionAdapterBinding);
  assertUnique(
    adapterBindings.map(
      (binding) => `${binding.adapterId}@${binding.adapterVersion}`
    ),
    'connection adapter binding'
  );
  return {
    packageId: requireStableString(item.packageId),
    packageVersion: requireVersionString(item.packageVersion),
    templateId: requireStableString(item.templateId),
    templateKind: item.templateKind as ProviderConnection['templateKind'],
    credentialSchemaId: requireStableString(item.credentialSchemaId),
    credentialSchemaVersion: requirePositiveIntegerValue(
      item.credentialSchemaVersion
    ),
    credentialVersionId: requireStableString(item.credentialVersionId),
    connectionPolicyId: requireStableString(item.connectionPolicyId),
    connectionPolicyRevision: requirePositiveIntegerValue(
      item.connectionPolicyRevision
    ),
    discoveryPolicyId: requireStableString(item.discoveryPolicyId),
    discoveryPolicyRevision: requirePositiveIntegerValue(
      item.discoveryPolicyRevision
    ),
    endpointPolicyId: requireStableString(item.endpointPolicyId),
    endpointPolicyRevision: requirePositiveIntegerValue(
      item.endpointPolicyRevision
    ),
    connectionConfigVersionId: requireStableString(
      item.connectionConfigVersionId
    ),
    connectionRevision: requirePositiveIntegerValue(item.connectionRevision),
    adapterBindings
  };
}

function parseConnectionAdapterBinding(
  value: unknown
): ProviderConnectionAdapterBinding {
  const item = requireRecord(value);
  return {
    adapterId: requireStableString(item.adapterId),
    adapterVersion: requireVersionString(item.adapterVersion),
    protocolId: requireStableString(item.protocolId),
    protocolVersion: requireVersionString(item.protocolVersion)
  };
}

function parseProtocolBinding(value: unknown): ProviderProtocolBinding {
  const item = requireRecord(value);
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.supportedPurposes)
  ) {
    throw new TypeError('Provider protocol binding is invalid');
  }
  requireOneOf(item.mediaKind, providerMediaKinds);
  requireOneOf(item.authScheme, providerAuthSchemes);
  requireOneOf(item.executionLifecycle, providerExecutionLifecycles);
  const supportedPurposes = item.supportedPurposes.map((purpose) => {
    requireOneOf(purpose, providerOperationPurposes);
    return purpose as ProviderOperationPurpose;
  });
  if (new Set(supportedPurposes).size !== supportedPurposes.length) {
    throw new TypeError('Provider protocol purposes are duplicated');
  }
  return {
    schemaVersion: 1,
    id: toProtocolBindingId(String(item.id)),
    providerId: toProviderId(String(item.providerId)),
    connectionId: toConnectionId(String(item.connectionId)),
    protocolId: requireNonBlankString(item.protocolId),
    protocolVersion: requireNonBlankString(item.protocolVersion),
    mediaKind: item.mediaKind as ProviderProtocolBinding['mediaKind'],
    adapterKind: requireNonBlankString(item.adapterKind),
    endpointTemplate: optionalString(item.endpointTemplate),
    authScheme: item.authScheme as ProviderProtocolBinding['authScheme'],
    executionLifecycle:
      item.executionLifecycle as ProviderProtocolBinding['executionLifecycle'],
    supportedPurposes,
    createdAt: toIsoTimestamp(String(item.createdAt)),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function parseModel(value: unknown): ProviderModel {
  const item = requireRecord(value);
  if (
    item.schemaVersion !== 2 ||
    typeof item.displayName !== 'string' ||
    item.displayName.trim().length === 0 ||
    typeof item.enabled !== 'boolean' ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 1
  ) {
    throw new TypeError('Provider model is invalid');
  }
  requireOneOf(item.mediaKind, providerMediaKinds);
  return {
    schemaVersion: 2,
    id: toModelId(String(item.id)),
    providerId: toProviderId(String(item.providerId)),
    connectionId: toConnectionId(String(item.connectionId)),
    protocolBindingId: toProtocolBindingId(String(item.protocolBindingId)),
    providerModelKey: requireNonBlankString(item.providerModelKey),
    mediaKind: item.mediaKind as ProviderModel['mediaKind'],
    revision: Number(item.revision),
    displayName: item.displayName,
    capabilityEvidenceId:
      item.capabilityEvidenceId === undefined
        ? undefined
        : toCapabilityEvidenceId(String(item.capabilityEvidenceId)),
    activeProfileId:
      item.activeProfileId === undefined
        ? undefined
        : requireStableString(item.activeProfileId),
    catalogState:
      item.catalogState === undefined
        ? 'present'
        : parseCatalogState(item.catalogState),
    catalogRevision:
      item.catalogRevision === undefined
        ? undefined
        : requirePositiveIntegerValue(item.catalogRevision),
    lastSeenAt: optionalTimestamp(item.lastSeenAt),
    enabled: item.enabled,
    createdAt: toIsoTimestamp(String(item.createdAt)),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function parseModelDefinition(value: unknown): ProviderModelDefinition {
  const item = requireRecord(value);
  if (item.schemaVersion !== 1 || !Array.isArray(item.profileTemplates)) {
    throw new TypeError('Provider model definition is invalid');
  }
  const profileTemplates = item.profileTemplates.map(parseProfileTemplate);
  assertUnique(
    profileTemplates.map((template) => template.templateId),
    'model profile template'
  );
  return {
    schemaVersion: 1,
    definitionId: requireStableString(item.definitionId),
    packageId: requireStableString(item.packageId),
    packageVersion: requireVersionString(item.packageVersion),
    providerModelKey: requireNonBlankString(item.providerModelKey),
    profileTemplates
  };
}

function parseProfileTemplate(value: unknown): ModelFeatureProfileTemplate {
  const item = requireRecord(value);
  if (
    !Array.isArray(item.features) ||
    typeof item.adapterKey !== 'string' ||
    typeof item.protocolDefinitionId !== 'string' ||
    typeof item.sourceDocumentRevision !== 'string'
  ) {
    throw new TypeError('Model profile template is invalid');
  }
  const features = item.features.map(parseProfileFeature);
  assertUnique(
    features.map((feature) => feature.productFeature),
    'model profile feature'
  );
  return {
    templateId: requireStableString(item.templateId),
    adapterKey: requireStableString(item.adapterKey),
    protocolDefinitionId: requireStableString(item.protocolDefinitionId),
    features,
    sourceDocumentRevision: requireNonBlankString(item.sourceDocumentRevision)
  };
}

function parseProfileFeature(value: unknown): ModelFeatureProfileFeature {
  const item = requireRecord(value);
  return {
    productFeature: parseProductFeature(item.productFeature),
    internalPurpose:
      item.internalPurpose === undefined
        ? undefined
        : requireNonBlankString(item.internalPurpose),
    parameterSchemaId: requireStableString(item.parameterSchemaId),
    resultSchemaId: requireStableString(item.resultSchemaId),
    usageSchemaId: requireStableString(item.usageSchemaId),
    constraintSetId: requireStableString(item.constraintSetId)
  };
}

function parseModelProfile(value: unknown): ModelFeatureProfile {
  const item = requireRecord(value);
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 1 ||
    !Number.isSafeInteger(item.modelRevision) ||
    Number(item.modelRevision) < 1 ||
    !Array.isArray(item.features) ||
    !Array.isArray(item.evidenceIds)
  ) {
    throw new TypeError('Model feature profile is invalid');
  }
  requireOneOf(item.status, modelProfileStatuses);
  const features = item.features.map(parseProfileFeature);
  assertUnique(
    features.map((feature) => feature.productFeature),
    'model profile feature'
  );
  const evidenceIds = item.evidenceIds.map((evidenceId) =>
    toCapabilityEvidenceId(String(evidenceId))
  );
  assertUnique(evidenceIds, 'model profile evidence');
  return {
    schemaVersion: 1,
    profileId: requireStableString(item.profileId),
    revision: Number(item.revision),
    packageId: requireStableString(item.packageId),
    sourceTemplateId: requireStableString(item.sourceTemplateId),
    adapterKey: requireStableString(item.adapterKey),
    modelId: requireStableString(item.modelId),
    modelRevision: Number(item.modelRevision),
    protocolBindingId: requireStableString(item.protocolBindingId),
    status: item.status as ModelFeatureProfile['status'],
    features,
    evidenceIds,
    recordedAt: toIsoTimestamp(String(item.recordedAt))
  };
}

function parseLegacyModel(value: unknown): LegacyProviderModel {
  const item = requireRecord(value);
  requireVersionAndName(item);
  if (typeof item.displayName !== 'string' || typeof item.enabled !== 'boolean') {
    throw new TypeError('Provider model is invalid');
  }
  return {
    schemaVersion: 1,
    id: toModelId(String(item.id)),
    providerId: toProviderId(String(item.providerId)),
    connectionId: toConnectionId(String(item.connectionId)),
    name: String(item.name),
    displayName: item.displayName,
    enabled: item.enabled,
    createdAt: toIsoTimestamp(String(item.createdAt)),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function parseCapability(value: unknown): ModelCapabilityEvidence {
  const item = requireRecord(value);
  if (
    item.schemaVersion !== 2 ||
    typeof item.capability !== 'string' ||
    item.capability.trim().length === 0 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 1
  ) {
    throw new TypeError('Capability evidence is invalid');
  }
  requireOneOf(item.state, capabilityStates);
  requireOneOf(item.source, capabilityEvidenceSources);
  return {
    schemaVersion: 2,
    id: toCapabilityEvidenceId(String(item.id)),
    modelId: toModelId(String(item.modelId)),
    revision: Number(item.revision),
    capability: item.capability,
    state: item.state as ModelCapabilityEvidence['state'],
    source: item.source as ModelCapabilityEvidence['source'],
    supersedesEvidenceId:
      item.supersedesEvidenceId === undefined
        ? undefined
        : toCapabilityEvidenceId(String(item.supersedesEvidenceId)),
    constraint: optionalString(item.constraint),
    parameterSchema: parseParameterSchema(item.parameterSchema),
    videoGenerationSchema: parseVideoGenerationSchema(
      item.videoGenerationSchema
    ),
    observedAt: optionalTimestamp(item.observedAt),
    recordedAt: toIsoTimestamp(String(item.recordedAt))
  };
}

function parseLegacyCapability(value: unknown): LegacyCapabilityEvidence {
  const item = requireRecord(value);
  if (
    item.schemaVersion !== 1 ||
    typeof item.capability !== 'string' ||
    item.capability.trim().length === 0
  ) {
    throw new TypeError('Capability evidence is invalid');
  }
  requireOneOf(item.state, capabilityStates);
  requireOneOf(item.source, capabilityEvidenceSources);
  return {
    schemaVersion: 1,
    id: toCapabilityEvidenceId(String(item.id)),
    modelId: toModelId(String(item.modelId)),
    capability: item.capability,
    state: item.state as LegacyCapabilityEvidence['state'],
    source: item.source as LegacyCapabilityEvidence['source'],
    constraint: optionalString(item.constraint),
    parameterSchema: parseParameterSchema(item.parameterSchema),
    videoGenerationSchema: parseVideoGenerationSchema(
      item.videoGenerationSchema
    ),
    observedAt: optionalTimestamp(item.observedAt),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function migrateLegacyCapabilities(
  legacy: readonly LegacyCapabilityEvidence[]
): readonly ModelCapabilityEvidence[] {
  const groups = new Map<string, LegacyCapabilityEvidence[]>();
  for (const evidence of legacy) {
    const key = evidenceHistoryKey(evidence);
    const group = groups.get(key) ?? [];
    group.push(evidence);
    groups.set(key, group);
  }
  const migrated: ModelCapabilityEvidence[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.id.localeCompare(right.id)
    );
    ordered.forEach((evidence, index) => {
      migrated.push({
        schemaVersion: 2,
        id: evidence.id,
        modelId: evidence.modelId,
        revision: index + 1,
        capability: evidence.capability,
        state: evidence.state,
        source: evidence.source,
        supersedesEvidenceId: index > 0 ? ordered[index - 1].id : undefined,
        constraint: evidence.constraint,
        parameterSchema: evidence.parameterSchema,
        videoGenerationSchema: evidence.videoGenerationSchema,
        observedAt: evidence.observedAt,
        recordedAt: evidence.updatedAt
      });
    });
  }
  return migrated;
}

function parseVideoGenerationSchema(
  value: unknown
): VideoGenerationCapabilitySchema | undefined {
  if (value === undefined) return undefined;
  try {
    return cloneVideoGenerationCapabilitySchema(
      value as VideoGenerationCapabilitySchema
    );
  } catch {
    throw new TypeError('Video generation capability schema is invalid');
  }
}

function parseParameterSchema(value: unknown): DynamicParameterSchema | undefined {
  if (value === undefined) return undefined;
  const item = requireRecord(value);
  if (item.schemaVersion !== 1 || !Array.isArray(item.fields)) {
    throw new TypeError('Capability parameter schema is invalid');
  }
  const keys = new Set<string>();
  const fields = item.fields.map((fieldValue) => {
    const field = requireRecord(fieldValue);
    const key = optionalString(field.key);
    const label = optionalString(field.label);
    if (
      !key ||
      !label ||
      typeof field.kind !== 'string' ||
      !dynamicParameterKinds.includes(
        field.kind as (typeof dynamicParameterKinds)[number]
      ) ||
      typeof field.required !== 'boolean' ||
      keys.has(key)
    ) {
      throw new TypeError('Capability parameter field is invalid');
    }
    keys.add(key);
    const options = parseParameterOptions(field.options);
    const minimum = optionalFiniteNumber(field.minimum);
    const maximum = optionalFiniteNumber(field.maximum);
    if (
      minimum !== undefined &&
      maximum !== undefined &&
      minimum > maximum
    ) {
      throw new TypeError('Capability parameter range is invalid');
    }
    if ((field.kind === 'enum') !== (options !== undefined)) {
      throw new TypeError('Enum parameter options are invalid');
    }
    return {
      key,
      label,
      kind: field.kind as (typeof dynamicParameterKinds)[number],
      required: field.required,
      options,
      minimum,
      maximum
    };
  });
  return { schemaVersion: 1, fields };
}

function parseParameterOptions(
  value: unknown
): readonly (string | number | boolean)[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (option) =>
        typeof option === 'string' ||
        typeof option === 'boolean' ||
        (typeof option === 'number' && Number.isFinite(option))
    )
  ) {
    throw new TypeError('Capability parameter options are invalid');
  }
  return [...value] as readonly (string | number | boolean)[];
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Capability parameter bound is invalid');
  }
  return value;
}

function parseRouting(value: unknown): RoutingPreference {
  const item = requireRecord(value);
  if (
    item.schemaVersion !== 1 ||
    typeof item.purpose !== 'string' ||
    item.purpose.trim().length === 0 ||
    !Number.isSafeInteger(item.priority) ||
    Number(item.priority) < 0 ||
    typeof item.enabled !== 'boolean'
  ) {
    throw new TypeError('Routing preference is invalid');
  }
  return {
    schemaVersion: 1,
    id: toRoutingPreferenceId(String(item.id)),
    purpose: item.purpose,
    modelId: toModelId(String(item.modelId)),
    priority: Number(item.priority),
    enabled: item.enabled,
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
}

function purposesForLegacyModel(
  modelId: ProviderModel['id'],
  capabilities: readonly LegacyCapabilityEvidence[],
  routingPreferences: readonly RoutingPreference[]
): readonly ProviderOperationPurpose[] {
  const purposes = new Set<ProviderOperationPurpose>();
  for (const value of [
    ...capabilities
      .filter((item) => item.modelId === modelId)
      .map((item) => item.capability),
    ...routingPreferences
      .filter((item) => item.modelId === modelId)
      .map((item) => item.purpose)
  ]) {
    if (
      providerOperationPurposes.includes(value as ProviderOperationPurpose)
    ) {
      purposes.add(value as ProviderOperationPurpose);
    }
  }
  return [...purposes];
}

function mediaKindForPurposes(
  purposes: readonly ProviderOperationPurpose[]
): ProviderMediaKind {
  const hasImage = purposes.some(
    (purpose) => purpose.includes('image') || purpose === 'reference_to_image'
  );
  const hasVideo = purposes.some(
    (purpose) => purpose.includes('video') || purpose === 'reference_to_video'
  );
  if (hasImage === hasVideo) return 'unknown';
  return hasImage ? 'image' : 'video';
}

function validateCapabilityHistory(
  capabilities: readonly ModelCapabilityEvidence[],
  byId: ReadonlyMap<ModelCapabilityEvidence['id'], ModelCapabilityEvidence>
): void {
  const revisionsByKey = new Map<string, Set<number>>();
  for (const evidence of capabilities) {
    const key = evidenceHistoryKey(evidence);
    const revisions = revisionsByKey.get(key) ?? new Set<number>();
    if (revisions.has(evidence.revision)) {
      throw new TypeError('Capability evidence revision is duplicated');
    }
    revisions.add(evidence.revision);
    revisionsByKey.set(key, revisions);
    if (!evidence.supersedesEvidenceId) continue;
    const previous = byId.get(evidence.supersedesEvidenceId);
    if (
      !previous ||
      evidenceHistoryKey(previous) !== key ||
      previous.revision >= evidence.revision
    ) {
      throw new TypeError('Capability evidence history link is invalid');
    }
  }
}

function assertCapabilityHistoryPreserved(
  current: ProviderRegistrySnapshot,
  next: ProviderRegistrySnapshot
): void {
  const nextById = new Map(next.capabilities.map((item) => [item.id, item]));
  for (const evidence of current.capabilities) {
    const retained = nextById.get(evidence.id);
    if (!retained || JSON.stringify(retained) !== JSON.stringify(evidence)) {
      throw new TypeError('Capability evidence history is immutable');
    }
  }
}

function evidenceHistoryKey(value: {
  readonly modelId: ProviderModel['id'];
  readonly capability: string;
  readonly source: ModelCapabilityEvidence['source'];
}): string {
  return `${value.modelId}\u0000${value.capability}\u0000${value.source}`;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Provider registry contains duplicate ${label} IDs`);
  }
}

function registryRevision(value: ProviderRegistrySnapshot): number {
  return value.registryRevision ?? 1;
}

function parseRegistryRevision(value: unknown): number {
  if (value === undefined) return 1;
  return requirePositiveIntegerValue(value);
}

function parseCatalogState(
  value: unknown
): NonNullable<ProviderModel['catalogState']> {
  requireOneOf(value, catalogStates);
  return value as NonNullable<ProviderModel['catalogState']>;
}

function requireVersionAndName(item: Record<string, unknown>): void {
  if (
    item.schemaVersion !== 1 ||
    typeof item.name !== 'string' ||
    item.name.trim().length === 0
  ) {
    throw new TypeError('Provider registry entity is invalid');
  }
}

function requireOneOf(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError('Provider registry state is invalid');
  }
}

function requireNonBlankString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Provider registry string is invalid');
  }
  return value;
}

function requireStableString(value: unknown): string {
  const normalized = requireNonBlankString(value);
  if (
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
  ) {
    throw new TypeError('Provider registry identifier is invalid');
  }
  return normalized;
}

function optionalStableString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireStableString(value);
}

function requireVersionString(value: unknown): string {
  const normalized = requireNonBlankString(value);
  if (normalized.length > 200) {
    throw new TypeError('Provider registry version is invalid');
  }
  return normalized;
}

function optionalVersionString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireVersionString(value);
}

function requirePositiveIntegerValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError('Provider registry revision is invalid');
  }
  return Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireNonBlankString(value);
}

function optionalTimestamp(value: unknown) {
  return value === undefined ? undefined : toIsoTimestamp(String(value));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Provider registry item is invalid');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
