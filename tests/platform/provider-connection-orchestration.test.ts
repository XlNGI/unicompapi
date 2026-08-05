import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toIsoTimestamp, type ProviderPackageDescriptor } from '../../src/domain';
import {
  JsonProviderManagementAuditStore,
  JsonProviderRegistryStore,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderPackageRegistry,
  SecureCredentialVault,
  type CredentialProtector,
  type ProviderConnectionValidationResultV1,
  type ProviderManagementAdapterPort
} from '../../src/platform';

const t1 = toIsoTimestamp('2026-08-05T00:00:00.000Z');
const t2 = toIsoTimestamp('2026-08-05T00:00:05.000Z');
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider connection orchestration', () => {
  it('validates before persisting, then saves and syncs the catalog with ordered progress', async () => {
    const fixture = await orchestrationFixture();
    fixture.behavior.validation = {
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      observedAt: t1,
      safeCode: 'synthetic_validation_passed'
    };
    fixture.catalog.entries = [
      { providerModelKey: 'fixture-chat-1', displayName: 'Fixture Chat 1' },
      { providerModelKey: 'fixture-chat-2', displayName: 'Fixture Chat 2' }
    ];
    const progress: string[] = [];
    const result = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-catalog',
      name: 'Orchestrated official',
      credentials: { api_key: 'fixture-orchestrated-secret' }
    }, (step) => progress.push(step));

    expect(result).toMatchObject({
      ok: true,
      value: {
        state: 'available',
        validated: true,
        catalog: 'synced',
        catalogCount: 2
      }
    });
    if (!result.ok) throw new Error('orchestrated add failed');
    expect(progress).toEqual(['validating', 'saving', 'syncing']);
    expect(fixture.calls.validation).toBe(1);
    expect(fixture.calls.discovery).toBe(1);

    const snapshot = await fixture.registry.load();
    const connection = snapshot.connections.find((item) =>
      item.id === result.value.connectionId
    );
    expect(connection).toMatchObject({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      lastConnectionValidationAt: t1
    });
    const models = snapshot.models.filter((model) =>
      model.connectionId === result.value.connectionId
    );
    expect(models.map((model) => model.providerModelKey).sort()).toEqual([
      'fixture-chat-1',
      'fixture-chat-2'
    ]);
    expect(models.every((model) => !model.enabled)).toBe(true);

    const audit = (await fixture.audit.list()).map((event) => event.action);
    expect(audit).toEqual([
      'connection_created',
      'connection_validated',
      'catalog_synced'
    ]);
  });

  it('fails validation without persisting any connection or credential trace', async () => {
    const fixture = await orchestrationFixture();
    fixture.behavior.validation = {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid',
      observedAt: t1,
      safeCode: 'authentication_failed'
    };
    const registryBefore = await fixture.registry.load();
    const vaultBefore = await readFile(fixture.vaultPath, 'utf8').catch(() => '');

    const result = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-catalog',
      name: 'Rejected official',
      credentials: { api_key: 'fixture-rejected-secret' }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'connection_validation_failed',
        message: 'authentication_failed'
      }
    });
    expect(fixture.calls.validation).toBe(1);
    expect(fixture.calls.discovery).toBe(0);

    const registryAfter = await fixture.registry.load();
    expect(registryAfter.connections).toEqual(registryBefore.connections);
    expect(registryAfter.providers).toEqual(registryBefore.providers);
    const vaultAfter = await readFile(fixture.vaultPath, 'utf8').catch(() => '');
    expect(vaultAfter).toBe(vaultBefore);
    expect(vaultAfter).not.toContain('fixture-rejected-secret');

    const audit = await fixture.audit.list();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'connection_validated',
        outcome: 'failed',
        safeCode: 'authentication_failed'
      })
    ]);
  });

  it('saves an unavailable connection when explicitly allowed and skips the catalog', async () => {
    const fixture = await orchestrationFixture();
    fixture.behavior.validation = {
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid',
      observedAt: t1,
      safeCode: 'authentication_failed'
    };
    const progress: string[] = [];
    const result = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-catalog',
      name: 'Forced unavailable',
      credentials: { api_key: 'fixture-forced-secret' },
      allowUnavailableSave: true
    }, (step) => progress.push(step));

    expect(result).toMatchObject({
      ok: true,
      value: {
        state: 'unavailable',
        validated: true,
        catalog: 'skipped'
      }
    });
    if (!result.ok) throw new Error('forced add failed');
    expect(progress).toEqual(['validating', 'saving']);
    expect(fixture.calls.discovery).toBe(0);

    const snapshot = await fixture.registry.load();
    const connection = snapshot.connections.find((item) =>
      item.id === result.value.connectionId
    );
    expect(connection).toMatchObject({
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid',
      lastConnectionValidationAt: t1
    });
  });

  it('falls back to a plain save when the template has no approved free validation', async () => {
    const fixture = await orchestrationFixture();
    const progress: string[] = [];
    const result = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-no-free',
      name: 'Deferred official',
      credentials: { api_key: 'fixture-deferred-secret' }
    }, (step) => progress.push(step));

    expect(result).toMatchObject({
      ok: true,
      value: {
        state: 'saved',
        validated: false,
        catalog: 'skipped'
      }
    });
    expect(progress).toEqual([]);
    expect(fixture.calls.validation).toBe(0);
    expect(fixture.calls.discovery).toBe(0);
  });

  it('keeps the validated connection when catalog synchronization fails', async () => {
    const fixture = await orchestrationFixture();
    fixture.behavior.validation = {
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      observedAt: t1,
      safeCode: 'synthetic_validation_passed'
    };
    fixture.behavior.discoveryThrows = true;
    const result = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-catalog',
      name: 'Catalog failure official',
      credentials: { api_key: 'fixture-catalog-failure-secret' }
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        state: 'available',
        validated: true,
        catalog: 'failed',
        catalogWarning: 'provider_management_failed'
      }
    });
    if (!result.ok) throw new Error('catalog-failure add failed');
    const snapshot = await fixture.registry.load();
    const connection = snapshot.connections.find((item) =>
      item.id === result.value.connectionId
    );
    expect(connection?.state).toBe('available');
    expect(
      snapshot.models.filter((model) => model.connectionId === result.value.connectionId)
    ).toEqual([]);
  });

  it('permits manual registration on the orchestrated catalog connection', async () => {
    const fixture = await orchestrationFixture();
    const created = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-catalog',
      name: 'Manual supplement official',
      credentials: { api_key: 'fixture-manual-supplement-secret' }
    });
    if (!created.ok) throw new Error('orchestrated add failed');
    const registered = await fixture.framework.registerExactModel({
      connectionId: created.value.connectionId,
      providerModelKey: 'beta-model-not-in-catalog',
      displayName: 'Beta model'
    });
    expect(registered).toMatchObject({
      ok: true,
      value: { state: 'registered_without_profile' }
    });
  });

  it('rejects invalid requests before any validation or persistence', async () => {
    const fixture = await orchestrationFixture();
    const result = await fixture.framework.addConnection({
      packageId: 'orchestration.fixture',
      templateId: 'fixture-official-catalog',
      name: 'Invalid',
      credentials: { api_key: 'fixture-invalid-secret' },
      allowUnavailableSave: 'yes'
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    expect(fixture.calls.validation).toBe(0);
  });
});

