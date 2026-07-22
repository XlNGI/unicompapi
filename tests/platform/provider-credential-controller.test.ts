import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
