const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const platform = require('../dist-electron/src/platform');
const fixture = require('./lib/r45-built-fixture.cjs');
const { registerChatContextIpcHandlers } = require('../dist-electron/electron/ipc/chat-context-ipc');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});

const projectId = fixture.projectId;
const rootDirectoryPromise = mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-mock-electron-project-'));
const userDataPromise = mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-mock-electron-user-'));
let browserWindow;
let lifecycle;
let newApiRuntime;
let deepSeekRuntime;
let requestCount = 0;
let abortCount = 0;
let transportMode = 'normal';

function sseResponse(model, text) {
  const chunk = { id: 'agent-mock-electron', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from(body); })() };
}

const transport = {
  send: async ({ body, signal }) => {
    requestCount += 1;
    const payload = JSON.parse(Buffer.from(body).toString('utf8'));
    if (transportMode === 'cancel') {
      await new Promise((resolve, reject) => {
        const onAbort = () => { abortCount += 1; reject(Object.assign(new Error('synthetic abort'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        void resolve;
      });
    }
    return sseResponse(payload.model, '真实 Electron 中的受控 Provider 替身响应。');
  }
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const rootDirectory = await rootDirectoryPromise;
  const userData = await userDataPromise;
  await mkdir(path.join(rootDirectory, 'entities'), { recursive: true });
  app.setPath('userData', userData);
  await app.whenReady();
  const providers = await fixture.providerFixture(userData, true);
  newApiRuntime = new platform.NewApiSharedRuntime({ transport });
  deepSeekRuntime = new platform.DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('unexpected deepseek request'); } } });
  const sessions = new platform.StorageProjectSessionRegistry();
  sessions.set({ projectId, projectName: 'Agent mock Electron', rootDirectory });
  lifecycle = registerChatContextIpcHandlers({
    getSession: () => sessions.get(),
    providerRegistry: providers.registry,
    providerPackages: new platform.ProviderPackageRegistry([
      platform.deepSeekProviderPackageDescriptor,
      platform.kimiProviderPackageDescriptor,
      platform.unicompapiProviderPackageDescriptor,
      platform.newApiProviderPackageDescriptor
    ]),
    runtimeAuthorization: providers.authorization,
    textSubmission: { credentialVault: providers.vault, deepSeekRuntime, newApiRuntime }
  });
  const html = path.join(rootDirectory, 'agent-mock.html');
  await writeFile(html, '<!doctype html><meta charset="utf-8"><title>Agent mock E2E</title>');
  browserWindow = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(path.resolve('.'), 'dist-electron/electron/preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false
  } });
  await browserWindow.loadFile(html);
  const js = source => browserWindow.webContents.executeJavaScript(source);
  const candidateResult = await js('window.unicomp.chatContexts.listTextCandidates("text_chat")');
  if (!candidateResult?.ok || !candidateResult.value?.length) throw new Error(`No synthetic candidate: ${JSON.stringify(candidateResult)}`);
  const candidateId = candidateResult.value[0].candidateId;
  const request = (id, content) => ({ clientCommandId: id, conversation: null, title: 'Agent mock Electron', content,
    productFeature: 'text_chat', candidateId, contextSelections: [], parameterValues: {} });
  const normal = await js(`window.unicomp.chatContexts.startAgentResponse(${JSON.stringify(request('mock-normal', '普通聊天'))})`);
  if (!normal?.ok || !normal.value?.execution?.responseExecutionId) throw new Error(`Normal Agent start failed: ${JSON.stringify(normal)}`);
  let normalRead;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    normalRead = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(normal.value.execution.responseExecutionId)})`);
    if (normalRead?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(normalRead.value.state)) break;
    await delay(100);
  }
  if (!normalRead?.ok || normalRead.value.state !== 'completed') throw new Error(`Normal execution not completed: ${JSON.stringify(normalRead)}`);

  transportMode = 'cancel';
  await js(`window.__agentMockPending = window.unicomp.chatContexts.startAgentResponse(${JSON.stringify(request('mock-cancel', '取消测试'))})`);
  await js('window.__agentMockPending.then(value => { window.__agentMockStartResult = value; }, error => { window.__agentMockStartResult = { ok: false, error: { message: String(error) } }; })');
  let cancelStartResult;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    cancelStartResult = await js('window.__agentMockStartResult');
    if (cancelStartResult !== undefined) break;
    await delay(100);
  }
  if (cancelStartResult?.ok && cancelStartResult.value?.execution?.responseExecutionId) {
    const cancelled = await js(`window.unicomp.chatContexts.cancelResponseExecution(${JSON.stringify(cancelStartResult.value.execution.responseExecutionId)})`);
    if (!cancelled?.ok) throw new Error(`Cancel execution failed: ${JSON.stringify(cancelled)}`);
  } else {
    const cancelledStart = await js('window.unicomp.chatContexts.cancelResponseStart({ projectId: "project-r45-built-offline", clientCommandId: "mock-cancel" })');
    if (!cancelledStart?.ok) throw new Error(`Cancel start failed: ${JSON.stringify(cancelledStart)}`);
  }
  await js('window.__agentMockPending');
  const report = { schemaVersion: 1, status: 'passed',
    boundary: 'real Electron BrowserWindow + production preload + production IPC + controlled in-process Provider transport',
    checks: ['normal Agent response', 'persistent execution identity', 'cancel start boundary'],
    requestCount, abortCount, toolCalling: 'not_run: fixture has no executable Office Tool Gateway target',
    externalProvider: 'blocked: no authorized external credentials used' };
  const output = path.resolve('outputs/conversation-phase6/agent-provider-mock-e2e.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function cleanup() {
  const bounded = (promise, ms = 1_500) => Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, ms))
  ]);
  await bounded(lifecycle?.interruptActiveResponses?.());
  await bounded(lifecycle?.waitForMutations?.());
  newApiRuntime?.dispose();
  deepSeekRuntime?.dispose();
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  await bounded(rm(await rootDirectoryPromise, { recursive: true, force: true }));
  await bounded(rm(await userDataPromise, { recursive: true, force: true }));
}

run().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; })
  .finally(async () => {
    await cleanup();
    app.quit();
    setTimeout(() => process.exit(process.exitCode ?? 0), 2_000).unref();
  });
