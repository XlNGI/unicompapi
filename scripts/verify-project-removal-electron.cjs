// Run with: node scripts/verify-project-removal-electron.cjs (after pnpm build).
// The real application/preload/IPC run against synthetic projects and an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  (async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'uc-project-removal-electron-'));
    try {
      const { spawn } = require('node:child_process');
      process.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { windowsHide: true, stdio: 'inherit',
          env: { ...process.env, UNICOMP_REMOVAL_TEST_ROOT: root } });
        child.on('error', reject);
        child.on('exit', code => resolve(code ?? 1));
      });
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('uc-project-removal-electron-'));
      await fsp.rm(root, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, session, shell } = require('electron');
  const evidence = path.resolve(__dirname, '../docs/evidence/project-removal-20261019');
  const root = path.resolve(process.env.UNICOMP_REMOVAL_TEST_ROOT);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('uc-project-removal-electron-'));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.mkdirSync(evidence, { recursive: true });
  delete process.env.VITE_DEV_SERVER_URL;
  process.env.UNICOMP_TEST_USER_DATA = profile;
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  const deadline = setTimeout(() => app.exit(1), 120_000);
  deadline.unref();
  const timestamp = '2026-10-19T00:00:00.000Z';
  const projects = [
    ['keep', '保留文件项目', true], ['trash', '回收站项目', true],
    ['missing', '失效项目', false], ['missing2', '断盘项目', false], ['broken', '损坏项目', true]
  ].map(([id, name, available]) => {
    const directory = path.join(root, id);
    const projectId = `project-removal-${id}`;
    if (available) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name, createdAt: timestamp, updatedAt: timestamp }));
      fs.writeFileSync(path.join(directory, 'retained.txt'), 'isolated synthetic project');
      if (id === 'broken') {
        fs.mkdirSync(path.join(directory, 'entities'));
        fs.writeFileSync(path.join(directory, 'entities/works.json'), '{invalid-json');
      }
    }
    return { projectId, projectName: name, rootDirectory: directory, lastOpenedAt: timestamp };
  });
  const catalogPath = path.join(profile, 'project-catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, entries: projects }));
  const catalog = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')).entries;
  const observations = {};
  const rendererErrors = [];
  let externalRequests = 0;
  let nativeTrashCalls = 0;
  let forceTrashFailure = true;
  let window;
  let exitCode = 1;
  const originalTrash = shell.trashItem.bind(shell);
  shell.trashItem = async directory => {
    // Never send any directory outside this run's verified synthetic root to trash.
    assert.equal(path.resolve(directory), path.join(root, 'trash'));
    nativeTrashCalls += 1;
    if (forceTrashFailure) throw new Error('Synthetic native trash failure');
    await originalTrash(directory);
  };
  app.on('browser-window-created', (_event, created) => {
    window = created;
    window.show = () => {};
    window.focus = () => {};
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) rendererErrors.push(message);
    });
  });
  app.once('ready', () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      externalRequests += 1;
      callback({ cancel: true });
    });
  });
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(operation, label) {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await operation()) return;
      await pause(75);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function clickText(selector, text) {
    await evaluate(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length>0 && el.textContent.trim()===${JSON.stringify(text)});if(!button || button.disabled)throw new Error('Missing enabled control: '+${JSON.stringify(text)});button.click();})()`);
  }
  async function waitDialog() {
    await waitFor(() => evaluate(`Boolean(document.querySelector('.uc-project-removal[open]')) && !document.querySelector('.uc-project-removal__actions button:last-child').disabled`), 'project removal dialog');
  }
  async function waitDialogClosed() {
    await waitFor(() => evaluate(`!document.querySelector('.uc-project-removal')`), 'removal completed');
  }
  async function openSidebarRemoval(name) {
    await evaluate(`document.querySelector('button[aria-label="管理项目：${name}"]').click()`);
    await waitFor(() => evaluate(`[...document.querySelectorAll('.rs-dropdown-menu [role="menuitem"]')].some(el=>el.getClientRects().length>0)`), 'project action menu');
    await clickText('.rs-dropdown-menu [role="menuitem"]', name === '断盘项目' ? '移除失效项目' : '删除项目');
    await waitDialog();
    assert.equal(await evaluate(`document.querySelector('.uc-project-removal > p').textContent`), `“${name}”`);
  }
  async function screenshot(name) {
    // Prime the hidden compositor: the first capture can return its previous frame.
    await window.webContents.capturePage();
    await pause(250);
    await fsp.writeFile(path.join(evidence, name), (await window.webContents.capturePage()).toPNG());
    (observations.screenshots ??= {})[name] = await evaluate(`({
      page: document.querySelector('h1')?.textContent,
      issues: document.querySelectorAll('.uc-work-library__issue-row').length,
      dialog: document.querySelector('.uc-project-removal > p')?.textContent,
      mode: document.querySelector('.uc-project-removal input:checked')?.value
    })`);
  }

  (async () => {
    const { ProjectSessionController } = require('../dist-electron/src/platform/ipc/project-session-controller.js');
    const removeProject = ProjectSessionController.prototype.removeProject;
    ProjectSessionController.prototype.removeProject = async function(request) {
      this.dependencies.onError = error => {
        (observations.hostErrors ??= []).push({ name: error.name, message: error.message });
      };
      const reply = await removeProject.call(this, request);
      (observations.removals ??= []).push({ request, reply });
      return reply;
    };
    require('../dist-electron/electron/main.js');
    await app.whenReady();
    await waitFor(async () => window && !window.webContents.isLoading()
      && await evaluate(`document.querySelectorAll('.uc-chat-page__project-group').length===5`), 'production project sidebar');
    window.setSize(1280, 840);
    await evaluate(`document.querySelector('#library-navigation-trigger').click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.uc-work-library__issue-row').length===3`), 'unavailable and corrupt project issues');
    await screenshot('library-before.png');
    await evaluate(`document.querySelector('button[aria-label="移除项目记录 失效项目"]').click()`);
    await waitDialog();
    // Escape dismisses the confirmation and never removes a record.
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitDialogClosed();
    assert.equal(catalog().length, 5);
    observations.escapePreservesRecord = true;
    await evaluate(`document.querySelector('button[aria-label="移除项目记录 失效项目"]').click()`);
    await waitDialog();
    assert.equal(await evaluate(`Boolean(document.querySelector('.uc-project-removal input[value="trash"]'))`), false);
    await clickText('.uc-project-removal button', '移除项目记录');
    await waitDialogClosed();
    await waitFor(() => evaluate(`document.querySelectorAll('.uc-work-library__issue-row').length===2`), 'warning refreshed');
    assert.equal(catalog().some(p => p.projectId === 'project-removal-missing'), false);
    observations.libraryMissingRemoval = true;
    await evaluate(`document.querySelector('button[aria-label="移除项目记录 损坏项目"]').click()`);
    await waitDialog();
    await clickText('.uc-project-removal button', '移除项目记录');
    await waitDialogClosed();
    assert.equal(fs.readFileSync(path.join(root, 'broken', 'retained.txt'), 'utf8'), 'isolated synthetic project');
    observations.corruptProjectFilesRetained = true;
    await evaluate(`document.querySelector('#projects-navigation-trigger').click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.uc-chat-page__project-group').length===3`), 'updated sidebar');
    await screenshot('projects-sidebar.png');
    await openSidebarRemoval('断盘项目');
    await clickText('.uc-project-removal button', '移除项目记录');
    await waitDialogClosed();
    await waitFor(() => evaluate(`document.querySelectorAll('.uc-chat-page__project-group').length===2`), 'missing sidebar record removed');
    observations.sidebarMissingRemoval = true;
    // Surface only the controlled validation reason for the synthetic target.
    const { validateProjectTrashTarget } = require('../dist-electron/src/platform/ipc/project-removal.js');
    try {
      await validateProjectTrashTarget(projects[1], catalog(), undefined, [profile, app.getAppPath()]);
    } catch (error) {
      observations.trashPreflightFailure = { name: error.name, message: error.message };
      throw error;
    }
    await openSidebarRemoval('回收站项目');
    await evaluate(`document.querySelector('.uc-project-removal input[value="trash"]').click()`);
    await screenshot('trash-confirmation.png');
    await clickText('.uc-project-removal button', '移到回收站');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.uc-project-removal [role="alert"]'))`), 'native trash failure remains retryable');
    assert.equal(catalog().length, 2);
    assert.equal(fs.existsSync(path.join(root, 'trash')), true);
    observations.failedTrashRetainsRecordAndFiles = true;
    assert.equal(nativeTrashCalls, 1, JSON.stringify(observations));
    forceTrashFailure = false;
    await clickText('.uc-project-removal button', '移到回收站');
    await waitDialogClosed();
    assert.equal(fs.existsSync(path.join(root, 'trash')), false);
    assert.equal(catalog().length, 1);
    observations.nativeTrashSucceeded = true;
    const opened = await evaluate(`window.unicomp.storage.openRecentProject('project-removal-keep')`);
    assert.equal(opened.ok, true);
    await evaluate(`window.dispatchEvent(new Event('unicomp:project-session-changed'))`);
    await waitFor(() => evaluate(`document.querySelector('.title-bar__project')?.textContent.includes('保留文件项目')`), 'current project title');
    await clickText('.uc-chat-page__workspace-actions button', '管理项目');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.uc-project-center__project-card'))`), 'project management cards');
    await evaluate(`document.querySelector('button[aria-label="删除项目 保留文件项目"]').click()`);
    await waitDialog();
    assert.equal(await evaluate(`document.querySelector('.uc-project-removal input[value="trash"]').disabled`), true);
    await screenshot('current-project-confirmation.png');
    await clickText('.uc-project-removal button', '移除项目记录');
    await waitDialogClosed();
    await waitFor(() => evaluate(`document.querySelector('.title-bar__project')?.textContent.includes('尚未打开项目')`), 'current session cleared');
    assert.equal((await evaluate(`window.unicomp.storage.getProjectSession()`)).value, undefined);
    assert.equal(catalog().length, 0);
    assert.equal(fs.readFileSync(path.join(root, 'keep', 'retained.txt'), 'utf8'), 'isolated synthetic project');
    observations.managementRemovalClosesCurrentAndRetainsFiles = true;
    await evaluate(`document.querySelector('.uc-chat-page__project-management-dialog .rs-modal-header-close').click()`);
    await evaluate(`document.querySelector('#library-navigation-trigger').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.uc-work-library')) && !document.querySelector('.uc-work-library__issues')`), 'all warnings cleared');
    observations.storageSummary = await evaluate(`window.unicomp.storage.getLocalStorageSummary()`);
    assert.equal(observations.storageSummary.ok, true);
    assert.equal(observations.storageSummary.value.projectUsage.projectCount, 0);
    assert.equal(observations.storageSummary.value.projectUsage.unavailableProjectCount, 0);
    await screenshot('library-after.png');
    const unknown = await evaluate(`window.unicomp.storage.removeProject('already-removed','forget')`);
    assert.equal(unknown.ok, true);
    assert.equal(nativeTrashCalls, 2);
    assert.equal(externalRequests, 0);
    assert.deepEqual(rendererErrors, []);
    exitCode = 0;
  })().catch(error => {
    observations.failure = { name: error.name, message: error.message, stack: error.stack };
    console.error(error);
  }).finally(async () => {
    await fsp.writeFile(path.join(evidence, 'electron.json'), JSON.stringify({ passed: exitCode === 0, externalRequests, rendererErrors,
      nativeTrashCalls, observations, boundary: 'production main/preload/renderer; synthetic project/profile only; one synthetic folder moved with real shell.trashItem; no model calls' }, null, 2));
    clearTimeout(deadline);
    app.exit(exitCode);
  });
}
