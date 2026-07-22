import { randomUUID } from 'node:crypto';
import {
  createModelCapabilityEvidence,
  createProviderModel,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toIsoTimestamp,
  toModelId,
  toRoutingPreferenceId,
  type ProviderConnection,
  type ProviderModel
} from '../../domain';
import type {
  ProviderManagementErrorCode,
  ProviderManagementResult,
  RoutePlanResult
} from '../../shared/provider-ipc';
import type { JsonProviderRegistryStore } from './provider-registry';

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
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      if (!this.ports.connectionValidation) {
        return failure('adapter_unavailable');
      }
      const observation = await this.ports.connectionValidation.validate(connection);
      const observedAt = toIsoTimestamp(observation.observedAt);
      await this.registry.save({
        ...snapshot,
        connections: snapshot.connections.map((item) =>
          item.id === connection.id
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
      });
      return {
        ok: true,
        value: { state: observation.state, observedAt }
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
      const existingByName = new Map(
        snapshot.models
          .filter((item) => item.connectionId === connection.id)
          .map((item) => [item.name, item])
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
          ? { ...existing, displayName: requireNonBlank(entry.displayName, 'displayName'), updatedAt: observedAt }
          : createProviderModel({
              id: toModelId(`model-${randomUUID()}`),
              providerId: connection.providerId,
              connectionId: connection.id,
              name: externalId,
              displayName: requireNonBlank(entry.displayName, 'displayName'),
              enabled: false,
              createdAt: observedAt,
              updatedAt: observedAt
            });
      });
      const retainedModels = snapshot.models.filter(
        (item) =>
          item.connectionId !== connection.id || !catalogNames.has(item.name)
      );
      await this.registry.save({
        ...snapshot,
        models: [...retainedModels, ...synced]
      });
      return {
        ok: true,
        value: { state: 'catalog_synced', count: synced.length, observedAt }
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
      const snapshot = await this.registry.load();
      const connection = snapshot.connections.find(
        (candidate) => candidate.id === connectionId
      );
      if (!connection) return failure('connection_not_found');
      if (
        snapshot.models.some(
          (model) => model.connectionId === connection.id && model.name === name
        )
      ) {
        return failure('model_already_exists');
      }
      const now = toIsoTimestamp(new Date().toISOString());
      const model = createProviderModel({
        id: toModelId(`model-${randomUUID()}`),
        providerId: connection.providerId,
        connectionId: connection.id,
        name,
        displayName,
        enabled: false,
        createdAt: now,
        updatedAt: now
      });
      await this.registry.save({ ...snapshot, models: [...snapshot.models, model] });
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
      const evidence = createModelCapabilityEvidence({
        id: toCapabilityEvidenceId(`capability-${randomUUID()}`),
        modelId: model.id,
        capability,
        state: observation.state,
        source: 'connection_verified',
        constraint: observation.constraint,
        observedAt,
        updatedAt: observedAt
      });
      const capabilities = snapshot.capabilities.filter(
        (candidate) =>
          candidate.modelId !== evidence.modelId ||
          candidate.capability !== evidence.capability ||
          candidate.source !== 'connection_verified'
      );
      await this.registry.save({
        ...snapshot,
        capabilities: [...capabilities, evidence]
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
      const evidence = createModelCapabilityEvidence({
        id: toCapabilityEvidenceId(`capability-${randomUUID()}`),
        modelId: toModelId(modelId),
        capability,
        state: item.state,
        source: 'user_confirmed',
        observedAt: now,
        updatedAt: now
      });
      const capabilities = snapshot.capabilities.filter(
        (candidate) =>
          candidate.modelId !== evidence.modelId ||
          candidate.capability !== evidence.capability ||
          candidate.source !== 'user_confirmed'
      );
      await this.registry.save({
        ...snapshot,
        capabilities: [...capabilities, evidence]
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
      const snapshot = await this.registry.load();
      if (!snapshot.models.some((model) => model.id === modelId)) {
        return failure('model_not_found');
      }
      const existing = snapshot.routingPreferences.find(
        (preference) =>
          preference.purpose === purpose && preference.modelId === modelId
      );
      const preference = createRoutingPreference({
        id: existing?.id ?? toRoutingPreferenceId(`routing-${randomUUID()}`),
        purpose,
        modelId: toModelId(modelId),
        priority: Number(item.priority),
        enabled: item.enabled,
        updatedAt: toIsoTimestamp(new Date().toISOString())
      });
      await this.registry.save({
        ...snapshot,
        routingPreferences: [
          ...snapshot.routingPreferences.filter(
            (candidate) => candidate.id !== preference.id
          ),
          preference
        ]
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
      const enabledModels = new Set(
        snapshot.models.filter((model) => model.enabled).map((model) => model.id)
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

function parseIdInput(value: unknown, field: string): string {
  const item = requireRecord(value);
  return requireId(item[field], field);
}

function parseTextInput(value: unknown, field: string): string {
  const item = requireRecord(value);
  return requireNonBlank(item[field], field);
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
    connection_not_found: 'The provider connection was not found',
    model_not_found: 'The provider model was not found',
    model_already_exists: 'The provider model is already registered',
    invalid_request: 'The provider management request is invalid',
    provider_operation_failed: 'The provider management operation failed'
  } as const;
  return { ok: false, error: { code, message: messages[code] } };
}
