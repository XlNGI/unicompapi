const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { mkdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'outputs', 'chat-production-progress');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'unicomp-chat-progress-'));
const buildDirectory = path.join(temporary, 'build');
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const checks = [];
const errors = [];
const blockedRequests = [];
let window;
const deadline = setTimeout(() => { console.error('Chat progress verification timed out'); app.exit(1); }, 120000);
const js = (source) => window.webContents.executeJavaScript(source);
async function until(source) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await js(source)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${source}`);
}
async function snapshot() {
  return js(`({
    text: document.body.innerText,
    progress: document.querySelectorAll('[aria-label="生产进度"]').length,
    summaries: Array.from(document.querySelectorAll('.uc-chat-document-progress__summary')).map(e => e.textContent),
    details: document.querySelectorAll('.uc-chat-document-progress details').length,
    steps: Array.from(document.querySelectorAll('.uc-chat-document-progress__step-list li')).map(e => e.textContent),
    trace: Array.from(document.querySelectorAll('.uc-chat-production-trace > li')).map(e => ({ code: e.dataset.eventCode, status: e.dataset.status, text: e.textContent })),
    assistants: document.querySelectorAll('li.uc-chat-page__message-item--assistant').length,
    bodies: Array.from(document.querySelectorAll('[aria-label="生成正文"]')).map(e => e.innerText),
    remoteImages: document.querySelectorAll('[aria-label="生成正文"] img[src^="http"]').length,
    replyStatus: document.querySelectorAll('[aria-label="回复状态"]').length,
    oldCards: document.querySelectorAll('.uc-chat-document-progress__steps,.uc-chat-page__activity,.uc-chat-page__reasoning').length
  })`);
}
async function assertClean() {
  const value = await snapshot();
  assert.equal(value.oldCards, 0);
  assert.doesNotMatch(value.text, /PRIVATE_REASONING|PRIVATE_OUTLINE|PRIVATE_PATH|AI 工作过程|模型返回的思考内容|生成步骤/);
  return value;
}
async function capture(name) {
  await delay(100);
  await writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
}
async function captureBody(name) {
  // Let streamed Markdown settle, then scroll the actual conversation viewport as a reader would.
  await delay(350);
  await js(`(() => {
    const body = document.querySelector('[aria-label="生成正文"]');
    const viewport = body.closest('.uc-chat-page__messages');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
    body.scrollIntoView({block:'center', behavior:'instant'});
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
  })()`);
  await delay(100);
  const bounds = await js(`(() => { const r = document.querySelector('[aria-label="生成正文"]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`);
  assert.ok(bounds.top >= 80 && bounds.bottom < 650, `Body must be visible in screenshot: ${JSON.stringify(bounds)}`);
  await capture(name);
}
async function verifyStreamStability() {
  await js('chatProgressHarness.mount("document")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('制作一份年度经营报告 PPT');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending');
  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().subscribed');
  await js('chatProgressHarness.emitDocumentChunk("paragraph")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("营收增长来自")');
  await delay(200);
  const samples = await js(`(async () => {
    const body = document.querySelector('[aria-label="生成正文"]');
    const viewport = body.closest('.uc-chat-page__messages');
    const composer = document.querySelector('.uc-chat-page__composer');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const initial = {height:body.offsetHeight, text:body.textContent, top:body.getBoundingClientRect().top,
      composerTop:composer.getBoundingClientRect().top, scroll:viewport.scrollTop,
      rows:document.querySelectorAll('.uc-chat-production-trace > li').length};
    const samples = [];
    for (let i = 0; i < 25; i++) {
      chatProgressHarness.emitTrace('model_response', 'progress', {purpose:'content', contentCharacters:1000+i}, 'assistant');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const current = document.querySelector('[aria-label="生成正文"]');
      samples.push({sameNode:current===body, textRetained:current.textContent===initial.text,
        heightDelta:current.offsetHeight-initial.height, topDelta:current.getBoundingClientRect().top-initial.top,
        composerDelta:composer.getBoundingClientRect().top-initial.composerTop, scrollDelta:viewport.scrollTop-initial.scroll,
        addedRows:document.querySelectorAll('.uc-chat-production-trace > li').length-initial.rows});
    }
    window.stableBody = body;
    return samples;
  })()`);
  assert.ok(samples.every(s => s.sameNode), 'progress updates must retain the body DOM node');
  assert.ok(samples.every(s => s.textRetained), 'progress updates must never clear visible body text');
  assert.ok(samples.every(s => s.heightDelta === 0 && s.topDelta === 0 && s.composerDelta === 0 && s.scrollDelta === 0 && s.addedRows === 0),
    `progress-only updates must not move the reading position: ${JSON.stringify(samples)}`);
  await js('chatProgressHarness.emitDocumentChunk("rest")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("客户留存稳定")');
  assert.equal(await js('window.stableBody === document.querySelector("[aria-label=生成正文]")'), true);
  await js('chatProgressHarness.finishDocument()');
  await until('chatProgressHarness.state().localGenerationPending');
  assert.equal(await js('window.stableBody === document.querySelector("[aria-label=生成正文]")'), true);
  await js('chatProgressHarness.finishLocalDocument()');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告（已校验）")');
  assert.equal(await js('window.stableBody === document.querySelector("[aria-label=生成正文]")'), true);
  await assertClean();
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, []);
  await capture('stream-stability.png');
  const report = {scope:'Real ChatPage, synthetic IPC, isolated profile; no model or network calls', samples,
    bodyRetainedThroughContentAndCompletion:true, errors, blockedRequests};
  await writeFile(path.join(output, 'stream-stability.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function run() {
  await mkdir(output, { recursive: true });
  await app.whenReady();
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: buildDirectory, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(workspace, 'tests/harness/chat-production-progress-harness.tsx'), formats: ['iife'],
        name: 'ChatProgressHarness', fileName: () => 'harness.js' } }
  });
  await writeFile(path.join(buildDirectory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}#root>.uc-chat-page{height:100%}</style></head><body><div id="root" class="workspace"></div><script src="harness.js"></script></body></html>');
  window = new BrowserWindow({ show: false, width: 1280, height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false, offscreen: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    blockedRequests.push(new URL(request.url).origin);
    callback({ cancel: true });
  });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(path.join(buildDirectory, 'index.html'));
  await until('window.chatProgressHarness?.ready && document.querySelector("[aria-label=生产进度]")');
  await until('document.body.innerText.includes("合成模型")');
  if (process.argv.includes('--stream-stability')) return verifyStreamStability();
  let value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.summaries.length, 1);
  assert.equal(value.details, 0, 'no completed events means no fabricated step list');
  assert.equal(value.replyStatus, 0);
  assert.doesNotMatch(value.text, /当前没有已登记的文本候选/);
  checks.push('saved document: one summary, no fabricated stages, no raw outline or reasoning');
  await capture('saved-document.png');

  await js('chatProgressHarness.mount("new-chat")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('请分析这些资料。');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending && document.querySelectorAll(".uc-chat-production-trace > li").length === 2');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.assistants, 1);
  assert.equal(value.details, 0);
  assert.equal((await js('chatProgressHarness.state().counters')).starts, 0);
  await until('chatProgressHarness.state().commandSubscriptions === 0 && chatProgressHarness.state().conversationSubscriptions === 1');
  assert.deepEqual(value.trace.map(e => e.code), ['request_received', 'model_request']);
  assert.match(value.trace[0].text, /请分析这些资料/);
  assert.match(value.trace[1].text, /本地 → 模型.*发送模型请求.*已开始/);
  checks.push('new-conversation planning: events appear before workflow returns, then command subscription hands off to one conversation subscription');
  await capture('planning-pending.png');

  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().subscribed && document.querySelectorAll(".uc-chat-production-trace > li").length === 8');
  await until('document.body.innerText.includes("这是合成的普通回复正文")');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.replyStatus, 0);
  assert.equal(value.assistants, 1, 'the temporary planning message must bind to the actual response');
  assert.equal(value.details, 0, 'all trace events are expanded by default');
  assert.match(value.text, /这是合成的普通回复正文/);
  assert.equal(value.bodies.length, 0, 'ordinary chat keeps its normal reply without a second generated-body panel');
  assert.equal(value.text.match(/这是合成的普通回复正文/g).length, 1);
  const traceText = value.trace.map((item) => item.text).join('\n');
  assert.match(traceText, /模型 → 本地/);
  assert.match(traceText, /本地工具/);
  checks.push('model response: all eight events stay expanded inside the same assistant alongside ordinary content');
  await capture('ordinary-reply.png');

  await js('chatProgressHarness.completeResponse()');
  await until('!chatProgressHarness.state().subscribed');
  await js('chatProgressHarness.emitTrace("document_compile", "started", {documentKind:"ppt"}, "assistant"); chatProgressHarness.emitTrace("document_compile", "completed", {documentKind:"ppt"}, "assistant"); chatProgressHarness.emitTrace("document_render", "failed", undefined, "assistant")');
  await until('document.querySelector(".uc-chat-document-progress__summary")?.textContent.includes("渲染文档 · 失败")');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.summaries.length, 1);
  assert.equal(value.replyStatus, 0);
  assert.equal(value.assistants, 1);
  assert.equal(value.trace.length, 11, 'streaming model-response progress is shown as one stable row');
  assert.deepEqual(value.trace.slice(-3).map(e => e.status), ['started', 'completed', 'failed']);
  assert.match(value.text, /这是合成的普通回复正文/, 'task progress must retain ordinary reply content');
  checks.push('local document events continue after text streaming ends, and a failed event is visibly marked as failure');
  await capture('production-progress-expanded.png');

  await js('chatProgressHarness.emitTrace("document_structure_check", "completed", {totalPages:3}, "assistant"); chatProgressHarness.emitTrace("document_hash_check", "completed", {bytes:1024}, "assistant"); chatProgressHarness.emitTrace("document_publish", "completed", undefined, "assistant"); chatProgressHarness.emitTrace("document_register", "completed", undefined, "assistant"); chatProgressHarness.emitTrace("task_complete", "completed", undefined, "assistant")');
  await until('document.querySelector(".uc-chat-document-progress__summary")?.textContent.includes("结束任务 · 已完成")');
  await js('chatProgressHarness.replay()');
  value = await assertClean();
  assert.equal(value.summaries.length, 1);
  assert.equal(value.trace.length, 16, 'duplicate and out-of-order replay must not add duplicate events');
  assert.deepEqual(value.trace.slice(-5).map(e => e.code), ['document_structure_check', 'document_hash_check', 'document_publish', 'document_register', 'task_complete']);
  assert.match(value.text, /这是合成的普通回复正文/);
  checks.push('publication: structure, file integrity, publish and registration events remain ordered after duplicate reversed replay');
  window.setSize(1024, 768);
  await capture('production-progress-compact.png');

  await js('chatProgressHarness.mount("reopen")');
  await until('document.querySelectorAll(".uc-chat-production-trace > li").length === 16');
  value = await assertClean();
  assert.equal(value.assistants, 1);
  assert.equal(value.details, 0);
  checks.push('history reopening restores all saved events on the original assistant without requiring a live response');
  await js('chatProgressHarness.issue()');
  await until('document.body.innerText.includes("生产记录不完整")');
  checks.push('a recording issue is shown explicitly instead of implying a complete execution history');
  await capture('production-progress-history.png');

  await js('chatProgressHarness.mount("saved-completed")');
  await until('document.querySelector("[aria-label=生产进度]")?.textContent.includes("文档已生成并保存")');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.details, 0);
  checks.push('reopened completed document hides historical reasoning and does not invent completed events');
  await js('chatProgressHarness.mount("saved-terminal-stale")');
  await until('document.querySelectorAll(".uc-chat-production-trace > li").length === 1');
  value = await assertClean();
  assert.match(value.summaries[0], /文档已生成并保存/);
  assert.equal(value.trace[0].status, 'started');
  assert.doesNotMatch(value.summaries[0], /已开始/);
  checks.push('persisted document completion takes summary precedence over a truncated trace whose last event only started');

  await js('chatProgressHarness.mount("saved-markdown")');
  await until('document.querySelector("[aria-label=生成正文]")');
  value = await assertClean();
  assert.match(value.text, /年度报告/);
  assert.match(value.text, /收入保持增长/);
  checks.push('plain Markdown document content falls back to readable body rendering');

  await js('chatProgressHarness.mount("document")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('制作一份年度经营报告 PPT');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending && document.querySelectorAll(".uc-chat-production-trace > li").length === 2');
  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().counters.starts >= 2 && chatProgressHarness.state().subscribed');
  assert.equal((await snapshot()).bodies.length, 0, 'an empty model response must not fabricate document body');
  await js('chatProgressHarness.emitDocumentChunk("title")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营")');
  value = await assertClean();
  assert.equal(value.bodies.length, 1);
  assert.doesNotMatch(value.bodies[0], /增长概览|营收增长来自/);
  await js('chatProgressHarness.emitDocumentChunk("paragraph")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告") && document.querySelector("[aria-label=生成正文]")?.textContent.includes("增长概览") && document.querySelector("[aria-label=生成正文]")?.textContent.includes("营收增长来自")');
  value = await assertClean();
  assert.match(value.text, /增长概览/);
  assert.match(value.text, /营收增长来自/);
  assert.equal(value.bodies.length, 1);
  assert.equal(value.remoteImages, 0, 'document body must not load remote image Markdown');
  assert.equal(value.text.match(/营收增长来自/g).length, 1);
  assert.doesNotMatch(value.text, /PRIVATE_REASONING|PRIVATE_PATH|sections|blocks/);
  checks.push('document body renders readable text while canonical JSON is still arriving in chunks');
  await captureBody('document-body-streaming.png');
  await js('chatProgressHarness.emitDocumentChunk("rest")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("客户留存稳定")');
  await js('chatProgressHarness.finishDocument()');
  await until('!chatProgressHarness.state().subscribed && chatProgressHarness.state().localGenerationPending');
  value = await assertClean();
  assert.equal(value.bodies.length, 1);
  assert.match(value.bodies[0], /营收增长来自核心业务的持续改善/);
  assert.equal(value.trace.at(-1).code, 'document_compile');
  assert.equal(value.trace.at(-1).status, 'started');
  checks.push('local document events continue after body stream completion while the body stays readable');
  await js('chatProgressHarness.finishLocalDocument()');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告（已校验）")');
  value = await assertClean();
  assert.match(value.text, /年度经营报告（已校验）/);
  assert.equal(value.bodies.length, 1);
  assert.doesNotMatch(value.bodies[0], /客户留存稳定|现金流改善/, 'the validated body replaces the original streamed payload');
  assert.doesNotMatch(value.text, /PRIVATE_REASONING|PRIVATE_PATH|sections|blocks/);
  checks.push('validated document body replaces the streamed draft after response completion');
  await captureBody('document-body-validated.png');
  await js('chatProgressHarness.mount("reopen")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告（已校验）")');
  value = await assertClean();
  assert.equal(value.bodies.length, 1);
  assert.equal(value.assistants, 1);
  assert.match(value.bodies[0], /营收增长来自核心业务的持续改善/);
  assert.doesNotMatch(value.bodies[0], /客户留存稳定|现金流改善/);
  checks.push('history restores the validated document body and all saved execution events on one assistant');
  await captureBody('document-body-history.png');

  await js('chatProgressHarness.mount("document-cancel")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('制作一份可取消的报告');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending');
  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().counters.starts >= 3 && chatProgressHarness.state().subscribed');
  await js('chatProgressHarness.emitDocumentChunk("paragraph")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("营收增长来自")');
  await js('chatProgressHarness.cancelDocument(); chatProgressHarness.finishDocument()');
  await until('!chatProgressHarness.state().subscribed');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("增长概览")');
  value = await assertClean();
  assert.match(value.text, /营收增长来自/);
  assert.equal(value.bodies.length, 1);
  assert.doesNotMatch(value.bodies[0], /核心业务的持续改善/);
  checks.push('cancelled document response keeps the already streamed readable body fragment');
  await captureBody('document-body-cancelled.png');
  assert.deepEqual(errors, [], 'renderer errors');
  assert.deepEqual(blockedRequests, [], 'the isolated UI must not attempt external requests');
  const report = { scope: 'Real ChatPage and DocumentProgress; synthetic IPC, isolated userData, HTTP(S) denied, no model calls',
    environment: { platform: os.platform(), electron: process.versions.electron, chromium: process.versions.chrome },
    checks, errors, blockedRequests, counters: await js('chatProgressHarness.state().counters') };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function finish(code) {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) {
    await js('window.chatProgressHarness?.unmount()').catch(() => undefined);
    window.destroy();
  }
  // Chromium can hold the isolated profile until process exit on Windows.
  // Remove only the generated build here; the profile stays in the OS temp area.
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.equal(path.dirname(path.resolve(buildDirectory)), path.resolve(temporary));
  await rm(buildDirectory, { recursive: true, force: true });
  console.log(`CHAT_PRODUCTION_PROGRESS_VERIFICATION_EXIT=${code}`);
  app.exit(code);
}
run().then(() => finish(0), async (error) => {
  console.error(error, errors);
  if (window && !window.isDestroyed()) console.error(await snapshot().catch(() => ({})));
  await finish(1);
});
