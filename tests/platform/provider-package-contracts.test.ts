import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPackageDescriptor } from '../../src/domain';
import {
  JsonProviderRegistryStore,
  ProviderConnectionContractService,
  ProviderPackageContractError,
  ProviderPackageRegistry,
  SecureCredentialVault,
  type CredentialProtector
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ProviderPackageRegistry', () => {
  it('publishes only safe template fields and resolves exact adapter contracts', () => {
    const registry = new ProviderPackageRegistry([packageFixture()]);

    const templates = registry.listSafeTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0]).toMatchObject({
      packageId: 'fixture-package',
      templateId: 'fixture-official',
      kind: 'official',
      baseUrlMode: 'fixed',
      credentialFields: [
        { key: 'api_key', secret: true, required: true },
        { key: 'organization', secret: false, required: false }
      ]
    });
    const serialized = JSON.stringify(templates);
    expect(serialized).not.toContain('adapter-fixture');
    expect(serialized).not.toContain('protocol.fixture');
    expect(serialized).not.toContain('api.fixture.test');
    expect(serialized).not.toContain('endpoint-policy');

    expect(
      registry.resolveAdapter(
        'fixture-package',
        'adapter-fixture',
        '1.0.0',
        'protocol.fixture',
        '2026-08-01'
      )
    ).toMatchObject({ adapterId: 'adapter-fixture' });
    expect(() =>
      registry.resolveAdapter(
        'fixture-package',
        'adapter-fixture',
        '1.0.0',
        'protocol.guessed',
        '1'
      )
    ).toThrowError(ProviderPackageContractError);
  });

  it('rejects package/template ownership gaps and unknown adapters', () => {
    const fixture = packageFixture();
    expect(
      () =>
        new ProviderPackageRegistry([
          {
            ...fixture,
            templates: [
              {
                ...fixture.templates[0],
                adapterBindings: [
                  { adapterId: 'adapter-missing', adapterVersion: '1.0.0' }
                ]
              }
            ]
          }
        ])
    ).toThrow('unknown adapter');

    const registry = new ProviderPackageRegistry([fixture]);
    expect(() => registry.resolveTemplate('fixture-package', 'missing-template'))
      .toThrow('does not belong');
    expect(() => registry.resolveTemplate('missing-package', 'fixture-official'))
      .toThrow('not registered');
  });

  it('enforces versioned endpoint policy before any transport exists', () => {
    const registry = new ProviderPackageRegistry([packageFixture()]);
    const official = registry.resolveTemplate('fixture-package', 'fixture-official');
    const custom = registry.resolveTemplate('fixture-package', 'fixture-compatible');

    expect(registry.resolveEndpoint(official, undefined, false)).toBe(
      'https://api.fixture.test/v1'
    );
    expect(() =>
      registry.resolveEndpoint(official, 'https://other.example/v1', false)
    ).toThrow('cannot be overridden');
    expect(
      registry.resolveEndpoint(
        custom,
        'https://gateway.example.test/v1/chat',
        false
      )
    ).toBe('https://gateway.example.test/v1/chat');
    for (const endpoint of [
      'http://gateway.example.test/v1',
      'https://127.0.0.1/v1',
      'https://localhost./v1',
      'https://10.1.2.3/v1',
      'https://gateway.example.test/admin',
      'https://user:password@gateway.example.test/v1',
      'https://gateway.example.test/v1?token=forbidden'
    ]) {
      expect(() => registry.resolveEndpoint(custom, endpoint, false)).toThrow(
        ProviderPackageContractError
      );
    }
  });
});

