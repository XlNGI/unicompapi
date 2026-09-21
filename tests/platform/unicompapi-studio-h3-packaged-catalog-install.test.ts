import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toIsoTimestamp } from '../../src/domain';
import {
  JsonProviderManagementAuditStore,
  JsonProviderRegistryStore,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderPackageRegistry,
  SecureCredentialVault,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
  frozenUnicompapiStudioH3ModelKeys,
  installPackagedUnicompapiStudioH3Catalog,
  unicompapiStudioH3ProviderPackageDescriptor,
  type CredentialProtector,
  type ProviderManagementAdapterPort
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-09-20T16:00:00.000Z');
const t1 = toIsoTimestamp('2026-09-20T16:01:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('UniCompAPI Studio H3 packaged catalog install', () => {
  it('installs one frozen T2V model with one bearer video binding', async () => {
    const fixture = await installFixture();
    const progress: string[] = [];
    const added = await fixture.framework.addConnection({
      packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
      templateId: UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
      name: 'Studio H3 packaged',
      credentials: { api_key: 'studio-h3-packaged-key' }
    }, (step) => progress.push(step));

    expect(added).toMatchObject({
      ok: true,
      value: {
        state: 'available',
        validated: true,
        catalog: 'synced',
        catalogCount: frozenUnicompapiStudioH3ModelKeys.length
      }
    });
    expect(progress).toEqual(['validating', 'saving', 'syncing']);
    if (!added.ok) throw new Error('addConnection failed');

    const snapshot = await fixture.registry.load();
    const connectionId = added.value.connectionId;
    const bindings = snapshot.protocolBindings.filter(
      (binding) => binding.connectionId === connectionId
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      adapterKind: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
      protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
      authScheme: 'bearer',
      endpointTemplate: 'https://unicompapi.com/studio/h3/v1/videos'
    });
    expect([...bindings[0].supportedPurposes]).toEqual(['video_generation']);

    const models = snapshot.models.filter((model) => model.connectionId === connectionId);
    expect(models.map((model) => model.providerModelKey)).toEqual(
      [...frozenUnicompapiStudioH3ModelKeys]
    );
    expect(models.every((model) => model.enabled)).toBe(true);
    expect(models.every((model) => model.activeProfileId)).toBe(true);
    const textProfile = snapshot.modelProfiles?.find(
      (profile) => profile.profileId === models[0]?.activeProfileId
    );
    expect(textProfile?.status).toBe('verified');
    expect(textProfile?.features.map((feature) => feature.productFeature))
      .toEqual(['text_to_video']);
  });

  it('is idempotent for the same connection', async () => {
    const fixture = await installFixture();
    const added = await fixture.framework.addConnection({
      packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
      templateId: UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
      name: 'Studio H3 idempotent',
      credentials: { api_key: 'studio-h3-idempotent-key' }
    });
    if (!added.ok) throw new Error('addConnection failed');
    const first = await installPackagedUnicompapiStudioH3Catalog(fixture.registry, {
      providerId: added.value.providerId,
      connectionId: added.value.connectionId,
      now: t1
    });
    const second = await installPackagedUnicompapiStudioH3Catalog(fixture.registry, {
      providerId: added.value.providerId,
      connectionId: added.value.connectionId,
      now: t1
    });
    expect(first.count).toBe(frozenUnicompapiStudioH3ModelKeys.length);
    expect(second.count).toBe(frozenUnicompapiStudioH3ModelKeys.length);
    const snapshot = await fixture.registry.load();
    expect(
      snapshot.models.filter((model) => model.connectionId === added.value.connectionId)
    ).toHaveLength(frozenUnicompapiStudioH3ModelKeys.length);
    expect(
      snapshot.protocolBindings.filter(
        (binding) => binding.connectionId === added.value.connectionId
      )
    ).toHaveLength(1);
  });
});

async function installFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uc-studio-h3-packaged-'));
  roots.push(root);
  const packages = new ProviderPackageRegistry([unicompapiStudioH3ProviderPackageDescriptor]);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const probe: ProviderManagementAdapterPort = {
    identity: {
      packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
      adapterId: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
      adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
      protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
    },
    async validateConnection() {
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: t0
      };
    }
  };
  return {
    registry,
    framework: new ProviderManagementFramework(
      packages,
      registry,
      new SecureCredentialVault(path.join(root, 'credentials.json'), protector()),
      new ProviderManagementAdapterRegistry(packages, [probe]),
      new JsonProviderManagementAuditStore(path.join(root, 'audit.json')),
      { now: () => t0 }
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
