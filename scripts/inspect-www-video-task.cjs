// Read only one accepted WWW task. No uploads, quotes, generation or settlement.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit' });
  child.on('error', () => { console.error('Diagnostic process unavailable'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, safeStorage } = require('electron');
  const option = name => {
    const at = process.argv.indexOf(name);
    assert.ok(at >= 0 && process.argv[at + 1], 'Required diagnostic option missing');
    return process.argv[at + 1];
  };
  const projectDirectory = path.resolve(option('--project-directory'));
  const executionId = option('--execution-id');
  const output = path.resolve(option('--output-directory'));
  const originalRoot = path.join(app.getPath('appData'), 'unicomp-desktop');
  const profile = path.join(__dirname, '../.cache/www-video-diagnostic-20261019', String(process.pid));
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(path.join(originalRoot, 'Local State'), path.join(profile, 'Local State'));
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = value => Array.isArray(value) ? value : Object.values(value).find(Array.isArray) ?? [];
  function summary(value, field = '', depth = 0) {
    if (depth > 7) return '[bounded]';
    if (Array.isArray(value)) return value.slice(0, 10).map(v => summary(v, field, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 65).map(([key, v]) =>
      [key, /prompt|input|authorization|secret|token|credential/i.test(key) ? '[redacted]' : summary(v, key, depth + 1)]));
    if (typeof value === 'string') {
      if (/^(id|asset_id|model|status|state|action|output_type|review_phase|currency|price_version|code|type|object|mime_type|kind)$/.test(field) && /^[A-Za-z0-9_.:/-]{0,200}$/.test(value)) return value;
      if (field === 'url' && /^https:\/\/www\.unicompapi\.com\/v1\/(?:h3\/tasks|videos)\/[A-Za-z0-9_-]+\/content\?asset_id=[A-Za-z0-9_-]+$/.test(value)) return value;
      if (field === 'url' && /^\/v1\/(?:h3\/tasks|videos)\/[A-Za-z0-9_-]+\/content\?asset_id=[A-Za-z0-9_-]+$/.test(value)) return value;
      return { type: 'string', length: value.length };
    }
    return value;
  }
  async function main() {
    await app.whenReady();
    const p = require('../dist-electron/src/platform');
    const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
    const executionPath = path.join(projectDirectory, 'entities/executions.json');
    const routesPath = path.join(projectDirectory, 'entities/provider-execution-route-snapshots.json');
    const invocationsPath = path.join(projectDirectory, 'entities/provider-invocations.json');
    const registryPath = path.join(originalRoot, 'provider-registry.json');
    const protectedFiles = [executionPath, routesPath, invocationsPath, registryPath];
    const before = protectedFiles.map(file => sha(fs.readFileSync(file)));
    const execution = rows(read(executionPath)).find(e => e.id === executionId);
    assert.ok(execution?.remoteOperationId && execution.submissionOutcome === 'accepted_async', 'No accepted original task');
    const invocation = rows(read(invocationsPath)).find(i => i.subject?.executionId === executionId);
    const route = rows(read(routesPath)).find(r => r.id === invocation?.routeSnapshotId);
    assert.equal(route?.packageId, p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID);
    const registry = new p.JsonProviderRegistryStore(registryPath);
    const connection = (await registry.load()).connections.find(c => c.id === route.connectionId);
    assert.equal(connection?.credentialVersionId, route.credentialVersionId);
    assert.equal(connection?.connectionConfigVersionId, route.connectionConfigVersionId);
    const vault = new p.SecureCredentialVault(path.join(originalRoot, 'secure-credentials.json'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(), protect: v => safeStorage.encryptString(v), unprotect: v => safeStorage.decryptString(Buffer.from(v))
    });
    const requests = [];
    const transport = new ElectronNewApiHttpTransport();
    const runtime = new p.NewApiSharedRuntime({ transport: { async send(request) {
      const url = new URL(request.url);
      try {
      assert.equal(request.method, 'GET');
      assert.equal(url.origin, 'https://www.unicompapi.com');
      assert.equal(url.pathname, '/v1/' + (route.providerModelKey === 'MiniMax-H3' ? 'h3/tasks/' : 'videos/') + execution.remoteOperationId);
      assert.equal(request.body, undefined);
      const response = await transport.send(request);
      requests.push({ method: request.method, path: url.pathname, status: response.status });
      return response;
      } catch (error) {
        console.error(JSON.stringify({ stage: 'original_get', method: request.method, path: url.pathname,
          name: error.name, kind: error.kind, assertion: error.name === 'AssertionError' ? error.message : undefined }));
        throw error;
      }
    } } });
    try {
      await vault.useRecord(connection.credentialReference, async credentials => {
        const response = await runtime.requestWwwVideo({ connection, credentials, operation: 'query', h3: route.providerModelKey === 'MiniMax-H3', remoteId: execution.remoteOperationId });
        const original = JSON.parse(Buffer.from(response.body).toString('utf8'));
        const report = { capturedAt: new Date().toISOString(), model: route.providerModelKey, remoteTaskId: execution.remoteOperationId,
          localState: execution.state, localFailure: execution.failure, requests, paidGenerationPosts: 0, settlementPosts: 0,
          responseSha256: sha(response.body), response: summary(original), localRecordsUnchanged: protectedFiles.every((file, i) => sha(fs.readFileSync(file)) === before[i]) };
        assert.equal(report.localRecordsUnchanged, true);
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'original-task-inspection.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
      });
    } finally { runtime.dispose(); }
  }
  main().then(() => app.exit(0)).catch(error => { console.error(JSON.stringify({ code: error.code ?? 'diagnostic_failed', name: error.name })); app.exit(1); });
}
