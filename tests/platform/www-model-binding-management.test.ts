import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, createProviderModel, createProviderProtocolBinding, toModelId, toProtocolBindingId,
  toProjectId, toDraftId } from '../../src/domain';
import { JsonProviderRegistryStore } from '../../src/platform/providers/provider-registry';
import { ProviderPackageRegistry } from '../../src/platform/providers/provider-package-registry';
import { ProviderManagementFramework, ProviderManagementAdapterRegistry, JsonProviderManagementAuditStore } from '../../src/platform/providers/provider-management-framework';
import { RegistryFeatureCandidateSource, ProviderFeatureContractRegistry } from '../../src/platform/providers/provider-registry-feature-candidates';
import { SecureCredentialVault } from '../../src/platform/providers/credential-vault';
import { unicompapiWwwProviderPackageDescriptor, UNICOMPAPI_WWW_TEMPLATE_ID } from '../../src/platform/providers/newapi/unicompapi-contracts';
import { NEWAPI_CHAT_ADAPTER_ID, NEWAPI_CHAT_PROTOCOL_ID, NEWAPI_PROTOCOL_VERSION } from '../../src/platform/providers/newapi/newapi-contracts';
import { listWwwVideoContracts, wwwVideoFeatureContracts } from '../../src/platform/providers/newapi/www-video-contracts';
import { wwwConnection, wwwTime } from '../fixtures/www-video';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(modelKey: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uc-www-binding-repair-'));
  roots.push(root);
  const packages = new ProviderPackageRegistry([unicompapiWwwProviderPackageDescriptor]);
  const resolved = packages.resolveTemplate(unicompapiWwwProviderPackageDescriptor.packageId, UNICOMPAPI_WWW_TEMPLATE_ID);
  const connection = { ...wwwConnection(), templateId: UNICOMPAPI_WWW_TEMPLATE_ID,
    adapterBindings: resolved.adapters.map(a => ({ adapterId: a.adapterId, adapterVersion: a.adapterVersion, protocolId: a.protocolId, protocolVersion: a.protocolVersion })) };
  const provider = createProvider({ id: connection.providerId, name: 'WWW synthetic fixture', accessCategory: 'online',
    identityState: 'verified', packageId: connection.packageId!, packageVersion: connection.packageVersion!, createdAt: wwwTime, updatedAt: wwwTime });
  const binding = createProviderProtocolBinding({ id: toProtocolBindingId('binding-www-management-chat'), providerId: provider.id,
    connectionId: connection.id, protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION,
    adapterKind: NEWAPI_CHAT_ADAPTER_ID, mediaKind: 'unknown', executionLifecycle: 'unknown', supportedPurposes: [],
    authScheme: 'unknown', createdAt: wwwTime, updatedAt: wwwTime });
  const model = createProviderModel({ id: toModelId('model-www-management'), providerId: provider.id, connectionId: connection.id,
    protocolBindingId: binding.id, providerModelKey: modelKey, displayName: modelKey, mediaKind: 'unknown', enabled: false,
    catalogState: 'present', revision: 1, createdAt: wwwTime, updatedAt: wwwTime });
  const registryPath = path.join(root, 'registry.json');
  const registry = new JsonProviderRegistryStore(registryPath);
  await registry.save({ schemaVersion: 2, providers: [provider], connections: [connection], protocolBindings: [binding], models: [model], capabilities: [], routingPreferences: [] });
  const readCredential = vi.fn(() => { throw new Error('Credential access forbidden in offline management test'); });
  const vault = new SecureCredentialVault(path.join(root, 'credentials.json'), { isAvailable: () => false, protect: readCredential, unprotect: readCredential });
  const framework = new ProviderManagementFramework(packages, registry, vault, new ProviderManagementAdapterRegistry(packages, []),
    new JsonProviderManagementAuditStore(path.join(root, 'audit.json')), { now: () => wwwTime });
  const candidates = new RegistryFeatureCandidateSource(registry, packages, new ProviderFeatureContractRegistry(wwwVideoFeatureContracts()), {
    async checkAccess() { return { allowed: true, operation: 'submit', reason: 'allowed', policyId: 'www-offline-test', policyRevision: 1 }; }
  });
  const subject = { projectId: toProjectId('project-www-management'), subject: { kind: 'draft' as const, draftId: toDraftId('draft-www-management'), draftRevision: 1 },
    productFeature: 'text_chat' as const, surface: 'conversation' as const, imageCount: 0, videoCount: 0, contextCount: 0,
    parameterValues: {}, outboundTextSnapshot: 'Synthetic local management test', materialReferences: [], contextContentHashes: [] };
  return { framework, registry, registryPath, model, connection, readCredential, candidates, subject };
}

