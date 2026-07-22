import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProviderId,
  toRoutingPreferenceId
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  ProviderRegistryController
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('JsonProviderRegistryStore', () => {
  it('persists a versioned registry and returns credential-free DTOs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const provider = createProvider({
      id: toProviderId('provider-test'),
      name: 'Test provider',
      accessCategory: 'custom_remote',
      identityState: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-test'),
      providerId: provider.id,
      name: 'Test connection',
      endpoint: 'https://private.example.test',
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved',
      credentialReference: 'credential-reference-only',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const model = createProviderModel({
      id: toModelId('model-test'),
      providerId: provider.id,
      connectionId: connection.id,
      name: 'model-id',
      displayName: 'Test model',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const capability = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId('capability-test'),
      modelId: model.id,
      capability: 'image_generation',
      state: 'declared_supported',
      source: 'provider_declared',
      updatedAt: timestamp
    });
    const routing = createRoutingPreference({
      id: toRoutingPreferenceId('routing-test'),
      purpose: 'image_generation',
      modelId: model.id,
      priority: 0,
      enabled: true,
      updatedAt: timestamp
    });

    await store.save({
      schemaVersion: 1,
      providers: [provider],
      connections: [connection],
      models: [model],
      capabilities: [capability],
      routingPreferences: [routing]
    });

    const result = await new ProviderRegistryController(store).getRegistry();
    expect(result).toMatchObject({
      ok: true,
      value: {
        connections: [
          {
            connectionId: 'connection-test',
            endpointConfigured: true,
            credentialState: 'saved'
          }
        ],
        capabilities: [{ state: 'declared_supported' }]
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private.example.test');
    expect(serialized).not.toContain('credential-reference-only');
  });

  it('rejects models that reference an unknown connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));

    await expect(
      store.save({
        schemaVersion: 1,
        providers: [],
        connections: [],
        models: [
          createProviderModel({
            id: toModelId('model-orphan'),
            providerId: toProviderId('provider-orphan'),
            connectionId: toConnectionId('connection-orphan'),
            name: 'orphan',
            displayName: 'Orphan',
            enabled: false,
            createdAt: timestamp,
            updatedAt: timestamp
          })
        ],
        capabilities: [],
        routingPreferences: []
      })
    ).rejects.toThrow('invalid references');
  });
});
