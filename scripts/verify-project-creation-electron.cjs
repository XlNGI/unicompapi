const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');

// Exercise the shipped main/preload/renderer with isolated data and no Provider.
const workspace = path.resolve(__dirname, '..');
const mode = process.env.UNICOMP_THREAD_FIRST === '0' ? 'legacy' : 'thread';
const evidence = path.resolve(process.env.UNICOMP_PROJECT_CREATION_EVIDENCE_DIR
  ?? path.join(workspace, '.cache', 'project-session-read-fix-20261017'));
let temporaryRoot;
let mainWindow;
let exitCode = 1;
let externalRequests = 0;
const observations = {};
const deadline = setTimeout(() => app.exit(1), 90_000);
deadline.unref();
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(operation, label) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const value = await operation();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function evaluate(expression) { return mainWindow.webContents.executeJavaScript(expression); }
async function assertNoStorageNotice() {
  assert.equal(await evaluate(`document.body.innerText.includes('本地保存失败')`), false);
}

(async () => {
  // Complete bootstrap synchronously so main registers its privileged scheme
  // before Electron emits ready.
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'unicomp-project-create-electron-'));
  const projectRoot = path.join(temporaryRoot, 'project');
  mkdirSync(projectRoot);
  mkdirSync(evidence, { recursive: true });
  delete process.env.VITE_DEV_SERVER_URL;
  process.env.UNICOMP_TEST_USER_DATA = path.join(temporaryRoot, 'user-data');
  app.setPath('userData', process.env.UNICOMP_TEST_USER_DATA);
  app.on('browser-window-created', (_event, window) => {
    mainWindow = window;
    window.webContents.setBackgroundThrottling(false);
    // The acceptance window must not take focus from the user's application.
    window.show = () => {};
    window.focus = () => {};
  });
  let directorySelections = 0;
  dialog.showOpenDialog = async (_ownerOrOptions, maybeOptions) => {
    const options = maybeOptions ?? _ownerOrOptions;
    assert.ok(options.properties.includes('openDirectory'));
    directorySelections += 1;
    await evaluate(`window.dispatchEvent(new Event('focus'))`);
    await pause(250);
    observations.directoryFocusList = await evaluate(`window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100})`);
    assert.equal(observations.directoryFocusList.ok, true);
    assert.deepEqual(observations.directoryFocusList.value.items, []);
    await assertNoStorageNotice();
    return { canceled: false, filePaths: [projectRoot] };
  };
  app.once('ready', () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      externalRequests += 1;
      callback({ cancel: true });
    });
  });
  require('../dist-electron/electron/main.js');
  await app.whenReady();
  await waitFor(async () => mainWindow && !mainWindow.webContents.isLoading()
    && await evaluate(`Boolean(document.querySelector('.uc-chat-page'))`), 'production chat');
  await pause(400);
  observations.initialSession = await evaluate(`window.unicomp.storage.getProjectSession()`);
  assert.equal(observations.initialSession.ok, true);
  assert.equal(observations.initialSession.value, undefined);
  observations.initialList = await evaluate(`window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100})`);
  assert.equal(observations.initialList.ok, true);
  assert.deepEqual(observations.initialList.value.items, []);
  await assertNoStorageNotice();
  await evaluate(`[...document.querySelectorAll('.uc-chat-page__workspace-actions button')].find(button=>button.textContent.trim()==='新建项目').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('#chat-project-name'))`), 'new project dialog');
  await evaluate(`(()=>{const input=document.querySelector('#chat-project-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'新建项目保存验证');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`!document.querySelector('.uc-chat-page__project-create-dialog button[type="submit"]').disabled`), 'create enabled');
  await evaluate(`document.querySelector('.uc-chat-page__project-create-dialog form').requestSubmit()`);
  observations.createdSession = await waitFor(async () => {
    const result = await evaluate(`window.unicomp.storage.getProjectSession()`);
    return result.ok && result.value ? result.value : undefined;
  }, 'created project session');
  await waitFor(() => evaluate(`!document.querySelector('#chat-project-name')`), 'project dialog closed');
  await waitFor(() => evaluate(`document.querySelector('.uc-chat-page__header')?.textContent.includes('新建项目保存验证')
    && document.querySelector('.uc-chat-page__project-list')?.textContent.includes('新建项目保存验证')`), 'created project visible in chat');
  await pause(300);
  await assertNoStorageNotice();
  assert.equal(directorySelections, 1);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8'));
  assert.equal(manifest.id, observations.createdSession.projectId);
  assert.equal(manifest.name, '新建项目保存验证');
  const catalog = JSON.parse(await readFile(path.join(process.env.UNICOMP_TEST_USER_DATA, 'project-catalog.json'), 'utf8'));
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].projectId, manifest.id);
  observations.createdConversation = await evaluate(`window.unicomp.chatContexts.createConversation('本地保存验证',true)`);
  assert.equal(observations.createdConversation.ok, true);
  const conversation = observations.createdConversation.value;
  observations.savedMessage = await evaluate(`window.unicomp.chatContexts.addUserMessage(${JSON.stringify(conversation.conversationId)},${conversation.revision},'第一条本地消息')`);
  assert.equal(observations.savedMessage.ok, true);
  observations.closed = await evaluate(`window.unicomp.storage.closeProject()`);
  assert.equal(observations.closed.ok, true);
  observations.afterClose = await evaluate(`window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100})`);
  assert.equal(observations.afterClose.ok, true);
  assert.deepEqual(observations.afterClose.value.items, []);
  observations.reopened = await evaluate(`window.unicomp.storage.openRecentProject(${JSON.stringify(manifest.id)})`);
  assert.equal(observations.reopened.ok, true);
  observations.restoredConversation = await evaluate(`window.unicomp.chatContexts.getConversation(${JSON.stringify(conversation.conversationId)})`);
  assert.equal(observations.restoredConversation.ok, true);
  assert.deepEqual(observations.restoredConversation.value.messages.map(message => message.content), ['第一条本地消息']);
  await evaluate(`window.dispatchEvent(new Event('unicomp:project-session-changed'))`);
  await pause(400);
  await assertNoStorageNotice();
  assert.equal(externalRequests, 0);
  exitCode = 0;
})().catch(error => {
  observations.failure = { name: error.name, message: error.message, stack: error.stack };
  console.error(error);
}).finally(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, `electron-${mode}.json`), `${JSON.stringify({
    passed: exitCode === 0, mode, externalRequests, observations,
    boundary: 'isolated production main/preload/renderer; controlled directory selection with focus refresh; local IPC message save; no Provider generation'
  }, null, 2)}\n`);
  // Main's normal before-quit handler drains its own operations first.
  app.once('will-quit', event => {
    event.preventDefault();
    clearTimeout(deadline);
    void (async () => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      await session.defaultSession.closeAllConnections();
      // Chromium can retain its cache handles until process exit on Windows.
      // Keep the isolated profile if it is still locked; never touch user data.
      if (temporaryRoot) {
        assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporaryRoot).startsWith('unicomp-project-create-electron-'));
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
      }
      console.log(JSON.stringify({ passed: exitCode === 0, mode, externalRequests }));
      app.exit(exitCode);
    })();
  });
  app.quit();
});
