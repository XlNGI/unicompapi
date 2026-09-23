const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

// Full production React workbench with isolated IPC fixtures, no user profile or provider requests.
const workspace = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const parameters = process.argv.includes('--parameters');
const output = path.join(workspace, 'outputs', 'video-workbench-regression');
app.setPath('userData', path.join(os.tmpdir(), `unicomp-workbench-${process.pid}`));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Workbench verification timed out'); app.exit(1); }, 180000);
let temporary;
let window;
const checks = [];
const errors = [];
async function loadContract(relative, exportName) {
  const Module = require('node:module');
  const result = await require(require.resolve('esbuild', { paths: [require.resolve('vite')] })).build({
    entryPoints: [path.join(workspace, relative)], bundle: true, write: false, platform: 'node', format: 'cjs'
  });
  const loaded = new Module(path.join(workspace, 'workbench-contract.cjs'));
  loaded.filename = path.join(workspace, 'workbench-contract.cjs');
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  return loaded.exports[exportName];
}
const js = (source) => window.webContents.executeJavaScript(source);
async function until(source) {
  for (let i = 0; i < 100; i++) {
    if (await js(source)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${source}`);
}
const original = 'textarea[aria-label="原始创作需求"]';
async function focus(selector = original) {
  await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
  await delay(20);
}
async function type(text) {
  for (const key of text) {
    window.webContents.sendInputEvent({ type: 'char', keyCode: key });
    await delay(8);
  }
}
async function click(label) {
  await until(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`);
  await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
}
async function state() { return js('workbenchHarness.state()'); }
async function run() {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workbench-'));
  await mkdir(output, { recursive: true });
  await app.whenReady();
  const vite = require('vite');
  const genericSchema = await loadContract('src/platform/providers/newapi/newapi-contracts.ts', 'newApiDefaultTextToVideoParameterSchema');
  const seedanceSchema = await loadContract('src/platform/providers/newapi/unicompapi-model-capabilities.ts', 'uniCompApiSeedance2TextToVideoParameterSchema');
  await vite.build({ configFile: false, root: workspace, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'workbench-observation', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/video-workbench-harness.tsx')) {
        return code.replace(/import \{ newApiDefaultTextToVideoParameterSchema \} from [^;]+;/,
          `const newApiDefaultTextToVideoParameterSchema = ${JSON.stringify(genericSchema)};`)
          .replace(/import \{ uniCompApiSeedance2TextToVideoParameterSchema \} from [^;]+;/,
            `const uniCompApiSeedance2TextToVideoParameterSchema = ${JSON.stringify(seedanceSchema)};`);
      }
      if (id.endsWith('/VideoWorkbenchPage.tsx')) {
        return code.replace('  const storage =', '  window.workbenchRenders = (window.workbenchRenders || 0) + 1;\n  const storage =');
      }
      if (baseline && id.endsWith('/VideoImageWorkspace.tsx')) {
        return code.replace("import { BufferedPromptInput } from '../../../components/BufferedPromptInput';", "import { Input as BufferedPromptInput } from 'rsuite';");
      }
    } }],
    build: { outDir: temporary, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(workspace, 'tests/harness/video-workbench-harness.tsx'), formats: ['iife'], name: 'WorkbenchHarness', fileName: () => 'harness.js' } }
  });
  await writeFile(path.join(temporary, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  window = new BrowserWindow({ show: true, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(path.join(temporary, 'index.html'), { query: parameters ? { parameters: '1' } : {} });
  if (parameters) return runParameterChecks();
  await until('window.workbenchHarness?.ready && document.querySelector("textarea") && document.body.textContent.includes("H3 fixture")');
  await until('Array.from(document.images).some(i => i.naturalWidth === 320) && Array.from(document.querySelectorAll("video")).some(v => v.readyState >= 2)');
  await js(`(() => { const v = document.querySelector('.uc-generation-result-preview video'); v.loop = true; v.muted = true; return v.play(); })()`);
  await delay(250);
  checks.push('full workbench with source image, ten history items and decoded video');
  const before = await state();
  const renders = await js('workbenchRenders');
  await focus();
  await type('abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3));
  const after = await state();
  const renderDelta = await js('workbenchRenders') - renders;
  const counts = Object.fromEntries(Object.keys(before.counters).map(key => [key, after.counters[key] - before.counters[key]]));
  assert.ok(await js(`!document.querySelector('.uc-generation-result-preview video').paused`));
  if (!baseline) {
    assert.equal(renderDelta, 0, 'typing must not rerender the workbench');
    assert.equal(counts.saves, 0);
    assert.equal(counts.candidates, 0);
    assert.equal(counts.previews, 0);
    checks.push('108 native character events: no workbench renders or boundary calls while typing');
  }
  await until('workbenchHarness.counters.saves > 0');
  assert.ok((await state()).drafts[0].prompt.originalInput.endsWith('0123456789'));
  checks.push('idle autosave');
  await delay(100);
  const samples = (await state()).samples.slice(0, 108).sort((a, b) => a - b);
  const metrics = { samples: samples.length, p50Ms: samples[Math.floor(samples.length * .5)],
    p95Ms: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1), renderDelta, boundaryCalls: counts };
  await writeFile(path.join(output, 'image-input-observation.json'), JSON.stringify({ metrics,
    renderer: await js('({visibility:document.visibilityState, focused:document.hasFocus(), longTasks:workbenchHarness.longTasks})') }, null, 2));
  if (!baseline) {
    assert.equal(samples.length, 108);
    assert.ok(metrics.p95Ms <= 50, `input-to-rendering-opportunity p95 ${metrics.p95Ms} > 50ms`);
    await focus();
    await window.webContents.insertText('粘贴中文');
    await click('生成'); // Programmatic click deliberately does not blur the editor.
    await until('workbenchHarness.counters.prepares === 1');
    assert.ok((await state()).preparedPrompt.endsWith('粘贴中文'));
    checks.push('focused paste -> immediate generation preflight contains final character');

    await js(`Array.from(document.querySelectorAll('details')).find(e => e.querySelector('summary')?.textContent.includes('模型参数')).open = true`);
    await focus('.uc-dynamic-parameters input');
    await js(`(() => { const e = document.querySelector('.uc-dynamic-parameters input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '-'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await delay(20);
    await click('生成');
    await delay(50);
    assert.equal((await state()).counters.prepares, 1, 'invalid number must block preflight');
    await js(`document.querySelector('.uc-dynamic-parameters input').select()`);
    await js(`(() => { const e = document.querySelector('.uc-dynamic-parameters input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '12'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await delay(20);
    await focus();
    await click('生成');
    await until('workbenchHarness.counters.prepares === 2');
    assert.equal((await state()).drafts[0].featureSelection.parameterValues.duration, 12);
    checks.push('dynamic parameter intermediate number blocked, corrected value saved at generation');

    await js(`(() => { const e = document.querySelector(${JSON.stringify(original)}); e.focus(); e.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true})); })()`);
    const saves = (await state()).counters.saves;
    await window.webContents.insertText('输入法');
    await delay(350);
    assert.equal((await state()).counters.saves, saves);
    await js(`document.querySelector(${JSON.stringify(original)}).dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'输入法'}))`);
    assert.equal(await js('workbenchHarness.flush()'), true);
    assert.ok((await state()).drafts[0].prompt.originalInput.endsWith('输入法'));
    checks.push('composition event sequence and focused explicit flush');

    await js('workbenchHarness.showFinal()');
    await until('document.querySelectorAll("textarea").length === 2');
    await focus('textarea:not([aria-label])');
    await window.webContents.insertText('最终编辑');
    assert.equal(await js('workbenchHarness.flush()'), true);
    assert.ok((await state()).drafts[0].prompt.finalPrompt.endsWith('最终编辑'));
    await focus();
    await window.webContents.insertText('原始编辑');
    await focus('textarea:not([aria-label])');
    await window.webContents.insertText('末字');
    await click('新建本地草稿');
    await until('workbenchHarness.state().drafts.length === 2');
    const old = (await state()).drafts[0];
    assert.ok(old.prompt.originalInput.endsWith('原始编辑'));
    assert.ok(old.prompt.finalPrompt.endsWith('末字'));
    checks.push('two prompt fields, blur and new draft retain independent final text');
    await js('workbenchHarness.remount()');
    await until(`document.querySelector(${JSON.stringify(original)})?.value.endsWith('原始编辑')`);
    checks.push('reopen saved draft');

    await focus();
    await window.webContents.insertText('卸载末字');
    await js('workbenchHarness.unmount()');
    await until('workbenchHarness.state().drafts[0].prompt.originalInput.endsWith("卸载末字")');
    checks.push('route unmount persists pending input');

    await js('workbenchHarness.failCandidates(true); workbenchHarness.remount("draft-2")');
    await until('document.body.textContent.includes("没有可选模型")');
    await js('workbenchHarness.failCandidates(false)');
    await js('workbenchHarness.remount("draft-2")');
    await until('document.body.textContent.includes("H3 fixture")');
    checks.push('original empty-model display restored; remount reloads candidates');

    await js(`document.querySelector('[role="combobox"]').click()`);
    await until(`Array.from(document.querySelectorAll('[role="option"]')).some(e => e.textContent.includes('Seedance fixture'))`);
    await js(`Array.from(document.querySelectorAll('[role="option"]')).find(e => e.textContent.includes('Seedance fixture')).click()`);
    assert.equal(await js('workbenchHarness.flush()'), true);
    assert.equal((await state()).drafts[1].featureSelection.candidateId, 'candidate-1');
    checks.push('model picker switches between returned video candidates');
    await focus();
    await window.webContents.insertText('长文本'.repeat(700));
    const prepares = (await state()).counters.prepares;
    await click('生成');
    await until(`workbenchHarness.counters.prepares === ${prepares + 1}`);
    assert.equal((await state()).preparedPrompt, '长文本'.repeat(700));
    checks.push('2100-character paste into empty prompt then immediate preflight');

    await focus();
    await window.webContents.insertText('关闭末字');
    await js('window.dispatchEvent(new Event("beforeunload", {cancelable:true}))');
    await until('workbenchHarness.counters.closes === 1');
    assert.ok((await state()).drafts[1].prompt.originalInput.endsWith('关闭末字'));
    checks.push('beforeunload flush persists focused final character before close callback');
    await focus();
    await window.webContents.insertText('失败保留');
    await js('workbenchHarness.failSaves(true)');
    assert.equal(await js('workbenchHarness.flush()'), false);
    assert.ok(await js(`document.querySelector(${JSON.stringify(original)}).value.endsWith('失败保留')`));
    await js('workbenchHarness.failSaves(false)');
    assert.equal(await js('workbenchHarness.flush()'), true);
    checks.push('failed save blocks flush, retains text and later persists');
    await delay(150);
    await writeFile(path.join(output, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1024, 768);
    await delay(150);
    await writeFile(path.join(output, 'compact.png'), (await window.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(errors, [], 'renderer errors');
  const report = { mode: baseline ? 'unbuffered-baseline' : 'fixed', scope: 'Full image-to-video workbench; IPC fixtures, local generated media, no network',
    environment: { platform: os.platform(), electron: process.versions.electron, chromium: process.versions.chrome, gpu: 'disabled' },
    measurement: 'native input event -> next rendering opportunity; not OS paint or physical keyboard latency', metrics, checks, errors };
  await writeFile(path.join(output, baseline ? 'baseline.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function runParameterChecks() {
  const failures = [];
  const metrics = [];
  function check(condition, label) {
    (condition ? checks : failures).push(label);
  }
  async function openParameters() {
    await until('document.querySelector(".uc-dynamic-parameters")');
    await js(`Array.from(document.querySelectorAll('details')).find(e => e.querySelector('summary')?.textContent.includes('模型参数')).open = true`);
    await delay(100);
  }
  async function setField(label, value) {
    await js(`(() => { const e = document.querySelector('input[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  }
  async function values() { return (await state()).drafts[0].featureSelection.parameterValues; }
  await until('window.workbenchHarness?.ready && document.body.textContent.includes("H3 fixture")');
  await openParameters();
  for (const [index, name] of ['generic12', 'seedance9'].entries()) {
    if (index) {
      await setField('帧数', '31');
      await setField('随机种子', '77');
      await js(`document.querySelector('[role="combobox"]').click()`);
      await until(`Array.from(document.querySelectorAll('[role="option"]')).some(e => e.textContent.includes('Seedance fixture'))`);
      await js(`Array.from(document.querySelectorAll('[role="option"]')).find(e => e.textContent.includes('Seedance fixture')).click()`);
      await until('document.querySelectorAll(".uc-dynamic-parameters__field").length === 9');
      await openParameters();
      await delay(1800);
      check(Object.keys(await values()).length === 0, 'switching schema discards pending old-model parameters');
    }
    await delay(2200);
    await js('workbenchHarness.samples.length = 0; workbenchHarness.longTasks.length = 0');
    const dispatchMs = [];
    // Include pauses across both the 600ms field commit and 1000ms autosave.
    for (let n = 0; n < (baseline ? 12 : 100); n++) {
      await js(`(() => { const e = document.querySelector('input[aria-label="随机种子"]'); e.focus(); e.select(); })()`);
      const start = performance.now();
      window.webContents.sendInputEvent({ type: 'char', keyCode: String(n % 10) });
      await js('new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))');
      dispatchMs.push(performance.now() - start);
      await delay(n % 20 === 0 ? 1800 : 8);
    }
    if (!index && !baseline) {
      await js(`document.querySelector('input[aria-label="分辨率"]').focus()`);
      await type('a'.repeat(100));
      await window.webContents.insertText('中文粘贴');
    }
    if (index && !baseline) {
      for (let n = 0; n < 100; n++) {
        await js(`document.querySelector('.uc-dynamic-parameters [role="combobox"]').click()`);
        await until(`Array.from(document.querySelectorAll('[role="option"]')).some(e => e.textContent.trim() === '${n % 2 ? '720p' : '480p'}')`);
        await js(`Array.from(document.querySelectorAll('[role="option"]')).find(e => e.textContent.trim() === '${n % 2 ? '720p' : '480p'}').click()`);
      }
    }
    await delay(2400);
    const samples = (await state()).samples.sort((a,b) => a-b);
    const longTasks = await js('workbenchHarness.longTasks');
    dispatchMs.sort((a,b) => a-b);
    const row = { name, samples: samples.length, p95Ms: samples[Math.floor(samples.length * .95)],
      dispatchP95Ms: dispatchMs[Math.floor(dispatchMs.length * .95)], dispatchMaxMs: dispatchMs.at(-1),
      maxLongTaskMs: Math.max(0, ...longTasks), longTasks };
    metrics.push(row);
    check(row.p95Ms <= 50 && row.dispatchP95Ms <= 50 && row.maxLongTaskMs < 100, `${name}: edit/commit/save window meets 50ms p95 and no 100ms long task`);
    await writeFile(path.join(output, `parameters-${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await setField('帧数', '25');
  await setField('随机种子', '42');
  await click('生成');
  await until('workbenchHarness.counters.prepares > 0');
  check((await values()).frames === 25 && (await values()).seed === 42, 'two pending fields survive immediate generate without blur');
  await setField('帧数', '26');
  await setField('随机种子', '43');
  await js('workbenchHarness.flush()');
  check((await values()).frames === 26 && (await values()).seed === 43, 'global flush includes pending parameters');
  if (!baseline) {
    const prepares = (await state()).counters.prepares;
    await setField('随机种子', '-');
    await click('生成');
    await delay(100);
    check((await state()).counters.prepares === prepares, 'invalid intermediate blocks generation');
    check(await js(`document.querySelector('input[aria-label="随机种子"]').value === '-'`), 'invalid input remains visible');
    await setField('随机种子', '44');
    await setField('帧数', '');
    await js('workbenchHarness.flush()');
    check((await values()).seed === 44 && !('frames' in await values()), 'correction and clearing preserve independent values');
    await setField('帧数', '27');
    await click('新建本地草稿');
    await until('workbenchHarness.state().drafts.length === 2');
    check((await values()).frames === 27, 'new draft preserves previous pending parameter');
    await js('workbenchHarness.remount()');
    await openParameters();
    await setField('随机种子', '45');
    await js('workbenchHarness.unmount()');
    await delay(250);
    check((await values()).seed === 45, 'route unmount persists pending parameter');
    await js('workbenchHarness.remount()');
    await openParameters();
    await setField('随机种子', '46');
    await js('workbenchHarness.failSaves(true)');
    check(await js('workbenchHarness.flush()') === false, 'save failure blocks successful flush');
    check(await js(`document.querySelector('input[aria-label="随机种子"]').value === '46'`), 'save failure preserves visible input');
    await js('workbenchHarness.failSaves(false)');
    check(await js('workbenchHarness.flush()') === true && (await values()).seed === 46, 'recovery saves retained input');
    await setField('随机种子', '47');
    await js('window.dispatchEvent(new Event("beforeunload", {cancelable:true}))');
    await delay(100);
    check((await values()).seed === 47 && (await state()).counters.closes === 1, 'close boundary saves pending parameter');
    for (const width of [1024, 1920]) {
      window.setSize(width, 1000);
      await delay(200);
      await writeFile(path.join(output, `parameters-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    // Verify the form's own available width, independent of viewport and outer containers.
    for (const width of [400, 619, 620, 800]) {
      await js(`document.querySelector('.uc-dynamic-parameters-container').style.width = '${width}px'`);
      const columns = await js(`getComputedStyle(document.querySelector('.uc-dynamic-parameters')).gridTemplateColumns.split(' ').length`);
      check(columns === (width < 620 ? 1 : 2), `parameter width ${width}px has correct columns`);
    }
  }
  check(errors.length === 0, 'no renderer errors');
  const report = { mode: baseline ? 'parameter-baseline' : 'parameter-fixed',
    scope: 'Real AppLayout, text-video workbench and schemas; isolated IPC fixtures, production preload integration verified separately',
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, gpu: 'disabled' },
    measurement: 'Native digit dispatch through rendering opportunity plus whole edit/idle/autosave long-task observation; synthetic string/enum/lifecycle operations',
    metrics, checks, failures, errors };
  await writeFile(path.join(output, baseline ? 'parameter-baseline.json' : 'parameter-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (baseline) assert.ok(failures.length > 0, 'baseline must reproduce a regression');
  else assert.deepEqual(failures, [], 'parameter regressions');
}
run().then(() => finish(0), async (error) => {
  console.error(error, errors);
  if (window) console.error(await js('({text:document.body.innerText,ready:window.workbenchHarness?.ready,visibility:document.visibilityState,focused:document.hasFocus(),longTasks:window.workbenchHarness?.longTasks})'));
  return finish(1);
});
async function finish(code) {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) {
    await js(`document.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); }); window.workbenchHarness?.unmount();`);
    await delay(200);
    window.destroy();
    await delay(200);
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  console.log(`WORKBENCH_VERIFICATION_EXIT=${code}`);
  app.exit(code);
}
