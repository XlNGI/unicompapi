import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  capabilityEvidenceSources,
  capabilityStates,
  cloneVideoGenerationCapabilitySchema,
  dynamicParameterKinds,
  connectionStates,
  credentialStates,
  providerAccessCategories,
  providerIdentityStates,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProviderId,
  toRoutingPreferenceId,
  type ModelCapabilityEvidence,
  type DynamicParameterSchema,
  type Provider,
  type ProviderConnection,
  type ProviderModel,
  type RoutingPreference,
  type VideoGenerationCapabilitySchema
} from '../../domain';
import type {
  ProviderIpcResult,
  ProviderRegistryDto
} from '../../shared/provider-ipc';

export interface ProviderRegistrySnapshot {
  readonly schemaVersion: 1;
  readonly providers: readonly Provider[];
  readonly connections: readonly ProviderConnection[];
  readonly models: readonly ProviderModel[];
  readonly capabilities: readonly ModelCapabilityEvidence[];
  readonly routingPreferences: readonly RoutingPreference[];
}

export class JsonProviderRegistryStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly registryPath: string) {}

  async load(): Promise<ProviderRegistrySnapshot> {
    await this.writeQueue;
    try {
      return parseSnapshot(JSON.parse(await readFile(this.registryPath, 'utf8')));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return emptySnapshot();
      throw error;
    }
  }

  async save(snapshot: ProviderRegistrySnapshot): Promise<void> {
    const validated = parseSnapshot(snapshot);
    const operation = this.writeQueue.then(() => this.write(validated));
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async write(snapshot: ProviderRegistrySnapshot): Promise<void> {
    const parent = path.dirname(this.registryPath);
    const temporary = path.join(
      parent,
      `.${path.basename(this.registryPath)}.${randomUUID()}.tmp`
    );
    await mkdir(parent, { recursive: true });
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.registryPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class ProviderRegistryController {
  constructor(private readonly store: JsonProviderRegistryStore) {}

  async getRegistry(): Promise<ProviderIpcResult<ProviderRegistryDto>> {
    try {
      const snapshot = await this.store.load();
      return {
        ok: true,
        value: {
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
          models: snapshot.models.map((model) => ({
            modelId: model.id,
            providerId: model.providerId,
            connectionId: model.connectionId,
            name: model.name,
            displayName: model.displayName,
            enabled: model.enabled
          })),
          capabilities: snapshot.capabilities.map((capability) => ({
            evidenceId: capability.id,
            modelId: capability.modelId,
            capability: capability.capability,
            state: capability.state,
            source: capability.source,
            constraint: capability.constraint,
            parameterSchema: capability.parameterSchema,
            videoGenerationSchema: capability.videoGenerationSchema,
            observedAt: capability.observedAt
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
  return {
    schemaVersion: 1,
    providers: [],
    connections: [],
    models: [],
    capabilities: [],
    routingPreferences: []
  };
}

function parseSnapshot(value: unknown): ProviderRegistrySnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
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
  const models = value.models.map(parseModel);
  const capabilities = value.capabilities.map(parseCapability);
  const routingPreferences = value.routingPreferences.map(parseRouting);
  const providerIds = new Set(providers.map((item) => item.id));
  const connectionIds = new Set(connections.map((item) => item.id));
  const modelIds = new Set(models.map((item) => item.id));

  if (
    connections.some((item) => !providerIds.has(item.providerId)) ||
    models.some(
      (item) =>
        !providerIds.has(item.providerId) || !connectionIds.has(item.connectionId)
    ) ||
    capabilities.some((item) => !modelIds.has(item.modelId)) ||
    routingPreferences.some((item) => !modelIds.has(item.modelId))
  ) {
    throw new TypeError('Provider registry contains invalid references');
  }

  return {
    schemaVersion: 1,
    providers,
    connections,
    models,
    capabilities,
    routingPreferences
  };
}

function parseProvider(value: unknown): Provider {
  const item = requireRecord(value);
  requireVersionAndName(item);
  requireOneOf(item.accessCategory, providerAccessCategories);
  requireOneOf(item.identityState, providerIdentityStates);
  return {
    schemaVersion: 1,
    id: toProviderId(String(item.id)),
    name: String(item.name),
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
  return {
    schemaVersion: 1,
    id: toConnectionId(String(item.id)),
    providerId: toProviderId(String(item.providerId)),
    name: String(item.name),
    endpoint: optionalString(item.endpoint),
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

function parseModel(value: unknown): ProviderModel {
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
    state: item.state as ModelCapabilityEvidence['state'],
    source: item.source as ModelCapabilityEvidence['source'],
    constraint: optionalString(item.constraint),
    parameterSchema: parseParameterSchema(item.parameterSchema),
    videoGenerationSchema: parseVideoGenerationSchema(
      item.videoGenerationSchema
    ),
    observedAt: optionalTimestamp(item.observedAt),
    updatedAt: toIsoTimestamp(String(item.updatedAt))
  };
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

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Provider registry string is invalid');
  }
  return value;
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
