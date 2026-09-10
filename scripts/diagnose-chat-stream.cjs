const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { app, safeStorage } = require('electron');

// Explicitly approved diagnostics only: two bounded synthetic text requests.
const { values } = parseArgs({ options: {
  'authorized-two-synthetic-requests': { type: 'boolean' }, model: { type: 'string', multiple: true }
} });
const authorized = values['authorized-two-synthetic-requests'];
const modelNames = values.model ?? [];
const requestedAt = new Date().toISOString();
const results = [];
let setupCode;
let reportWritten = false;
const deadline = setTimeout(() => {
  setupCode = 'diagnostic_deadline_exceeded';
  writeReport();
  app.exit(1);
}, 190_000);
app.on('window-all-closed', () => {});

function writeReport() {
  if (reportWritten) return;
  reportWritten = true;
  process.stdout.write(JSON.stringify({ requestedAt, finishedAt: new Date().toISOString(), setupCode,
    outboundScope: 'synthetic text only, no attachments or conversation history',
    routeSource: 'recorded routes validated against current registry',
    maximumRequests: 2, maximumOutputTokensPerRequest: 512, retries: 0, cost: 'unknown', results }, null, 2) + '\n');
}

async function run() {
  if (!authorized) throw new Error('explicit_authorization_required');
  if (modelNames.length !== 2 || new Set(modelNames).size !== 2) throw new Error('two_distinct_models_required');
  await app.whenReady();
  const platform = require('../dist-electron/src/platform');
  const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
  const { ElectronProxyAdapter } = require('../dist-electron/electron/ipc/settings-platform-adapters');
  const dataDirectory = path.join(app.getPath('appData'), require('../package.json').name);
  const catalog = JSON.parse(await readFile(path.join(dataDirectory, 'project-catalog.json'), 'utf8'));
  const currentProject = [...catalog.entries].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0];
  if (!currentProject) throw new Error('project_unavailable');
  const routes = JSON.parse(await readFile(path.join(currentProject.rootDirectory, 'entities', 'provider-execution-route-snapshots.json'), 'utf8'));
  const executions = JSON.parse(await readFile(path.join(currentProject.rootDirectory, 'entities', 'conversation-response-executions.json'), 'utf8'));
  const registry = new platform.JsonProviderRegistryStore(path.join(dataDirectory, 'provider-registry.json'));
  const snapshot = await registry.load();
  const schemas = platform.createTextParameterSchemaResolver();
  const protector = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: () => { throw new Error('read_only_diagnostic'); },
    unprotect: (value) => safeStorage.decryptString(Buffer.from(value))
  };
  const vault = new platform.SecureCredentialVault(path.join(dataDirectory, 'secure-credentials.json'), protector);
  const plans = [];
  for (const modelName of modelNames) {
    const execution = [...executions.executions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find(item =>
      snapshot.models.some(model => model.id === item.snapshot.candidate.modelId && model.providerModelKey === modelName));
    const route = routes.snapshots.find(item => item.id === execution?.snapshot.routeSnapshotId);
    if (!route) throw new Error('recorded_route_unavailable');
    const connection = snapshot.connections.find(item => item.id === route.connectionId);
    if (!connection?.credentialReference || connection.credentialVersionId !== route.credentialVersionId ||
      route.providerModelKey !== modelName) throw new Error('recorded_route_no_longer_current');
    const schema = await schemas.get(route.parameterSchemaId, route.parameterSchemaRevision);
    const limitField = schema?.fields.find(field => field.fieldId === 'max_completion_tokens') ??
      schema?.fields.find(field => field.fieldId === 'max_tokens');
    if (!limitField) throw new Error('bounded_output_unavailable');
    plans.push({ modelName, route, limitField });
  }
  const settings = await new platform.JsonSettingsRepository(path.join(dataDirectory, 'settings', 'settings.json')).load();
  const proxyMode = settings.document.network.proxy;
  const proxyAdapter = new ElectronProxyAdapter();
  const proxy = new platform.ProxyService(proxyAdapter,
    new platform.SecureCredentialVault(path.join(dataDirectory, 'settings', 'proxy-credentials.json'), protector));
  try {
    await proxy.activate(proxyMode);
    for (const { modelName, route, limitField } of plans) {
    const safeLog = [];
    let contentLength = 0;
    let reasoningLength = 0;
    let safeCode;
    const observations = [];
    const runtime = new platform.NewApiSharedRuntime({
      transport: new ElectronNewApiHttpTransport(), proxy: () => proxyMode, defaultTimeoutMs: 90_000,
      defaultStreamIdleTimeoutMs: 90_000, defaultStreamTotalTimeoutMs: 90_000,
      logger: event => safeLog.push(event)
    });
    const adapter = new platform.NewApiChatAdapter(runtime,
      platform.createRegistryCredentialResolver(registry, vault),
      platform.createRegistryConnectionResolver(registry), schemas, {
        start: async () => {}, appendContent: async (_id, delta) => { contentLength += delta.length; },
        appendReasoning: async (_id, delta) => { reasoningLength += delta.length; }, complete: async () => {},
        fail: async (_id, code) => { safeCode = code; }, requestCancel: async () => {},
        confirmCancelled: async () => {}, interrupt: async () => {}
      }, { append: async observation => observations.push({ status: observation.status, facts: observation.facts }) });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 90_000);
    const entry = { model: modelName, state: 'in_progress', startedAt: new Date().toISOString(),
      cost: 'unknown', safeLog, observations };
    results.push(entry);
    try {
      const handle = await adapter.submit({ routeSnapshot: route, signal: abort.signal, request: {
        responseExecutionId: 'synthetic-diagnostic-execution', invocationAttemptId: 'synthetic-diagnostic-attempt',
        messages: [{ role: 'user', content: 'Reply with one short sentence describing a blue square. Text only.' }],
        parameterValues: { [limitField.fieldId]: 512 }
      } });
      const result = await handle.completion;
      Object.assign(entry, { state: result.state, safeCode });
    } catch (error) {
      const code = error && typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'diagnostic_failed';
      Object.assign(entry, { state: 'failed', safeCode: safeCode ?? code });
    } finally {
      clearTimeout(timeout);
      Object.assign(entry, { finishedAt: new Date().toISOString(), contentLength, reasoningLength });
      await adapter.dispose();
    }
    }
  } finally {
    proxy.dispose();
    proxyAdapter.dispose();
  }
}

run().catch(error => {
  setupCode = error && /^[a-z_]+$/.test(error.message) ? error.message : 'diagnostic_setup_failed';
  process.exitCode = 1;
}).finally(() => { clearTimeout(deadline); writeReport(); app.exit(process.exitCode ?? 0); });
