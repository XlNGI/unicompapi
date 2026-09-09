import { randomUUID } from 'node:crypto';
import type {
  ModelFeatureProfile,
  ProviderModelDefinition
} from '../../domain';
import type { JsonProviderRegistryStore } from './provider-registry';

export type ProviderModelCatalogErrorCode =
  | 'invalid_request'
  | 'model_not_found'
  | 'model_definition_not_found'
  | 'model_definition_mismatch'
  | 'model_profile_template_not_found'
  | 'model_profile_binding_mismatch'
  | 'model_catalog_state_invalid'
  | 'provider_package_mismatch'
  | 'model_definition_already_exists';

export class ProviderModelCatalogError extends Error {
  constructor(
    readonly code: ProviderModelCatalogErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProviderModelCatalogError';
  }
}

export class ProviderModelCatalogService {
  constructor(private readonly registry: JsonProviderRegistryStore) {}

  async registerDefinition(definition: ProviderModelDefinition): Promise<void> {
    await this.registry.mutate((snapshot) => {
      const definitions = snapshot.modelDefinitions ?? [];
      const existing = definitions.find(
        (candidate) => candidate.definitionId === definition.definitionId
      );
      if (existing) {
        throw new ProviderModelCatalogError(
          'model_definition_already_exists',
          'The provider model definition is already registered'
        );
      }
      return {
        snapshot: {
          ...snapshot,
          modelDefinitions: [...definitions, definition]
        },
        result: undefined
      };
    });
  }

  async instantiateProfile(input: unknown): Promise<ModelFeatureProfile> {
    const request = parseProfileRequest(input);
    return this.registry.mutate((snapshot) => {
      const model = snapshot.models.find((candidate) => candidate.id === request.modelId);
      if (!model) {
        throw new ProviderModelCatalogError(
          'model_not_found',
          'The provider model is not registered'
        );
      }
      if ((model.catalogState ?? 'present') !== 'present') {
        throw new ProviderModelCatalogError(
          'model_catalog_state_invalid',
          'A missing or retired catalog model cannot receive a profile'
        );
      }
      const definition = (snapshot.modelDefinitions ?? []).find(
        (candidate) => candidate.definitionId === request.definitionId
      );
      if (!definition) {
        throw new ProviderModelCatalogError(
          'model_definition_not_found',
          'The provider model definition is not registered'
        );
      }
      if (definition.providerModelKey !== model.providerModelKey) {
        throw new ProviderModelCatalogError(
          'model_definition_mismatch',
          'The model definition does not exactly match the catalog key'
        );
      }
      const provider = snapshot.providers.find(
        (candidate) => candidate.id === model.providerId
      );
      if (
        !provider?.packageId ||
        provider.packageId !== definition.packageId ||
        provider.packageVersion !== definition.packageVersion
      ) {
        throw new ProviderModelCatalogError(
          'provider_package_mismatch',
          'The model definition package does not own the provider'
        );
      }
      const template = definition.profileTemplates.find(
        (candidate) => candidate.templateId === request.profileTemplateId
      );
      if (!template) {
        throw new ProviderModelCatalogError(
          'model_profile_template_not_found',
          'The provider model profile template is not registered'
        );
      }
      const binding = snapshot.protocolBindings.find(
        (candidate) => candidate.id === model.protocolBindingId
      );
      if (
        !binding ||
        binding.adapterKind !== template.adapterKey ||
        binding.protocolId !== template.protocolDefinitionId
      ) {
        throw new ProviderModelCatalogError(
          'model_profile_binding_mismatch',
          'The profile template does not exactly match the protocol binding'
        );
      }
      const nextModelRevision = model.revision + 1;
      const profile: ModelFeatureProfile = {
        schemaVersion: 1,
        profileId: `profile-${randomUUID()}`,
        revision: Math.max(
          1,
          ...(snapshot.modelProfiles ?? [])
            .filter((candidate) => candidate.modelId === model.id)
            .map((candidate) => candidate.revision + 1)
        ),
        packageId: definition.packageId,
        sourceTemplateId: template.templateId,
        adapterKey: template.adapterKey,
        modelId: model.id,
        modelRevision: nextModelRevision,
        protocolBindingId: model.protocolBindingId,
        status: 'declared',
        features: template.features,
        evidenceIds: snapshot.capabilities
          .filter((candidate) => candidate.modelId === model.id)
          .map((candidate) => candidate.id),
        recordedAt: new Date().toISOString()
      };
      return {
        snapshot: {
          ...snapshot,
          models: snapshot.models.map((candidate) =>
            candidate.id === model.id
              ? {
                  ...candidate,
                  activeProfileId: profile.profileId,
                  revision: nextModelRevision,
                  updatedAt: profile.recordedAt as typeof candidate.updatedAt
                }
              : candidate
          ),
          modelProfiles: [...(snapshot.modelProfiles ?? []), profile]
        },
        result: profile
      };
    });
  }
}

function parseProfileRequest(value: unknown): {
  readonly modelId: string;
  readonly definitionId: string;
  readonly profileTemplateId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderModelCatalogError(
      'invalid_request',
      'The model profile request is invalid'
    );
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (
    keys.some(
      (key) => !['modelId', 'definitionId', 'profileTemplateId'].includes(key)
    )
  ) {
    throw new ProviderModelCatalogError(
      'invalid_request',
      'The model profile request contains unsupported fields'
    );
  }
  return {
    modelId: requireIdentifier(item.modelId),
    definitionId: requireIdentifier(item.definitionId),
    profileTemplateId: requireIdentifier(item.profileTemplateId)
  };
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    throw new ProviderModelCatalogError(
      'invalid_request',
      'The model profile identifier is invalid'
    );
  }
  return value;
}