describe('WWW model binding and enable management', () => {
  it.each(['deepseek-v4-flash', 'qwen-image-2.0', 'unknown-model-key'])('rejects enabling %s without a usable profile and leaves the registry unchanged', async key => {
    const f = await fixture(key);
    const before = await readFile(f.registryPath, 'utf8');
    expect(await f.framework.setModelEnabled({ modelId: f.model.id, enabled: true }))
      .toMatchObject({ ok: false, error: { code: 'model_profile_unavailable' } });
    expect(await readFile(f.registryPath, 'utf8')).toBe(before);
    expect(f.readCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['deepseek-v4-flash', 'official.deepseek.v4.chat'], ['glm-4.6', 'official.zhipu.glm-4.6.chat'],
    ['glm-4.7', 'official.zhipu.glm-4.7.chat'], ['glm-5.2', 'official.zhipu.glm-5.2.chat'],
    ['kimi-k2.6', 'official.moonshot.kimi-k2.6.chat'], ['kimi-k3', 'official.moonshot.kimi-k3.chat']
  ])('binds %s without auto-enabling, then enables its declared text candidate', async (key, contractId) => {
    const f = await fixture(key);
    expect(f.framework.listModelApiContracts()).toContainEqual(expect.objectContaining({ contractId, authority: 'model_vendor' }));
    expect(await f.framework.bindModelApiContract({ modelId: f.model.id, expectedRevision: 1,
      binding: { schemaVersion: 1, contractId, contractRevision: 1, rules: [] }, confirmed: true })).toMatchObject({ ok: true });
    expect((await f.registry.load()).models[0].enabled).toBe(false);
    expect(await f.framework.setModelEnabled({ modelId: f.model.id, enabled: true })).toMatchObject({ ok: true });
    const candidate = (await f.candidates.list(f.subject))[0];
    expect(candidate.eligibility).toMatchObject({ modelEnabled: true, profileStatus: 'declared', bindingAvailable: true, featureSupported: true });
    expect(candidate.routeTemplate.parameterContract?.contractId).toBe(contractId);
    expect(f.readCredential).not.toHaveBeenCalled();
  });

  it('rejects a stale bound connection pin and still permits disabling', async () => {
    const f = await fixture('kimi-k3');
    expect(await f.framework.bindModelApiContract({ modelId: f.model.id, expectedRevision: 1,
      binding: { schemaVersion: 1, contractId: 'official.moonshot.kimi-k3.chat', contractRevision: 1, rules: [] }, confirmed: true })).toMatchObject({ ok: true });
    await f.registry.mutate(s => ({ snapshot: { ...s, connections: s.connections.map(c => ({ ...c, credentialVersionId: 'credential-rotated' })) }, result: undefined }));
    expect(await f.framework.setModelEnabled({ modelId: f.model.id, enabled: true })).toMatchObject({ ok: false, error: { code: 'model_profile_unavailable' } });
    expect(await f.framework.setModelEnabled({ modelId: f.model.id, enabled: false })).toMatchObject({ ok: true });
  });

  it.each(listWwwVideoContracts().map(c => c.modelKey))('preserves exact WWW video enablement for %s', async key => {
    const f = await fixture(key);
    expect(await f.framework.setModelEnabled({ modelId: f.model.id, enabled: true })).toMatchObject({ ok: true });
    const s = await f.registry.load();
    expect(s.modelProfiles?.find(p => p.profileId === s.models[0].activeProfileId)?.apiContract?.contractId)
      .toBe(listWwwVideoContracts().find(c => c.modelKey === key)!.id);
    expect(f.readCredential).not.toHaveBeenCalled();
  });
});