describe('ProviderConnectionContractService', () => {
  it('atomically saves package-owned metadata and an encrypted structured credential', async () => {
    const root = await makeRoot();
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vaultPath = path.join(root, 'credentials.json');
    const vault = new SecureCredentialVault(vaultPath, protector());
    const service = new ProviderConnectionContractService(
      new ProviderPackageRegistry([packageFixture()]),
      registry,
      vault
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await service.saveConnection({
      packageId: 'fixture-package',
      templateId: 'fixture-compatible',
      name: 'Fixture compatible',
      endpoint: 'https://gateway.example.test/v1',
      credentials: {
        api_key: 'fixture-secret-value',
        organization: 'fixture-org'
      }
    });

    expect(result).toMatchObject({ ok: true, value: { state: 'saved' } });
    const snapshot = await registry.load();
    expect(snapshot.providers.at(-1)).toMatchObject({
      packageId: 'fixture-package',
      packageVersion: '1.0.0'
    });
    const connection = snapshot.connections.at(-1);
    expect(connection).toMatchObject({
      packageId: 'fixture-package',
      templateId: 'fixture-compatible',
      templateKind: 'compatible_custom',
      credentialSchemaId: 'fixture-credential',
      credentialSchemaVersion: 1,
      connectionPolicyId: 'fixture-connection-policy',
      discoveryPolicyId: 'fixture-discovery-policy',
      endpointPolicyId: 'fixture-compatible-endpoint-policy',
      endpointPolicyRevision: 1,
      connectionRevision: 1,
      adapterBindings: [
        {
          adapterId: 'adapter-fixture',
          adapterVersion: '1.0.0',
          protocolId: 'protocol.fixture',
          protocolVersion: '2026-08-01'
        }
      ]
    });
    expect(connection?.connectionConfigVersionId).toMatch(/^connection-config-/);
    expect(connection?.credentialVersionId).toMatch(/^credential-version-/);
    expect(await readFile(vaultPath, 'utf8')).not.toContain('fixture-secret-value');
    await expect(
      vault.useRecord(connection!.credentialReference!, async (record) => record)
    ).resolves.toEqual({
      schemaId: 'fixture-credential',
      schemaVersion: 1,
      values: {
        api_key: 'fixture-secret-value',
        organization: 'fixture-org'
      }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects arbitrary REST/protocol fields and package mismatches before vault writes', async () => {
    const root = await makeRoot();
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vault = new SecureCredentialVault(
      path.join(root, 'credentials.json'),
      protector()
    );
    const saveSpy = vi.spyOn(vault, 'saveRecord');
    const service = new ProviderConnectionContractService(
      new ProviderPackageRegistry([packageFixture()]),
      registry,
      vault
    );

    const unknownJson = await service.saveConnection({
      packageId: 'fixture-package',
      templateId: 'fixture-compatible',
      name: 'Unsafe fixture',
      endpoint: 'https://gateway.example.test/v1',
      credentials: { api_key: 'must-not-be-written' },
      protocolId: 'guess-from-model-name',
      method: 'POST',
      body: { unknown: true }
    });
    expect(unknownJson).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });

    const wrongTemplate = await service.saveConnection({
      packageId: 'missing-package',
      templateId: 'fixture-compatible',
      name: 'Wrong owner',
      endpoint: 'https://gateway.example.test/v1',
      credentials: { api_key: 'must-not-be-written' }
    });
    expect(wrongTemplate).toMatchObject({
      ok: false,
      error: { code: 'package_not_found' }
    });
    expect(JSON.stringify([unknownJson, wrongTemplate])).not.toContain(
      'must-not-be-written'
    );
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('removes the new credential when publishing connection metadata fails', async () => {
    const root = await makeRoot();
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vaultPath = path.join(root, 'credentials.json');
    const vault = new SecureCredentialVault(vaultPath, protector());
    vi.spyOn(registry, 'save').mockRejectedValueOnce(
      new Error('synthetic registry failure')
    );
    const service = new ProviderConnectionContractService(
      new ProviderPackageRegistry([packageFixture()]),
      registry,
      vault
    );

    const result = await service.saveConnection({
      packageId: 'fixture-package',
      templateId: 'fixture-official',
      name: 'Rollback fixture',
      credentials: { api_key: 'rollback-secret-value' }
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'connection_save_failed' }
    });
    const rolledBack = await registry.load();
    expect(rolledBack.providers).toHaveLength(0);
    expect(rolledBack.connections).toHaveLength(0);
    const vaultSnapshot = JSON.parse(await readFile(vaultPath, 'utf8')) as {
      entries: unknown[];
    };
    expect(vaultSnapshot.entries).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('rollback-secret-value');
  });

  it('validates exact structured fields without exposing supplied values', async () => {
    const root = await makeRoot();
    const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
    const vault = new SecureCredentialVault(
      path.join(root, 'credentials.json'),
      protector()
    );
    const saveSpy = vi.spyOn(vault, 'saveRecord');
    const service = new ProviderConnectionContractService(
      new ProviderPackageRegistry([packageFixture()]),
      registry,
      vault
    );

    for (const credentials of [
      {},
      { api_key: 'secret', unknown_token: 'must-not-leak' },
      { api_key: '' }
    ]) {
      const result = await service.saveConnection({
        packageId: 'fixture-package',
        templateId: 'fixture-official',
        name: 'Invalid credential fixture',
        credentials
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'credential_invalid' }
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|must-not-leak/);
    }
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

function packageFixture(): ProviderPackageDescriptor {
  return {
    packageId: 'fixture-package',
    packageVersion: '1.0.0',
    displayName: 'Fixture Provider',
    credentialSchemas: [
      {
        schemaId: 'fixture-credential',
        version: 1,
        fields: [
          {
            key: 'api_key',
            label: 'API key',
            secret: true,
            required: true,
            kind: 'token'
          },
          {
            key: 'organization',
            label: 'Organization',
            secret: false,
            required: false,
            kind: 'string'
          }
        ]
      }
    ],
    endpointPolicies: [
      {
        policyId: 'fixture-official-endpoint-policy',
        revision: 1,
        allowedSchemes: ['https'],
        allowedHosts: ['api.fixture.test'],
        allowedPorts: [443],
        allowedPathPrefixes: ['/v1'],
        redirectPolicy: 'deny',
        proxyPolicy: 'system',
        allowLoopback: false,
        allowPrivateNetwork: false,
        allowLoopbackHttp: false,
        dnsRebindingProtection: 'required',
        fixedBaseUrl: 'https://api.fixture.test/v1'
      },
      {
        policyId: 'fixture-compatible-endpoint-policy',
        revision: 1,
        allowedSchemes: ['https'],
        allowedHosts: ['*'],
        allowedPorts: [443],
        allowedPathPrefixes: ['/v1'],
        redirectPolicy: 'same_origin',
        proxyPolicy: 'system',
        allowLoopback: false,
        allowPrivateNetwork: false,
        allowLoopbackHttp: false,
        dnsRebindingProtection: 'required'
      }
    ],
    adapters: [
      {
        adapterId: 'adapter-fixture',
        adapterVersion: '1.0.0',
        protocolId: 'protocol.fixture',
        protocolVersion: '2026-08-01',
        operations: ['validate_connection', 'discover_models', 'submit']
      }
    ],
    templates: [
      {
        templateId: 'fixture-official',
        kind: 'official',
        displayName: 'Fixture Official',
        baseUrlMode: 'fixed',
        credentialSchemaId: 'fixture-credential',
        credentialSchemaVersion: 1,
        connectionPolicyId: 'fixture-connection-policy',
        connectionPolicyRevision: 1,
        discoveryPolicyId: 'fixture-discovery-policy',
        discoveryPolicyRevision: 1,
        endpointPolicyId: 'fixture-official-endpoint-policy',
        endpointPolicyRevision: 1,
        adapterBindings: [
          { adapterId: 'adapter-fixture', adapterVersion: '1.0.0' }
        ],
        freeConnectionValidation: true,
        modelDiscoveryKind: 'catalog'
      },
      {
        templateId: 'fixture-compatible',
        kind: 'compatible_custom',
        displayName: 'Fixture Compatible',
        baseUrlMode: 'required',
        credentialSchemaId: 'fixture-credential',
        credentialSchemaVersion: 1,
        connectionPolicyId: 'fixture-connection-policy',
        connectionPolicyRevision: 1,
        discoveryPolicyId: 'fixture-discovery-policy',
        discoveryPolicyRevision: 1,
        endpointPolicyId: 'fixture-compatible-endpoint-policy',
        endpointPolicyRevision: 1,
        adapterBindings: [
          { adapterId: 'adapter-fixture', adapterVersion: '1.0.0' }
        ],
        freeConnectionValidation: true,
        modelDiscoveryKind: 'manual_exact'
      }
    ]
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-package-contracts-'));
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
