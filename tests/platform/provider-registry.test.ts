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
import { createUserViduRegistryRecords } from '../fixtures/vidu-user-registry';

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

  it('starts with an empty registry on fresh install and persists user records only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const store = new JsonProviderRegistryStore(registryPath);

    const empty = await store.load();
    expect(empty).toMatchObject({
      schemaVersion: 2,
      providers: [],
      connections: [],
      protocolBindings: [],
      models: [],
      capabilities: [],
      routingPreferences: []
    });

    const provider = createProvider({
      id: toProviderId('provider-custom'),
      name: 'Custom provider',
      accessCategory: 'custom_remote',
      identityState: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-custom'),
      providerId: provider.id,
      name: 'Custom connection',
      endpoint: 'https://private.example.test',
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved',
      credentialReference: 'credential-reference-only',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await store.mutate((snapshot) => ({
      snapshot: {
        ...snapshot,
        providers: [provider],
        connections: [connection]
      },
      result: undefined
    }));

    const reloaded = await new JsonProviderRegistryStore(registryPath).load();
    expect(reloaded.providers).toEqual([provider]);
    expect(reloaded.connections).toEqual([connection]);
    expect(reloaded.protocolBindings).toEqual([]);
    expect(JSON.stringify(reloaded)).not.toContain('provider-vidu');
    expect(JSON.stringify(reloaded)).not.toContain('connection-vidu-default');
  });

  it('purges soft-deleted connection tombs without capability history on load', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const store = new JsonProviderRegistryStore(registryPath);
    const vidu = createUserViduRegistryRecords();
    const tombstoneConnection = {
      ...vidu.connections[0],
      state: 'deleted' as const,
      credentialState: 'saved' as const,
      credentialReference: 'existing-credential-reference'
    };
    await store.save({
      schemaVersion: 2,
      providers: vidu.providers,
      connections: [tombstoneConnection],
      protocolBindings: vidu.protocolBindings.slice(0, 1),
      models: vidu.models.slice(0, 5).map((model) => ({
        ...model,
        capabilityEvidenceId: undefined
      })),
      capabilities: [],
      routingPreferences: []
    });

    const snapshot = await new JsonProviderRegistryStore(registryPath).load();
    expect(snapshot.connections).toEqual([]);
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.protocolBindings).toEqual([]);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.capabilities).toEqual([]);
  });

  it('rejects removal or mutation of persisted capability history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const registryPath = path.join(root, 'registry.json');
    const store = new JsonProviderRegistryStore(registryPath);
    const provider = createProvider({
      id: toProviderId('provider-history'),
      name: 'History provider',
      accessCategory: 'custom_remote',
      identityState: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-history'),
      providerId: provider.id,
      name: 'History connection',
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const model = createProviderModel({
      id: toModelId('model-history'),
      providerId: provider.id,
      connectionId: connection.id,
      protocolBindingId: toProtocolBindingId('protocol-history-image'),
      providerModelKey: 'history-model',
      mediaKind: 'image',
      revision: 1,
      displayName: 'History model',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const binding = createProviderProtocolBinding({
      id: toProtocolBindingId('protocol-history-image'),
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: 'history.image.v1',
      protocolVersion: '1',
      mediaKind: 'image',
      adapterKind: 'history_adapter',
      authScheme: 'unknown',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['image_generation'],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const historicalEvidence = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId('capability-history-orphan'),
      modelId: model.id,
      revision: 1,
      capability: 'image_generation',
      state: 'declared_supported',
      source: 'provider_declared',
      recordedAt: timestamp
    });
    await store.save({
      schemaVersion: 2,
      providers: [provider],
      connections: [connection],
      protocolBindings: [binding],
      models: [model],
      capabilities: [historicalEvidence],
      routingPreferences: []
    });
    const current = await store.load();

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
    const fixture = createBaselineRegistryRecords();
    await store.save({
      schemaVersion: 2,
      providers: [fixture.provider],
      connections: [fixture.connection],
      protocolBindings: [fixture.binding],
      models: [fixture.model],
      capabilities: [],
      routingPreferences: []
    });
    const snapshot = await store.load();

    await expect(
      store.save({
        ...snapshot,
        models: snapshot.models.map((model) =>
          model.id === fixture.model.id
            ? { ...model, mediaKind: 'video' as const }
            : model
        )
      })
    ).rejects.toThrow('invalid references');
  });

  it('rejects duplicate revisions in an immutable evidence history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-providers-'));
    roots.push(root);
    const store = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const fixture = createBaselineRegistryRecords();
    await store.save({
      schemaVersion: 2,
      providers: [fixture.provider],
      connections: [fixture.connection],
      protocolBindings: [fixture.binding],
      models: [fixture.model],
      capabilities: [fixture.evidence],
      routingPreferences: []
    });
    const snapshot = await store.load();

    await expect(
      store.save({
        ...snapshot,
        capabilities: [
          ...snapshot.capabilities,
          {
            ...fixture.evidence,
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
    const fixture = createBaselineRegistryRecords();
    await store.save({
      schemaVersion: 2,
      providers: [fixture.provider],
      connections: [fixture.connection],
      protocolBindings: [],
      models: [],
      capabilities: [],
      routingPreferences: []
    });
    const snapshot = await store.load();
    const provider = snapshot.providers[0]!;
    const connection = snapshot.connections[0]!;

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

function createBaselineRegistryRecords() {
  const provider = createProvider({
    id: toProviderId('provider-baseline'),
    name: 'Baseline provider',
    accessCategory: 'custom_remote',
    identityState: 'unverified',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-baseline'),
    providerId: provider.id,
    name: 'Baseline connection',
    state: 'saved',
    identityState: 'unverified',
    credentialState: 'saved',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const binding = createProviderProtocolBinding({
    id: toProtocolBindingId('protocol-baseline-image'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'baseline.image.v1',
    protocolVersion: '1',
    mediaKind: 'image',
    adapterKind: 'baseline_adapter',
    authScheme: 'unknown',
    executionLifecycle: 'synchronous_completed',
    supportedPurposes: ['image_generation'],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const model = createProviderModel({
    id: toModelId('model-baseline'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: binding.id,
    providerModelKey: 'baseline-model',
    mediaKind: 'image',
    revision: 1,
    displayName: 'Baseline model',
    enabled: false,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const evidence = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId('capability-baseline-1'),
    modelId: model.id,
    revision: 1,
    capability: 'image_generation',
    state: 'declared_supported',
    source: 'provider_declared',
    recordedAt: timestamp
  });
  return { provider, connection, binding, model, evidence };
}
