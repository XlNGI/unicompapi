const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/generation-submission-receipt');
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
let win;
const checks = [];
const errors = [];
const js = code => win.webContents.executeJavaScript(code);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i=0;i<100;i++) { if (await js(code)) return; await delay(50); }
  throw new Error(`Timed out: ${code}\n${await js('document.body.innerText')}\n${JSON.stringify(errors)}`);
}
async function run() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  const build = path.join(output, 'build');
  await require('vite').build({ configFile: false, root, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: build, emptyOutDir: true, rollupOptions: { onwarn(warning, warn) { if(warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } }, lib: { entry: path.join(root, 'tests/harness/generation-submission-receipt-harness.tsx'),
      formats: ['iife'], name: 'SubmissionHarness', fileName: () => 'harness.js' } } });
  await fs.writeFile(path.join(build, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
  win.webContents.on('console-message', (_event, level, message) => { if(level>=3) errors.push(message); });
  await win.loadFile(path.join(build, 'index.html'));
  const button = `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='生成')`;
  for (const mode of ['image', 'video']) {
    await js(`submissionHarness.configure('${mode}')`);
    await until(`${button} && !(${button}).disabled`);
    await js(`(()=>{const b=${button};b.click();b.click()})()`);
    await until('submissionHarness.state().submits === 1');
    await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'New input while pending');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await until('submissionHarness.state().prompt === "New input while pending"');
    await js('submissionHarness.release()');
    await until(`Boolean(${button}) && !Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='处理中')`);
    assert.equal(await js('submissionHarness.state().submits'), 1);
    assert.equal(await js('submissionHarness.state().prompt'), 'New input while pending');
    assert.equal(await js('submissionHarness.state().clears'), 0);
    checks.push(`${mode}: same-tick double click submits once; receipt releases busy; delayed result preserves new input`);
  }
  await js('submissionHarness.configure("image")');
  await until(`${button} && !(${button}).disabled`);
  await js(`(${button}).click()`);
  await until('submissionHarness.state().submits === 1');
  await js('submissionHarness.unmount(); submissionHarness.release()');
  await delay(100);
  assert.equal(await js('submissionHarness.state().clears'), 0);
  assert.equal(await js('submissionHarness.state().persisted'), 0);
  checks.push('Late image response after navigation does not clear or replace a workspace draft');
  assert.deepEqual(errors, []);
}
const watchdog = setTimeout(()=>{console.error('Submission verification timeout');app.exit(1)},60000);
run().then(async () => {
  clearTimeout(watchdog); await fs.writeFile(path.join(output,'report.json'),JSON.stringify({ checks, errors },null,2));
  console.log(JSON.stringify({ checks, errors })); app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(watchdog);app.exit(1)});
