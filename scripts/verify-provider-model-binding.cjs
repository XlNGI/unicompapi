// Production page -> production preload -> production IPC/Host -> isolated JSON registry.
// Run after pnpm build. No real registry, credential vault, project, or Provider transport.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
if (!process.versions.electron) {
  // Chromium keeps userData files locked until process exit. A Node parent owns
  // and removes the exact temporary root after the child has fully stopped.
  (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-binding-run-'));
    const { spawn } = require('node:child_process');
    let exitCode = 1;
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { windowsHide: true, stdio: 'inherit',
          env: { ...process.env, UNICOMP_BINDING_TEST_ROOT: root } });
        child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
      });
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    }
    process.exitCode = exitCode;
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
const { app, BrowserWindow } = require('electron');
const p = require('../dist-electron/src/platform');
const d = require('../dist-electron/src/domain');
const { registerProviderIpcHandlers } = require('../dist-electron/electron/ipc/provider-ipc');
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'docs/evidence/model-binding-repair-20261019/electron');
assert.ok(process.env.UNICOMP_BINDING_TEST_ROOT, 'Run this verification with node');
const runRoot = path.resolve(process.env.UNICOMP_BINDING_TEST_ROOT);
assert.equal(path.dirname(runRoot), path.resolve(os.tmpdir()));
const userData = path.join(runRoot, 'userData');
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let window, temporary, credentialReads = 0, externalRequests = 0;
const errors = [], checks = [];
let lastScript;
const js = code => { lastScript = code; return window.webContents.executeJavaScript(code); };
const q = JSON.stringify;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(50); }
  throw new Error('Timed out: ' + code);
}
const findButton = label => 'Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === ' + q(label) + ')';
const byLabel = label => 'document.querySelector(' + q('[aria-label="' + label + '"]') + ')';
const modelToggle = key => 'Array.from(document.querySelectorAll(".uc-provider-page__model")).find(e => e.querySelector("small")?.textContent === ' + q(key) + ')?.querySelector("[role=switch]")';
async function clickButton(label) { await js(findButton(label) + '.click()'); }
async function selectModel(key) {
  await js('Array.from(document.querySelectorAll(".uc-provider-page__model-select")).find(e => e.textContent.includes(' + q(key) + ')).click()');
  await until('document.querySelector(".uc-provider-page__model-select[aria-pressed=true]")?.textContent.includes(' + q(key) + ')');
  await js('Array.from(document.querySelectorAll("details")).find(e => e.querySelector("summary")?.textContent === "模型 API 合同").open = true');
  await until(byLabel('模型 API 合同'));
}
async function main() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  temporary = path.join(runRoot, 'fixture');
  await fs.mkdir(temporary, { recursive: true });
  const packages = new p.ProviderPackageRegistry([p.unicompapiWwwProviderPackageDescriptor]);
  const resolved = packages.resolveTemplate(p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, p.UNICOMPAPI_WWW_TEMPLATE_ID);
  const now = d.toIsoTimestamp('2026-10-19T04:00:00.000Z');
  const provider = d.createProvider({ id: d.toProviderId('provider-ui-binding'), name: 'WWW isolated fixture', accessCategory: 'online', identityState: 'verified',
    packageId: resolved.package.packageId, packageVersion: resolved.package.packageVersion, createdAt: now, updatedAt: now });
  const connection = d.createProviderConnection({ id: d.toConnectionId('connection-ui-binding'), providerId: provider.id, name: 'Isolated WWW',
    endpoint: p.UNICOMPAPI_WWW_BASE_URL, packageId: provider.packageId, packageVersion: provider.packageVersion,
    templateId: p.UNICOMPAPI_WWW_TEMPLATE_ID, templateKind: resolved.template.kind,
    endpointPolicyId: resolved.endpointPolicy.policyId, endpointPolicyRevision: resolved.endpointPolicy.revision,
    credentialSchemaId: resolved.credentialSchema.schemaId, credentialSchemaVersion: resolved.credentialSchema.version,
    connectionPolicyId: resolved.template.connectionPolicyId, connectionPolicyRevision: resolved.template.connectionPolicyRevision,
    discoveryPolicyId: resolved.template.discoveryPolicyId, discoveryPolicyRevision: resolved.template.discoveryPolicyRevision,
    adapterBindings: resolved.adapters.map(a => ({ adapterId: a.adapterId, adapterVersion: a.adapterVersion, protocolId: a.protocolId, protocolVersion: a.protocolVersion })),
    connectionRevision: 1, connectionConfigVersionId: 'config-ui-binding', credentialVersionId: 'credential-ui-binding',
    state: 'available', credentialState: 'valid', identityState: 'verified', createdAt: now, updatedAt: now });
  const binding = d.createProviderProtocolBinding({ id: d.toProtocolBindingId('binding-ui-chat'), providerId: provider.id, connectionId: connection.id,
    protocolId: p.NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION, adapterKind: p.NEWAPI_CHAT_ADAPTER_ID,
    mediaKind: 'unknown', executionLifecycle: 'unknown', supportedPurposes: [], authScheme: 'unknown', createdAt: now, updatedAt: now });
  const keys = ['deepseek-v4-flash', 'glm-4.6', 'glm-4.7', 'glm-5.2', 'kimi-k2.6', 'kimi-k3', 'qwen-image-2.0', 'wan3.0-video', 'deployment-alias'];
  const models = keys.map((key, i) => d.createProviderModel({ id: d.toModelId('model-ui-' + i), providerId: provider.id, connectionId: connection.id,
    protocolBindingId: binding.id, providerModelKey: key, displayName: key, mediaKind: 'unknown', enabled: false, catalogState: 'present',
    revision: 1, createdAt: now, updatedAt: now }));
  const registry = new p.JsonProviderRegistryStore(path.join(temporary, 'registry.json'));
  await registry.save({ schemaVersion: 2, providers: [provider], connections: [connection], protocolBindings: [binding], models, capabilities: [], routingPreferences: [] });
  const vault = new p.SecureCredentialVault(path.join(temporary, 'credentials.json'), { isAvailable: () => false,
    protect() { credentialReads++; throw new Error('Forbidden'); }, unprotect() { credentialReads++; throw new Error('Forbidden'); } });
  const management = new p.ProviderManagementFramework(packages, registry, vault, new p.ProviderManagementAdapterRegistry(packages, []),
    new p.JsonProviderManagementAuditStore(path.join(temporary, 'audit.json')));
  registerProviderIpcHandlers({ registry, management });
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: path.join(temporary, 'ui'), emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(workspace, 'tests/harness/provider-model-binding-harness.tsx'), formats: ['iife'], name: 'ProviderBindingUi', fileName: () => 'harness.js' } } });
  await fs.writeFile(path.join(temporary, 'ui/index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  window = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { preload: path.join(workspace, 'dist-electron/electron/preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, spellcheck: false, offscreen: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => { externalRequests++; callback({ cancel: true }); });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  await window.loadFile(path.join(temporary, 'ui/index.html'));
  await until(findButton('管理'));
  await clickButton('管理');
  await selectModel('deepseek-v4-flash');
  await js(modelToggle('deepseek-v4-flash') + '.click()');
  await until('document.body.textContent.includes("无法启用：请先完成模型适配或绑定兼容合同")');
  assert.equal((await registry.load()).models[0].enabled, false);
  checks.push('unbound text enable rejected through production UI/preload/IPC; stored state remains disabled');
  for (const key of keys.slice(0, 6)) {
    await selectModel(key);
    await js(byLabel('模型 API 合同') + '.click()');
    await until('Array.from(document.querySelectorAll("[role=option]")).some(e => e.textContent.includes(' + q(key) + '))');
    await js('Array.from(document.querySelectorAll("[role=option]")).find(e => e.textContent.includes(' + q(key) + ')).click()');
    await clickButton('确认兼容并绑定合同');
    await until('document.body.textContent.includes("当前绑定：official.") && !' + findButton('确认兼容并绑定合同') + '.disabled');
    const saved = await registry.load();
    const model = saved.models.find(m => m.providerModelKey === key);
    assert.equal(model.enabled, false);
    assert.equal(saved.modelProfiles.find(pr => pr.profileId === model.activeProfileId).status, 'declared');
    await js(modelToggle(key) + '.click()');
    await until(modelToggle(key) + '?.getAttribute("aria-checked") === "true"');
    assert.equal((await registry.load()).models.find(m => m.providerModelKey === key).enabled, true);
    checks.push(key + ': exact contract selected, bound without auto-enable, then explicitly enabled');
  }
  await selectModel('qwen-image-2.0');
  await until('document.body.textContent.includes("当前型号没有精确合同候选")');
  await js(modelToggle('qwen-image-2.0') + '.click()');
  await until('document.body.textContent.includes("无法启用：请先完成模型适配或绑定兼容合同")');
  assert.equal((await registry.load()).models.find(m => m.providerModelKey === 'qwen-image-2.0').enabled, false);
  checks.push('image model without a WWW image adapter stays pending and cannot be enabled');
  await selectModel('wan3.0-video');
  await js(byLabel('模型 API 合同') + '.click()');
  await until('document.querySelectorAll("[role=option]").length > 0');
  assert.equal(await js('Array.from(document.querySelectorAll("[role=option]")).every(e => e.textContent.includes("wan3.0-video"))'), true);
  await js('Array.from(document.querySelectorAll("[role=option]"))[0].click()');
  await clickButton('确认兼容并绑定合同');
  await until('document.body.textContent.includes("当前绑定：relay.unicompapi-www.wan3.0-video.video")');
  checks.push('video model keeps its exact relay contract; vendor text choices are excluded');
  window.webContents.invalidate();
  await delay(100);
  await fs.writeFile(path.join(output, 'video-bound.png'), (await window.webContents.capturePage()).toPNG());
  await selectModel('deployment-alias');
  await until('document.body.textContent.includes("当前型号没有精确合同候选")');
  await js('Array.from(document.querySelectorAll(".rs-toggle")).find(e => e.textContent.includes("中转别名"))?.querySelector("[role=switch]").click()');
  await js(byLabel('模型 API 合同') + '.click()');
  await until('document.querySelectorAll("[role=option]").length > 1');
  assert.equal(await js('Array.from(document.querySelectorAll("[role=option]")).every(e => e.textContent.includes("厂商合同"))'), true);
  assert.equal((await registry.load()).models.find(m => m.providerModelKey === 'deployment-alias').activeProfileId, undefined);
  checks.push('alias text choices require opt-in; no implicit contract binding');
  assert.equal(credentialReads, 0); assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
  const result = { status: 'passed', checks, errors, credentialReads, externalRequests,
    boundary: 'Production ProvidersPage, compiled preload, production IPC and Host registry; synthetic isolated records only; no live Provider compatibility claim' };
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, checks: checks.length, credentialReads, externalRequests }));
}
async function cleanup() {
  window?.destroy();
}
const deadline = setTimeout(() => { console.error('UI verification deadline'); app.exit(1); }, 180000);
main().then(async () => { await cleanup(); clearTimeout(deadline); app.exit(0); })
  .catch(async error => { console.error(error.stack); await fs.mkdir(output, { recursive: true });
    if (window && !window.isDestroyed()) {
      await fs.writeFile(path.join(output, 'failure.html'), await window.webContents.executeJavaScript('document.documentElement.outerHTML'));
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    }
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, lastScript, checks, errors }, null, 2));
    await cleanup(); clearTimeout(deadline); app.exit(1); });
}
