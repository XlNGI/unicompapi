import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProviderId,
  toRoutingPreferenceId,
  type ProviderModelDefinition
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  ProviderCapabilityController,
  ProviderModelCatalogService,
  ProviderRegistryConflictError
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-08-03T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Provider registry revision and catalog contracts', () => {
  it('serializes independent stores and rejects stale save revisions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-registry-cas-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const first = new JsonProviderRegistryStore(registryPath);
    const second = new JsonProviderRegistryStore(registryPath);
    await first.save(createCasSeedSnapshot());

    const firstView = await first.load();
    const staleView = await second.load();
    expect(firstView.registryRevision).toBe(1);
    await first.save({
      ...firstView,
      routingPreferences: [
        createRoutingPreference({
          id: toRoutingPreferenceId('routing-cas-first'),
          purpose: 'reference_to_video',
          modelId: firstView.models[0]!.id,
          priority: 0,
          enabled: true,
          updatedAt: timestamp
        })
      ]
    });

    await expect(second.save(staleView)).rejects.toBeInstanceOf(
      ProviderRegistryConflictError
    );
    expect((await first.load()).registryRevision).toBe(2);
  });

  it('applies concurrent mutations to the latest snapshot without dropping either update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-registry-mutate-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const first = new JsonProviderRegistryStore(registryPath);
    const second = new JsonProviderRegistryStore(registryPath);
    await first.save(createCasSeedSnapshot());
    const modelId = (await first.load()).models[0]!.id;

    await Promise.all([
      first.mutate((snapshot) => ({
        snapshot: {
          ...snapshot,
          routingPreferences: [
            ...snapshot.routingPreferences,
            createRoutingPreference({
              id: toRoutingPreferenceId('routing-concurrent-first'),
              purpose: 'reference_to_video',
              modelId,
              priority: 0,
              enabled: true,
              updatedAt: timestamp
            })
          ]
        },
        result: undefined
      })),
      second.mutate((snapshot) => ({
        snapshot: {
          ...snapshot,
          routingPreferences: [
            ...snapshot.routingPreferences,
            createRoutingPreference({
              id: toRoutingPreferenceId('routing-concurrent-second'),
              purpose: 'reference_to_image',
              modelId,
              priority: 1,
              enabled: true,
              updatedAt: timestamp
            })
          ]
        },
        result: undefined
      }))
    ]);

    const result = await first.load();
    expect(result.routingPreferences.map((item) => item.id)).toEqual([
      'routing-concurrent-first',
      'routing-concurrent-second'
    ]);
    expect(result.registryRevision).toBe(3);
  });

  it('marks disappeared catalog models missing, disables them, and excludes them from routes', async () => {
    const fixture = await createFixture();
    const controller = new ProviderCapabilityController(fixture.registry, {
      modelCatalogSync: {
        sync: async () => ({
          entries: [{ externalId: 'new-model', displayName: 'New model' }],
          observedAt: '2026-08-03T01:00:00.000Z'
        })
      }
    });
    const registered = await controller.registerManualModel({
      connectionId: fixture.connection.id,
      name: 'old-model',
      displayName: 'Old model'
    });
    if (!registered.ok || !registered.value.modelId) throw new Error('model missing');

    await fixture.registry.mutate((snapshot) => ({
      snapshot: {
        ...snapshot,
        models: snapshot.models.map((model) =>
          model.id === registered.value!.modelId
            ? { ...model, enabled: true, revision: model.revision + 1 }
            : model
        )
      },
      result: undefined
    }));
    await controller.syncModelCatalog({ connectionId: fixture.connection.id });

    const snapshot = await fixture.registry.load();
    const oldModel = snapshot.models.find(
      (model) => model.providerModelKey === 'old-model'
    );
    const newModel = snapshot.models.find(
      (model) => model.providerModelKey === 'new-model'
    );
    expect(oldModel).toMatchObject({ catalogState: 'missing', enabled: false });
    expect(newModel).toMatchObject({
      catalogState: 'present',
      lastSeenAt: '2026-08-03T01:00:00.000Z'
    });
    expect(await controller.planRoute({ purpose: 'reference_to_image' })).toMatchObject({
      ok: true,
      value: { candidates: [] }
    });
  });

  it('instantiates a declared profile only for an exact model definition and binding', async () => {
    const fixture = await createPackageFixture();
    const definition: ProviderModelDefinition = {
      schemaVersion: 1,
      definitionId: 'definition-fixture-model',
      packageId: 'fixture-package',
      packageVersion: '1.0.0',
      providerModelKey: 'fixture-model',
      profileTemplates: [
        {
          templateId: 'profile-template-fixture',
          adapterKey: 'fixture_adapter',
          protocolDefinitionId: 'fixture.protocol',
          sourceDocumentRevision: 'docs-fixture@1',
          features: [
            {
              productFeature: 'text_to_image',
              parameterSchemaId: 'parameters-fixture-v1',
              resultSchemaId: 'results-fixture-v1',
              usageSchemaId: 'usage-fixture-v1',
              constraintSetId: 'constraints-fixture-v1'
            }
          ]
        }
      ]
    };
    const service = new ProviderModelCatalogService(fixture.registry);
    await service.registerDefinition(definition);
    const profile = await service.instantiateProfile({
      modelId: fixture.model.id,
      definitionId: definition.definitionId,
      profileTemplateId: 'profile-template-fixture'
    });

    expect(profile).toMatchObject({
      status: 'declared',
      modelId: fixture.model.id,
      modelRevision: 2,
      adapterKey: 'fixture_adapter'
    });
    const snapshot = await fixture.registry.load();
    expect(snapshot.models[0]).toMatchObject({
      activeProfileId: profile.profileId,
      revision: 2
    });
    expect(snapshot.modelProfiles).toHaveLength(1);

    await fixture.registry.mutate((current) => ({
      snapshot: {
        ...current,
        models: current.models.map((model) =>
          model.id === fixture.model.id
            ? { ...model, enabled: true, revision: model.revision + 1 }
            : model
        ),
        routingPreferences: [
          createRoutingPreference({
            id: toRoutingPreferenceId('routing-profile-fixture'),
            purpose: 'image_generation',
            modelId: fixture.model.id,
            priority: 0,
            enabled: true,
            updatedAt: timestamp
          })
        ]
      },
      result: undefined
    }));
    const beforeVerification = await new ProviderCapabilityController(
      fixture.registry
    ).planRoute({ purpose: 'image_generation' });
    expect(beforeVerification).toMatchObject({
      ok: true,
      value: { candidates: [] }
    });
    await fixture.registry.mutate((current) => ({
      snapshot: {
        ...current,
        modelProfiles: current.modelProfiles!.map((candidate) =>
          candidate.profileId === profile.profileId
            ? { ...candidate, status: 'verified' as const }
            : candidate
        )
      },
      result: undefined
    }));
    await expect(
      new ProviderCapabilityController(fixture.registry).planRoute({
        purpose: 'image_generation'
      })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        candidates: [{ modelId: fixture.model.id, priority: 0 }]
      }
    });

    await expect(
      service.instantiateProfile({
        modelId: fixture.model.id,
        definitionId: definition.definitionId,
        profileTemplateId: 'missing-template'
      })
    ).rejects.toMatchObject({
      code: 'model_profile_template_not_found'
    });
  });
});

