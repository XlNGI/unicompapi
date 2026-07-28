import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
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
      protocolBindingId: toProtocolBindingId('protocol-test-image'),
      providerModelKey: 'model-id',
      mediaKind: 'image',
      revision: 1,
      displayName: 'Test model',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const capability = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId('capability-test'),
      modelId: model.id,
      revision: 1,
      capability: 'image_generation',
      state: 'declared_supported',
      source: 'provider_declared',
      recordedAt: timestamp
    });
    const binding = createProviderProtocolBinding({
      id: model.protocolBindingId,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: 'fixture.image',
      protocolVersion: '1',
      mediaKind: 'image',
      adapterKind: 'fixture_image',
      authScheme: 'unknown',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['image_generation'],
      createdAt: timestamp,
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
      schemaVersion: 2,
      providers: [provider],
      connections: [connection],
      protocolBindings: [binding],
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
    expect(serialized).not.toContain('fixture_image');
  });

  it('loads the frozen Vidu protocol catalog without invented verified facts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));

    const snapshot = await store.load();
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.protocolBindings).toHaveLength(3);
    expect(
      snapshot.protocolBindings.map((binding) => ({
        protocolId: binding.protocolId,
        mediaKind: binding.mediaKind,
        executionLifecycle: binding.executionLifecycle
      }))
    ).toEqual([
      {
        protocolId: 'vidu.ent.v2.reference2video',
        mediaKind: 'video',
        executionLifecycle: 'asynchronous_polling'
      },
      {
        protocolId: 'vidu.ent.v1.images',
        mediaKind: 'image',
        executionLifecycle: 'synchronous_completed'
      },
      {
        protocolId: 'vidu.ent.v2.image.reference2image',
        mediaKind: 'image',
        executionLifecycle: 'synchronous_completed'
      }
    ]);
    expect(snapshot.models.map((model) => model.providerModelKey)).toEqual([
      'viduq3-drama',
      'viduq3-ad',
      'viduq3-mix',
      'viduq3-turbo',
      'viduq3',
      'viduimage-2',
      'q2-fast',
      'q2-pro',
      'q3-fast',
      'q3-lite'
    ]);
    expect(snapshot.models.every((model) => !model.enabled)).toBe(true);
    expect(
      snapshot.capabilities.every(
        (evidence) =>
          evidence.state === 'declared_supported' &&
          evidence.parameterSchema === undefined &&
          evidence.videoGenerationSchema === undefined
      )
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/price|cost|duration|resolution/i);
  });

  it('rejects removal or mutation of persisted capability history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const store = new JsonProviderRegistryStore(registryPath);
    const seeded = await store.load();
    await store.save(seeded);
    const current = await store.load();
    const currentEvidenceIds = new Set(
      current.models.map((model) => model.capabilityEvidenceId)
    );
    const historicalEvidence = current.capabilities.find(
      (evidence) => !currentEvidenceIds.has(evidence.id)
    );
    if (!historicalEvidence) throw new Error('historical evidence missing');

    await expect(
      store.save({
        ...current,
        capabilities: current.capabilities.filter(
          (evidence) => evidence.id !== historicalEvidence.id
        )
      })
    ).rejects.toThrow('immutable');
    await expect(
      store.save({
        ...current,
        capabilities: current.capabilities.map((evidence) =>
          evidence.id === historicalEvidence.id
            ? { ...evidence, state: 'unsupported' }
            : evidence
        )
      })
    ).rejects.toThrow('immutable');
  });

  it('migrates schema v1 models and keeps old evidence IDs readable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    await writeFile(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: [{
          schemaVersion: 1,
          id: 'provider-legacy',
          name: 'Legacy',
          accessCategory: 'local',
          identityState: 'unverified',
          createdAt: timestamp,
          updatedAt: timestamp
        }],
        connections: [{
          schemaVersion: 1,
          id: 'connection-legacy',
          providerId: 'provider-legacy',
          name: 'Legacy',
          state: 'saved',
          identityState: 'unverified',
          credentialState: 'not_configured',
          createdAt: timestamp,
          updatedAt: timestamp
        }],
        models: [{
          schemaVersion: 1,
          id: 'model-legacy',
          providerId: 'provider-legacy',
          connectionId: 'connection-legacy',
          name: 'legacy-model',
          displayName: 'Legacy model',
          enabled: false,
          createdAt: timestamp,
          updatedAt: timestamp
        }],
        capabilities: [{
          schemaVersion: 1,
          id: 'evidence-legacy',
          modelId: 'model-legacy',
          capability: 'image_generation',
          state: 'user_confirmed',
          source: 'user_confirmed',
          observedAt: timestamp,
          updatedAt: timestamp
        }],
        routingPreferences: []
      }),
      'utf8'
    );

    const migrated = await new JsonProviderRegistryStore(registryPath).load();
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      models: [{
        id: 'model-legacy',
        providerModelKey: 'legacy-model',
        mediaKind: 'image',
        capabilityEvidenceId: 'evidence-legacy'
      }],
      capabilities: [{
        id: 'evidence-legacy',
        revision: 1,
        recordedAt: timestamp
      }]
    });
  });

  it('rejects a model whose media kind contradicts its protocol binding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const snapshot = await store.load();
    const firstModel = snapshot.models[0];
    if (!firstModel) throw new Error('frozen model missing');

    await expect(
      store.save({
        ...snapshot,
        models: snapshot.models.map((model) =>
          model.id === firstModel.id ? { ...model, mediaKind: 'image' } : model
        )
      })
    ).rejects.toThrow('invalid references');
  });

  it('rejects duplicate revisions in an immutable evidence history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const snapshot = await store.load();
    const firstEvidence = snapshot.capabilities[0];
    if (!firstEvidence) throw new Error('frozen evidence missing');

    await expect(
      store.save({
        ...snapshot,
        capabilities: [
          ...snapshot.capabilities,
          {
            ...firstEvidence,
            id: toCapabilityEvidenceId('evidence-duplicate-revision')
          }
        ]
      })
    ).rejects.toThrow('revision is duplicated');
  });

  it('rejects models that reference an unknown connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));

    await expect(
      store.save({
        schemaVersion: 2,
        providers: [],
        connections: [],
        protocolBindings: [
          createProviderProtocolBinding({
            id: toProtocolBindingId('protocol-orphan'),
            providerId: toProviderId('provider-orphan'),
            connectionId: toConnectionId('connection-orphan'),
            protocolId: 'orphan',
            protocolVersion: '1',
            mediaKind: 'unknown',
            adapterKind: 'unavailable',
            authScheme: 'unknown',
            executionLifecycle: 'unknown',
            supportedPurposes: [],
            createdAt: timestamp,
            updatedAt: timestamp
          })
        ],
        models: [
          createProviderModel({
            id: toModelId('model-orphan'),
            providerId: toProviderId('provider-orphan'),
            connectionId: toConnectionId('connection-orphan'),
            protocolBindingId: toProtocolBindingId('protocol-orphan'),
            providerModelKey: 'orphan',
            mediaKind: 'unknown',
            revision: 1,
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
