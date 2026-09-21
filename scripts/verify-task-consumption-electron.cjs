const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');

// Actual production main/preload/renderer; only the summary response is controlled.
// A disposable profile and blocked network keep real accounts and bills untouched.
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unicomp-consumption-'));
const baseline = process.argv.includes('--baseline');
const output = path.join(root, 'outputs', 'task-consumption-events', baseline ? 'before' : 'after');
const project = path.join(temporary, 'project');
fs.mkdirSync(project);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
delete process.env.VITE_DEV_SERVER_URL;
const pending = [];
const checks = [];
const observations = {};
const errors = [];
const monitorTrace = [];
if (process.argv.includes('--trace')) {
  const originalStat = fsp.stat;
  fsp.stat = async (...args) => {
    try {
      const result = await originalStat(...args);
      if (String(args[0]).startsWith(project)) monitorTrace.push({ at: Date.now(), path: String(args[0]).slice(project.length), mtime: result.mtimeMs, size: result.size });
      return result;
    } catch (error) { throw error; }
  };
  const originalWatch = fs.watch;
  fs.watch = (...args) => {
    monitorTrace.push({ at: Date.now(), watch: String(args[0]) });
    return originalWatch(...args);
  };
}
let window;
let finishing = false;
let requestCount = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => finish(new Error('Consumption verification deadline exceeded')), 240000);
app.on('browser-window-created', (_event, created) => {
  window = created;
  const send = created.webContents.send.bind(created.webContents);
  created.webContents.send = (channel, ...args) => {
    if (channel === 'storage:consumption-changed') monitorTrace.push({ at: Date.now(), notification: new Error().stack });
    return send(channel, ...args);
  };
  created.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_request, callback) => callback({ cancel: true }));
});
require(path.join(root, 'dist-electron/electron/main.js'));
const js = source => window.webContents.executeJavaScript(source);
async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${predicate}`);
}
async function screenshot(name) {
  await fsp.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}
function summary(amount = '20.16') {
  const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.now() + 8 * 3600000 - (6 - i) * 86400000).toISOString().slice(0, 10));
  return {
    currencyCode: 'CNY', currencyLabel: '人民币',
    period: { startDate: dates[0], endDate: dates[6], calendarDays: 7, timeZone: 'Asia/Shanghai' },
    totalAmount: amount, actualBillAmount: amount, estimatedAmount: '0', refundedAmount: '0',
    totalCallCount: 70, successfulCallCount: 45, pricedCallCount: 9, includedCallCount: 9,
    pendingConversionCallCount: 0, missingPricingRuleCount: 0, missingUsageCount: 0,
    invalidFeeCount: 0, pendingReconciliationCallCount: 0, unestimatedCallCount: 0,
    timeBuckets: dates.map((date, i) => ({ date, amount: i === 6 ? amount : '0', callCount: i === 6 ? 9 : 0 })),
    providerSlices: Number(amount) ? [{ key: 'fixture', providerId: 'fixture', label: 'OpenAI Compatible',
      amount, callCount: 9, ratioBasisPoints: 10000, isOther: false }] : [],
    pendingCurrencies: [], conversionSources: [], issues: [], disclaimer: 'provider_bill_preferred_with_estimate_fallback'
  };
}
async function resolveNext(value = summary()) {
  await until(() => pending.length > 0);
  pending.shift()({ ok: true, value });
  await delay(100);
}
async function eventRefresh() {
  const count = requestCount;
  window.webContents.send('storage:consumption-changed');
  await until(() => requestCount > count);
}
async function measure() {
  return js(`(() => {
    const chart = document.querySelector('.uc-task-center__charts-mask');
    const filters = document.querySelector('.uc-task-center__task-filters');
    return { height: chart.getBoundingClientRect().height, filterTop: filters.getBoundingClientRect().top,
      text: chart.textContent, bars: chart.querySelectorAll('.uc-task-center__bar-row').length,
      donut: !!chart.querySelector('.uc-task-center__donut'),
      sameBar: !window.originalBar || window.originalBar === chart.querySelector('.uc-task-center__bar-row'),
      sameDonut: !window.originalDonut || window.originalDonut === chart.querySelector('.uc-task-center__donut') };
  })()`);
}
function stable(a, b, label) {
  assert.ok(Math.abs(a.height - b.height) < 1, `${label}: chart height ${a.height} -> ${b.height}`);
  assert.ok(Math.abs(a.filterTop - b.filterTop) < 1, `${label}: filters ${a.filterTop} -> ${b.filterTop}`);
  assert.equal(b.bars, 7, `${label}: keep seven rows`);
  assert.equal(b.donut, true, `${label}: keep donut`);
  assert.doesNotMatch(b.text, /正在汇总|正在读取成功调用费用|正在读取消费账单|正在计算供应商/);
}
async function run() {
  await fsp.mkdir(output, { recursive: true });
  await until(async () => window && !window.webContents.isLoading() && await js('!!document.querySelector(".sidebar")'));
  window.setSize(1280, 840);
  window.show();
  window.focus();
  const created = await js(`unicomp.storage.createProject('Consumption regression')`);
  assert.equal(created.ok, true);
  await delay(1200);
  ipcMain.removeHandler('storage:get-consumption-summary');
  ipcMain.handle('storage:get-consumption-summary', () => {
    requestCount++;
    return new Promise(resolve => pending.push(resolve));
  });
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '任务中心').click()`);
  await until(() => pending.length > 0);
  observations.cold = await measure();
  await screenshot('initial');
  await resolveNext();
  observations.loaded = await measure();
  await screenshot('loaded');
  await js(`window.originalBar=document.querySelector('.uc-task-center__bar-row');window.originalDonut=document.querySelector('.uc-task-center__donut')`);
  await eventRefresh();
  await delay(600);
  observations.refreshing = await measure();
  await screenshot('refreshing');
  // This assertion is the original RED, using the unchanged production UI.
  stable(observations.loaded, observations.refreshing, 'slow event refresh');
  assert.equal(observations.refreshing.sameBar, true);
  assert.equal(observations.refreshing.sameDonut, true);
  await resolveNext(summary('21.16'));
  observations.updated = await measure();
  stable(observations.loaded, observations.updated, 'updated amount');
  assert.match(observations.updated.text, /¥21\.16/);
  assert.equal(observations.updated.sameBar, true);
  assert.equal(observations.updated.sameDonut, true);
  checks.push('slow event refresh preserves actual DOM nodes, geometry and old values; new values update in place');
  stable(observations.cold, observations.loaded, 'first load');
  assert.doesNotMatch(observations.cold.text, /¥0\.00/);
  checks.push('first load has stable dimensions and does not invent a zero bill');

  await eventRefresh();
  pending.shift()({ ok: false, error: { code: 'read_failed', message: 'isolated failure' } });
  await delay(100);
  observations.failure = await measure();
  stable(observations.loaded, observations.failure, 'failed refresh');
  assert.match(observations.failure.text, /更新失败.*上次/);
  assert.match(observations.failure.text, /¥21\.16/);
  await screenshot('failure');
  await eventRefresh();
  stable(observations.failure, await measure(), 'retry pending');
  await resolveNext(summary('21.16'));
  assert.doesNotMatch((await measure()).text, /更新失败/);
  checks.push('failure retains old numbers with honest status; successful refresh clears status without shifting');

  const beforeIdle = requestCount;
  for (let step = 0; step < 7; step++) {
    await delay(10000);
    console.log(`Idle observation ${(step + 1) * 10}s: summary requests=${requestCount}`);
    assert.equal(requestCount, beforeIdle, 'idle page must not poll consumption');
  }
  assert.equal(requestCount, beforeIdle, 'idle page must not poll consumption');
  observations.idle = { durationSeconds: 70, before: beforeIdle, after: requestCount };
  stable(observations.loaded, await measure(), 'idle page');
  checks.push('70 seconds idle: no 30-second summary polling or 60-second health-triggered billing');

  await fsp.writeFile(path.join(project, 'entities', 'image-workspace-drafts.json'), JSON.stringify({ schemaVersion: 1, drafts: [] }));
  await delay(1200);
  assert.equal(requestCount, beforeIdle, 'draft autosave must not refresh consumption');
  await fsp.writeFile(path.join(project, 'entities', 'provider-invocations.json'), JSON.stringify({ schemaVersion: 1, revision: 1, attempts: [], events: [] }));
  await until(() => requestCount > beforeIdle);
  await resolveNext();
  checks.push('real recursive project watcher ignores draft writes and notifies consumption on invocation writes');
  const afterWrite = requestCount;
  for (let step = 0; step < 7; step++) {
    await delay(10000);
    console.log(`Post-write idle ${(step + 1) * 10}s: summary requests=${requestCount}`);
    assert.equal(requestCount, afterWrite, 'health fallback must not repeat an already observed write');
  }
  observations.postWriteIdle = { durationSeconds: 70, before: afterWrite, after: requestCount };
  checks.push('70 seconds after a real invocation write: health fallback does not repeat its notification');

  const beforeNavigation = requestCount;
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '项目').click()`);
  await delay(150);
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '任务中心').click()`);
  await delay(500);
  assert.equal(requestCount, beforeNavigation, 'navigation must reuse the same cached snapshot');
  observations.navigation = { before: beforeNavigation, after: requestCount };
  assert.match((await measure()).text, /¥20\.16/);
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '项目').click()`);
  await eventRefresh();
  await resolveNext(summary('22.16'));
  const beforeReturn = requestCount;
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '任务中心').click()`);
  await delay(300);
  assert.equal(requestCount, beforeReturn);
  assert.match((await measure()).text, /¥22\.16/);
  checks.push('navigation reuses cache and changes received while away remain current on return');

  await eventRefresh();
  const obsolete = pending.shift();
  window.webContents.send('storage:consumption-changed');
  await delay(50);
  obsolete({ ok: true, value: summary('99.16') });
  await until(() => pending.length > 0);
  assert.doesNotMatch((await measure()).text, /¥99\.16/);
  await resolveNext(summary('23.16'));
  await delay(100);
  assert.match((await measure()).text, /¥23\.16/);
  assert.doesNotMatch((await measure()).text, /¥99\.16/);
  checks.push('late obsolete response cannot overwrite newer totals');

  await eventRefresh();
  await resolveNext(summary('0'));
  observations.zero = await measure();
  stable(observations.loaded, observations.zero, 'transition to empty data');
  await eventRefresh();
  stable(observations.zero, await measure(), 'zero consumption refresh');
  await resolveNext(summary('0'));
  assert.match((await measure()).text, /¥0\.00/);
  checks.push('genuine zero/empty result remains stable during refresh');

  await eventRefresh();
  const conversion = { ...summary(), pendingConversionCallCount: 1, pendingReconciliationCallCount: 1,
    pendingCurrencies: [{ currencyCode: 'USD', callCount: 1 }],
    conversionSources: [{ sourceCurrencyCode: 'USD', targetCurrencyCode: 'CNY', sourceTitle: 'Local fixture',
      sourceUrl: 'https://example.invalid', sourceCheckedAt: '2026-09-20' }] };
  await resolveNext(conversion);
  const withNotes = await measure();
  await eventRefresh();
  stable(withNotes, await measure(), 'conversion notes while refreshing');
  assert.match((await measure()).text, /Local fixture/);
  await resolveNext(conversion);
  checks.push('existing pending-conversion and source notes remain visible during refresh');

  for (const width of [1024, 1440]) {
    window.setSize(width, 900);
    await delay(100);
    const before = await measure();
    await eventRefresh();
    stable(before, await measure(), `width ${width}`);
    await resolveNext(conversion);
    await screenshot(`width-${width}`);
  }
  checks.push('1024 and 1440 pixel window refresh geometry');
  await js(`document.querySelector('.uc-task-center__task-filters').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:80}))`);
  await delay(450);
  assert.equal(await js(`document.querySelector('[data-consumption-charts-collapsed]').getAttribute('data-consumption-charts-collapsed')`), 'true');
  await js(`document.querySelector('.uc-task-center__task-filters').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-80}))`);
  await delay(450);
  assert.equal(await js(`document.querySelector('[data-consumption-charts-collapsed]').getAttribute('data-consumption-charts-collapsed')`), 'false');
  checks.push('existing intentional wheel collapse and reveal');

  // A cold renderer start, unlike route navigation, must perform an initial read.
  await window.webContents.reload();
  await until(async () => !window.webContents.isLoading() && await js('!!document.querySelector(".sidebar")'));
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '任务中心').click()`);
  await until(() => pending.length > 0);
  const coldAgain = await measure();
  pending.shift()({ ok: false, error: { code: 'read_failed', message: 'isolated initial failure' } });
  await delay(100);
  stable(coldAgain, await measure(), 'first read failure');
  assert.match((await measure()).text, /读取消费统计失败/);
  assert.doesNotMatch((await measure()).text, /¥0\.00/);
  await eventRefresh();
  await resolveNext(summary('0'));
  stable(coldAgain, await measure(), 'first read empty result');
  checks.push('cold renderer: first read failure and subsequent empty result keep the same layout');

  await eventRefresh();
  const multiple = summary('30.16');
  multiple.timeBuckets[5] = { ...multiple.timeBuckets[5], amount: '10', callCount: 1 };
  multiple.timeBuckets[6] = { ...multiple.timeBuckets[6], amount: '20.16', callCount: 8 };
  multiple.providerSlices = [
    { ...multiple.providerSlices[0], amount: '15.12', ratioBasisPoints: 7500 },
    { ...multiple.providerSlices[0], key: 'second', providerId: 'second', label: 'Second fixture', amount: '5.04', ratioBasisPoints: 2500 }
  ];
  await resolveNext(multiple);
  stable(coldAgain, await measure(), 'new provider and changed bars');
  assert.match((await measure()).text, /75\.00%/);
  assert.match((await measure()).text, /25\.00%/);
  const widths = await js(`Array.from(document.querySelectorAll('.uc-task-center__bar-row i')).map(e=>parseFloat(e.style.width))`);
  assert.ok(widths[5] > 49 && widths[5] < 50 && widths[6] === 100);
  checks.push('new provider shares and changed bar widths reflect new summary values');

  await eventRefresh();
  await resolveNext({ ...summary('24.16'), nextBillingRefreshAt: Date.now() + 1000 });
  await until(() => pending.length > 0);
  await resolveNext(summary('25.16'));
  assert.match((await measure()).text, /¥25\.16/);
  checks.push('server pending-bill deadline triggers silent reconciliation, settled response stops that timer');

  await js(`localStorage.setItem('unicomp.theme','light')`);
  await window.webContents.reload();
  await until(async () => !window.webContents.isLoading() && await js('!!document.querySelector(".sidebar")'));
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b => b.textContent.trim() === '任务中心').click()`);
  await resolveNext();
  assert.equal(await js('document.documentElement.dataset.theme'), 'light');
  const light = await measure();
  await eventRefresh();
  stable(light, await measure(), 'light theme refresh');
  await screenshot('light-refreshing');
  await resolveNext();
  checks.push('light theme through actual theme initialization and full page reload');
  assert.deepEqual(errors, []);
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  await fsp.mkdir(output, { recursive: true });
  const files = ['src/pages/tasks/TasksPage.tsx', 'src/ui/consumption-read-store.ts', 'src/platform/ipc/call-billing-cache.ts',
    'electron/ipc/storage-ipc.ts', 'dist-electron/electron/ipc/storage-ipc.js',
    'src/platform/ipc/provider-invocation-read-model-controller.ts', 'src/styles/pages.css', 'dist-electron/electron/main.js',
    'dist-electron/electron/preload.js', ...fs.readdirSync(path.join(root, 'dist/assets'))
      .filter(name => /\.(css|js)$/.test(name)).map(name => `dist/assets/${name}`)];
  const sha256 = Object.fromEntries(files.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
  const report = { baseline, passed: !error, error: error?.message, checks, observations, errors, requestCount, monitorTrace,
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, url: window?.webContents.getURL() },
    scope: 'Production main/preload/renderer in visible Electron; summary IPC uses synthetic delayed responses; temporary profile; network blocked; no user data/provider calls', sha256 };
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, checks, observations, output }, null, 2));
  for (const existing of BrowserWindow.getAllWindows()) existing.destroy();
  app.exit(error ? 1 : 0);
}
run().then(() => finish(), finish);
