import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toIsoTimestamp } from '../../src/domain';
import {
  JsonProviderManagementAuditStore,
  JsonProviderRegistryStore,
  MINIMAX_H3_CN_TEMPLATE_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_ID,
  MINIMAX_H3_VIDEO_ADAPTER_ID,
  MINIMAX_H3_VIDEO_ADAPTER_VERSION,
  MINIMAX_H3_VIDEO_PROTOCOL_ID,
  MINIMAX_H3_VIDEO_PROTOCOL_VERSION,
  ProviderManagementAdapterRegistry,
  ProviderManagementFramework,
  ProviderPackageRegistry,
  SecureCredentialVault,
  frozenMiniMaxH3ModelKeys,
  installPackagedMiniMaxH3Catalog,
  minimaxH3ProviderPackageDescriptor,
  type CredentialProtector,
  type ProviderManagementAdapterPort
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-09-20T14:00:00.000Z');
const t1 = toIsoTimestamp('2026-09-20T14:01:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MiniMax packaged catalog install', () => {
  it('installs two frozen models with one bearer video binding', async () => {
    const fixture = await installFixture();
    const progress: string[] = [];
    const added = await fixture.framework.addConnection({
      packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
      templateId: MINIMAX_H3_CN_TEMPLATE_ID,
      name: 'MiniMax packaged',
      credentials: { api_key: 'minimax-packaged-key' }
    }, (step) => progress.push(step));

    expect(added).toMatchObject({
      ok: true,
      value: {
        state: 'available',
        validated: true,
        catalog: 'synced',
        catalogCount: frozenMiniMaxH3ModelKeys.length
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
      adapterKind: MINIMAX_H3_VIDEO_ADAPTER_ID,
      protocolId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
      authScheme: 'bearer',
      endpointTemplate: 'https://api.minimaxi.com/v2/video_generation'
    });
    expect([...bindings[0].supportedPurposes].sort()).toEqual([
      'reference_to_video',
      'video_generation'
    ]);

    const models = snapshot.models.filter((model) => model.connectionId === connectionId);
    expect(models.map((model) => model.providerModelKey).sort()).toEqual(
      [...frozenMiniMaxH3ModelKeys].sort()
    );
    expect(models.every((model) => model.enabled)).toBe(true);
    expect(models.every((model) => model.activeProfileId)).toBe(true);
    const textProfile = snapshot.modelProfiles?.find(
      (profile) => profile.profileId === models[0]?.activeProfileId
    );
    expect(textProfile?.status).toBe('verified');
    expect(
      textProfile?.features.map((feature) => feature.productFeature).sort()
    ).toEqual(['image_to_video', 'text_to_video']);
  });

  it('is idempotent for the same connection', async () => {
    const fixture = await installFixture();
    const added = await fixture.framework.addConnection({
      packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
      templateId: MINIMAX_H3_CN_TEMPLATE_ID,
      name: 'MiniMax idempotent',
      credentials: { api_key: 'minimax-idempotent-key' }
    });
    if (!added.ok) throw new Error('addConnection failed');
    const first = await installPackagedMiniMaxH3Catalog(fixture.registry, {
      providerId: added.value.providerId,
      connectionId: added.value.connectionId,
      now: t1
    });
    const second = await installPackagedMiniMaxH3Catalog(fixture.registry, {
      providerId: added.value.providerId,
      connectionId: added.value.connectionId,
      now: t1
    });
    expect(first.count).toBe(frozenMiniMaxH3ModelKeys.length);
    expect(second.count).toBe(frozenMiniMaxH3ModelKeys.length);
    const snapshot = await fixture.registry.load();
    expect(
      snapshot.models.filter((model) => model.connectionId === added.value.connectionId)
    ).toHaveLength(frozenMiniMaxH3ModelKeys.length);
    expect(
      snapshot.protocolBindings.filter(
        (binding) => binding.connectionId === added.value.connectionId
      )
    ).toHaveLength(1);
  });
});

async function installFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uc-minimax-packaged-'));
  roots.push(root);
  const packages = new ProviderPackageRegistry([minimaxH3ProviderPackageDescriptor]);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const probe: ProviderManagementAdapterPort = {
    identity: {
      packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
      adapterId: MINIMAX_H3_VIDEO_ADAPTER_ID,
      adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION,
      protocolId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: MINIMAX_H3_VIDEO_PROTOCOL_VERSION
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
