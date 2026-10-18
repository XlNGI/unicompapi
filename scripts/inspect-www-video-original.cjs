// Read only the paid acceptance original. No generation, upload or settlement operations.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const p = require('../dist-electron/src/platform');
const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
const originalRoot = path.join(app.getPath('appData'), 'unicomp-desktop');
const recordArg = process.argv.find(x => x.startsWith('--record-index='));
const recordIndex = recordArg ? Number(recordArg.slice('--record-index='.length)) : 0;
if (!Number.isSafeInteger(recordIndex) || recordIndex < 0) throw new Error('Invalid original record index');
const queryOnly = process.argv.includes('--query-only');
const profile = sync.mkdtempSync(path.join(os.tmpdir(), 'unicomp-www-original-read-'));
sync.copyFileSync(path.join(originalRoot, 'Local State'), path.join(profile, 'Local State'));
app.setPath('userData', profile); app.disableHardwareAcceleration();
async function main() {
  await app.whenReady();
  const output = path.resolve('outputs/www-video-contracts', recordArg ? `original-read-${recordIndex}` : 'live-e2e');
  await fs.mkdir(output, { recursive: true });
  const budget = JSON.parse(await fs.readFile(path.resolve('outputs/www-video-contracts/live/budget.json'), 'utf8'));
  const entry = budget.records[recordIndex]; if (!entry?.taskId) throw new Error('No original');
  const registry = new p.JsonProviderRegistryStore(path.join(originalRoot, 'provider-registry.json'));
  const c = (await registry.load()).connections.find(c => c.packageId === p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID);
  const connection = { ...c, adapterBindings: [...c.adapterBindings.filter(b => b.adapterId !== p.NEWAPI_VIDEO_ADAPTER_ID),
    { adapterId: p.NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: p.NEWAPI_ADAPTER_VERSION, protocolId: p.NEWAPI_VIDEO_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION }] };
  const vault = new p.SecureCredentialVault(path.join(originalRoot, 'secure-credentials.json'), { isAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: v => safeStorage.encryptString(v), unprotect: v => safeStorage.decryptString(Buffer.from(v)) });
  const runtime = new p.NewApiSharedRuntime({ transport: new ElectronNewApiHttpTransport() });
  try { await vault.useRecord(c.credentialReference, async credentials => {
    for (const operation of queryOnly ? ['query'] : ['query', 'request_lookup']) {
      const response = await runtime.requestWwwVideo({ connection, credentials, operation, h3: entry.model === 'MiniMax-H3', remoteId: entry.taskId, idempotencyKey: entry.idempotencyKey });
      const data = JSON.parse(Buffer.from(response.body).toString());
      const summarize = v => Array.isArray(v) ? v.map(summarize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) =>
        [k, /prompt|token|secret|key|authorization|content|input|output/i.test(k) && k !== 'idempotency_key' ? '[redacted]' : summarize(x)])) :
        typeof v === 'string' && v.length > 600 ? '[bounded]' : v;
      await fs.writeFile(path.join(output, `original-${operation}.json`), JSON.stringify(summarize(data), null, 2));
      await fs.writeFile(path.join(output, `inspection-${operation}.json`), JSON.stringify({ inspectedAt: new Date().toISOString(),
        operation, method: 'GET', model: entry.model, taskId: entry.taskId, status: data.status,
        billing: data.billing, errorCode: data.error?.code, paidGenerationPosts: 0 }, null, 2));
      console.log(JSON.stringify({ operation, fields: Object.keys(data), status: data.status, result: data.data }));
    }
  }); } finally { runtime.dispose(); }
}
main().then(() => app.exit(0)).catch(e => { console.error(JSON.stringify({ code: e.code ?? 'read_failed' })); app.exit(1); });
