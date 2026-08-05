import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toIsoTimestamp } from '../../src/domain';
import {
  deepSeekProviderPackageDescriptor,
  JsonProviderManagementAuditStore,
  JsonProviderRegistryStore,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderPackageRegistry,
  SecureCredentialVault,
  UNICOMPAPI_OFFICIAL_BASE_URL,
  unicompapiProviderPackageDescriptor,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor,
  type CredentialProtector,
  type ProviderManagementAdapterPort
} from '../../src/platform';

const t1 = toIsoTimestamp('2026-08-05T03:00:00.000Z');
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider probe decisions (PR3 contract)', () => {
  it('pins template management actions per provider evidence', async () => {
    const fixture = await decisionsFixture();
    const summaries = fixture.framework.listTemplates();
    const byTemplate = new Map(summaries.map((item) => [item.templateId, item]));

    expect(byTemplate.get('kling-official')).toMatchObject({
      validationAction: 'available',
      modelDiscoveryAction: 'manual_exact'
    });
    expect(byTemplate.get('volcengine-ark-official')).toMatchObject({
      validationAction: 'unsupported',
      modelDiscoveryAction: 'manual_exact'
    });
    expect(byTemplate.get('vidu-official')).toMatchObject({
      validationAction: 'unsupported',
      modelDiscoveryAction: 'unsupported'
    });
    expect(byTemplate.get('unicompapi-official')).toMatchObject({
      kind: 'official',
      baseUrlMode: 'fixed',
      providerName: 'UniCompAPI',
      validationAction: 'available',
      modelDiscoveryAction: 'catalog_available',
      freeConnectionValidation: true,
      modelDiscoveryKind: 'catalog'
    });
  });

  it('runs the Kling account probe during orchestrated add without catalog sync', async () => {
    const fixture = await decisionsFixture();
    const progress: string[] = [];
    const result = await fixture.framework.addConnection({
      packageId: 'provider-package-kling',
      templateId: 'kling-official',
      name: 'Kling official probe',
      credentials: {
        access_key: 'decisions-ak',
        secret_key: 'decisions-sk'
      }
    }, (step) => progress.push(step));

    expect(result).toMatchObject({
      ok: true,
      value: {
        state: 'available',
        validated: true,
        catalog: 'skipped'
      }
    });
    expect(progress).toEqual(['validating', 'saving']);
    expect(fixture.klingValidationCalls).toBe(1);
  });

  it('orchestrates UniCompAPI add with fixed endpoint and catalog sync', async () => {
    const fixture = await decisionsFixture();
    const progress: string[] = [];
    const result = await fixture.framework.addConnection({
      packageId: unicompapiProviderPackageDescriptor.packageId,
      templateId: 'unicompapi-official',
      name: 'UniCompAPI official',
      credentials: { api_key: 'decisions-unicompapi-key' }
    }, (step) => progress.push(step));

    expect(result).toMatchObject({
      ok: true,
      value: { state: 'available', validated: true, catalog: 'synced' }
    });
    expect(progress).toEqual(['validating', 'saving', 'syncing']);
    expect(fixture.unicompapiValidationCalls).toBe(1);
    expect(fixture.unicompapiCatalogCalls).toBe(1);
    expect(fixture.unicompapiLastEndpoint).toBe(UNICOMPAPI_OFFICIAL_BASE_URL);

    const overridden = await fixture.framework.addConnection({
      packageId: unicompapiProviderPackageDescriptor.packageId,
      templateId: 'unicompapi-official',
      name: 'UniCompAPI override denied',
      endpoint: 'https://example.com/v1',
      credentials: { api_key: 'decisions-unicompapi-key' }
    });
    expect(overridden).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    });
    if (!overridden.ok) {
      expect(overridden.error.message).toMatch(/fixed provider endpoint/i);
    }
  });

  it('saves Volcengine and Vidu connections deferred without any adapter call', async () => {
    const fixture = await decisionsFixture();
    const volcengine = await fixture.framework.addConnection({
      packageId: 'provider-package-volcengine',
      templateId: 'volcengine-ark-official',
      name: 'Volcengine deferred',
      credentials: { api_key: 'decisions-ark-key' }
    });
    expect(volcengine).toMatchObject({
      ok: true,
      value: { state: 'saved', validated: false, catalog: 'skipped' }
    });

    const vidu = await fixture.framework.addConnection({
      packageId: viduProviderPackageDescriptor.packageId,
      templateId: 'vidu-official',
      name: 'Vidu deferred',
      credentials: { token: 'decisions-vidu-token' }
    });
    expect(vidu).toMatchObject({
      ok: true,
      value: { state: 'saved', validated: false, catalog: 'skipped' }
    });
    expect(fixture.klingValidationCalls).toBe(0);
  });
});

async function decisionsFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uc-probe-decisions-'));
  roots.push(root);
  const packages = new ProviderPackageRegistry([
    deepSeekProviderPackageDescriptor,
    volcengineProviderPackageDescriptor,
    klingProviderPackageDescriptor,
    newApiProviderPackageDescriptor,
    unicompapiProviderPackageDescriptor,
    viduProviderPackageDescriptor
  ]);
  const state = {
    klingValidationCalls: 0,
    unicompapiValidationCalls: 0,
    unicompapiCatalogCalls: 0,
    unicompapiLastEndpoint: undefined as string | undefined
  };
  const klingProbe: ProviderManagementAdapterPort = {
    identity: {
      packageId: 'provider-package-kling',
      adapterId: 'kling.video',
      adapterVersion: '2026-08-03',
      protocolId: 'kling.api2.video-generation',
      protocolVersion: '2026-08-03'
    },
    async validateConnection() {
      state.klingValidationCalls += 1;
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: t1
      };
    }
  };
  const unicompapiProbe: ProviderManagementAdapterPort = {
    identity: {
      packageId: 'provider-package-unicompapi',
      adapterId: 'newapi.chat',
      adapterVersion: '2026-08-03',
      protocolId: 'newapi.openai.chat-completions',
      protocolVersion: '2026-08-03'
    },
    async validateConnection(input) {
      state.unicompapiValidationCalls += 1;
      state.unicompapiLastEndpoint = input.endpoint;
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: t1
      };
    },
    async discoverModels() {
      state.unicompapiCatalogCalls += 1;
      return {
        entries: [{ providerModelKey: 'unicompapi-chat', displayName: 'UniCompAPI Chat' }],
        observedAt: t1
      };
    }
  };
  return {
    get klingValidationCalls() { return state.klingValidationCalls; },
    get unicompapiValidationCalls() { return state.unicompapiValidationCalls; },
    get unicompapiCatalogCalls() { return state.unicompapiCatalogCalls; },
    get unicompapiLastEndpoint() { return state.unicompapiLastEndpoint; },
    framework: new ProviderManagementFramework(
      packages,
      new JsonProviderRegistryStore(path.join(root, 'registry.json')),
      new SecureCredentialVault(path.join(root, 'credentials.json'), protector()),
      new ProviderManagementAdapterRegistry(packages, [klingProbe, unicompapiProbe]),
      new JsonProviderManagementAuditStore(path.join(root, 'audit.json')),
      { now: () => t1 }
    )
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
