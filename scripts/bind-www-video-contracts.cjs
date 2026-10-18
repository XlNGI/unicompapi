// Local management only. Default is preview; --apply persists the nine authorized exact bindings.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const p = require('../dist-electron/src/platform');
const apply = process.argv.includes('--apply');
async function main() {
  assert.ok(process.env.APPDATA, 'Native app data directory unavailable');
  const userData = path.join(process.env.APPDATA, 'unicomp-desktop');
  const registry = new p.JsonProviderRegistryStore(path.join(userData, 'provider-registry.json'));
  const before = await registry.load();
  const connections = before.connections.filter(c => c.packageId === p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID && c.state === 'available');
  assert.equal(connections.length, 1); const connection = connections[0];
  const contracts = p.listWwwVideoContracts();
  const selected = contracts.map(c => { const model = before.models.find(m => m.connectionId === connection.id && m.providerModelKey === c.modelKey); assert.ok(model); return { contract: c, model }; });
  const packages = new p.ProviderPackageRegistry([p.unicompapiWwwProviderPackageDescriptor]);
  const vault = new p.SecureCredentialVault(path.join(userData, 'secure-credentials.json'), { isAvailable: () => false,
    protect: () => { throw new Error('No credential changes'); }, unprotect: () => { throw new Error('No credential reads'); } });
  const framework = new p.ProviderManagementFramework(packages, registry, vault, new p.ProviderManagementAdapterRegistry(packages, []),
    new p.JsonProviderManagementAuditStore(path.join(userData, 'provider-management-audit.json')));
  const results = [];
  for (const { contract, model } of selected) {
    if (apply) {
      const bound = await framework.bindModelApiContract({ modelId: model.id, expectedRevision: model.revision, binding: { schemaVersion: 1, contractId: contract.id, contractRevision: contract.revision, rules: [] }, confirmed: true });
      assert.ok(bound.ok, JSON.stringify(bound));
      const enabled = await framework.setModelEnabled({ modelId: model.id, enabled: true }); assert.ok(enabled.ok, JSON.stringify(enabled));
    }
    results.push({ model: model.providerModelKey, contractId: contract.id, authority: 'relay', state: apply ? 'bound_enabled' : 'preview' });
  }
  const after = await registry.load();
  const selectedIds = new Set(selected.map(x => x.model.id));
  assert.deepEqual(after.models.filter(m => !selectedIds.has(m.id)), before.models.filter(m => !selectedIds.has(m.id)));
  assert.deepEqual(after.connections.filter(c => c.id !== connection.id), before.connections.filter(c => c.id !== connection.id));
  assert.deepEqual(after.routingPreferences, before.routingPreferences);
  if (apply) for (const { contract, model } of selected) {
    const m = after.models.find(m => m.id === model.id), profile = after.modelProfiles.find(x => x.profileId === m.activeProfileId);
    assert.equal(m.enabled, true); assert.equal(profile.apiContract.contractId, contract.id);
    assert.equal(profile.apiContract.contractFingerprint, p.wwwVideoContractFingerprint(contract));
    assert.equal(profile.status, 'declared');
  }
  const receipt = { time: new Date().toISOString(), apply, connectionCount: 1, results, unrelatedModelsAndConnectionsUnchanged: true,
    credentialReads: 0, externalRequests: 0, liveVerification: 'Separate acceptance evidence; declaration is not live verification' };
  await fs.mkdir(path.resolve('outputs/www-video-contracts'), { recursive: true });
  await fs.writeFile(path.resolve('outputs/www-video-contracts', apply ? 'bindings-applied.json' : 'bindings-preview.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
main().catch(e => { console.error(JSON.stringify({ code: e.code ?? 'binding_failed', message: 'Inspect local management receipt; no external request made.' })); process.exitCode = 1; });
