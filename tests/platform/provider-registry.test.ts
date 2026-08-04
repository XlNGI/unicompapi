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
      schemaVersion: 3,
      currentConnectionId: null,
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
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.currentConnectionId).toBeNull();
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

  it('migrates schema v2 with no implicit current connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-v2-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const snapshot = await new JsonProviderRegistryStore(registryPath).load();
    const legacy: Record<string, unknown> = { ...snapshot };
    delete legacy.currentConnectionId;
    await writeFile(registryPath, JSON.stringify({
      ...legacy,
      schemaVersion: 2
    }), 'utf8');

    const migrated = await new JsonProviderRegistryStore(registryPath).load();
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      currentConnectionId: null
    });
  });

  it('adds missing frozen Vidu records to an existing v2 registry without changing user records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const store = new JsonProviderRegistryStore(registryPath);
    const provider = createProvider({
      id: toProviderId('provider-custom'),
      name: 'Custom provider',
      accessCategory: 'custom_remote',
      identityState: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-custom-deleted'),
      providerId: provider.id,
      name: 'Deleted custom connection',
      state: 'deleted',
      identityState: 'unverified',
      credentialState: 'saved',
      credentialReference: 'credential-reference-must-survive',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await store.save({
      schemaVersion: 3,
      currentConnectionId: null,
      providers: [provider],
      connections: [connection],
      protocolBindings: [],
      models: [],
      capabilities: [],
      routingPreferences: []
    });

    await store.ensureFrozenViduCatalog();

    const snapshot = await store.load();
    expect(snapshot.providers[0]).toEqual(provider);
    expect(snapshot.connections[0]).toEqual(connection);
    expect(snapshot.providers.some((item) => item.id === 'provider-vidu')).toBe(true);
    expect(
      snapshot.connections.some((item) => item.id === 'connection-vidu-default')
    ).toBe(true);
    expect(snapshot.protocolBindings).toHaveLength(3);
    expect(snapshot.models).toHaveLength(10);
    expect(snapshot.capabilities.length).toBeGreaterThan(10);
  });

  it('preserves existing same-id Vidu records and immutable capability history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const store = new JsonProviderRegistryStore(registryPath);
    const seeded = await store.load();
    const viduProvider = seeded.providers[0];
    const viduConnection = seeded.connections[0];
    const firstEvidence = seeded.capabilities[0];
    if (!viduProvider || !viduConnection || !firstEvidence) {
      throw new Error('frozen Vidu fixture missing');
    }
    const existingProvider = { ...viduProvider, name: 'Existing Vidu record' };
    const deletedConnection = {
      ...viduConnection,
      state: 'deleted' as const,
      credentialState: 'saved' as const,
      credentialReference: 'existing-credential-reference'
    };
    await store.save({
      ...seeded,
      providers: [existingProvider],
      connections: [deletedConnection],
    });

    await store.ensureFrozenViduCatalog();

    const snapshot = await store.load();
    expect(snapshot.providers[0]).toEqual(existingProvider);
    expect(snapshot.connections[0]).toEqual(deletedConnection);
    expect(snapshot.capabilities).toEqual(seeded.capabilities);
    expect(snapshot.capabilities.filter((item) => item.id === firstEvidence.id)).toHaveLength(1);
    expect(snapshot.models).toHaveLength(10);
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
      schemaVersion: 3,
      currentConnectionId: null,
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

  it('rejects a package-owned connection whose provider ownership differs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const snapshot = await store.load();
    const provider = snapshot.providers[0];
    const connection = snapshot.connections[0];
    if (!provider || !connection) throw new Error('frozen provider missing');

    await expect(
      store.save({
        ...snapshot,
        providers: [
          {
            ...provider,
            packageId: 'fixture-package',
            packageVersion: '1.0.0'
          }
        ],
        connections: [
          {
            ...connection,
            packageId: 'different-package',
            packageVersion: '1.0.0',
            templateId: 'fixture-template',
            templateKind: 'official',
            credentialSchemaId: 'fixture-credential',
            credentialSchemaVersion: 1,
            credentialVersionId: 'credential-version-fixture',
            connectionPolicyId: 'connection-policy-fixture',
            connectionPolicyRevision: 1,
            discoveryPolicyId: 'discovery-policy-fixture',
            discoveryPolicyRevision: 1,
            endpointPolicyId: 'endpoint-policy-fixture',
            endpointPolicyRevision: 1,
            connectionConfigVersionId: 'connection-config-fixture',
            connectionRevision: 1,
            adapterBindings: [
              {
                adapterId: 'adapter-fixture',
                adapterVersion: '1',
                protocolId: 'protocol.fixture',
                protocolVersion: '1'
              }
            ]
          }
        ],
        protocolBindings: [],
        models: [],
        capabilities: [],
        routingPreferences: []
      })
    ).rejects.toThrow('invalid references');
  });

  it('rejects models that reference an unknown connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));

    await expect(
      store.save({
        schemaVersion: 3,
        currentConnectionId: null,
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
