const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { mkdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, clipboard } = require('electron');
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'outputs', 'chat-stream-performance');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'unicomp-chat-performance-'));
const buildDirectory = path.join(temporary, 'build');
const errors = [];
const blockedRequests = [];
let window;
let bridgeWindow;
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 120000);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function js(source) {
  const expression = typeof source === 'function' ? '(' + source.toString() + ')()' : source;
  const result = await window.webContents.executeJavaScript('(async () => { try { return await (0, eval)(' + JSON.stringify(expression) + '); } catch (error) { return { verificationError: String(error.stack) }; } })()');
  if (result?.verificationError) throw new Error(result.verificationError);
  return result;
}
async function until(source) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await js(source)) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + source);
}
async function run() {
  await mkdir(output, { recursive: true });
  await app.whenReady();
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: buildDirectory, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(workspace, 'tests/harness/chat-stream-performance-harness.tsx'),
        formats: ['iife'], name: 'ChatStreamHarness', fileName: () => 'harness.js' } }
  });
  await writeFile(path.join(buildDirectory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}#root>.uc-chat-page{height:100%}</style></head><body><div id="root" class="workspace"></div><script src="harness.js"></script></body></html>');
  window = new BrowserWindow({ show: false, width: 1280, height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    blockedRequests.push(new URL(request.url).origin);
    callback({ cancel: true });
  });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(path.join(buildDirectory, 'index.html'));
  await until('document.querySelectorAll(".uc-chat-page__project-item").length === 45 && document.body.innerText.includes("本地流式测试")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('本地性能测试，不发送给任何服务商。');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatStreamHarness.state().subscribed && document.querySelector(".uc-chat-page__message-item--live")');
  await js('chatStreamHarness.emit("content_delta", "# 流式测试\\n\\n")');
  await delay(100);
  const wheelTargets = await js(function () {
    const viewport = document.querySelector('.uc-chat-page__messages');
    const sidebar = document.querySelector('.uc-chat-page__workspace-scroll');
    sidebar.scrollTop = 0;
    const point = element => {
      const bounds = element.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    };
    return { main: point(viewport), sidebar: point(sidebar), mainTop: viewport.scrollTop };
  });
  window.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelTargets.main, deltaY: 360, deltaX: 0, canScroll: true });
  await until('document.querySelector(".uc-chat-page__messages").scrollTop < ' + wheelTargets.mainTop);
  await delay(200);
  const wheelReadingTop = await js('document.querySelector(".uc-chat-page__messages").scrollTop');
  await js('chatStreamHarness.emit("content_delta", "滚轮回看测试。")');
  await delay(100);
  assert.ok(Math.abs(await js('document.querySelector(".uc-chat-page__messages").scrollTop') - wheelReadingTop) <= 1);
  window.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelTargets.sidebar, deltaY: -360, deltaX: 0, canScroll: true });
  await until('document.querySelector(".uc-chat-page__workspace-scroll").scrollTop > 0');
  const nativeWheel = { messageWheelMoved: true, sidebarWheelMoved: true, readingPausedDuringStreaming: true };
  const samples = await js(async function () {
    const viewport = document.querySelector('.uc-chat-page__messages');
    const sidebar = document.querySelector('.uc-chat-page__workspace-scroll');
    const live = document.querySelector('.uc-chat-page__message-item--live .uc-chat-stream-plain');
    let sidebarMutations = 0;
    const observer = new MutationObserver(records => { sidebarMutations += records.length; });
    observer.observe(sidebar, { subtree: true, childList: true, characterData: true, attributes: true });
    viewport.scrollTop = 600;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    const readingTop = viewport.scrollTop;
    const intervals = [];
    let previous;
    let maxReadingDrift = 0;
    let changedFrames = 0;
    let previousText = live.textContent;
    let sameLiveNode = true;
    let maxSidebarScroll = 0;
    for (let frame = 0; frame < 240; frame++) {
      const now = await new Promise(resolve => requestAnimationFrame(resolve));
      if (previous !== undefined) intervals.push(now - previous);
      previous = now;
      for (let chunk = 0; chunk < 5; chunk++) chatStreamHarness.emit('content_delta', '连续输入测试：文字不得丢失。');
      sidebar.scrollTop = (frame % 80) * 20;
      sidebar.dispatchEvent(new Event('scroll', { bubbles: true }));
      maxSidebarScroll = Math.max(maxSidebarScroll, sidebar.scrollTop);
      maxReadingDrift = Math.max(maxReadingDrift, Math.abs(viewport.scrollTop - readingTop));
      const current = document.querySelector('.uc-chat-page__message-item--live .uc-chat-stream-plain');
      sameLiveNode = sameLiveNode && current === live;
      if (current.textContent !== previousText) changedFrames++;
      previousText = current.textContent;
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect();
    intervals.sort((left, right) => left - right);
    return { p95FrameMs: intervals[Math.floor(intervals.length * 0.95)], maxFrameMs: Math.max(...intervals),
      frames: intervals.length, changedFrames, sidebarMutations, maxSidebarScroll, maxReadingDrift,
      sameLiveNode, textExact: live.textContent === chatStreamHarness.state().content,
      contentCharacters: chatStreamHarness.state().content.length,
      followButton: Boolean(document.querySelector('[aria-label="回到最新消息"]')) };
  });
  assert.equal(samples.textExact, true);
  assert.equal(samples.sameLiveNode, true);
  assert.equal(samples.sidebarMutations, 0);
  assert.ok(samples.maxSidebarScroll > 0);
  assert.ok(samples.maxReadingDrift <= 1);
  assert.ok(samples.changedFrames >= 200);
  assert.ok(samples.p95FrameMs <= 34, JSON.stringify(samples));
  assert.ok(samples.maxFrameMs <= 100, JSON.stringify(samples));
  assert.equal(samples.followButton, true);
  await writeFile(path.join(output, 'stream-reading.png'), (await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("[aria-label=回到最新消息]").click()');
  await js('chatStreamHarness.emit("content_delta", "\\n\\n结束标记"); chatStreamHarness.emit("stream_completed")');
  await until('!chatStreamHarness.state().subscribed && !document.querySelector(".uc-chat-page__message-item--live")');
  const completion = await js(function () {
    const viewport = document.querySelector('.uc-chat-page__messages');
    const last = Array.from(document.querySelectorAll('li.uc-chat-page__message-item--assistant')).at(-1);
    last.querySelector('[aria-label="复制消息"]').click();
    return { contentRetained: last.textContent.includes('结束标记'),
      copiedExact: chatStreamHarness.state().copied === chatStreamHarness.state().content,
      distanceToBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop };
  });
  assert.equal(completion.contentRetained, true);
  assert.equal(completion.copiedExact, true);
  assert.ok(completion.distanceToBottom <= 1);
  await writeFile(path.join(output, 'completed.png'), (await window.webContents.capturePage()).toPNG());
  await window.loadFile(path.join(buildDirectory, 'index.html'));
  await until('document.body.innerText.includes("本地流式测试")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('本地停止验收');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatStreamHarness.state().subscribed');
  await js('chatStreamHarness.emit("content_delta", "停止前已生成的内容"); document.querySelector("[aria-label=停止生成]").click()');
  await until('chatStreamHarness.state().executionState === "cancelled" && !chatStreamHarness.state().subscribed');
  assert.equal(await js('document.querySelector(".uc-chat-page__composer textarea").value'), '本地停止验收');
  assert.equal(await js('document.body.innerText.includes("停止前已生成的内容")'), true);
  bridgeWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
    sandbox: false, preload: path.join(workspace, 'dist-electron/electron/preload.js') } });
  await bridgeWindow.loadURL('data:text/html,<title>Isolated clipboard bridge</title>');
  const originalClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  let nativeClipboardExact = false;
  try {
    await bridgeWindow.webContents.executeJavaScript('window.unicomp.clipboard.writeText("本地剪贴板验收\\nUnicode ✓")');
    nativeClipboardExact = clipboard.readText() === '本地剪贴板验收\nUnicode ✓';
    assert.equal(nativeClipboardExact, true);
  } finally {
    clipboard.write(originalClipboard);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, []);
  const report = { scope: 'Real production ChatPage in isolated Electron; synthetic IPC, 45 projects, 24 history messages, 1200 deltas, no external model calls',
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, platform: os.platform() },
    criteria: { p95FrameMs: 34, maxFrameMs: 100, readingDriftPx: 1, sidebarMutations: 0 },
    samples, nativeWheel, completion, cancellation: { confirmed: true, partialTextRetained: true, inputRestored: true },
    nativeClipboardExact, errors, blockedRequests,
    notProven: ['User active window wheel feel', 'Real provider latency and streaming', 'Equal performance to Codex'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function finish(code) {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) window.destroy();
  if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.destroy();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.equal(path.dirname(path.resolve(buildDirectory)), path.resolve(temporary));
  await rm(buildDirectory, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0), async error => { console.error(error, errors); await finish(1); });
