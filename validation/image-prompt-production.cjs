const { app, BrowserWindow, ipcMain, nativeImage, session } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

// After pnpm build:
//   pnpm exec electron validation/image-prompt-production.cjs
//   UNICOMP_TEST_IMAGE_PROMPT_SCENARIO=no-model repeats the original request
//   without a selected model, then selects one and continues the saved request.
// Only the project/session and HTTP transport are synthetic. Image paste/import,
// renderer, preload, IPC, intent planning, scope checks, and repositories are real.
const base = path.resolve(__dirname, '..');
const scenario = process.env.UNICOMP_TEST_IMAGE_PROMPT_SCENARIO || 'selected';
assert.ok(['selected', 'no-model'].includes(scenario), 'Unknown image prompt scenario');
fsSync.mkdirSync(path.join(base, 'tmp'), { recursive: true });
const runRoot = fsSync.mkdtempSync(path.join(base, 'tmp/image-prompt-e2e-'));
const projectRoot = path.join(runRoot, 'project');
const modelKey = 'gpt-5.6-sol';
const replies = [
  '参考图提示词：蓝色与橙色方块构成简洁几何图案，平面构图，清晰边缘。（合成视觉验收）',
  'English prompt: A clean geometric composition of blue and orange squares, flat design, crisp edges. (Synthetic visual verification)'
];
const checks = [];
const ipcCalls = [];
const workflows = [];
const modelRequests = [];
const artifacts = [];
let networkRequests = 0;
let imageBytes;
let imageHash;
let win;
console.log('Synthetic image prompt artifacts:', runRoot);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.setPath('userData', path.join(runRoot, 'user-data'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Image prompt verification deadline exceeded'); app.exit(1); }, 90000);
const execute = script => win.webContents.executeJavaScript(script);

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  ipcCalls.push(channel);
  const result = await listener(...args);
  if (['chat-context:start-workflow', 'chat-context:answer-workflow'].includes(channel) && result?.ok) {
    const workflow = result.value.workflow;
    workflows.push({ channel, kind: workflow.plan.kind, status: workflow.status, missing: workflow.plan.missing,
      ambiguities: workflow.plan.ambiguities, workflowId: workflow.workflowId });
  }
  return result;
});
const transport = require(path.join(base, 'dist-electron/electron/ipc/management-adapters.js'));
transport.ElectronNewApiHttpTransport.prototype.send = async function (request) {
  if (request.method === 'GET' && request.url.endsWith('/models')) {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
      object: 'list', data: [{ id: modelKey, object: 'model' }]
    })) };
  }
  assert.equal(request.method, 'POST');
  assert.ok(request.url.endsWith('/chat/completions'), 'Image prompting must not call document or image generation endpoints');
  const body = JSON.parse(new TextDecoder().decode(request.body));
  modelRequests.push(body);
  assert.ok(modelRequests.length <= 2, 'Unexpected classifier, retry, or duplicate response request');
  const userMessages = body.messages.filter(message => message.role === 'user');
  const lastUser = userMessages.at(-1);
  assert.ok(Array.isArray(lastUser?.content), 'The current message must contain real multimodal input');
  const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
  assert.equal(images.length, 1, 'Exactly one authorized image must be sent, without history duplication');
  const url = images[0].image_url?.url;
  assert.match(url, /^data:image\/png;base64,/);
  const sentBytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  assert.equal(createHash('sha256').update(sentBytes).digest('hex'), imageHash, 'The imported image bytes must reach both model requests');
  const lastText = lastUser.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.ok(lastText.includes(modelRequests.length === 1 ? '生成提示词' : '生成英文提示词'), 'The current instruction was lost');
  assert.ok(!body.tools?.some(tool => tool.type === 'web_search' || tool.type === 'builtin_function'), 'Image prompting must not enable network search');
  const reply = replies[modelRequests.length - 1];
  const chunk = { id: `chatcmpl-image-prompt-${modelRequests.length}`, object: 'chat.completion.chunk', created: 1, model: modelKey,
    choices: [{ index: 0, delta: { content: reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  })() };
};
const platform = require(path.join(base, 'dist-electron/src/platform'));
platform.StorageProjectSessionRegistry.prototype.get = () => ({
  projectId: 'image-prompt-production-project', projectName: '附图提示词隔离验收', rootDirectory: projectRoot
});
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};