interface OrchestrationFixture {
  readonly framework: ProviderManagementFramework;
  readonly registry: JsonProviderRegistryStore;
  readonly audit: JsonProviderManagementAuditStore;
  readonly vaultPath: string;
  readonly calls: { validation: number; discovery: number };
  readonly behavior: {
    validation: ProviderConnectionValidationResultV1;
    discoveryThrows: boolean;
  };
  readonly catalog: { entries: { providerModelKey: string; displayName: string }[] };
}

async function orchestrationFixture(): Promise<OrchestrationFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-orchestration-'));
  roots.push(root);
  const packages = new ProviderPackageRegistry([packageFixture()]);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const vaultPath = path.join(root, 'credentials.json');
  const vault = new SecureCredentialVault(vaultPath, protector());
  const audit = new JsonProviderManagementAuditStore(path.join(root, 'provider-audit.json'));
  const calls = { validation: 0, discovery: 0 };
  const behavior = {
    validation: {
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      observedAt: t1,
      safeCode: 'synthetic_validation_passed'
    } as ProviderConnectionValidationResultV1,
    discoveryThrows: false
  };
  const catalog: OrchestrationFixture['catalog'] = { entries: [] };
  const adapter: ProviderManagementAdapterPort = {
    identity: {
      packageId: 'orchestration.fixture',
      adapterId: 'fixture.adapter',
      adapterVersion: '1.0.0',
      protocolId: 'fixture.protocol',
      protocolVersion: '2026-08-05'
    },
    async validateConnection(input) {
      calls.validation += 1;
      expect(input.connection.state).toBe('saved');
      expect(input.credentials).toMatchObject({
        schemaId: 'orchestration.credential'
      });
      return behavior.validation;
    },
    async discoverModels() {
      calls.discovery += 1;
      if (behavior.discoveryThrows) {
        throw new Error('synthetic catalog outage');
      }
      return { entries: [...catalog.entries], observedAt: t2 };
    }
  };
  const adapters = new ProviderManagementAdapterRegistry(packages, [adapter]);
  return {
    registry,
    audit,
    vaultPath,
    calls,
    behavior,
    catalog,
    framework: new ProviderManagementFramework(
      packages,
      registry,
      vault,
      adapters,
      audit,
      { now: () => t2 }
    )
  };
}

