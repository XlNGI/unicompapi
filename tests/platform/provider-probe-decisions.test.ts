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
    viduProviderPackageDescriptor
  ]);
  const state = { klingValidationCalls: 0 };
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
  return {
    get klingValidationCalls() { return state.klingValidationCalls; },
    framework: new ProviderManagementFramework(
      packages,
      new JsonProviderRegistryStore(path.join(root, 'registry.json')),
      new SecureCredentialVault(path.join(root, 'credentials.json'), protector()),
      new ProviderManagementAdapterRegistry(packages, [klingProbe]),
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
