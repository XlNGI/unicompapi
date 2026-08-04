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
  it('closes legacy arbitrary provider, endpoint, and JSON connection creation', async () => {
    const { registry, connectionId } = await fixtureRegistry();
    const controller = new ProviderCapabilityController(registry);
    const before = await registry.load();

    for (const result of [
      await controller.createProvider({
        name: 'Arbitrary provider',
        accessCategory: 'custom_remote'
      }),
      await controller.createConnection({
        providerId: before.providers[0].id,
        name: 'Arbitrary REST',
        endpoint: 'https://arbitrary.invalid',
        protocol: 'auto',
        body: { unknown: true }
      }),
      await controller.updateConnection({
        connectionId,
        name: 'Arbitrary update',
        endpoint: 'https://arbitrary.invalid'
      })
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'adapter_unavailable' }
      });
    }
    expect(await registry.load()).toEqual(before);
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
        candidates: [],
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
    schemaVersion: 3,
    currentConnectionId: null,
    providers: [provider],
    connections: [connection],
    protocolBindings: [],
    models: [],
    capabilities: [],
    routingPreferences: []
  });
  return { registry, connectionId: connection.id };
}
