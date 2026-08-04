import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  toRoutingPreferenceId
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  ProviderCredentialController,
  SecureCredentialVault,
  type CredentialProtector
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ProviderCredentialController', () => {
  it('saves, checks, and deletes only the local protected credential', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-credential-'));
    roots.push(root);
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vaultPath = path.join(root, 'secure-credentials.json');
    const controller = new ProviderCredentialController(
      registry,
      new SecureCredentialVault(vaultPath, protector())
    );
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
      state: 'unconfigured',
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

    expect(
      await controller.saveCredential({
        connectionId: connection.id,
        value: 'fixture-value'
      })
    ).toEqual({ ok: true, value: { state: 'saved' } });
    expect(await controller.getCredentialStatus({ connectionId: connection.id }))
      .toEqual({ ok: true, value: { state: 'saved' } });
    expect(
      await controller.checkCredentialStorage({ connectionId: connection.id })
    ).toEqual({
      ok: true,
      value: { state: 'saved', remoteValidation: 'not_attempted' }
    });
    expect(await readFile(vaultPath, 'utf8')).not.toContain('fixture-value');

    expect(
      await controller.deleteLocalCredential({ connectionId: connection.id })
    ).toEqual({
      ok: true,
      value: { state: 'deleted', remoteRevocation: 'not_attempted' }
    });
    const savedConnection = (await registry.load()).connections[0];
    expect(savedConnection.credentialState).toBe('deleted');
    expect(savedConnection.credentialReference).toBeUndefined();
  });

  it('does not create a vault entry for an unknown connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-credential-'));
    roots.push(root);
    const controller = new ProviderCredentialController(
      new JsonProviderRegistryStore(path.join(root, 'registry.json')),
      new SecureCredentialVault(path.join(root, 'secure-credentials.json'), protector())
    );

    expect(
      await controller.saveCredential({
        connectionId: 'connection-missing',
        value: 'fixture-value'
      })
    ).toMatchObject({ ok: false, error: { code: 'connection_not_found' } });
  });

  it('rotates a replacement credential and clears prior connection validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-credential-'));
    roots.push(root);
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vault = new SecureCredentialVault(
      path.join(root, 'secure-credentials.json'),
      protector()
    );
    const controller = new ProviderCredentialController(registry, vault);
    const provider = createProvider({
      id: toProviderId('provider-replace-fixture'),
      name: 'Replace fixture provider',
      accessCategory: 'online',
      identityState: 'verified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-replace-fixture'),
      providerId: provider.id,
      name: 'Replace fixture connection',
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      credentialReference: 'credential-replace-old',
      lastConnectionValidationAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await vault.save('credential-replace-old', 'old-fixture-value');
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

    expect(
      await controller.saveCredential({
        connectionId: connection.id,
        value: 'new-fixture-value'
      })
    ).toEqual({ ok: true, value: { state: 'saved' } });
    const savedConnection = (await registry.load()).connections[0];
    expect(savedConnection).toMatchObject({
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved'
    });
    expect(savedConnection.lastConnectionValidationAt).toBeUndefined();
    expect(savedConnection.credentialReference).not.toBe(
      connection.credentialReference
    );
    expect(await vault.status('credential-replace-old')).toBe('not_configured');
    await expect(
      vault.useValue(savedConnection.credentialReference!, async (value) => value)
    ).resolves.toBe('new-fixture-value');
  });

  it('keeps the previous credential and validation facts when registry save fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-credential-'));
    roots.push(root);
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vaultPath = path.join(root, 'secure-credentials.json');
    const vault = new SecureCredentialVault(vaultPath, protector());
    const controller = new ProviderCredentialController(registry, vault);
    const provider = createProvider({
      id: toProviderId('provider-rollback-fixture'),
      name: 'Rollback fixture provider',
      accessCategory: 'online',
      identityState: 'verified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-rollback-fixture'),
      providerId: provider.id,
      name: 'Rollback fixture connection',
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      credentialReference: 'credential-rollback-old',
      lastConnectionValidationAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await vault.save('credential-rollback-old', 'old-fixture-value');
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
    vi.spyOn(registry, 'save').mockRejectedValueOnce(
      new Error('fixture registry failure')
    );

    expect(
      await controller.saveCredential({
        connectionId: connection.id,
        value: 'new-fixture-value'
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'credential_operation_failed' }
    });
    expect((await registry.load()).connections[0]).toEqual(connection);
    await expect(
      vault.useValue('credential-rollback-old', async (value) => value)
    ).resolves.toBe('old-fixture-value');
    const vaultSnapshot = JSON.parse(await readFile(vaultPath, 'utf8')) as {
      entries: { reference: string }[];
    };
    expect(vaultSnapshot.entries.map((entry) => entry.reference)).toEqual([
      'credential-rollback-old'
    ]);
  });

  it('soft-deletes a connection while preserving historical model facts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-credential-'));
    roots.push(root);
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vault = new SecureCredentialVault(
      path.join(root, 'secure-credentials.json'),
      protector()
    );
    const controller = new ProviderCredentialController(registry, vault);
    const provider = createProvider({
      id: toProviderId('provider-delete-fixture'),
      name: 'Delete fixture provider',
      accessCategory: 'custom_remote',
      identityState: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-delete-fixture'),
      providerId: provider.id,
      name: 'Delete fixture connection',
      endpoint: 'https://fixture.invalid',
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'saved',
      credentialReference: 'credential-delete-fixture',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const model = createProviderModel({
      id: toModelId('model-delete-fixture'),
      providerId: provider.id,
      connectionId: connection.id,
      protocolBindingId: toProtocolBindingId('protocol-delete-fixture'),
      providerModelKey: 'delete-fixture-model',
      mediaKind: 'unknown',
      revision: 1,
      displayName: 'Delete fixture model',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const routing = createRoutingPreference({
      id: toRoutingPreferenceId('routing-delete-fixture'),
      purpose: 'fixture_purpose',
      modelId: model.id,
      priority: 0,
      enabled: true,
      updatedAt: timestamp
    });
    const binding = createProviderProtocolBinding({
      id: model.protocolBindingId,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: 'fixture.unclassified',
      protocolVersion: '1',
      mediaKind: 'unknown',
      adapterKind: 'unavailable',
      authScheme: 'unknown',
      executionLifecycle: 'unknown',
      supportedPurposes: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await vault.save('credential-delete-fixture', 'fixture-value');
    await registry.save({
      schemaVersion: 3,
      currentConnectionId: null,
      providers: [provider],
      connections: [connection],
      protocolBindings: [binding],
      models: [model],
      capabilities: [],
      routingPreferences: [routing]
    });

    expect(await controller.deleteConnection({ connectionId: connection.id }))
      .toEqual({
        ok: true,
        value: { state: 'deleted', remoteRevocation: 'not_attempted' }
      });
    const snapshot = await registry.load();
    expect(snapshot.connections[0]).toMatchObject({
      state: 'deleted',
      credentialState: 'deleted'
    });
    expect(snapshot.connections[0].endpoint).toBeUndefined();
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0].enabled).toBe(false);
    expect(snapshot.routingPreferences[0].enabled).toBe(false);
    expect(await vault.status('credential-delete-fixture')).toBe('not_configured');
  });
});

function protector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
    unprotect: (value) =>
      Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8')
  };
}