function createCasSeedSnapshot() {
  const provider = createProvider({
    id: toProviderId('provider-cas'),
    name: 'CAS provider',
    accessCategory: 'custom_remote',
    identityState: 'unverified',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-cas'),
    providerId: provider.id,
    name: 'CAS connection',
    state: 'saved',
    identityState: 'unverified',
    credentialState: 'not_configured',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const binding = createProviderProtocolBinding({
    id: toProtocolBindingId('protocol-cas'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'cas.media.v1',
    protocolVersion: '1',
    mediaKind: 'video',
    adapterKind: 'cas_adapter',
    authScheme: 'unknown',
    executionLifecycle: 'asynchronous_polling',
    supportedPurposes: ['reference_to_video', 'reference_to_image'],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const model = createProviderModel({
    id: toModelId('model-cas'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: binding.id,
    providerModelKey: 'cas-model',
    mediaKind: 'video',
    revision: 1,
    displayName: 'CAS model',
    enabled: false,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return {
    schemaVersion: 2 as const,
    providers: [provider],
    connections: [connection],
    protocolBindings: [binding],
    models: [model],
    capabilities: [],
    routingPreferences: []
  };
}

async function createFixture(): Promise<{
  readonly registry: JsonProviderRegistryStore;
  readonly connection: ReturnType<typeof createProviderConnection>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-registry-catalog-'));
  roots.push(root);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const provider = createProvider({
    id: toProviderId('provider-fixture'),
    name: 'Fixture provider',
    accessCategory: 'custom_remote',
    identityState: 'unverified',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-fixture'),
    providerId: provider.id,
    name: 'Fixture connection',
    state: 'saved',
    identityState: 'unverified',
    credentialState: 'not_configured',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await registry.save({
    schemaVersion: 2,
    providers: [provider],
    connections: [connection],
    protocolBindings: [],
    models: [],
    capabilities: [],
    routingPreferences: []
  });
  return { registry, connection };
}

async function createPackageFixture(): Promise<{
  readonly registry: JsonProviderRegistryStore;
  readonly model: ReturnType<typeof createProviderModel>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-registry-profile-'));
  roots.push(root);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const provider = createProvider({
    id: toProviderId('provider-package-fixture'),
    name: 'Fixture package provider',
    packageId: 'fixture-package',
    packageVersion: '1.0.0',
    accessCategory: 'custom_remote',
    identityState: 'unverified',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-package-fixture'),
    providerId: provider.id,
    name: 'Fixture package connection',
    state: 'saved',
    identityState: 'unverified',
    credentialState: 'not_configured',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const binding = createProviderProtocolBinding({
    id: toProtocolBindingId('protocol-package-fixture'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.protocol',
    protocolVersion: '1',
    mediaKind: 'image',
    adapterKind: 'fixture_adapter',
    authScheme: 'unknown',
    executionLifecycle: 'synchronous_completed',
    supportedPurposes: ['image_generation'],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const model = createProviderModel({
    id: toModelId('model-package-fixture'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: binding.id,
    providerModelKey: 'fixture-model',
    mediaKind: 'image',
    revision: 1,
    displayName: 'Fixture model',
    enabled: false,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await registry.save({
    schemaVersion: 2,
    providers: [provider],
    connections: [connection],
    protocolBindings: [binding],
    models: [model],
    capabilities: [],
    routingPreferences: []
  });
  return { registry, model };
}
