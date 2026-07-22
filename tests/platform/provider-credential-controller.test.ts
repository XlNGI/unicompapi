import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviderConnection,
  createProviderModel,
  createRoutingPreference,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
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
      schemaVersion: 1,
      providers: [provider],
      connections: [connection],
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
      name: 'delete-fixture-model',
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
    await vault.save('credential-delete-fixture', 'fixture-value');
    await registry.save({
      schemaVersion: 1,
      providers: [provider],
      connections: [connection],
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
