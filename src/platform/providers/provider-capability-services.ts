import { randomUUID } from 'node:crypto';
import {
  createModelCapabilityEvidence,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toRoutingPreferenceId,
  type ProviderConnection,
  type ModelCapabilityEvidence,
  type ProviderModel,
  type ProviderProtocolBinding,
  type DynamicParameterSchema,
  type VideoGenerationCapabilitySchema
} from '../../domain';
import type {
  ProviderManagementErrorCode,
  ProviderManagementResult,
  RoutePlanResult
} from '../../shared/provider-ipc';
import type { JsonProviderRegistryStore } from './provider-registry';
import { ProviderRegistryConflictError } from './provider-registry';

export interface ConnectionValidationObservation {
  readonly state: 'available' | 'unavailable';
  readonly identityState: 'verified' | 'verification_failed';
  readonly credentialState: 'valid' | 'invalid' | 'verification_unavailable';
  readonly observedAt: string;
}

export interface ConnectionValidationPort {
  validate(
    connection: ProviderConnection
  ): Promise<ConnectionValidationObservation>;
}

export interface ModelCatalogEntry {
  readonly externalId: string;
  readonly displayName: string;
}

export interface ModelCatalogSyncPort {
  sync(connection: ProviderConnection): Promise<{
    readonly entries: readonly ModelCatalogEntry[];
    readonly observedAt: string;
  }>;
}

export interface CapabilityValidationPort {
  validate(
    model: ProviderModel,
    capability: string
  ): Promise<{
    readonly state:
      | 'verified_supported'
      | 'unknown'
      | 'unsupported'
      | 'verification_failed'
      | 'restricted';
    readonly constraint?: string;
    readonly parameterSchema?: DynamicParameterSchema;
    readonly videoGenerationSchema?: VideoGenerationCapabilitySchema;
    readonly observedAt: string;
  }>;
}

export interface ProviderServicePorts {
  readonly connectionValidation?: ConnectionValidationPort;
  readonly modelCatalogSync?: ModelCatalogSyncPort;
  readonly capabilityValidation?: CapabilityValidationPort;
}

export class ProviderCapabilityController {
  constructor(
    private readonly registry: JsonProviderRegistryStore,
    private readonly ports: ProviderServicePorts = {}
  ) {}

