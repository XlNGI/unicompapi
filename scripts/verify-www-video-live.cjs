// Read-only WWW quote inspection. Paid acceptance exists only in verify-www-video-electron.cjs.
// Credentials remain inside the native encrypted vault callback.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const p = require('../dist-electron/src/platform');
const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
const userRoot = path.join(app.getPath('appData'), 'unicomp-desktop');
const output = path.resolve('outputs/www-video-contracts/live');
if (process.argv.includes('--generate')) throw new Error('Use the bounded native acceptance script for generation');
const isolatedUserData = path.join(os.tmpdir(), `unicomp-www-live-${process.pid}`);
fsSync.mkdirSync(isolatedUserData, { recursive: true });
// Chromium's OS-encrypted master key belongs to this profile. Copy only encrypted Local State.
fsSync.copyFileSync(path.join(userRoot, 'Local State'), path.join(isolatedUserData, 'Local State'));
app.setPath('userData', isolatedUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const examples = [
  { model: 'happyhorse-1.1-t2v', parameters: { resolution: '480P', duration_seconds: 3, watermark: false } },
  { model: 'wan3.0-video', parameters: { generation_mode: 'text_to_video', resolution: '480P', duration_seconds: 2 } },
  { model: 'wan3.0-video-ali', parameters: { generation_mode: 'text_to_video', resolution: '480P', duration_seconds: 2 } },
  { model: 'wan3.0-video-prime-ali', parameters: { generation_mode: 'text_to_video', resolution: '480P', duration_seconds: 2 } },
  { model: 'doubao-seedance-2-0-260128', parameters: { generation_mode: 'text_to_video', resolution: '480P', duration_seconds: 4 } },
  { model: 'MiniMax-H3', action: 'generate', parameters: { resolution: '2K', ratio: '16:9', duration: 4, generate_audio: true, watermark: false } }
];
function shape(v, depth = 0) {
  if (depth > 4) return 'bounded';
  if (Array.isArray(v)) return { type: 'array', count: v.length, first: v.length ? shape(v[0], depth + 1) : undefined };
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, val]) => [k, shape(val, depth + 1)]));
  return typeof v;
}
async function main() {
  await app.whenReady(); await fs.mkdir(output, { recursive: true });
  const lock = await fs.open(path.join(output, 'run.lock'), 'wx');
  let runtime;
  try {
    const registry = new p.JsonProviderRegistryStore(path.join(userRoot, 'provider-registry.json'));
    const snapshot = await registry.load();
    const connections = snapshot.connections.filter(c => c.packageId === p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID && c.state === 'available');
    if (connections.length !== 1) throw new Error('Expected one available WWW connection');
    const connection = connections[0];
    const vault = new p.SecureCredentialVault(path.join(userRoot, 'secure-credentials.json'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(), protect: value => safeStorage.encryptString(value),
      unprotect: value => safeStorage.decryptString(Buffer.from(value))
    });
    runtime = new p.NewApiSharedRuntime({ transport: new ElectronNewApiHttpTransport(), defaultTimeoutMs: 45_000 });
    // Read-only quotes use a temporary in-memory binding. Persistent changes go through management separately.
    const routedConnection = { ...connection, adapterBindings: [...(connection.adapterBindings ?? []).filter(b => b.adapterId !== p.NEWAPI_VIDEO_ADAPTER_ID),
      { adapterId: p.NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: p.NEWAPI_ADAPTER_VERSION, protocolId: p.NEWAPI_VIDEO_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION }] };
    await vault.useRecord(connection.credentialReference, async credentials => {
      for (const example of examples) {
        const original = { ...example, prompt: 'A small orange ceramic cup on a plain white table. Static camera, gentle studio lighting. No people, no text.' };
        const h3 = example.model === 'MiniMax-H3';
        let quote;
        try {
          const response = await runtime.requestWwwVideo({ connection: routedConnection, credentials, operation: 'quote', h3,
            body: new TextEncoder().encode(JSON.stringify({ ...original, ...(h3 ? { operation: 'quote' } : {}) })) });
          const q = JSON.parse(new TextDecoder().decode(response.body));
          quote = q.quote ?? q;
          const evidence = { model: example.model, time: new Date().toISOString(), quoteOnly: true, currency: quote.currency,
            quotedAmount: quote.quoted_amount, priceVersion: quote.price_version, inputDigest: quote.input_digest,
            closedReasons: Array.isArray(quote.closed_reasons) ? quote.closed_reasons.map(x => typeof x === 'string' && /^[A-Za-z0-9_. -]{1,120}$/.test(x) ? x : 'see_original_quote') : undefined,
            responseShape: shape(q), parameters: example.parameters };
          await fs.writeFile(path.join(output, `quote-${example.model}.json`), JSON.stringify(evidence, null, 2));
          console.log(JSON.stringify({ model: example.model, currency: evidence.currency, quotedAmount: evidence.quotedAmount, closedReasons: evidence.closedReasons, responseShape: evidence.responseShape }));
        } catch (e) {
          console.log(JSON.stringify({ model: example.model, quoteError: e.code ?? 'unavailable', requestId: e.failureDiagnostic?.requestId }));
          continue;
        }
      }
    });
  } finally { runtime?.dispose(); await lock.close(); await fs.rm(path.join(output, 'run.lock')); }
}
const deadline = setTimeout(() => { console.error('Live acceptance deadline; inspect durable originals before any new action.'); app.exit(1); }, 300_000);
main().then(() => { clearTimeout(deadline); app.exit(0); }).catch(e => { clearTimeout(deadline); console.error(JSON.stringify({ error: e.code ?? e.name ?? 'failed', message: e.code ? undefined : 'Acceptance stopped; no automatic retry.' })); app.exit(1); });
