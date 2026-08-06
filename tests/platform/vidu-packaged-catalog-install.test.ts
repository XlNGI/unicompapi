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
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_OFFICIAL_TEMPLATE_ID,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
  applyPackagedViduCatalogInstall,
  frozenViduModelKeys,
  installPackagedViduCatalog,
  viduProviderPackageDescriptor,
  type CredentialProtector,
  type ProviderManagementAdapterPort
} from '../../src/platform';
import {
  createUserViduRegistryRecords
} from '../fixtures/vidu-user-registry';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-08-05T14:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-05T14:01:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Vidu packaged catalog install', () => {
  it('installs ten models with four protocol bindings and verified profiles', async () => {
    const fixture = await installFixture();
    const progress: string[] = [];
    const added = await fixture.framework.addConnection({
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      templateId: VIDU_OFFICIAL_TEMPLATE_ID,
      name: 'Vidu packaged',
      credentials: { token: 'vidu-packaged-token' }
    }, (step) => progress.push(step));

    expect(added).toMatchObject({
      ok: true,
      value: {
        state: 'available',
        validated: true,
        catalog: 'synced',
        catalogCount: frozenViduModelKeys.length
      }
    });
    expect(progress).toEqual(['validating', 'saving', 'syncing']);
    if (!added.ok) throw new Error('addConnection failed');

    const snapshot = await fixture.registry.load();
    const connectionId = added.value.connectionId;
    const bindings = snapshot.protocolBindings.filter(
      (binding) => binding.connectionId === connectionId
    );
    expect(bindings.map((binding) => binding.adapterKind).sort()).toEqual([
      VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      VIDU_IMAGE_V1_ADAPTER_ID,
      VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
      VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID
    ].sort());

    const models = snapshot.models.filter((model) => model.connectionId === connectionId);
    expect(models).toHaveLength(frozenViduModelKeys.length);
    expect(models.every((model) => model.activeProfileId)).toBe(true);
    expect(models.every((model) => (model.catalogState ?? 'present') === 'present')).toBe(true);

    const imageV1 = models.find((model) => model.providerModelKey === 'viduimage-2');
    expect(imageV1?.enabled).toBe(false);
    const video = models.find((model) => model.providerModelKey === 'viduq3-turbo');
    expect(video?.enabled).toBe(true);
    const gemini = models.find((model) => model.providerModelKey === 'q3-lite');
    expect(gemini?.enabled).toBe(true);
    const official = models.find((model) => model.providerModelKey === 'viduq2');
    expect(official?.enabled).toBe(true);
    const officialBinding = bindings.find(
      (binding) => binding.adapterKind === VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID
    );
    const geminiBinding = bindings.find(
      (binding) => binding.adapterKind === VIDU_GEMINI_IMAGE_V2_ADAPTER_ID
    );
    expect(official?.protocolBindingId).toBe(officialBinding?.id);
    expect(gemini?.protocolBindingId).toBe(geminiBinding?.id);
    expect(
      snapshot.protocolBindings.find(
        (binding) =>
          binding.connectionId === connectionId &&
          binding.adapterKind === VIDU_IMAGE_V1_ADAPTER_ID
      )?.authScheme
    ).toBe('bearer');

    const videoProfile = snapshot.modelProfiles?.find(
      (profile) => profile.profileId === video?.activeProfileId
    );
    expect(videoProfile?.status).toBe('verified');
    const imageProfile = snapshot.modelProfiles?.find(
      (profile) => profile.profileId === imageV1?.activeProfileId
    );
    expect(imageProfile?.status).toBe('disabled');
    const officialProfile = snapshot.modelProfiles?.find(
      (profile) => profile.profileId === official?.activeProfileId
    );
    expect(officialProfile?.status).toBe('verified');
    expect(
      officialProfile?.features.some(
        (feature) => feature.productFeature === 'text_to_image'
      )
    ).toBe(true);
  });

  it('is idempotent for the same connection', async () => {
    const fixture = await installFixture();
    const added = await fixture.framework.addConnection({
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      templateId: VIDU_OFFICIAL_TEMPLATE_ID,
      name: 'Vidu idempotent',
      credentials: { token: 'vidu-idempotent-token' }
    });
    if (!added.ok) throw new Error('addConnection failed');

    const first = await installPackagedViduCatalog(fixture.registry, {
      providerId: added.value.providerId,
      connectionId: added.value.connectionId,
      now: t1
    });
    const second = await installPackagedViduCatalog(fixture.registry, {
      providerId: added.value.providerId,
      connectionId: added.value.connectionId,
      now: t1
    });
    expect(first.count).toBe(frozenViduModelKeys.length);
    expect(second.count).toBe(frozenViduModelKeys.length);

    const snapshot = await fixture.registry.load();
    expect(
      snapshot.models.filter((model) => model.connectionId === added.value.connectionId)
    ).toHaveLength(frozenViduModelKeys.length);
    expect(
      snapshot.protocolBindings.filter(
        (binding) => binding.connectionId === added.value.connectionId
      )
    ).toHaveLength(4);
  });

  it('remounts legacy gemini viduq2 onto official binding and fills missing adapterBindings', async () => {
    const frozen = createUserViduRegistryRecords();
    const geminiBinding = frozen.protocolBindings.find(
      (binding) => binding.adapterKind === VIDU_GEMINI_IMAGE_V2_ADAPTER_ID
    )!;
    const legacyConnection = {
      ...frozen.connections[0],
      adapterBindings: (frozen.connections[0].adapterBindings ?? []).filter(
        (binding) => binding.adapterId !== VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID
      ),
      connectionRevision: 1
    };
    const legacyModels = frozen.models.map((model) => {
      const profile = frozen.modelProfiles.find(
        (item) => item.modelId === model.id
      );
      if (model.providerModelKey === 'viduq2' || model.providerModelKey === 'viduq1') {
        return {
          ...model,
          protocolBindingId: geminiBinding.id,
          revision: 1,
          activeProfileId: profile?.profileId
        };
      }
      return {
        ...model,
        activeProfileId: profile?.profileId
      };
    });
    const legacyProfiles = frozen.modelProfiles.map((profile) => {
      const model = legacyModels.find((item) => item.id === profile.modelId);
      if (!model) return profile;
      if (model.providerModelKey === 'viduq2' || model.providerModelKey === 'viduq1') {
        return {
          ...profile,
          adapterKey: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
          protocolBindingId: geminiBinding.id,
          modelRevision: model.revision,
          status: 'restricted' as const
        };
      }
      if (model.providerModelKey === 'viduimage-2') {
        return {
          ...profile,
          status: 'verified' as const
        };
      }
      return profile;
    });
    const snapshot = {
      schemaVersion: 2 as const,
      registryRevision: 1,
      providers: frozen.providers,
      connections: [legacyConnection],
      protocolBindings: frozen.protocolBindings.filter(
        (binding) => binding.adapterKind !== VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID
      ),
      models: legacyModels.map((model) =>
        model.providerModelKey === 'viduimage-2'
          ? { ...model, enabled: true }
          : model
      ),
      capabilities: frozen.capabilities,
      routingPreferences: [],
      modelDefinitions: frozen.modelDefinitions,
      modelProfiles: legacyProfiles
    };

    const installed = applyPackagedViduCatalogInstall(snapshot, {
      providerId: legacyConnection.providerId,
      connectionId: legacyConnection.id,
      now: t1
    });

    const connection = installed.snapshot.connections.find(
      (item) => item.id === legacyConnection.id
    )!;
    expect(connection.connectionRevision).toBe(1);
    expect(
      connection.adapterBindings?.some(
        (binding) => binding.adapterId === VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID
      )
    ).toBe(true);

    const officialBinding = installed.snapshot.protocolBindings.find(
      (binding) =>
        binding.connectionId === legacyConnection.id &&
        binding.adapterKind === VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID
    )!;
    const viduq2 = installed.snapshot.models.find(
      (model) => model.providerModelKey === 'viduq2'
    )!;
    expect(viduq2.enabled).toBe(true);
    expect(viduq2.protocolBindingId).toBe(officialBinding.id);
    expect(viduq2.revision).toBeGreaterThan(1);
    const profile = installed.snapshot.modelProfiles?.find(
      (item) => item.profileId === viduq2.activeProfileId
    );
    expect(profile?.adapterKey).toBe(VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID);
    expect(profile?.protocolBindingId).toBe(officialBinding.id);
    expect(profile?.modelRevision).toBe(viduq2.revision);
    expect(profile?.status).toBe('verified');
    expect(
      profile?.features.some((feature) => feature.productFeature === 'text_to_image')
    ).toBe(true);

    const imageV1 = installed.snapshot.models.find(
      (model) => model.providerModelKey === 'viduimage-2'
    )!;
    expect(imageV1.enabled).toBe(false);
    const imageProfile = installed.snapshot.modelProfiles?.find(
      (item) => item.profileId === imageV1.activeProfileId
    );
    expect(imageProfile?.status).toBe('disabled');

    const q3 = installed.snapshot.models.find(
      (model) => model.providerModelKey === 'q3-lite'
    )!;
    expect(q3.protocolBindingId).toBe(geminiBinding.id);
  });

  it('applyPackagedViduCatalogInstall rejects non-Vidu connections', () => {
    const empty = {
      schemaVersion: 2 as const,
      registryRevision: 1,
      providers: [],
      connections: [],
      protocolBindings: [],
      models: [],
      capabilities: [],
      routingPreferences: [],
      modelDefinitions: [],
      modelProfiles: []
    };
    expect(() => applyPackagedViduCatalogInstall(empty, {
      providerId: 'provider-other',
      connectionId: 'connection-other',
      now: t0
    })).toThrow(/owned connection/);
  });
});

async function installFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uc-vidu-packaged-'));
  roots.push(root);
  const packages = new ProviderPackageRegistry([viduProviderPackageDescriptor]);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const viduProbe: ProviderManagementAdapterPort = {
    identity: {
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION
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
      new ProviderManagementAdapterRegistry(packages, [viduProbe]),
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