  async validateConnection(input: unknown): Promise<ProviderManagementResult> {
    try {
      const connectionId = parseIdInput(input, 'connectionId');
      if (!this.ports.connectionValidation) {
        return failure('adapter_unavailable');
      }
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      const observation = await this.ports.connectionValidation.validate(connection);
      const observedAt = toIsoTimestamp(observation.observedAt);
      await this.registry.mutate((latest) => {
        const current = latest.connections.find((item) => item.id === connectionId);
        if (!current) {
          throw new ProviderCapabilityError(
            'connection_not_found',
            'The provider connection disappeared during validation'
          );
        }
        return {
          snapshot: {
            ...latest,
            connections: latest.connections.map((item) =>
              item.id === current.id
                ? {
                    ...item,
                    state: observation.state,
                    identityState: observation.identityState,
                    credentialState: observation.credentialState,
                    lastConnectionValidationAt: observedAt,
                    updatedAt: observedAt
                  }
                : item
            )
          },
          result: undefined
        };
      });
      return {
        ok: true,
        value: { state: observation.state, observedAt }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async createProvider(_input: unknown): Promise<ProviderManagementResult> {
    return failure('adapter_unavailable');
  }

  async createConnection(_input: unknown): Promise<ProviderManagementResult> {
    return failure('adapter_unavailable');
  }

  async updateConnection(_input: unknown): Promise<ProviderManagementResult> {
    return failure('adapter_unavailable');
  }

  async setConnectionEnabled(input: unknown): Promise<ProviderManagementResult> {
    try {
      const item = requireRecord(input);
      const connectionId = requireId(item.connectionId, 'connectionId');
      if (typeof item.enabled !== 'boolean') return failure('invalid_request');
      const result = await this.registry.mutate((snapshot) => {
        const connection = snapshot.connections.find(
          (candidate) => candidate.id === connectionId
        );
        if (!connection) {
          throw new ProviderCapabilityError(
            'connection_not_found',
            'The provider connection was not found'
          );
        }
        if (connection.state === 'deleted') throw new TypeError('connection is deleted');
        const state = item.enabled
          ? connection.endpoint
            ? 'saved'
            : 'unconfigured'
          : 'disabled';
        return {
          snapshot: {
            ...snapshot,
            connections: snapshot.connections.map((candidate) =>
              candidate.id === connection.id
                ? {
                    ...candidate,
                    state,
                    updatedAt: toIsoTimestamp(new Date().toISOString())
                  }
                : candidate
            )
          },
          result: { state, connectionId: connection.id }
        };
      });
      return { ok: true, value: result };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async setModelEnabled(input: unknown): Promise<ProviderManagementResult> {
    try {
      const item = requireRecord(input);
      const modelId = requireId(item.modelId, 'modelId');
      if (typeof item.enabled !== 'boolean') return failure('invalid_request');
      const modelState = await this.registry.mutate<{ state: string; modelId: string }>((snapshot) => {
        const model = snapshot.models.find((candidate) => candidate.id === modelId);
        if (!model) {
          throw new ProviderCapabilityError(
            'model_not_found',
            'The provider model was not found'
          );
        }
        const connection = snapshot.connections.find(
          (candidate) => candidate.id === model.connectionId
        );
        if (
          !connection ||
          connection.state === 'deleted' ||
          (item.enabled && connection.state === 'disabled') ||
          ((model.catalogState ?? 'present') !== 'present' && item.enabled)
        ) {
          throw new TypeError('model cannot be enabled');
        }
        const updatedAt = toIsoTimestamp(new Date().toISOString());
        return {
          snapshot: {
            ...snapshot,
            models: snapshot.models.map((candidate) =>
              candidate.id === model.id
                ? {
                    ...candidate,
                    enabled: item.enabled as boolean,
                    revision: candidate.revision + 1,
                    updatedAt
                  }
                : candidate
            )
          },
          result: {
            state: item.enabled ? 'enabled' : 'disabled',
            modelId: model.id
          }
        };
      });
      return {
        ok: true,
        value: modelState
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async syncModelCatalog(input: unknown): Promise<ProviderManagementResult> {
    try {
      const connectionId = parseIdInput(input, 'connectionId');
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      if (!this.ports.modelCatalogSync) return failure('adapter_unavailable');
      const result = await this.ports.modelCatalogSync.sync(connection);
      const observedAt = toIsoTimestamp(result.observedAt);
      const syncedCount = await this.registry.mutate<number>((latest) => {
        const currentConnection = latest.connections.find(
          (item) => item.id === connectionId
        );
        if (!currentConnection) {
          throw new ProviderCapabilityError(
            'connection_not_found',
            'The provider connection disappeared during catalog sync'
          );
        }
        const existingByName = new Map(
          latest.models
            .filter((item) => item.connectionId === currentConnection.id)
            .map((item) => [item.providerModelKey, item])
        );
        const unclassified = ensureUnclassifiedBinding(
          latest.protocolBindings,
          currentConnection,
          observedAt
        );
        const nextCatalogRevision = nextConnectionCatalogRevision(
          latest.models,
          currentConnection.id
        );
        const catalogNames = new Set<string>();
        const synced = result.entries.map((entry) => {
          const externalId = requireNonBlank(entry.externalId, 'externalId');
          if (catalogNames.has(externalId)) {
            throw new TypeError('Model catalog contains duplicate entries');
          }
          catalogNames.add(externalId);
          const existing = existingByName.get(externalId);
          return existing
            ? updateCatalogModel(
                existing,
                requireNonBlank(entry.displayName, 'displayName'),
                observedAt,
                nextCatalogRevision
              )
            : createProviderModel({
                id: toModelId(`model-${randomUUID()}`),
                providerId: currentConnection.providerId,
                connectionId: currentConnection.id,
                protocolBindingId: unclassified.binding.id,
                providerModelKey: externalId,
                mediaKind: 'unknown',
                revision: 1,
                catalogState: 'present',
                catalogRevision: nextCatalogRevision,
                lastSeenAt: observedAt,
                displayName: requireNonBlank(entry.displayName, 'displayName'),
                enabled: false,
                createdAt: observedAt,
                updatedAt: observedAt
              });
        });
        const missing = latest.models.map((item) => {
          if (
            item.connectionId !== currentConnection.id ||
            catalogNames.has(item.providerModelKey)
          ) {
            return item;
          }
          const nextState: NonNullable<ProviderModel['catalogState']> =
            item.catalogState === 'retired' ? 'retired' : 'missing';
          return {
            ...item,
            catalogState: nextState,
            catalogRevision: nextCatalogRevision,
            enabled: false,
            revision: item.revision + 1,
            updatedAt: observedAt
          };
        });
        return {
          snapshot: {
            ...latest,
            protocolBindings: unclassified.protocolBindings,
            models: [
              ...missing.filter(
                (item) =>
                  item.connectionId !== currentConnection.id ||
                  !catalogNames.has(item.providerModelKey)
              ),
              ...synced
            ]
          },
          result: synced.length
        };
      });
      return {
        ok: true,
        value: { state: 'catalog_synced', count: syncedCount, observedAt }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async registerManualModel(input: unknown): Promise<ProviderManagementResult> {
    try {
      const item = requireRecord(input);
      const connectionId = requireId(item.connectionId, 'connectionId');
      const name = requireNonBlank(item.name, 'name');
      const displayName = requireNonBlank(item.displayName, 'displayName');
      const model = await this.registry.mutate((snapshot) => {
        const connection = snapshot.connections.find(
          (candidate) => candidate.id === connectionId
        );
        if (!connection) {
          throw new ProviderCapabilityError(
            'connection_not_found',
            'The provider connection was not found'
          );
        }
        if (
          snapshot.models.some(
            (candidate) =>
              candidate.connectionId === connection.id &&
              candidate.providerModelKey === name
          )
        ) {
          throw new ProviderCapabilityError(
            'model_already_exists',
            'The provider model is already registered'
          );
        }
        const now = toIsoTimestamp(new Date().toISOString());
        const unclassified = ensureUnclassifiedBinding(
          snapshot.protocolBindings,
          connection,
          now
        );
        const created = createProviderModel({
          id: toModelId(`model-${randomUUID()}`),
          providerId: connection.providerId,
          connectionId: connection.id,
          protocolBindingId: unclassified.binding.id,
          providerModelKey: name,
          mediaKind: 'unknown',
          revision: 1,
          catalogState: 'present',
          displayName,
          enabled: false,
          createdAt: now,
          updatedAt: now
        });
        return {
          snapshot: {
            ...snapshot,
            protocolBindings: unclassified.protocolBindings,
            models: [...snapshot.models, created]
          },
          result: created
        };
      });
      return {
        ok: true,
        value: { state: 'registered_unverified', modelId: model.id }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async validateCapability(input: unknown): Promise<ProviderManagementResult> {
    try {
      const item = requireRecord(input);
      const modelId = requireId(item.modelId, 'modelId');
      const capability = requireNonBlank(item.capability, 'capability');
      const snapshot = await this.registry.load();
      const model = snapshot.models.find((candidate) => candidate.id === modelId);
      if (!model) return failure('model_not_found');
      if (!this.ports.capabilityValidation) return failure('adapter_unavailable');
      const observation = await this.ports.capabilityValidation.validate(
        model,
        capability
      );
      const observedAt = toIsoTimestamp(observation.observedAt);
      const evidence = await this.registry.mutate((latest) => {
        const currentModel = latest.models.find((candidate) => candidate.id === modelId);
        if (!currentModel) {
          throw new ProviderCapabilityError(
            'model_not_found',
            'The provider model disappeared during capability validation'
          );
        }
        const previous = latestCapabilityEvidence(
          latest.capabilities,
          currentModel.id,
          capability,
          'connection_verified'
        );
        const nextEvidence = createModelCapabilityEvidence({
          id: toCapabilityEvidenceId(`capability-${randomUUID()}`),
          modelId: currentModel.id,
          revision: (previous?.revision ?? 0) + 1,
          capability,
          state: observation.state,
          source: 'connection_verified',
          constraint: observation.constraint,
          parameterSchema: observation.parameterSchema,
          videoGenerationSchema: observation.videoGenerationSchema,
          observedAt,
          recordedAt: observedAt,
          supersedesEvidenceId: previous?.id
        });
        return {
          snapshot: {
            ...latest,
            models: latest.models.map((candidate) =>
              candidate.id === currentModel.id
                ? {
                    ...candidate,
                    revision: candidate.revision + 1,
                    capabilityEvidenceId: nextEvidence.id,
                    updatedAt: observedAt
                  }
                : candidate
            ),
            capabilities: [...latest.capabilities, nextEvidence]
          },
          result: nextEvidence
        };
      });
      return {
        ok: true,
        value: {
          state: evidence.state,
          evidenceId: evidence.id,
          observedAt
        }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async recordUserCapability(input: unknown): Promise<ProviderManagementResult> {
    try {
      const item = requireRecord(input);
      const modelId = requireId(item.modelId, 'modelId');
      const capability = requireNonBlank(item.capability, 'capability');
      if (item.state !== 'user_confirmed' && item.state !== 'unsupported') {
        return failure('invalid_request');
      }
      const snapshot = await this.registry.load();
      if (!snapshot.models.some((model) => model.id === modelId)) {
        return failure('model_not_found');
      }
      const now = toIsoTimestamp(new Date().toISOString());
      const evidence = await this.registry.mutate((latest) => {
        const currentModel = latest.models.find((candidate) => candidate.id === modelId);
        if (!currentModel) {
          throw new ProviderCapabilityError(
            'model_not_found',
            'The provider model disappeared during capability update'
          );
        }
        const previous = latestCapabilityEvidence(
          latest.capabilities,
          currentModel.id,
          capability,
          'user_confirmed'
        );
        const nextEvidence = createModelCapabilityEvidence({
          id: toCapabilityEvidenceId(`capability-${randomUUID()}`),
          modelId: currentModel.id,
          revision: (previous?.revision ?? 0) + 1,
          capability,
          state: item.state as 'user_confirmed' | 'unsupported',
          source: 'user_confirmed',
          observedAt: now,
          recordedAt: now,
          supersedesEvidenceId: previous?.id
        });
        return {
          snapshot: {
            ...latest,
            models: latest.models.map((candidate) =>
              candidate.id === currentModel.id
                ? {
                    ...candidate,
                    revision: candidate.revision + 1,
                    capabilityEvidenceId: nextEvidence.id,
                    updatedAt: now
                  }
                : candidate
            ),
            capabilities: [...latest.capabilities, nextEvidence]
          },
          result: nextEvidence
        };
      });
      return {
        ok: true,
        value: { state: evidence.state, evidenceId: evidence.id }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async saveRoutingPreference(input: unknown): Promise<ProviderManagementResult> {
    try {
      const item = requireRecord(input);
      const purpose = requireNonBlank(item.purpose, 'purpose');
      const modelId = requireId(item.modelId, 'modelId');
      if (
        !Number.isSafeInteger(item.priority) ||
        Number(item.priority) < 0 ||
        typeof item.enabled !== 'boolean'
      ) {
        return failure('invalid_request');
      }
      const preference = await this.registry.mutate((snapshot) => {
        if (!snapshot.models.some((model) => model.id === modelId)) {
          throw new ProviderCapabilityError(
            'model_not_found',
            'The provider model was not found'
          );
        }
        const existing = snapshot.routingPreferences.find(
          (candidate) =>
            candidate.purpose === purpose && candidate.modelId === modelId
        );
        const created = createRoutingPreference({
          id: existing?.id ?? toRoutingPreferenceId(`routing-${randomUUID()}`),
          purpose,
          modelId: toModelId(modelId),
          priority: Number(item.priority),
          enabled: item.enabled as boolean,
          updatedAt: toIsoTimestamp(new Date().toISOString())
        });
        return {
          snapshot: {
            ...snapshot,
            routingPreferences: [
              ...snapshot.routingPreferences.filter(
                (candidate) => candidate.id !== created.id
              ),
              created
            ]
          },
          result: created
        };
      });
      return {
        ok: true,
        value: { state: 'routing_saved', preferenceId: preference.id }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async planRoute(input: unknown): Promise<RoutePlanResult> {
    try {
      const purpose = parseTextInput(input, 'purpose');
      const snapshot = await this.registry.load();
      const routableConnections = new Set(
        snapshot.connections
          .filter(
            (connection) =>
              connection.state !== 'disabled' && connection.state !== 'deleted'
          )
          .map((connection) => connection.id)
      );
      const enabledModels = new Set(
        snapshot.models
          .filter(
            (model) =>
              model.enabled &&
              (model.catalogState ?? 'present') === 'present' &&
              snapshot.modelProfiles?.some(
                (profile) =>
                  profile.profileId === model.activeProfileId &&
                  profile.status === 'verified'
              ) === true &&
              routableConnections.has(model.connectionId) &&
              snapshot.protocolBindings.some(
                (binding) =>
                  binding.id === model.protocolBindingId &&
                  (binding.mediaKind === 'unknown' ||
                    binding.supportedPurposes.includes(
                      purpose as (typeof binding.supportedPurposes)[number]
                    ))
              )
          )
          .map((model) => model.id)
      );
      const candidates = snapshot.routingPreferences
        .filter(
          (preference) =>
            preference.purpose === purpose &&
            preference.enabled &&
            enabledModels.has(preference.modelId)
        )
        .sort((left, right) => left.priority - right.priority)
        .map((preference) => ({
          modelId: preference.modelId,
          priority: preference.priority,
          costState: 'unknown' as const,
          privacyState: 'unknown' as const,
          regionState: 'unknown' as const
        }));
      return {
        ok: true,
        value: {
          purpose,
          candidates,
          requiresSubmissionConfirmation: true
        }
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }
}

function ensureUnclassifiedBinding(
  existing: readonly ProviderProtocolBinding[],
  connection: ProviderConnection,
  now: ReturnType<typeof toIsoTimestamp>
): {
  readonly binding: ProviderProtocolBinding;
  readonly protocolBindings: readonly ProviderProtocolBinding[];
} {
  const id = toProtocolBindingId(
    `protocol-binding-unclassified-${connection.id}`
  );
  const binding = existing.find((candidate) => candidate.id === id);
  if (binding) return { binding, protocolBindings: existing };
  const created = createProviderProtocolBinding({
    id,
    providerId: connection.providerId,
    connectionId: connection.id,
    protocolId: 'unclassified',
    protocolVersion: '1',
    mediaKind: 'unknown',
    adapterKind: 'adapter_unavailable',
    authScheme: 'unknown',
    executionLifecycle: 'unknown',
    supportedPurposes: [],
    createdAt: now,
    updatedAt: now
  });
  return { binding: created, protocolBindings: [...existing, created] };
}

function updateCatalogModel(
  model: ProviderModel,
  displayName: string,
  updatedAt: ReturnType<typeof toIsoTimestamp>,
  catalogRevision: number
): ProviderModel {
  if (
    model.displayName === displayName &&
    (model.catalogState ?? 'present') === 'present' &&
    model.catalogRevision === catalogRevision
  ) {
    return model;
  }
  return {
    ...model,
    displayName,
    catalogState: 'present',
    catalogRevision,
    lastSeenAt: updatedAt,
    revision: model.revision + 1,
    updatedAt
  };
}

function nextConnectionCatalogRevision(
  models: readonly ProviderModel[],
  connectionId: ProviderModel['connectionId']
): number {
  return (
    Math.max(
      0,
      ...models
        .filter((model) => model.connectionId === connectionId)
        .map((model) => model.catalogRevision ?? 0)
    ) + 1
  );
}

function latestCapabilityEvidence(
  capabilities: readonly ModelCapabilityEvidence[],
  modelId: ProviderModel['id'],
  capability: string,
  source: ModelCapabilityEvidence['source']
): ModelCapabilityEvidence | undefined {
  return capabilities
    .filter(
      (candidate) =>
        candidate.modelId === modelId &&
        candidate.capability === capability &&
        candidate.source === source
    )
    .sort((left, right) => right.revision - left.revision)[0];
}

function parseIdInput(value: unknown, field: string): string {
  const item = requireRecord(value);
  return requireId(item[field], field);
}

function parseTextInput(value: unknown, field: string): string {
  const item = requireRecord(value);
  return requireNonBlank(item[field], field);
}

class ProviderCapabilityError extends Error {
  constructor(
    readonly code: ProviderManagementErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProviderCapabilityError';
  }
}

function requireId(value: unknown, field: string): string {
  const result = requireNonBlank(value, field);
  if (result.length > 200) throw new TypeError(`${field} is invalid`);
  return result;
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider management request is invalid');
  }
  return value as Record<string, unknown>;
}

function mapError(error: unknown): ProviderManagementErrorCode {
  if (error instanceof ProviderCapabilityError) return error.code;
  if (error instanceof ProviderRegistryConflictError) {
    return 'provider_registry_conflict';
  }
  return error instanceof TypeError ? 'invalid_request' : 'provider_operation_failed';
}

function failure(
  code: ProviderManagementErrorCode
): {
  readonly ok: false;
  readonly error: {
    readonly code: ProviderManagementErrorCode;
    readonly message: string;
  };
} {
  const messages = {
    adapter_unavailable: 'The provider adapter is not configured',
    provider_registry_conflict: 'The provider registry changed; retry the operation',
    provider_not_found: 'The provider was not found',
    connection_not_found: 'The provider connection was not found',
    model_not_found: 'The provider model was not found',
    model_already_exists: 'The provider model is already registered',
    invalid_request: 'The provider management request is invalid',
    provider_operation_failed: 'The provider management operation failed'
  } as const;
  return { ok: false, error: { code, message: messages[code] } };
}
