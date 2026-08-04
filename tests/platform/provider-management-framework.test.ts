import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRoutingPreference,
  toIsoTimestamp,
  toRoutingPreferenceId,
  type ProviderPackageDescriptor
} from '../../src/domain';
import {
  JsonProviderManagementAuditStore,
  JsonProviderRegistryStore,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderModelCatalogService,
  ProviderPackageRegistry,
  SecureCredentialVault,
  type CredentialProtector,
  type ProviderCredentialRetentionPort,
  type ProviderManagementAdapterPort
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-08-03T14:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T14:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T14:02:00.000Z');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('provider management framework', () => {
  it('lists only safe templates and creates a package-owned connection without transport', async () => {
    const fixture = await frameworkFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const templates = fixture.framework.listTemplates();
    expect(templates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        packageId: 'management.fixture',
        templateId: 'fixture-official-catalog',
        kind: 'official',
        freeConnectionValidation: true,
        modelDiscoveryKind: 'catalog',
        validationAction: 'available',
        modelDiscoveryAction: 'catalog_available'
      }),
      expect.objectContaining({
        templateId: 'fixture-compatible-manual',
        kind: 'compatible_custom',
        baseUrlMode: 'required',
        validationAction: 'available',
        modelDiscoveryAction: 'manual_exact'
      }),
      expect.objectContaining({
        templateId: 'fixture-official-no-free',
        validationAction: 'unsupported',
        modelDiscoveryAction: 'catalog_available'
      })
    ]));
    expect(JSON.stringify(templates)).not.toMatch(
      /fixture\.adapter|fixture\.protocol|api\.management\.test|endpoint-policy/i
    );

    const created = await createConnection(fixture);
    expect(created).toMatchObject({ ok: true, value: { state: 'saved' } });
    if (!created.ok) throw new Error('connection creation failed');
    const snapshot = await fixture.registry.load();
    expect(snapshot.providers.find((provider) =>
      provider.id === created.value.providerId
    )).toMatchObject({
      packageId: 'management.fixture',
      packageVersion: '1.0.0'
    });
    expect(snapshot.connections.find((connection) =>
      connection.id === created.value.connectionId
    )).toMatchObject({
      id: created.value.connectionId,
      templateId: 'fixture-official-catalog',
      credentialSchemaId: 'management.credential',
      endpointPolicyId: 'management.official.endpoint',
      connectionRevision: 1,
      adapterBindings: [{
        adapterId: 'fixture.adapter',
        adapterVersion: '1.0.0',
        protocolId: 'fixture.protocol',
        protocolVersion: '2026-08-03'
      }]
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await fixture.audit.list()).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: 'connection_created',
        outcome: 'succeeded',
        connectionId: created.value.connectionId
      })
    ]);
    expect(await readFile(fixture.vaultPath, 'utf8')).not.toContain(
      'fixture-create-secret'
    );
    await expect(fixture.framework.createConnection({
      packageId: 'management.fixture',
      templateId: 'fixture-official-catalog',
      credentials: { api_key: 'must-never-be-persisted' },
      unsupported: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    expect(await readFile(fixture.vaultPath, 'utf8')).not.toContain(
      'must-never-be-persisted'
    );
  });

  it('marks live management actions as approval-bound when no adapter is installed', async () => {
    const fixture = await frameworkFixture();
    const withoutLiveAdapters = new ProviderManagementFramework(
      fixture.packages,
      fixture.registry,
      fixture.vault,
      new ProviderManagementAdapterRegistry(fixture.packages, []),
      fixture.audit,
      { now: () => t2 }
    );

    expect(withoutLiveAdapters.listTemplates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        templateId: 'fixture-official-catalog',
        validationAction: 'requires_live_api_approval',
        modelDiscoveryAction: 'requires_live_api_approval'
      }),
      expect.objectContaining({
        templateId: 'fixture-compatible-manual',
        validationAction: 'requires_live_api_approval',
        modelDiscoveryAction: 'manual_exact'
      }),
      expect.objectContaining({
        templateId: 'fixture-official-no-free',
        validationAction: 'unsupported',
        modelDiscoveryAction: 'requires_live_api_approval'
      })
    ]));
  });

  it('validates only through the exact approved free adapter and never changes profiles or runtime authorization', async () => {
    const fixture = await frameworkFixture();
    const created = await createConnection(fixture);
    if (!created.ok) throw new Error('connection creation failed');

    const validation = await fixture.framework.validateConnection({
      connectionId: created.value.connectionId
    });
    expect(validation).toMatchObject({
      ok: true,
      value: { state: 'available', observedAt: t1 }
    });
    expect(fixture.calls.validation).toBe(1);
    const snapshot = await fixture.registry.load();
    expect(snapshot.connections.find((connection) =>
      connection.id === created.value.connectionId
    )).toMatchObject({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      lastConnectionValidationAt: t1
    });
    expect(snapshot.models.filter((model) =>
      model.connectionId === created.value.connectionId
    )).toEqual([]);

    const noFree = await fixture.framework.createConnection({
      packageId: 'management.fixture',
      templateId: 'fixture-official-no-free',
      name: 'No free validation',
      credentials: { api_key: 'fixture-no-free-secret' }
    });
    if (!noFree.ok) throw new Error('no-free connection creation failed');
    await expect(fixture.framework.validateConnection({
      connectionId: noFree.value.connectionId
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'free_validation_unavailable' }
    });
    expect(fixture.calls.validation).toBe(1);

    const withoutPort = new ProviderManagementFramework(
      fixture.packages,
      fixture.registry,
      fixture.vault,
      new ProviderManagementAdapterRegistry(fixture.packages, []),
      fixture.audit,
      { now: () => t2 }
    );
    await expect(withoutPort.validateConnection({
      connectionId: created.value.connectionId
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' }
    });
    expect(fixture.calls.validation).toBe(1);
  });

  it('activates exactly one live-validated connection and rejects stale or invalid switches', async () => {
    const fixture = await frameworkFixture();
    const first = await createConnection(fixture);
    const second = await createConnection(fixture);
    if (!first.ok || !second.ok) throw new Error('connection creation failed');

    let snapshot = await fixture.registry.load();
    const activated = await fixture.framework.activateConnection({
      connectionId: first.value.connectionId,
      expectedRegistryRevision: snapshot.registryRevision
    });
    expect(activated).toMatchObject({ ok: true, value: { state: 'active' } });
    snapshot = await fixture.registry.load();
    expect(snapshot.currentConnectionId).toBe(first.value.connectionId);

    await expect(fixture.framework.activateConnection({
      connectionId: second.value.connectionId,
      expectedRegistryRevision: (snapshot.registryRevision ?? 1) - 1
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_registry_conflict' }
    });
    expect((await fixture.registry.load()).currentConnectionId).toBe(
      first.value.connectionId
    );

    fixture.validation.state = 'unavailable';
    fixture.validation.identityState = 'verification_failed';
    fixture.validation.credentialState = 'invalid';
    snapshot = await fixture.registry.load();
    await expect(fixture.framework.activateConnection({
      connectionId: second.value.connectionId,
      expectedRegistryRevision: snapshot.registryRevision
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'connection_not_available' }
    });
    expect((await fixture.registry.load()).currentConnectionId).toBe(
      first.value.connectionId
    );
  });

  it('does not silently activate a disabled connection', async () => {
    const fixture = await frameworkFixture();
    const created = await createConnection(fixture);
    if (!created.ok) throw new Error('connection creation failed');
    await fixture.framework.setConnectionEnabled({
      connectionId: created.value.connectionId,
      enabled: false
    });
    const snapshot = await fixture.registry.load();

    await expect(fixture.framework.activateConnection({
      connectionId: created.value.connectionId,
      expectedRegistryRevision: snapshot.registryRevision
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'connection_not_available' }
    });
    expect(fixture.calls.validation).toBe(0);
    expect((await fixture.registry.load()).currentConnectionId).toBeNull();
  });

  it('allows only one concurrent activation for the same registry revision', async () => {
    const fixture = await frameworkFixture();
    const first = await createConnection(fixture);
    const second = await createConnection(fixture);
    if (!first.ok || !second.ok) throw new Error('connection creation failed');
    const revision = (await fixture.registry.load()).registryRevision;

    const outcomes = await Promise.all([
      fixture.framework.activateConnection({
        connectionId: first.value.connectionId,
        expectedRegistryRevision: revision
      }),
      fixture.framework.activateConnection({
        connectionId: second.value.connectionId,
        expectedRegistryRevision: revision
      })
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toMatchObject([
      { error: { code: 'provider_registry_conflict' } }
    ]);
    const current = (await fixture.registry.load()).currentConnectionId;
    expect([first.value.connectionId, second.value.connectionId]).toContain(current);
  });

  it('synchronizes exact catalog keys without inferring capabilities and marks disappeared models missing', async () => {
    const fixture = await frameworkFixture();
    const created = await createAndValidate(fixture);
    fixture.catalog.entries = [
      { providerModelKey: 'model.alpha', displayName: 'Model Alpha' },
      { providerModelKey: 'model.beta', displayName: 'Model Beta' }
    ];
    const first = await fixture.framework.syncModelCatalog({
      connectionId: created.connectionId
    });
    expect(first).toMatchObject({
      ok: true,
      value: { count: 2, catalogRevision: 1, observedAt: t2 }
    });
    let snapshot = await fixture.registry.load();
    expect(snapshot.protocolBindings.filter((binding) =>
      binding.connectionId === created.connectionId
    )).toEqual([
      expect.objectContaining({
        protocolId: 'fixture.protocol',
        protocolVersion: '2026-08-03',
        adapterKind: 'fixture.adapter',
        mediaKind: 'unknown',
        executionLifecycle: 'unknown',
        supportedPurposes: []
      })
    ]);
    const createdModels = snapshot.models.filter((model) =>
      model.connectionId === created.connectionId
    );
    expect(createdModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerModelKey: 'model.alpha',
        catalogState: 'present',
        enabled: false
      }),
      expect.objectContaining({
        providerModelKey: 'model.beta',
        catalogState: 'present',
        enabled: false
      })
    ]));
    const createdModelIds = new Set<string>(createdModels.map((model) => model.id));
    expect(snapshot.capabilities.filter((capability) =>
      createdModelIds.has(capability.modelId)
    )).toEqual([]);
    expect(snapshot.modelProfiles?.filter((profile) =>
      createdModelIds.has(profile.modelId)
    )).toEqual([]);

    fixture.catalog.entries = [
      { providerModelKey: 'model.alpha', displayName: 'Model Alpha 2' }
    ];
    const beta = createdModels.find((model) => model.providerModelKey === 'model.beta');
    if (!beta) throw new Error('beta model missing after first catalog sync');
    await fixture.registry.mutate((current) => ({
      snapshot: {
        ...current,
        routingPreferences: [createRoutingPreference({
          id: toRoutingPreferenceId('routing-management-beta'),
          purpose: 'text_execution',
          modelId: beta.id,
          priority: 0,
          enabled: true,
          updatedAt: t1
        })]
      },
      result: undefined
    }));
    await fixture.framework.syncModelCatalog({ connectionId: created.connectionId });
    snapshot = await fixture.registry.load();
    expect(snapshot.models.find((model) =>
      model.connectionId === created.connectionId &&
      model.providerModelKey === 'model.alpha'
    ))
      .toMatchObject({ catalogState: 'present', catalogRevision: 2 });
    expect(snapshot.models.find((model) =>
      model.connectionId === created.connectionId &&
      model.providerModelKey === 'model.beta'
    ))
      .toMatchObject({ catalogState: 'missing', enabled: false, catalogRevision: 2 });
    expect(snapshot.routingPreferences.find((preference) =>
      preference.modelId === beta.id
    )?.enabled).toBe(false);

    fixture.catalog.entries = [
      { providerModelKey: 'duplicate', displayName: 'First' },
      { providerModelKey: 'duplicate', displayName: 'Second' }
    ];
    const before = await fixture.registry.load();
    await expect(fixture.framework.syncModelCatalog({
      connectionId: created.connectionId
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    expect(await fixture.registry.load()).toEqual(before);
  });

  it('permits exact manual registration only on a manual template and never creates a profile', async () => {
    const fixture = await frameworkFixture();
    const manual = await fixture.framework.createConnection({
      packageId: 'management.fixture',
      templateId: 'fixture-compatible-manual',
      name: 'Manual custom',
      endpoint: 'https://gateway.management.test/v1',
      credentials: { api_key: 'fixture-manual-secret' }
    });
    if (!manual.ok) throw new Error('manual connection creation failed');
    await fixture.framework.validateConnection({ connectionId: manual.value.connectionId });
    const registered = await fixture.framework.registerExactModel({
      connectionId: manual.value.connectionId,
      providerModelKey: 'deployment-exact-001',
      displayName: 'Deployment 001'
    });
    expect(registered).toMatchObject({
      ok: true,
      value: { state: 'registered_without_profile' }
    });
    const snapshot = await fixture.registry.load();
    const manualModels = snapshot.models.filter((model) =>
      model.connectionId === manual.value.connectionId
    );
    expect(manualModels).toEqual([
      expect.objectContaining({
        providerModelKey: 'deployment-exact-001',
        enabled: false,
        activeProfileId: undefined
      })
    ]);
    const manualModelIds = new Set<string>(manualModels.map((model) => model.id));
    expect(snapshot.modelProfiles?.filter((profile) =>
      manualModelIds.has(profile.modelId)
    )).toEqual([]);

    const official = await createAndValidate(fixture);
    await expect(fixture.framework.registerExactModel({
      connectionId: official.connectionId,
      providerModelKey: 'must-not-register',
      displayName: 'Must not register'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'manual_registration_unavailable' }
    });
    await expect(fixture.framework.syncModelCatalog({
      connectionId: manual.value.connectionId
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'catalog_sync_unavailable' }
    });
  });

  it('rotates structured credentials, retains active versions, and clears validation without exposing values', async () => {
    const active = new Set<string>();
    const retention: ProviderCredentialRetentionPort = {
      async hasActiveReference(version) { return active.has(version); },
      async listActiveCredentialVersions() { return [...active]; },
      async markCredentialUnavailable() {}
    };
    const fixture = await frameworkFixture({ retention });
    const created = await createAndValidate(fixture);
    const before = (await fixture.registry.load()).connections.find((connection) =>
      connection.id === created.connectionId
    );
    if (!before) throw new Error('created connection missing before rotation');
    active.add(before.credentialVersionId!);

    const result = await fixture.framework.rotateCredential({
      connectionId: created.connectionId,
      credentials: { api_key: 'fixture-rotated-secret' }
    });
    expect(result).toMatchObject({
      ok: true,
      value: { previousCredential: 'retained_for_active_operations' }
    });
    const after = (await fixture.registry.load()).connections.find((connection) =>
      connection.id === created.connectionId
    );
    if (!after) throw new Error('created connection missing after rotation');
    expect(after).toMatchObject({
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved',
      lastConnectionValidationAt: undefined,
      connectionRevision: 2
    });
    expect(after.credentialVersionId).not.toBe(before.credentialVersionId);
    expect(await fixture.vault.status(before.credentialReference!)).toBe('saved');
    await expect(fixture.vault.useRecord(after.credentialReference!, async (record) =>
      record.values.api_key
    )).resolves.toBe('fixture-rotated-secret');
    expect(await readFile(fixture.vaultPath, 'utf8')).not.toMatch(
      /fixture-create-secret|fixture-rotated-secret/
    );
    expect(JSON.stringify(await fixture.audit.list())).not.toMatch(
      /fixture-create-secret|fixture-rotated-secret/
    );
  });

  it('enables only a present model with a verified exact profile and cascades connection disable', async () => {
    const fixture = await frameworkFixture();
    const created = await createAndValidate(fixture);
    fixture.catalog.entries = [{ providerModelKey: 'model.routable', displayName: 'Routable' }];
    await fixture.framework.syncModelCatalog({ connectionId: created.connectionId });
    let snapshot = await fixture.registry.load();
    const model = snapshot.models.find((candidate) =>
      candidate.connectionId === created.connectionId &&
      candidate.providerModelKey === 'model.routable'
    );
    if (!model) throw new Error('routable model missing after catalog sync');
    await expect(fixture.framework.setModelEnabled({
      modelId: model.id,
      enabled: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'model_not_routable' }
    });

    const catalog = new ProviderModelCatalogService(fixture.registry);
    await catalog.registerDefinition({
      schemaVersion: 1,
      definitionId: 'definition.routable',
      packageId: 'management.fixture',
      packageVersion: '1.0.0',
      providerModelKey: 'model.routable',
      profileTemplates: [{
        templateId: 'profile-template.routable',
        adapterKey: 'fixture.adapter',
        protocolDefinitionId: 'fixture.protocol',
        sourceDocumentRevision: 'synthetic-contract@1',
        features: [{
          productFeature: 'text_chat',
          parameterSchemaId: 'parameters.text-chat.v1',
          resultSchemaId: 'results.text-chat.v1',
          usageSchemaId: 'usage.text-chat.v1',
          constraintSetId: 'constraints.text-chat.v1'
        }]
      }]
    });
    const profile = await catalog.instantiateProfile({
      modelId: model.id,
      definitionId: 'definition.routable',
      profileTemplateId: 'profile-template.routable'
    });
    await fixture.registry.mutate((current) => ({
      snapshot: {
        ...current,
        modelProfiles: current.modelProfiles!.map((candidate) =>
          candidate.profileId === profile.profileId
            ? { ...candidate, status: 'verified' as const }
            : candidate
        ),
        routingPreferences: [createRoutingPreference({
          id: toRoutingPreferenceId('routing-management-fixture'),
          purpose: 'text_execution',
          modelId: model.id,
          priority: 0,
          enabled: true,
          updatedAt: t2
        })]
      },
      result: undefined
    }));
    await expect(fixture.framework.setModelEnabled({
      modelId: model.id,
      enabled: true
    })).resolves.toMatchObject({ ok: true, value: { state: 'enabled' } });
    await expect(fixture.framework.setModelEnabled({
      modelId: model.id,
      enabled: false
    })).resolves.toMatchObject({ ok: true, value: { state: 'disabled' } });
    snapshot = await fixture.registry.load();
    expect(snapshot.routingPreferences.find((preference) =>
      preference.modelId === model.id
    )?.enabled).toBe(false);
    await fixture.framework.setModelEnabled({ modelId: model.id, enabled: true });
    await fixture.registry.mutate((current) => ({
      snapshot: {
        ...current,
        routingPreferences: current.routingPreferences.map((preference) =>
          preference.modelId === model.id
            ? { ...preference, enabled: true, updatedAt: t2 }
            : preference
        )
      },
      result: undefined
    }));
    await expect(fixture.framework.setConnectionEnabled({
      connectionId: created.connectionId,
      enabled: false
    })).resolves.toMatchObject({ ok: true, value: { state: 'disabled' } });
    snapshot = await fixture.registry.load();
    expect(snapshot.connections.find((connection) =>
      connection.id === created.connectionId
    )?.state).toBe('disabled');
    expect(snapshot.models.find((candidate) => candidate.id === model.id)?.enabled).toBe(false);
    expect(snapshot.routingPreferences.find((preference) =>
      preference.modelId === model.id
    )?.enabled).toBe(false);

    const unregisteredViduModel = snapshot.models.find((candidate) =>
      candidate.connectionId === 'connection-vidu-default'
    );
    if (!unregisteredViduModel) throw new Error('frozen Vidu model fixture missing');
    await expect(fixture.framework.setModelEnabled({
      modelId: unregisteredViduModel.id,
      enabled: false
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'package_not_found' }
    });
    expect((await fixture.registry.load()).models.find((candidate) =>
      candidate.id === unregisteredViduModel.id
    )?.enabled).toBe(unregisteredViduModel.enabled);
  });

  it('blocks deletion with active operations, then explicitly abandons and soft-deletes without history loss', async () => {
    const activeVersions: string[] = [];
    const abandoned: string[][] = [];
    const retention: ProviderCredentialRetentionPort = {
      async hasActiveReference(version) { return activeVersions.includes(version); },
      async listActiveCredentialVersions() { return [...activeVersions]; },
      async markCredentialUnavailable(input) {
        abandoned.push([...input.credentialVersionIds]);
      }
    };
    const fixture = await frameworkFixture({ retention });
    const created = await createAndValidate(fixture);
    const beforeActivation = await fixture.registry.load();
    await fixture.framework.activateConnection({
      connectionId: created.connectionId,
      expectedRegistryRevision: beforeActivation.registryRevision
    });
    fixture.catalog.entries = [{ providerModelKey: 'model.history', displayName: 'History' }];
    await fixture.framework.syncModelCatalog({ connectionId: created.connectionId });
    const before = await fixture.registry.load();
    const beforeConnection = before.connections.find((connection) =>
      connection.id === created.connectionId
    );
    if (!beforeConnection) throw new Error('created connection missing before deletion');
    activeVersions.push(beforeConnection.credentialVersionId!);
    await expect(fixture.framework.deleteConnection({
      connectionId: created.connectionId,
      confirmLocalDeletion: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'active_operations_present' }
    });
    expect((await fixture.registry.load()).connections.find((connection) =>
      connection.id === created.connectionId
    )?.state).toBe('available');

    await expect(fixture.framework.deleteConnection({
      connectionId: created.connectionId,
      confirmLocalDeletion: true,
      abandonActiveOperations: true
    })).resolves.toMatchObject({
      ok: true,
      value: { state: 'deleted', remoteRevocation: 'not_attempted' }
    });
    const after = await fixture.registry.load();
    expect(after.currentConnectionId).toBeNull();
    expect(after.providers.find((provider) =>
      provider.id === beforeConnection.providerId
    )).toBeDefined();
    expect(after.connections.find((connection) =>
      connection.id === created.connectionId
    )).toMatchObject({
      state: 'deleted',
      credentialState: 'deleted',
      credentialReference: undefined,
      endpoint: undefined
    });
    const afterModels = after.models.filter((model) =>
      model.connectionId === created.connectionId
    );
    expect(afterModels).toHaveLength(1);
    expect(afterModels[0].providerModelKey).toBe('model.history');
    expect(abandoned).toEqual([[beforeConnection.credentialVersionId]]);
    expect(await fixture.vault.status(beforeConnection.credentialReference!))
      .toBe('not_configured');
  });
});

describe('provider management audit store', () => {
  it('serializes concurrent appends and falls back to the last valid backup', async () => {
    const root = await makeRoot();
    const auditPath = path.join(root, 'provider-audit.json');
    const first = new JsonProviderManagementAuditStore(auditPath);
    const second = new JsonProviderManagementAuditStore(auditPath);
    await first.append({
      eventId: 'provider-audit-1',
      action: 'connection_created',
      outcome: 'succeeded',
      connectionId: 'connection-audit-1',
      occurredAt: t0
    });
    await Promise.all([
      first.append({
        eventId: 'provider-audit-2',
        action: 'connection_validated',
        outcome: 'succeeded',
        connectionId: 'connection-audit-1',
        safeCode: 'available',
        occurredAt: t1
      }),
      second.append({
        eventId: 'provider-audit-3',
        action: 'catalog_synced',
        outcome: 'succeeded',
        connectionId: 'connection-audit-1',
        count: 2,
        occurredAt: t2
      })
    ]);
    expect((await first.list()).map((event) => event.sequence)).toEqual([1, 2, 3]);
    await writeFile(auditPath, '{broken', 'utf8');
    const recovered = await first.list();
    expect(recovered.map((event) => event.sequence)).toEqual([1, 2]);
  });
});

interface Fixture {
  readonly framework: ProviderManagementFramework;
  readonly packages: ProviderPackageRegistry;
  readonly registry: JsonProviderRegistryStore;
  readonly vault: SecureCredentialVault;
  readonly audit: JsonProviderManagementAuditStore;
  readonly vaultPath: string;
  readonly calls: { validation: number; discovery: number };
  readonly validation: {
    state: 'available' | 'unavailable';
    identityState: 'verified' | 'verification_failed';
    credentialState: 'valid' | 'invalid' | 'verification_unavailable';
  };
  readonly catalog: { entries: { providerModelKey: string; displayName: string }[] };
}

async function frameworkFixture(
  options: { readonly retention?: ProviderCredentialRetentionPort } = {}
): Promise<Fixture> {
  const root = await makeRoot();
  const packages = new ProviderPackageRegistry([packageFixture()]);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const vaultPath = path.join(root, 'credentials.json');
  const vault = new SecureCredentialVault(vaultPath, protector());
  const audit = new JsonProviderManagementAuditStore(path.join(root, 'provider-audit.json'));
  const calls = { validation: 0, discovery: 0 };
  const validation: Fixture['validation'] = {
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid'
  };
  const catalog: Fixture['catalog'] = { entries: [] };
  const adapter: ProviderManagementAdapterPort = {
    identity: {
      packageId: 'management.fixture',
      adapterId: 'fixture.adapter',
      adapterVersion: '1.0.0',
      protocolId: 'fixture.protocol',
      protocolVersion: '2026-08-03'
    },
    async validateConnection(input) {
      calls.validation += 1;
      expect(input.credentials).toMatchObject({
        schemaId: 'management.credential',
        values: { api_key: expect.stringMatching(/^fixture-/) }
      });
      return {
        ...validation,
        observedAt: t1,
        safeCode: 'synthetic_validation_passed'
      };
    },
    async discoverModels(input) {
      calls.discovery += 1;
      expect(input.credentials.schemaId).toBe('management.credential');
      return { entries: [...catalog.entries], observedAt: t2 };
    }
  };
  const adapters = new ProviderManagementAdapterRegistry(packages, [adapter]);
  return {
    packages,
    registry,
    vault,
    audit,
    vaultPath,
    calls,
    validation,
    catalog,
    framework: new ProviderManagementFramework(
      packages,
      registry,
      vault,
      adapters,
      audit,
      { now: () => t2, credentialRetention: options.retention }
    )
  };
}

async function createConnection(fixture: Fixture) {
  return fixture.framework.createConnection({
    packageId: 'management.fixture',
    templateId: 'fixture-official-catalog',
    name: 'Fixture official',
    credentials: { api_key: 'fixture-create-secret' }
  });
}

async function createAndValidate(fixture: Fixture): Promise<{ connectionId: string }> {
  const created = await createConnection(fixture);
  if (!created.ok) throw new Error('connection creation failed');
  const validated = await fixture.framework.validateConnection({
    connectionId: created.value.connectionId
  });
  if (!validated.ok) throw new Error('connection validation failed');
  return { connectionId: created.value.connectionId };
}

function packageFixture(): ProviderPackageDescriptor {
  return {
    packageId: 'management.fixture',
    packageVersion: '1.0.0',
    displayName: 'Management Fixture',
    credentialSchemas: [{
      schemaId: 'management.credential',
      version: 1,
      fields: [{
        key: 'api_key',
        label: 'API key',
        secret: true,
        required: true,
        kind: 'token'
      }]
    }],
    endpointPolicies: [
      endpointPolicy(
        'management.official.endpoint',
        ['api.management.test'],
        'https://api.management.test/v1'
      ),
      endpointPolicy(
        'management.no-free.endpoint',
        ['api-no-free.management.test'],
        'https://api-no-free.management.test/v1'
      ),
      endpointPolicy('management.custom.endpoint', ['gateway.management.test'])
    ],
    adapters: [{
      adapterId: 'fixture.adapter',
      adapterVersion: '1.0.0',
      protocolId: 'fixture.protocol',
      protocolVersion: '2026-08-03',
      operations: ['validate_connection', 'discover_models', 'submit']
    }],
    templates: [
      template('fixture-official-catalog', 'official', 'fixed', true, 'catalog',
        'management.official.endpoint'),
      template('fixture-compatible-manual', 'compatible_custom', 'required', true,
        'manual_exact', 'management.custom.endpoint'),
      template('fixture-official-no-free', 'official', 'fixed', false, 'catalog',
        'management.no-free.endpoint')
    ]
  };
}

function template(
  templateId: string,
  kind: 'official' | 'compatible_custom',
  baseUrlMode: 'fixed' | 'required',
  freeConnectionValidation: boolean,
  modelDiscoveryKind: 'catalog' | 'manual_exact',
  endpointPolicyId: string
): ProviderPackageDescriptor['templates'][number] {
  return {
    templateId,
    kind,
    displayName: templateId,
    baseUrlMode,
    credentialSchemaId: 'management.credential',
    credentialSchemaVersion: 1,
    connectionPolicyId: `connection-policy.${templateId}`,
    connectionPolicyRevision: 1,
    discoveryPolicyId: `discovery-policy.${templateId}`,
    discoveryPolicyRevision: 1,
    endpointPolicyId,
    endpointPolicyRevision: 1,
    adapterBindings: [{ adapterId: 'fixture.adapter', adapterVersion: '1.0.0' }],
    freeConnectionValidation,
    modelDiscoveryKind
  };
}

function endpointPolicy(
  policyId: string,
  allowedHosts: readonly string[],
  fixedBaseUrl?: string
): ProviderPackageDescriptor['endpointPolicies'][number] {
  return {
    policyId,
    revision: 1,
    allowedSchemes: ['https'],
    allowedHosts,
    allowedPorts: [443],
    allowedPathPrefixes: ['/v1'],
    redirectPolicy: 'same_origin',
    proxyPolicy: 'system',
    allowLoopback: false,
    allowPrivateNetwork: false,
    allowLoopbackHttp: false,
    dnsRebindingProtection: 'required',
    fixedBaseUrl
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-management-'));
  roots.push(root);
  return root;
}

function protector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
    unprotect: (value) =>
      Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8')
  };
}
