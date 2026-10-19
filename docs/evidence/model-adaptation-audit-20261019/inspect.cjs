// Local audit: read the live registry as bytes only; exercise mutations on a temporary copy.
// No credential vault, Provider transport, user project, or real registry mutation is used.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
const Module = require('node:module');
const workspace = path.resolve(__dirname, '../../..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Match the application's TypeScript resolution: otherwise Node chooses the
// adjacent official-api-contracts.json before official-api-contracts.ts.
const originalResolver = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('.') && parent?.filename?.startsWith(workspace + path.sep) && !path.extname(request)) {
    const candidate = path.resolve(path.dirname(parent.filename), request + '.ts');
    if (fs.existsSync(candidate)) return candidate;
  }
  return originalResolver.call(this, request, parent, ...rest);
};
require.extensions['.ts'] = (entry, filename) => entry._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }
}).outputText, filename);
const source = relative => require(path.join(workspace, relative));
const { JsonProviderRegistryStore } = source('src/platform/providers/provider-registry.ts');
const { ProviderPackageRegistry } = source('src/platform/providers/provider-package-registry.ts');
const { ProviderManagementFramework, ProviderManagementAdapterRegistry } = source('src/platform/providers/provider-management-framework.ts');
const { RegistryFeatureCandidateSource, ProviderFeatureContractRegistry } = source('src/platform/providers/provider-registry-feature-candidates.ts');
const { initializeProviderFeatureProfiles } = source('src/platform/providers/provider-feature-profile-initialization.ts');
const { unicompapiWwwProviderPackageDescriptor: descriptor } = source('src/platform/providers/newapi/unicompapi-contracts.ts');
const { listOfficialApiContracts } = source('src/platform/providers/contracts/official-api-contracts.ts');
const { listWwwVideoContracts, wwwVideoContractFingerprint } = source('src/platform/providers/newapi/www-video-contracts.ts');
const auditedFiles = [
  'src/pages/providers/ModelContractBinding.tsx', 'src/pages/providers/ProviderManageView.tsx',
  'src/platform/providers/provider-management-framework.ts', 'src/platform/providers/provider-registry.ts',
  'src/platform/providers/provider-registry-feature-candidates.ts', 'src/platform/providers/provider-feature-candidates.ts',
  'src/platform/providers/provider-feature-profile-initialization.ts', 'src/platform/providers/provider-model-catalog.ts',
  'src/platform/providers/contracts/official-api-contracts.ts', 'src/platform/providers/contracts/official-api-contracts.json',
  'src/platform/providers/contracts/bound-text-contract.ts', 'src/domain/entities/parameter-compatibility.ts',
  'src/platform/providers/newapi/unicompapi-contracts.ts', 'src/platform/providers/newapi/unicompapi-model-capabilities.ts',
  'src/platform/providers/newapi/openai-compatible-image-routing.ts', 'src/platform/providers/newapi/openai-compatible-video-routing.ts',
  'src/platform/providers/newapi/newapi-chat-adapter.ts', 'src/platform/providers/newapi/www-video-contracts.ts',
  'src/platform/providers/newapi/www-video-catalog.json', 'src/platform/providers/newapi/www-video-adapter.ts',
  'scripts/audit-model-contracts.cjs', 'scripts/bind-www-video-contracts.cjs'
];
const sourceHashes = () => Object.fromEntries(auditedFiles.map(relative => [relative, sha256(fs.readFileSync(path.join(workspace, relative)))]));
async function main() {
  const livePath = path.join(process.env.APPDATA, 'unicomp-desktop', 'provider-registry.json');
  const beforeBytes = await fsp.readFile(livePath);
  const snapshot = JSON.parse(beforeBytes);
  const beforeHashes = sourceHashes();
  const connections = snapshot.connections.filter(c => c.packageId === descriptor.packageId && c.state !== 'deleted');
  assert.equal(connections.length, 1, 'Expected one current WWW connection');
  const connection = connections[0];
  const vendorContracts = listOfficialApiContracts();
  const relayContracts = listWwwVideoContracts();
  const rows = snapshot.models.filter(m => m.connectionId === connection.id && m.catalogState !== 'retired').map(model => {
    const active = (snapshot.modelProfiles ?? []).find(p => p.profileId === model.activeProfileId);
    const relay = relayContracts.find(c => c.modelKey === model.providerModelKey);
    return { modelKey: model.providerModelKey, enabled: model.enabled, catalogState: model.catalogState,
      profileStatus: active?.status ?? null, features: active?.features.map(f => f.productFeature) ?? [],
      contractId: active?.apiContract?.contractId ?? null,
      contractRevision: active?.apiContract?.contractRevision ?? null,
      contractFingerprintCurrent: active?.apiContract && relay ? active.apiContract.contractFingerprint === wwwVideoContractFingerprint(relay) : null,
      connectionPinCurrent: active?.apiContractConnectionPin ? active.apiContractConnectionPin.connectionConfigVersionId === connection.connectionConfigVersionId &&
        active.apiContractConnectionPin.credentialVersionId === connection.credentialVersionId : null,
      exactVendorContractCandidates: vendorContracts.filter(c => c.modelKeys.includes(model.providerModelKey)).map(c => c.id),
      exactRelayContractCandidate: relay?.id ?? null };
  });
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'unicomp-model-adaptation-audit-'));
  assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
  let credentialAccessAttempts = 0;
  let externalRequestAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { externalRequestAttempts++; throw new Error('Network forbidden in local audit'); };
  const vault = new Proxy({}, { get() { credentialAccessAttempts++; throw new Error('Credentials forbidden in local audit'); } });
  const packages = new ProviderPackageRegistry([descriptor]);
  const auditEvents = [];
  const replays = [];
  try {
    const registry = new JsonProviderRegistryStore(path.join(tempRoot, 'registry.json'));
    await registry.save(snapshot);
    const framework = new ProviderManagementFramework(packages, registry, vault,
      new ProviderManagementAdapterRegistry(packages, []), {
        async append(event) { const record = { ...event, schemaVersion: 1, sequence: auditEvents.length + 1 }; auditEvents.push(record); return record; },
        async list() { return auditEvents; }
      });
    const subject = { projectId: 'project-audit-synthetic', subject: { kind: 'draft', draftId: 'draft-audit-synthetic', draftRevision: 1 },
      productFeature: 'text_chat', surface: 'conversation', imageCount: 0, videoCount: 0, contextCount: 0,
      parameterValues: {}, outboundTextSnapshot: 'Synthetic offline audit.', materialReferences: [], contextContentHashes: [] };
    const candidates = new RegistryFeatureCandidateSource(registry, packages, new ProviderFeatureContractRegistry([]), {
      async checkAccess() { return { allowed: true, operation: 'submit', reason: 'allowed', policyId: 'policy-audit-synthetic', policyRevision: 1 }; }
    });
    // A model with an exact vendor contract still has no automatically attached text profile after enable/initialization.
    const deepSeek = snapshot.models.find(m => m.connectionId === connection.id && m.providerModelKey === 'deepseek-v4-flash');
    assert.ok(deepSeek);
    const enabled = await framework.setModelEnabled({ modelId: deepSeek.id, enabled: true });
    assert.equal(enabled.ok, true);
    await initializeProviderFeatureProfiles(registry, packages);
    const afterEnable = await registry.load();
    const enabledModel = afterEnable.models.find(m => m.id === deepSeek.id);
    const enableCandidates = (await candidates.list(subject)).filter(c => c.routeTemplate.modelId === deepSeek.id);
    assert.equal(enabledModel.enabled, true);
    assert.equal(enabledModel.activeProfileId, undefined);
    assert.equal(enableCandidates.length, 0);
    replays.push({ case: 'enable_unbound_www_text_model', modelKey: deepSeek.providerModelKey,
      result: enabled.value.state, profileAfterInitialization: null, textCandidateCount: 0,
      findingReproduced: 'Enable succeeds without an executable text profile' });
    // Exercise the production host binder for all six source-backed, currently unbound exact text keys.
    for (const row of rows.filter(r => !r.contractId && r.exactVendorContractCandidates.some(id => id.endsWith('.chat')))) {
      const current = (await registry.load()).models.find(m => m.connectionId === connection.id && m.providerModelKey === row.modelKey);
      const contractId = row.exactVendorContractCandidates.find(id => id.endsWith('.chat'));
      const contract = vendorContracts.find(c => c.id === contractId);
      const bound = await framework.bindModelApiContract({ modelId: current.id, expectedRevision: current.revision,
        binding: { schemaVersion: 1, contractId, contractRevision: contract.revision, rules: [] }, confirmed: true });
      assert.equal(bound.ok, true, `${row.modelKey}: ${JSON.stringify(bound)}`);
      const after = await registry.load();
      const model = after.models.find(m => m.id === current.id);
      const profile = after.modelProfiles.find(p => p.profileId === model.activeProfileId);
      const textCandidates = (await candidates.list(subject)).filter(c => c.routeTemplate.modelId === current.id);
      assert.equal(textCandidates.length, 1, row.modelKey);
      assert.equal(textCandidates[0].eligibility.bindingAvailable, true, row.modelKey);
      assert.equal(textCandidates[0].eligibility.featureSupported, true, row.modelKey);
      replays.push({ case: 'bind_www_vendor_text_contract_on_copy', modelKey: row.modelKey, contractId,
        result: bound.value.state, profileStatus: profile.status, textCandidateCount: textCandidates.length,
        bindingAvailable: true, featureSupported: true, liveCompatibility: 'not_tested' });
    }
    const image = snapshot.models.find(m => m.connectionId === connection.id && m.providerModelKey === 'qwen-image-2.0');
    assert.ok(image);
    const imageEnabled = await framework.setModelEnabled({ modelId: image.id, enabled: true });
    assert.equal(imageEnabled.ok, true);
    await initializeProviderFeatureProfiles(registry, packages);
    const imageAfter = (await registry.load()).models.find(m => m.id === image.id);
    const imageCandidates = (await candidates.list({ ...subject, productFeature: 'text_to_image', surface: 'quick' }))
      .filter(c => c.routeTemplate.modelId === image.id);
    assert.equal(imageAfter.activeProfileId, undefined);
    assert.equal(imageCandidates.length, 0);
    replays.push({ case: 'enable_www_image_without_adapter', modelKey: image.providerModelKey,
      result: imageEnabled.value.state, imageCandidateCount: imageCandidates.length, profileAfterInitialization: null,
      imageAdapterPublished: descriptor.adapters.some(a => a.adapterId === 'newapi.image'), liveCompatibility: 'not_tested' });
    const afterBytes = await fsp.readFile(livePath);
    assert.equal(sha256(afterBytes), sha256(beforeBytes), 'Live registry changed while auditing');
    assert.deepEqual(sourceHashes(), beforeHashes, 'Audited source changed while auditing');
    assert.equal(credentialAccessAttempts, 0);
    assert.equal(externalRequestAttempts, 0);
    const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), baseline: 'e29b7a8',
      scope: 'Local WWW registry inventory and offline production-host replays; not a remote model inventory or live Provider acceptance',
      localConnection: { endpoint: connection.endpoint, state: connection.state, identityState: connection.identityState, credentialState: connection.credentialState },
      counts: { catalogModels: rows.length, boundModels: rows.filter(r => r.contractId).length,
        unboundModels: rows.filter(r => !r.contractId).length, enabledBoundModels: rows.filter(r => r.contractId && r.enabled).length,
        unboundWithExactVendorSourceCandidate: rows.filter(r => !r.contractId && r.exactVendorContractCandidates.length).length,
        unboundWithoutExactSourceCandidate: rows.filter(r => !r.contractId && !r.exactVendorContractCandidates.length).length },
      publishedWwwAdapters: descriptor.adapters.map(a => a.adapterId), models: rows, replays,
      guards: { liveRegistrySha256Before: sha256(beforeBytes), liveRegistrySha256After: sha256(afterBytes), liveRegistryUnchanged: true,
        credentialAccessAttempts, externalRequestAttempts, realUserProjectsRead: 0, sourceUnchanged: true, sourceHashes: beforeHashes },
      initialHarnessFailure: { attempts: 2, cause: 'CommonJS source loader resolved an extensionless import to adjacent JSON before TypeScript',
        productFailure: false, correction: 'Prefer workspace .ts source for extensionless imports, matching application compilation' },
      limitations: ['No public document requests or remote discovery', 'No paid model calls', 'No Electron UI replay',
        'Contract source candidates do not prove WWW protocol compatibility', 'Existing full-suite results are not counted as this audit'] };
    await fsp.writeFile(path.join(__dirname, 'inspection.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ counts: report.counts, replays, guards: { liveRegistryUnchanged: true, sourceUnchanged: true, credentialAccessAttempts, externalRequestAttempts } }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