function packageFixture(): ProviderPackageDescriptor {
  return {
    packageId: 'orchestration.fixture',
    packageVersion: '1.0.0',
    displayName: 'Orchestration Fixture',
    credentialSchemas: [{
      schemaId: 'orchestration.credential',
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
        'orchestration.official.endpoint',
        ['api.orchestration.test'],
        'https://api.orchestration.test/v1'
      ),
      endpointPolicy(
        'orchestration.no-free.endpoint',
        ['api-no-free.orchestration.test'],
        'https://api-no-free.orchestration.test/v1'
      )
    ],
    adapters: [{
      adapterId: 'fixture.adapter',
      adapterVersion: '1.0.0',
      protocolId: 'fixture.protocol',
      protocolVersion: '2026-08-05',
      operations: ['validate_connection', 'discover_models', 'submit']
    }],
    templates: [
      template('fixture-official-catalog', true, 'orchestration.official.endpoint'),
      template('fixture-official-no-free', false, 'orchestration.no-free.endpoint')
    ]
  };
}

function template(
  templateId: string,
  freeConnectionValidation: boolean,
  endpointPolicyId: string
): ProviderPackageDescriptor['templates'][number] {
  return {
    templateId,
    kind: 'official',
    displayName: templateId,
    baseUrlMode: 'fixed',
    credentialSchemaId: 'orchestration.credential',
    credentialSchemaVersion: 1,
    connectionPolicyId: `connection-policy.${templateId}`,
    connectionPolicyRevision: 1,
    discoveryPolicyId: `discovery-policy.${templateId}`,
    discoveryPolicyRevision: 1,
    endpointPolicyId,
    endpointPolicyRevision: 1,
    adapterBindings: [{ adapterId: 'fixture.adapter', adapterVersion: '1.0.0' }],
    freeConnectionValidation,
    modelDiscoveryKind: 'catalog'
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

function protector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value: string) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
    unprotect: (value: Buffer) =>
      Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8')
  };
}
