const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const output = path.join(root, 'outputs', 'video-editor-project-switch', baseline ? 'baseline' : 'fixed');
const temporaryRoot = path.join(root, 'outputs', 'video-editor-project-switch', `runtime-${process.pid}`);
app.setPath('userData', path.join(temporaryRoot, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
let window;
const checks = [];
const errors = [];
const deadline = setTimeout(() => { console.error('Project switch test timed out'); app.exit(1); }, 120000);
const js = source => window.webContents.executeJavaScript(source);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(source) {
  for (let i = 0; i < 120; i++) { if (await js(source)) return; await delay(50); }
  throw new Error(`Timed out: ${source}`);
}
async function click(selector) {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`);
  const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay(30);
}
async function switchProject(id) {
  await click('.title-bar__project');
  const index = ['A', 'B', 'Empty', 'Failed'].indexOf(id) + 1;
  await click(`.title-bar__project-option:nth-child(${index})`);
  await until(`document.querySelector('.title-bar__project').textContent.includes('Project ${id}')`);
}
const editor = "document.querySelector('.uc-video-editor')";
async function loaded(id) {
  await until(`${editor}?.textContent.includes('项目：Project ${id}') && ${editor}.textContent.includes('Draft ${id}') && !!document.querySelector('[data-clip-id="clip-${id}"]')`);
}
async function capture(name) {
  window.webContents.invalidate();
  await delay(150);
  await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}
async function run() {
  await fs.mkdir(output, { recursive: true });
  await app.whenReady();
  // Unrelated destinations are stubs; App, AppLayout, title bar and editor are production code.
  await require('vite').build({ configFile: false, root, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'unrelated-page-fixtures', enforce: 'pre', transform(_code, id) {
      if (baseline && id.endsWith('/src/ui/App.tsx')) {
        return execFileSync('git', ['show', 'f08b282:src/ui/App.tsx'], { cwd: root, encoding: 'utf8' });
      }
      const name = ['ChatPage', 'VideoQuickPage'].find(name => id.endsWith(`/${name}.tsx`));
      if (name) return `export function ${name}() { return null; }`;
    } }],
    build: { outDir: path.join(temporaryRoot, 'build'), emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(root, 'tests/harness/video-editor-project-switch-harness.tsx'), formats: ['iife'], name: 'ProjectSwitchHarness', fileName: () => 'harness.js' } }
  });
  const html = path.join(temporaryRoot, 'build', 'index.html');
  await fs.writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  window = new BrowserWindow({ show: false, width: 1600, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, spellcheck: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(html);
  await until('window.projectSwitchHarness?.ready');
  await click('#video-creation-navigation-trigger');
  await click('#video-creation-navigation .nav-subitem:last-child');
  await loaded('A');
  await until(`document.querySelector('video[aria-label="时间线预览"]')?.readyState >= 2`);
  await capture('project-a');
  await js(`window.oldEditor = ${editor}; window.oldVideo = document.querySelector('video[aria-label="时间线预览"]');`);
  await click('.uc-video-editor__transport-play');
  await until('!oldVideo.paused');
  await switchProject('B');
  if (baseline) {
    await delay(200);
    assert.equal(await js(`${editor}.textContent.includes('项目：Project A')`), true);
    assert.equal(await js(`${editor}.textContent.includes('项目：Project B')`), false);
    checks.push('Reproduced: title bar shows B while editor remains A');
    await capture('stale-project');
    return;
  }
  await loaded('B');
  await until('oldVideo.paused');
  assert.equal(await js('oldEditor.isConnected'), false);
  await until(`document.querySelector('video[aria-label="时间线预览"]')?.src === projectSwitchHarness.media('B')`);
  checks.push('A -> B from real title bar: project, draft, clip and preview update; old playback stops');
  await capture('project-b');
  await click('.uc-video-editor__media-bin [role="tab"]:last-child');
  await until(`${editor}.textContent.includes('Work B')`);
  assert.equal(await js(`${editor}.textContent.includes('Work A')`), false);
  await click('.uc-video-editor__media-bin [role="tab"]:first-child');
  checks.push('Project material list contains B works only');

  await js(`window.retainedEditor = ${editor};`);
  await click('#projects-navigation-trigger');
  await click('#video-creation-navigation-trigger');
  await click('#video-creation-navigation .nav-subitem:last-child');
  await loaded('B');
  assert.equal(await js(`${editor} === retainedEditor`), true);
  checks.push('Navigation away/back without switching project retains editor instance');

  await js('projectSwitchHarness.delayList()');
  await switchProject('A');
  await until('projectSwitchHarness.state().pending === 1');
  assert.equal(await js(`document.querySelectorAll('.uc-video-editor__seg').length`), 0);
  await switchProject('B');
  await loaded('B');
  await js('projectSwitchHarness.release()');
  await delay(100);
  await loaded('B');
  checks.push('Rapid A -> B: slow A draft list cannot overwrite B; old timeline clears during load');

  await js('projectSwitchHarness.delayPreview()');
  await switchProject('A');
  await loaded('A');
  await until('projectSwitchHarness.state().pending === 1');
  await switchProject('B');
  await loaded('B');
  await js('projectSwitchHarness.release()');
  await delay(100);
  assert.equal(await js(`document.querySelector('video[aria-label="时间线预览"]')?.src`), await js("projectSwitchHarness.media('B')"));
  checks.push('Late A preview cannot replace B preview');

  await switchProject('Empty');
  await until(`${editor}.textContent.includes('项目：Project Empty')`);
  assert.equal(await js('document.querySelectorAll(".uc-video-editor__seg").length'), 0);
  assert.equal(await js(`!!document.querySelector('video[aria-label="时间线预览"]')`), false);
  await capture('empty-project');
  checks.push('Empty project clears old draft, timeline and preview');

  await switchProject('Failed');
  await until(`${editor}.textContent.includes('该编辑草稿已不存在，请重新选择。')`);
  assert.equal(await js('document.querySelectorAll(".uc-video-editor__seg").length'), 0);
  assert.equal(await js(`${editor}.textContent.includes('Draft B')`), false);
  checks.push('Draft read failure does not leave previous project content');
  await switchProject('A');
  await loaded('A');
  await js(`window.retainedEditor = ${editor}; projectSwitchHarness.failOpen(true);`);
  await click('.title-bar__project');
  await click('.title-bar__project-option:nth-child(2)');
  await until("document.querySelector('.title-bar__project-error')?.textContent.includes('Fixture open failed')");
  assert.equal(await js(`${editor} === retainedEditor`), true);
  await loaded('A');
  await click('.title-bar__project');
  await js('projectSwitchHarness.failOpen(false)');
  checks.push('Failed project switch preserves current editor');

  await click('#projects-navigation-trigger');
  const reads = await js('projectSwitchHarness.state().listReads.length');
  await switchProject('B');
  assert.equal(await js('projectSwitchHarness.state().listReads.length'), reads);
  await click('#video-creation-navigation-trigger');
  await click('#video-creation-navigation .nav-subitem:last-child');
  await loaded('B');
  checks.push('Project switch while editor hidden clears state without loading until opened');

  await js('projectSwitchHarness.closeProject()');
  await until(`${editor}.textContent.includes('需要先打开项目')`);
  assert.equal(await js('document.querySelectorAll(".uc-video-editor__seg").length'), 0);
  checks.push('Closing project clears editor and shows no-project state');
  await js('projectSwitchHarness.unmount()');
  assert.deepEqual(errors, []);
  checks.push('No renderer errors; root unmounted');
}
let exitCode = 0;
run().catch(error => { exitCode = 1; errors.push(error.stack); console.error(error); }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  clearTimeout(deadline);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: exitCode === 0, baseline, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: exitCode === 0, checks, errors }));
  app.exit(exitCode);
});
