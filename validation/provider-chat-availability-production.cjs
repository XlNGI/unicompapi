const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Run after pnpm build: pnpm exec electron validation/provider-chat-availability-production.cjs
// Real production renderer/preload/IPC/repositories; isolated synthetic project and
// credentials. Catalog responses and the two fault scenarios are the only mocks.
const base = path.resolve(__dirname, '..');
fsSync.mkdirSync(path.join(base, 'tmp'), { recursive: true });
const runRoot = fsSync.mkdtempSync(path.join(base, 'tmp/provider-chat-e2e-'));
const artifacts = [];
const checks = [];
const ipcCalls = [];
let networkRequests = 0;
let generationRequests = 0;
let candidateFault = 'none';
let candidateFaultsRemaining = 0;
let win;
console.log('Synthetic production artifacts:', runRoot);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.setPath('userData', path.join(runRoot, 'user-data'));
const deadline = setTimeout(() => { console.error('Production verification deadline exceeded'); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, (...args) => {
  ipcCalls.push(channel);
  if (channel === 'chat-context:list-text-candidates') {
    if (candidateFault === 'first-two-fail' && candidateFaultsRemaining > 0) {
      candidateFaultsRemaining--;
      return { ok: false, error: { code: 'storage_error', message: 'Synthetic candidate read failure' } };
    }
    if (candidateFault === 'reasoning-rejects' && args[1]?.productFeature === 'text_reasoning') {
      throw new Error('Synthetic reasoning candidate rejection');
    }
  }
  return listener(...args);
});
const transport = require(path.join(base, 'dist-electron/electron/ipc/management-adapters.js'));
transport.ElectronNewApiHttpTransport.prototype.send = async function (request) {
  if (request.method !== 'GET' || !request.url.endsWith('/models')) {
    generationRequests++;
    throw new Error('Unexpected model request blocked by offline verification');
  }
  return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
    object: 'list', data: ['qwen-image', 'glm-5.2', 'deepseek-r1-0528'].map(id => ({ id, object: 'model' }))
  })) };
};
const platform = require(path.join(base, 'dist-electron/src/platform'));
platform.StorageProjectSessionRegistry.prototype.get = () => ({
  projectId: 'provider-chat-production-e2e', projectName: '模型与对话隔离验收', rootDirectory: path.join(runRoot, 'project')
});
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
const execute = script => win.webContents.executeJavaScript(script);
async function waitFor(script, description) {
  for (let i = 0; i < 80; i++) { if (await execute(script).catch(() => false)) return; await pause(100); }
  throw new Error('Timed out: ' + description);
}
async function clickText(text, selector = 'button') {
  await execute(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!e) throw new Error('missing '+${JSON.stringify(text)}); e.click(); })()`);
}
async function inputValue(selector, value) {
  await execute(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing input'); const prototype = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await pause(100);
}
async function screenshot(name) {
  await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const file = name + '.png'; await fs.writeFile(path.join(runRoot, file), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); artifacts.push(file);
}
async function selectModel(key) {
  await execute(`(() => { const e = [...document.querySelectorAll('.uc-provider-page__model-select')].find(x => x.textContent.includes(${JSON.stringify(key)})); if (!e) throw new Error('missing model '+${JSON.stringify(key)}); e.click(); })()`);
  await waitFor(`document.querySelector('[aria-label="模型概要"]')?.textContent.includes(${JSON.stringify(key)})`, 'model summary selection');
  await pause(100);
}
async function providerGeometry() {
  return execute(`(() => {
    const aside = document.querySelector('[aria-label="模型概要"]');
    const row = document.querySelector('.uc-provider-page__model-search-row');
    const dock = document.querySelector('.uc-project-status-dock');
    const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; };
    const modelRows = [...document.querySelectorAll('.uc-provider-page__model')].map(e => ({ profileRight: e.querySelector('.uc-provider-page__model-select').getBoundingClientRect().right, enabledLeft: e.querySelector('.uc-status-pill').getBoundingClientRect().left }));
    return { summaryPosition: getComputedStyle(aside).position, summary: rect(aside), catalog: rect(row), dock: rect(dock), modelRows, nativeExists: !!document.querySelector('.uc-provider-page__native-search'), nativeOpen: !!document.querySelector('.uc-provider-page__native-search[open]'), viewport: { width: innerWidth, height: innerHeight }, overflowX: document.documentElement.scrollWidth > innerWidth };
  })()`);
}
async function checkProviderLayout(width, height, expanded) {
  const state = await providerGeometry();
  assert.equal(state.summaryPosition, 'static');
  assert.ok(state.summary.bottom <= state.catalog.top, 'summary/configuration overlaps catalog');
  assert.ok(state.summary.left >= 0 && state.summary.right <= state.viewport.width, 'summary exceeds window width');
  assert.equal(state.overflowX, false, 'page creates horizontal overflow');
  assert.ok(state.modelRows.every(row => row.profileRight <= row.enabledLeft), 'model status columns overlap');
  assert.equal(state.nativeOpen, expanded);
  checks.push({ case: expanded ? 'text-settings-expanded' : 'image-summary', size: `${width}x${height}`, geometry: state });
}
(async () => {
  fsSync.mkdirSync(path.join(runRoot, 'project'), { recursive: true });
  fsSync.mkdirSync(app.getPath('userData'), { recursive: true });
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => { networkRequests++; callback({ cancel: true }); }));
  require(path.join(base, 'dist-electron/electron/main.js'));
  await app.whenReady();
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && await execute('Boolean(document.querySelector(".app-shell"))').catch(() => false)) break;
    await pause(100);
  }
  assert.ok(win);
  win.webContents.setBackgroundThrottling(false);
  win.setMinimumSize(0, 0);
  await execute(`(async () => {
    const p = window.unicomp.providers;
    const added = await p.addConnection({ packageId: 'provider-package-unicompapi', templateId: 'unicompapi-official', name: 'Synthetic UI connection', credentials: { api_key: 'synthetic-offline-only' } });
    if (!added.ok) throw new Error(JSON.stringify(added));
    const registry = await p.getRegistry(); if (!registry.ok) throw new Error(JSON.stringify(registry));
    if (registry.value.models.length !== 3) throw new Error('Synthetic catalog was not discovered');
    for (const model of registry.value.models) { const r = await p.setModelEnabled(model.modelId, true); if (!r.ok) throw new Error(JSON.stringify(r)); }
    return true;
  })()`);
  await clickText('模型与服务商');
  await waitFor('!!document.querySelector(".uc-provider-page__view-switch")', 'provider view');
  await clickText('连接管理');
  await waitFor('document.querySelectorAll(".uc-provider-page__model").length === 3', 'synthetic model catalog');
  for (const [width, height] of [[1280, 820], [1024, 768], [1440, 900]]) {
    win.setContentSize(width, height); await pause(180);
    await selectModel('qwen-image');
    await execute('document.querySelector(".uc-provider-page").scrollIntoView({ block: "start" })');
    assert.equal((await providerGeometry()).nativeExists, false, 'image model exposes text search protocol');
    await checkProviderLayout(width, height, false);
    await screenshot(`provider-image-${width}x${height}`);
    await selectModel('glm-5.2');
    const collapsed = await providerGeometry();
    assert.equal(collapsed.nativeExists, true); assert.equal(collapsed.nativeOpen, false);
    await execute('document.querySelector(".uc-provider-page__native-search summary").click()');
    await pause(100);
    await execute('document.querySelector("[aria-label=模型概要]").scrollIntoView({ block: "start" })');
    await checkProviderLayout(width, height, true);
    await screenshot(`provider-text-expanded-${width}x${height}`);
  }
  const evidenceInput = '.uc-provider-page__native-search input[type="url"]';
  await inputValue(evidenceInput, 'https://example.com/synthetic-draft');
  await execute('document.querySelector(".uc-provider-page__native-search .rs-picker-toggle").click()');
  await waitFor('document.body.innerText.includes("智谱对话搜索")', 'native protocol options');
  await clickText('智谱对话搜索', '[role="option"]');
  await selectModel('deepseek-r1-0528');
  assert.equal((await providerGeometry()).nativeOpen, false);
  await execute('document.querySelector(".uc-provider-page__native-search summary").click()');
  assert.equal(await execute(`document.querySelector(${JSON.stringify(evidenceInput)}).value`), '');
  assert.equal(await execute('document.querySelector(".uc-provider-page__native-search").textContent.includes("请选择已确认支持的协议")'), true);
  checks.push({ case: 'model-switch-clears-evidence-and-protocol-draft', passed: true });

  candidateFault = 'first-two-fail'; candidateFaultsRemaining = 2;
  await clickText('对话');
  await waitFor('document.body.innerText.includes("读取模型列表失败")', 'candidate loading failure');
  await inputValue('textarea', '我要生成ppt');
  await execute('document.querySelector("[aria-label=模型设置]").click()');
  await waitFor('document.body.innerText.includes("模型列表加载失败，请重新加载")', 'picker failure message');
  assert.equal(await execute('document.body.innerText.includes("本地保存失败")'), false);
  await screenshot('chat-model-load-failure');
  await clickText('重新加载模型', '.uc-chat-page__message button');
  await waitFor('!document.body.innerText.includes("读取模型列表失败")', 'retry clears failure');
  assert.equal(await execute('document.querySelector("textarea").value'), '我要生成ppt');
  checks.push({ case: 'candidate-read-failure-retry-preserves-draft', passed: true });
  await pause(180);
  if (!await execute('document.querySelector("[aria-label=模型设置]")?.getAttribute("aria-expanded") === "true"')) {
    await execute('document.querySelector("[aria-label=模型设置]").click()');
  }
  await waitFor('document.querySelector("[aria-label=模型设置]")?.getAttribute("aria-expanded") === "true" && document.querySelectorAll("[role=option]").length > 0', 'visible recovered model menu');
  await screenshot('chat-model-load-recovered');
  await execute('document.querySelector("[aria-label=模型设置]").click()');
  await execute('document.querySelector("[aria-label=发送消息]").click()');
  await waitFor('document.body.innerText.includes("主题") && !document.querySelector("[aria-label=停止需求理解]")', 'local PPT topic clarification');
  const workflow = await execute(`(async () => { const list = await window.unicomp.chatContexts.listConversations(true, false); if (!list.ok || !list.value.length) throw new Error('conversation missing'); const c = await window.unicomp.chatContexts.getConversation(list.value[0].conversationId); if (!c.ok) throw new Error('conversation unavailable'); return c.value.messages.map(m => ({ role: m.role, content: m.content })); })()`);
  assert.ok(workflow.some(m => m.role === 'assistant' && m.content.includes('主题')), 'PPT topic question was not persisted');
  assert.equal(generationRequests, 0);
  await screenshot('chat-ppt-local-clarification');
  checks.push({ case: 'ppt-topic-clarification-persisted-without-model-request', passed: true });

  candidateFault = 'reasoning-rejects';
  await clickText('模型与服务商'); await waitFor('!!document.querySelector(".uc-provider-page")', 'leave chat');
  await clickText('对话'); await waitFor('!!document.querySelector("[aria-label=模型设置]")', 'return to chat');
  await execute('document.querySelector("[aria-label=模型设置]").click()');
  await waitFor('document.querySelectorAll("[role=option]").length > 0', 'successful chat candidates retained');
  assert.equal(await execute('document.body.innerText.includes("读取模型列表失败")'), false);
  await clickText('深度推理适合复杂分析，响应时间可能更长', '[role="radio"]');
  await waitFor('document.body.innerText.includes("模型列表加载失败，请重新加载")', 'failed reasoning category is explicit');
  await screenshot('chat-partial-candidate-failure');
  checks.push({ case: 'one-candidate-category-rejects-other-remains-usable', passed: true });
  assert.equal(networkRequests, 0); assert.equal(generationRequests, 0);
  assert.equal(ipcCalls.filter(c => c === 'providers:set-native-search').length, 0, 'draft testing unexpectedly saved configuration');
  const result = { passed: true, checks, realNetworkRequests: networkRequests, generationRequests, artifacts, scope: 'isolated synthetic userData/project; production renderer/preload/IPC; no real network/model request' };
  await fs.writeFile(path.join(runRoot, 'provider-chat-availability-production-result.json'), JSON.stringify(result, null, 2));
  console.log('Production provider/chat regression passed:', checks.length, 'checks');
  clearTimeout(deadline); app.quit();
})().catch(async error => {
  console.error(error);
  if (win && !win.isDestroyed()) { await screenshot('failure').catch(() => {}); }
  await fs.writeFile(path.join(runRoot, 'provider-chat-availability-production-result.json'), JSON.stringify({ passed: false, error: String(error), checks, artifacts, realNetworkRequests: networkRequests, generationRequests }, null, 2)).catch(() => {});
  clearTimeout(deadline); app.exit(1);
});