async function waitFor(script, description) {
  for (let i = 0; i < 150; i++) {
    if (await execute(script).catch(() => false)) return;
    await pause(100);
  }
  const page = await execute('document.body.innerText').catch(() => 'unavailable');
  throw new Error(`Timed out: ${description}\n${page}`);
}
async function screenshot(name) {
  // Chromium defers lazy image decoding in a hidden validation window. Decode
  // the real preview URLs before visual QA; never substitute preview content.
  await execute('Promise.all(Array.from(document.images).map(async image => { image.loading = "eager"; await image.decode(); }))');
  await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const file = `${name}.png`;
  await fs.writeFile(path.join(runRoot, file), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  artifacts.push(file);
}
async function selectModel() {
  await execute('document.querySelector("[aria-label=模型设置]").click()');
  await waitFor(`Array.from(document.querySelectorAll('[role=option]')).some(e => e.textContent.includes(${JSON.stringify(modelKey)}))`, 'model option');
  await execute(`(() => { const option = [...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes(${JSON.stringify(modelKey)})); option.click(); })()`);
}
async function send(content) {
  await execute(`(() => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(content)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('document.querySelector("[aria-label=发送消息]")?.disabled === false', 'enabled send button');
  await execute('document.querySelector("[aria-label=发送消息]").click()');
}
async function storedConversation() {
  return execute(`(async () => {
    const api = window.unicomp.chatContexts;
    const list = await api.listConversations(true, false);
    if (!list.ok || list.value.length !== 1) throw new Error('Expected one isolated conversation');
    const result = await api.getConversation(list.value[0].conversationId);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
  })()`);
}
function assertChatWorkflows() {
  assert.ok(workflows.length >= 1, 'The request must pass through the real workflow planner');
  for (const workflow of workflows) {
    assert.equal(workflow.kind, 'chat', 'Prompt wording must be treated as a chat task');
    assert.ok(!['needs_clarification', 'needs_confirmation'].includes(workflow.status), 'No Office/unknown intent clarification is needed');
    assert.deepEqual(workflow.missing, []);
    assert.deepEqual(workflow.ambiguities, []);
  }
}
async function assertCompletedResponse(index) {
  await waitFor(`document.body.innerText.includes(${JSON.stringify(replies[index - 1])}) && !!document.querySelector('[aria-label="发送消息"]') && document.querySelector('textarea')?.disabled === false`, `response ${index}`);
  const stored = await storedConversation();
  assert.equal(modelRequests.length, index, 'One model response request is allowed per user instruction');
  assert.equal(stored.messages.filter(message => message.role === 'user').length, index, 'Model selection must not duplicate the original user request');
  assert.ok(stored.messages.some(message => message.role === 'assistant' && message.state === 'completed' && message.content.includes(replies[index - 1])));
  assert.ok(stored.messages.every(message => !message.documentResult), 'Prompt text must not create a document');
  assertChatWorkflows();
  return stored;
}

(async () => {
  fsSync.mkdirSync(projectRoot, { recursive: true });
  fsSync.mkdirSync(app.getPath('userData'), { recursive: true });
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => {
    networkRequests++;
    callback({ cancel: true });
  }));
  require(path.join(base, 'dist-electron/electron/main.js'));
  await app.whenReady();
  const bitmap = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    const blue = (x < 32) === (y < 32);
    bitmap[offset] = blue ? 220 : 30;
    bitmap[offset + 1] = blue ? 100 : 150;
    bitmap[offset + 2] = blue ? 30 : 240;
    bitmap[offset + 3] = 255;
  }
  imageBytes = nativeImage.createFromBitmap(bitmap, { width: 64, height: 64 }).toPNG();
  assert.ok(imageBytes.length > 0);
  imageHash = createHash('sha256').update(imageBytes).digest('hex');
  await fs.writeFile(path.join(runRoot, 'synthetic-reference.png'), imageBytes);
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && await execute('Boolean(document.querySelector(".app-shell"))').catch(() => false)) break;
    await pause(100);
  }
  assert.ok(win);
  win.webContents.setBackgroundThrottling(false);
  win.setContentSize(1280, 820);
  await execute(`(async () => {
    const providers = window.unicomp.providers;
    const added = await providers.addConnection({ packageId: 'provider-package-unicompapi', templateId: 'unicompapi-official',
      name: 'Synthetic image prompting', credentials: { api_key: 'synthetic-offline-only' } });
    if (!added.ok) throw new Error(JSON.stringify(added));
    const registry = await providers.getRegistry();
    if (!registry.ok || registry.value.models.length !== 1) throw new Error('Synthetic model missing');
    const enabled = await providers.setModelEnabled(registry.value.models[0].modelId, true);
    if (!enabled.ok) throw new Error(JSON.stringify(enabled));
  })()`);
  await execute(`(() => { const navigation = [...document.querySelectorAll('button,a')].find(e => e.textContent.trim() === '对话'); if (!navigation) throw new Error('Chat navigation missing'); navigation.click(); })()`);
  await waitFor('!!document.querySelector("textarea") && !!document.querySelector("[aria-label=模型设置]")', 'chat composer');
  if (scenario === 'selected') await selectModel();
  else assert.ok(!(await execute('document.querySelector("[aria-label=模型设置]").innerText')).includes(modelKey), 'This scenario requires no selected model');

  await execute(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'synthetic-reference.png', { type: 'image/png' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  })()`);
  await waitFor('!!document.querySelector(".uc-chat-page__attachments .uc-chat-attachment--image img") && document.querySelector(".uc-chat-page__attachments button[aria-label^=移除附件]")?.disabled === false', 'real pasted image import');
  assert.equal(ipcCalls.filter(channel => channel === 'document-attachment:import').length, 1);
  assert.equal(modelRequests.length, 0);
  await send('生成提示词');
  if (scenario === 'no-model') {
    await waitFor('Array.from(document.querySelectorAll(".uc-chat-page__message,[role=status]")).some(e => /(?:选择|选用).{0,8}(?:可用)?模型/.test(e.textContent)) && !!document.querySelector("[aria-label=发送消息]")', 'model selection notice');
    assert.equal(modelRequests.length, 0, 'No provider request is allowed before choosing a model');
    assertChatWorkflows();
    const pending = await storedConversation();
    assert.equal(pending.messages.filter(message => message.role === 'user').length, 1);
    assert.ok(pending.messages.every(message => !message.documentResult));
    await screenshot('image-prompt-awaiting-model');
    checks.push({ case: 'missing-model-keeps-chat-request-and-image', passed: true });
    await selectModel();
    await waitFor('Array.from(document.querySelectorAll("button")).some(e => e.textContent.trim() === "继续执行" && !e.disabled)', 'ready to continue the saved request');
    await execute('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "继续执行").click()');
  }
  const first = await assertCompletedResponse(1);
  const firstAttachment = first.messages.find(message => message.role === 'user')?.attachments?.[0];
  assert.ok(firstAttachment, 'Original user message must retain its imported image reference');
  await screenshot('image-prompt-completed');
  checks.push({ case: 'original-image-prompt-one-response-no-clarification', passed: true });
  await send('生成英文提示词');
  const second = await assertCompletedResponse(2);
  assert.deepEqual(second.messages.find(message => message.role === 'user').attachments?.[0], firstAttachment);
  assert.equal(ipcCalls.filter(channel => channel === 'document-attachment:import').length, 1, 'Follow-up must reuse the existing image scope');
  assert.ok(!ipcCalls.some(channel => /^document-generation:(?:prepare-generation|prepare-deterministic-revision|generate-from-message)$/.test(channel)), 'No Office document generation command is allowed');
  const documents = await fs.readdir(path.join(projectRoot, 'files/documents')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(documents.length, 0);
  assert.equal(networkRequests, 0);
  await screenshot('image-prompt-english-follow-up');
  checks.push({ case: 'english-follow-up-reuses-identical-image-bytes', passed: true });
  const result = { passed: true, scenario, checks, workflows, modelRequests: modelRequests.length, realNetworkRequests: networkRequests,
    image: { mimeType: 'image/png', checksumSha256: imageHash, bytes: imageBytes.length }, artifacts,
    scope: 'isolated synthetic image/project/userData; real production UI, preload, IPC, scope validation, and repositories; synthetic model transport only' };
  await fs.writeFile(path.join(runRoot, 'image-prompt-production-result.json'), JSON.stringify(result, null, 2));
  console.log('Image prompt production verification passed:', scenario, checks.length, 'checks');
  clearTimeout(deadline); app.quit();
})().catch(async error => {
  console.error(error);
  if (win && !win.isDestroyed()) await screenshot('failure').catch(() => {});
  await fs.writeFile(path.join(runRoot, 'image-prompt-production-result.json'), JSON.stringify({ passed: false, scenario, error: String(error),
    checks, workflows, modelRequests: modelRequests.length, realNetworkRequests: networkRequests, artifacts }, null, 2)).catch(() => {});
  clearTimeout(deadline); app.exit(1);
});
