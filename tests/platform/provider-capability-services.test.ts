import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviderConnection,
  toConnectionId,
  toIsoTimestamp,
  toProviderId
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  ProviderCapabilityController
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ProviderCapabilityController', () => {
  it('creates custom providers and manages connection and model enabled states', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-service-'));
    roots.push(root);
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const controller = new ProviderCapabilityController(registry);

    const providerResult = await controller.createProvider({
      name: 'Custom compatible fixture',
      accessCategory: 'custom_remote'
    });
    expect(providerResult).toMatchObject({
      ok: true,
      value: { state: 'provider_created' }
    });
    if (!providerResult.ok || !providerResult.value.providerId) {
      throw new Error('provider missing');
    }
    const connectionResult = await controller.createConnection({
      providerId: providerResult.value.providerId,
      name: 'Fixture connection',
      endpoint: null
    });
    expect(connectionResult).toMatchObject({
      ok: true,
      value: { state: 'unconfigured' }
    });
    if (!connectionResult.ok || !connectionResult.value.connectionId) {
      throw new Error('connection missing');
    }
    expect(
      await controller.updateConnection({
        connectionId: connectionResult.value.connectionId,
        name: 'Updated fixture connection',
        endpoint: 'https://fixture.invalid'
      })
    ).toMatchObject({ ok: true, value: { state: 'saved' } });
    const modelResult = await controller.registerManualModel({
      connectionId: connectionResult.value.connectionId,
      name: 'fixture-model-toggle',
      displayName: 'Fixture model toggle'
    });
    if (!modelResult.ok || !modelResult.value.modelId) {
      throw new Error('model missing');
    }
    expect(
      await controller.setModelEnabled({
        modelId: modelResult.value.modelId,
        enabled: true
      })
    ).toMatchObject({ ok: true, value: { state: 'enabled' } });
    expect(
      (await registry.load()).models.find(
        (model) => model.id === modelResult.value.modelId
      )?.enabled
    ).toBe(true);

    expect(
      await controller.saveRoutingPreference({
        purpose: 'fixture_purpose',
        modelId: modelResult.value.modelId,
        priority: 0,
        enabled: true
      })
    ).toMatchObject({ ok: true, value: { state: 'routing_saved' } });
    expect(
      await controller.setConnectionEnabled({
        connectionId: connectionResult.value.connectionId,
        enabled: false
      })
    ).toMatchObject({ ok: true, value: { state: 'disabled' } });
    expect(
      await controller.setModelEnabled({
        modelId: modelResult.value.modelId,
        enabled: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await controller.planRoute({ purpose: 'fixture_purpose' })).toEqual({
      ok: true,
      value: {
        purpose: 'fixture_purpose',
        candidates: [],
        requiresSubmissionConfirmation: true
      }
    });
  });

  it('keeps connection, catalog, and capability validation unavailable without adapters', async () => {
    const { registry, connectionId } = await fixtureRegistry();
    const controller = new ProviderCapabilityController(registry);

    for (const result of [
      await controller.validateConnection({ connectionId }),
      await controller.syncModelCatalog({ connectionId })
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'adapter_unavailable' }
      });
    }
    expect((await registry.load()).connections[0]).toMatchObject({
      state: 'saved',
      identityState: 'unverified'
    });
  });

  it('registers manual models without inferred capabilities and requires route confirmation', async () => {
    const { registry, connectionId } = await fixtureRegistry();
    const controller = new ProviderCapabilityController(registry);
    const registered = await controller.registerManualModel({
      connectionId,
      name: 'fixture-model',
      displayName: 'Fixture model'
    });
    expect(registered).toMatchObject({
      ok: true,
      value: { state: 'registered_unverified' }
    });
    if (!registered.ok || !registered.value.modelId) throw new Error('model missing');
    expect((await registry.load()).capabilities).toEqual([]);

    expect(
      await controller.recordUserCapability({
        modelId: registered.value.modelId,
        capability: 'fixture_capability',
        state: 'user_confirmed'
      })
    ).toMatchObject({ ok: true, value: { state: 'user_confirmed' } });
    expect(
      await controller.saveRoutingPreference({
        purpose: 'fixture_purpose',
        modelId: registered.value.modelId,
        priority: 0,
        enabled: true
      })
    ).toMatchObject({ ok: true, value: { state: 'routing_saved' } });

    const snapshot = await registry.load();
    await registry.save({
      ...snapshot,
      models: snapshot.models.map((model) => ({
        ...model,
        enabled: true,
        revision: model.revision + 1
      }))
    });
    expect(await controller.planRoute({ purpose: 'fixture_purpose' })).toEqual({
      ok: true,
      value: {
        purpose: 'fixture_purpose',
        candidates: [
          {
            modelId: registered.value.modelId,
            priority: 0,
            costState: 'unknown',
            privacyState: 'unknown',
            regionState: 'unknown'
          }
        ],
        requiresSubmissionConfirmation: true
      }
    });
  });

  it('persists connection and capability observations through separate ports', async () => {
    const { registry, connectionId } = await fixtureRegistry();
    const controller = new ProviderCapabilityController(registry, {
      connectionValidation: {
        validate: async () => ({
          state: 'available',
          identityState: 'verified',
          credentialState: 'valid',
          observedAt: '2026-07-22T01:00:00.000Z'
        })
      },
      modelCatalogSync: {
        sync: async () => ({
          entries: [{ externalId: 'observed-model', displayName: 'Observed model' }],
          observedAt: '2026-07-22T01:01:00.000Z'
        })
      },
      capabilityValidation: {
        validate: async () => ({
          state: 'verified_supported',
          observedAt: '2026-07-22T01:02:00.000Z'
        })
      }
    });

    expect(await controller.validateConnection({ connectionId })).toMatchObject({
      ok: true,
      value: { state: 'available' }
    });
    expect(await controller.syncModelCatalog({ connectionId })).toMatchObject({
      ok: true,
      value: { state: 'catalog_synced', count: 1 }
    });
    const model = (await registry.load()).models[0];
    expect(model.enabled).toBe(false);
    expect(
      await controller.validateCapability({
        modelId: model.id,
        capability: 'observed_capability'
      })
    ).toMatchObject({
      ok: true,
      value: { state: 'verified_supported' }
    });
    const firstSnapshot = await registry.load();
    const firstEvidenceId = firstSnapshot.capabilities[0].id;
    expect(firstSnapshot.capabilities[0]).toMatchObject({
      source: 'connection_verified',
      state: 'verified_supported',
      revision: 1
    });
    expect(
      await controller.validateCapability({
        modelId: model.id,
        capability: 'observed_capability'
      })
    ).toMatchObject({ ok: true, value: { state: 'verified_supported' } });
    const secondSnapshot = await registry.load();
    expect(secondSnapshot.capabilities).toHaveLength(2);
    expect(secondSnapshot.capabilities[0].id).toBe(firstEvidenceId);
    expect(secondSnapshot.capabilities[1]).toMatchObject({
      revision: 2,
      supersedesEvidenceId: firstEvidenceId
    });
  });
});

async function fixtureRegistry(): Promise<{
  registry: JsonProviderRegistryStore;
  connectionId: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-service-'));
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
  return { registry, connectionId: connection.id };
}
