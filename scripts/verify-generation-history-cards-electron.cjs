const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'outputs/generation-history-cards');
app.setPath('userData', path.join(output, 'profile'));
app.setPath('temp', path.join(output, 'temp'));
app.disableHardwareAcceleration();
let win;
const watchdog = setTimeout(() => { console.error('History card verification exceeded 60 seconds'); app.exit(1); }, 60000);
const report = { scope: 'Real shared component and production CSS; synthetic storage boundary, not full application E2E.', checks: [], errors: [] };
const js = (code) => win.webContents.executeJavaScript(code);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); }
  throw new Error(`Timed out: ${code}`);
}
const card = '.uc-generation-history__node[data-task-id="multi"]';
async function geometry() {
  return js(`Array.from(document.querySelectorAll('.uc-generation-history__current, .uc-generation-history__timeline, .uc-generation-history__node')).map(e => {
    const r = e.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height };
  })`);
}
async function paint() {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function run() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  const build = path.join(output, 'build');
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: build, emptyOutDir: true, lib: {
      entry: path.join(workspace, 'tests/harness/generation-history-task-cards-harness.tsx'),
      formats: ['iife'], name: 'HistoryHarness', fileName: () => 'harness.js'
    } } });
  await fs.writeFile(path.join(build, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, done) => done({ cancel: true }));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadFile(path.join(build, 'index.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until('document.querySelectorAll(".uc-generation-history__node").length === 3');
  await fs.writeFile(path.join(output, 'initial.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('.uc-generation-history__node')).map(e => e.querySelectorAll('.uc-generation-history__work, .uc-generation-history__status-button').length)`), [1, 1, 1], 'One preview per task, including a retry with two old works');
  assert.equal(await js(`document.querySelector('[data-task-id="single"] .uc-generation-history__task-card').textContent`),'');
  assert.equal(await js(`document.querySelector('[data-task-id="empty"] .uc-generation-history__task-card').textContent`),'生成中');
  report.checks.push('Single result is media only; empty task shows one status without redundant labels');
  report.checks.push('One preview per card for single, multi and no-work tasks');
  for (const [width, height, theme] of [[1200, 900, 'dark'], [800, 720, 'light']]) {
    win.setContentSize(width, height);
    await js(`document.documentElement.dataset.theme = '${theme}'; historyHarness.reset()`);
    await until(`document.querySelector('${card}').textContent.includes('／2')`);
    await js(`document.querySelector('${card} [aria-label="上一件作品"]').click()`);
    await until(`document.querySelector('${card}').textContent.includes('作品 1／2')`);
    const before = await geometry();
    assert.equal(await js(`document.querySelectorAll('${card} .uc-generation-history__work').length`), 1);
    await js(`document.querySelector('${card} [aria-label="下一件作品"]').click()`);
    await until(`historyHarness.selected() === 'multi-2' && document.querySelector('${card}').textContent.includes('作品 2／2')`);
    assert.equal(await js(`document.querySelector('${card} [aria-label="下一件作品"]').disabled`), true);
    assert.equal(await js(`document.querySelector('${card} .uc-generation-history__task-status').textContent`), '生成中');
    await js(`historyHarness.update('failed', true)`);
    await until(`document.querySelector('${card}').textContent.includes('作品 2／3')`);
    assert.equal(await js('historyHarness.selected()'), 'multi-2');
    assert.equal(await js(`document.querySelector('${card} .uc-generation-history__task-status').textContent`), '失败');
    assert.equal(await js(`document.querySelector('.uc-generation-history__timeline-heading').textContent.includes('成功 1 · 失败 1 · 进行中 1')`), true);
    assert.deepEqual(await geometry(), before, 'State and work count must not move card or surrounding layout');
    const containment = await js(`Array.from(document.querySelectorAll('.uc-generation-history__task-card')).every(e => {
      const p = e.getBoundingClientRect(); return Array.from(e.children).every(c => { const r=c.getBoundingClientRect(); return r.bottom<=p.bottom+1 && r.right<=p.right+1 && r.left>=p.left-1; });
    })`);
    assert.equal(containment, true, 'All card controls fit');
    await js(`document.querySelector('${card} .uc-generation-history__task-status').click()`);
    await until(`document.querySelector('${card} .uc-generation-history__task-status').getAttribute('aria-pressed') === 'true'`);
    await js(`historyHarness.update('failed')`);
    await delay(100);
    assert.equal(await js('historyHarness.selected()'), undefined, 'Refresh preserves explicit task-status selection');
    await js(`document.querySelector('${card} [aria-label="上一件作品"]').click()`);
    await until(`historyHarness.selected() === 'multi-1'`);
    await js(`document.querySelector('${card} [aria-label="下一件作品"]').focus()`);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`historyHarness.selected() === 'multi-2'`);
    assert.equal(await js(`document.activeElement?.getAttribute('aria-label')`), '下一件作品');
    await paint();
    await fs.writeFile(path.join(output, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    report.checks.push(`${theme} ${width}x${height}: switching, retry status, refresh retention, keyboard and fixed geometry`);
  }
  await js('historyHarness.many()');
  await until(`document.querySelector('${card}').textContent.includes('作品 1／60')`);
  for (let index = 2; index <= 60; index++) {
    await js(`document.querySelector('${card} [aria-label="下一件作品"]').click()`);
    await until(`document.querySelector('${card}').textContent.includes('作品 ${index}／60')`);
  }
  assert.equal(await js('historyHarness.selected()'), 'many-60');
  assert.equal(await js(`document.querySelectorAll('${card} .uc-generation-history__work').length`), 1);
  report.checks.push('All 60 works selectable through one preview without the old 50-work truncation');
  await js('historyHarness.stress()');
  await until('document.querySelectorAll(".uc-generation-history__node").length === 30');
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-task-id]')).map(e=>e.dataset.taskId)`),Array.from({length:30},(_,i)=>`stress-${75+i}`));
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='加载更早任务')`),false);
  report.checks.push('Only the newest 30 tasks across completed, failed and active states; no load-more control');
  await js('historyHarness.hold(); historyHarness.notify()');
  await until('historyHarness.reads().inFlight === 1');
  for (let i = 0; i < 15; i++) { await js('historyHarness.notify()'); await delay(10); }
  assert.equal(await js('historyHarness.reads().peak'), 1, 'Storage events must not overlap history reads');
  await js('historyHarness.release()');
  await until('historyHarness.reads().inFlight === 0');
  await delay(100);
  report.refresh = await js('historyHarness.reads()');
  assert.ok(report.refresh.historyReads <= 2, 'At most the current read plus one merged follow-up');
  report.checks.push('15 storage events merge into one follow-up with no concurrent reads');
  await js('historyHarness.generating()');
  win.show(); win.focus();
  await delay(150);
  const wheelPoint = await js(`(()=>{const r=document.querySelector('.uc-generation-history__timeline-scroll').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+60)}})()`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel', ...wheelPoint, deltaX:0, deltaY:-400});
  await delay(100);
  const userScroll = await js(`document.querySelector('.uc-generation-history__timeline-scroll').scrollLeft`);
  report.wheel = {wheelPoint,userScroll, geometry: await js(`(()=>{const e=document.querySelector('.uc-generation-history__timeline-scroll');return {width:e.clientWidth,scrollWidth:e.scrollWidth,viewport:[innerWidth,innerHeight]}})()`)};
  assert.ok(await js(`(()=>{const e=document.querySelector('.uc-generation-history__timeline-scroll');return e.scrollLeft<e.scrollWidth-e.clientWidth-100})()`), 'Wheel moves history during generation');
  await js('historyHarness.notify()');
  await delay(150);
  assert.equal(await js(`document.querySelector('.uc-generation-history__timeline-scroll').scrollLeft`), userScroll, 'Generation refresh does not pull user scroll back to latest');
  report.checks.push('Native wheel while generating retains user scroll across refresh');
  await js('historyHarness.stress()');
  await until('document.querySelectorAll(".uc-generation-history__node").length === 30');
  await js(`window.oldestActiveCard=document.querySelector('[data-task-id="stress-104"]');historyHarness.completeOldest()`);
  await until(`document.querySelector('[data-task-id="stress-104"] .uc-generation-history__work')!==null`);
  assert.equal(await js(`document.querySelector('[data-task-id="stress-104"]')===oldestActiveCard`),true);
  assert.equal(await js('document.querySelectorAll(".uc-generation-history__node").length'),30);
  report.checks.push('Completing a task preserves the 30-card window and its DOM identity');
  await js('historyHarness.appendLatest()');
  await until(`document.querySelector('[data-task-id="stress-105"]')!==null`);
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-task-id]')).map(e=>e.dataset.taskId)`),Array.from({length:30},(_,i)=>`stress-${76+i}`));
  assert.equal(await js(`document.querySelector('[data-task-id="stress-105"] .uc-generation-history__task-card').textContent`),'失败');
  report.checks.push('A new failed task evicts only the oldest card, retains exactly 30, and shows failure once');
  await js('historyHarness.follow()');
  await until('document.querySelector("[data-task-id=accepted]") !== null');
  assert.equal(await js('document.querySelectorAll(".uc-generation-history__node").length'), 1);
  await js(`window.acceptedCard=document.querySelector('[data-task-id=accepted]');window.transitionFrames=[];window.transitionObserver=new MutationObserver(()=>{const card=document.querySelector('[data-task-id=accepted]');const r=card.getBoundingClientRect();transitionFrames.push({count:document.querySelectorAll('.uc-generation-history__node').length,same:card===acceptedCard,y:r.y,height:r.height,previews:card.querySelectorAll('.uc-generation-history__work,.uc-generation-history__status-button').length})});transitionObserver.observe(document.querySelector('.uc-generation-history'),{childList:true,subtree:true})`);
  const acceptedGeometry = await js(`(()=>{const r=acceptedCard.getBoundingClientRect();return {y:r.y,height:r.height}})()`);
  for (const state of ['remote_completed','downloading','verifying_file','registering_work']) {
    await js(`historyHarness.finish('${state}')`);
    await delay(100);
  }
  await js('historyHarness.finish("completed")');
  await until('historyHarness.selected() === "accepted-work"');
  await paint();
  const transitionFrames = await js('transitionObserver.disconnect();transitionFrames');
  assert.ok(transitionFrames.length >= 4);
  for(const frame of transitionFrames) assert.deepEqual(frame,{count:1,same:true,...acceptedGeometry,previews:1});
  report.checks.push('All intermediate receive/register/complete mutations retain the same single card, preview slot and timeline geometry');
  await js('historyHarness.finish("cancelled")');
  await until('document.querySelector("[data-task-id=accepted]").textContent.includes("已取消")');
  assert.equal(await js('document.querySelector(".uc-generation-history__current").textContent.includes("正在生成")'), false);
  report.checks.push('Persisted acceptance stays one card, completion selects its Work, cancellation overrides stale local waiting');
  assert.deepEqual(report.errors, []);
}
run().then(async () => {
  clearTimeout(watchdog);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); win.destroy(); app.quit();
}).catch(async (error) => {
  clearTimeout(watchdog);
  report.failure = String(error);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error); if (win) win.destroy(); app.exit(1);
});
