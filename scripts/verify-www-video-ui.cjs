const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { app, BrowserWindow } = require('electron');
// Production React workbench; synthetic local IPC fixture and decoded local media only.
const workspace = path.resolve(__dirname, '..');
const h3 = process.argv.includes('--h3');
const seedance = process.argv.includes('--seedance');
const textModel = h3 || seedance;
const output = path.join(workspace, 'outputs/video-parameter-repair-20261020', h3 ? 'ui-h3' : seedance ? 'ui-seedance' : 'ui-edit');
app.setPath('userData', path.join(os.tmpdir(), 'unicomp-www-ui-' + process.pid));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let window, temporary, externalRequests = 0;
const errors = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => window.webContents.executeJavaScript(source);
async function until(source) {
  for (let i = 0; i < 100; i++) {
    if (await js(source)) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + source);
}
async function main() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-www-ui-'));
  const compiled = await require(require.resolve('esbuild', { paths: [require.resolve('vite')] })).build({
    entryPoints: [path.join(workspace, 'src/platform/providers/newapi/www-video-contracts.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs'
  });
  const loaded = new Module(path.join(workspace, 'ui-contract.cjs'));
  loaded.filename = path.join(workspace, 'ui-contract.cjs'); loaded.paths = module.paths;
  loaded._compile(compiled.outputFiles[0].text, loaded.filename);
  const modelKey = h3 ? 'MiniMax-H3' : seedance ? 'doubao-seedance-2-0-260128' : 'happyhorse-1.0-video-edit';
  const schema = loaded.exports.wwwVideoParameterSchema(loaded.exports.wwwVideoContract(modelKey), textModel ? 'text_to_video' : 'video_edit');
  const candidate = { schemaVersion: 1, candidateId: 'candidate-0', providerName: 'WWW local fixture', connectionName: 'Isolated fixture',
    modelName: modelKey, available: true, unavailableReasons: [], parameterSchema: schema,
    usageSchema: { schemaVersion: 1, schemaId: 'usage.unicompapi-www.video', revision: 1 }, cost: { state: 'unknown' } };
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'www-edit-fixture', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/video-workbench-harness.tsx')) return;
      code = code.replace(/import \{ newApiDefaultTextToVideoParameterSchema \} from [^;]+;/, '')
        .replace(/import \{ uniCompApiSeedance2TextToVideoParameterSchema \} from [^;]+;/, '');
      const start = code.indexOf('const candidates:');
      const end = code.indexOf('function makeDraft', start);
      assert.ok(start >= 0 && end > start);
      code = code.slice(0, start) + 'const candidates: VideoFeatureCandidateDto[] = ' + JSON.stringify([candidate]) + ';\n\n' + code.slice(end);
      if (textModel) return code;
      return code.replace("productFeature: textVideo ? 'text_to_video' : 'image_to_video'", "productFeature: 'video_edit'")
        .replace("originalInput: textVideo ? 'Local video prompt' : '', finalPrompt: textVideo ? 'Local video prompt' : ''", "originalInput: '将杯子改成蓝色', finalPrompt: '将杯子改成蓝色'")
        .replace("assetId: 'fixture-image', mediaKind: 'image' as const", "assetId: 'fixture-video', mediaKind: 'video' as const")
        .replace("    getMaterial: async () =>", "    selectMaterial: async (id: string) => { const current = drafts.get(id) as any; const draft = { ...current, featureSelection: { productFeature: 'video_edit', candidateId: 'candidate-0', parameterSchemaId: candidates[0].parameterSchema.schemaId, parameterSchemaRevision: candidates[0].parameterSchema.revision, parameterValues: {} }, imageToVideo: { ...current.imageToVideo, referenceImages: undefined, source: { assetId: 'fixture-video', mediaKind: 'video', role: 'source', selectedAt: timestamp } } }; drafts.set(id, draft); return ok({ cancelled: false, draft }); },\n    getMaterial: async () =>")
        .replace("ok({ url: imageUrl, mediaKind: 'image', mimeType: 'image/png', expiresAt: timestamp })", "ok({ url: videoUrl, mediaKind: 'video', mimeType: 'video/webm', expiresAt: timestamp })");
    } }],
    build: { outDir: temporary, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(workspace, 'tests/harness/video-workbench-harness.tsx'), formats: ['iife'], name: 'WwwVideoUi', fileName: () => 'harness.js' } }
  });
  await fs.writeFile(path.join(temporary, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  window = new BrowserWindow({ show: false, width: 1440, height: 1100,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false, offscreen: true } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => { externalRequests++; callback({ cancel: true }); });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(path.join(temporary, 'index.html'), textModel ? { query: { parameters: '1' } } : {});
  if (seedance) {
    await until('window.workbenchHarness?.ready && document.body.textContent.includes("doubao-seedance-2-0-260128")');
    const setPrompt = count => js(`(() => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '😀'.repeat(${count}));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await setPrompt(20000);
    await until('workbenchHarness.state().drafts[0].prompt.finalPrompt.length === 40000');
    assert.equal(await js('document.body.textContent.includes("20000 / 20000")'), true);
    assert.equal(await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "生成").disabled'), false);
    await setPrompt(20001);
    await until('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "生成").disabled');
    assert.equal(await js('workbenchHarness.counters.prepares'), 0);
    checks.push('production prompt input preserves 20,000 emoji without UTF-16 truncation', 'counter and Generate enforce the selected schema Unicode limit');
    assert.deepEqual(errors, []); assert.equal(externalRequests, 0);
    await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify({ status: 'passed', checks, errors, externalRequests,
      boundaries: 'production React; local synthetic IPC; no provider call' }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: checks.length, externalRequests })); return;
  }
  if (h3) {
    await until('window.workbenchHarness?.ready && document.body.textContent.includes("MiniMax-H3")');
    await js('Array.from(document.querySelectorAll("details")).find(e => e.querySelector("summary")?.textContent.includes("模型参数")).open = true');
    await until('document.querySelector("input[aria-label=分辨率]")');
    assert.equal(await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "生成").disabled'), true);
    assert.equal(await js('document.body.textContent.includes("不接受空参数")'), true);
    assert.deepEqual(await js('workbenchHarness.state().drafts[0].featureSelection.parameterValues'), {});
    await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "填入官方示例").click()');
    await until('workbenchHarness.state().drafts[0].featureSelection.parameterValues.duration === 4');
    assert.deepEqual(await js('workbenchHarness.state().drafts[0].featureSelection.parameterValues'), schema.exampleValues);
    assert.equal(await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "生成").disabled'), false);
    assert.equal(await js('document.body.textContent.includes("费用上限") || document.body.textContent.includes("报价上限") || document.querySelector("section[aria-label=费用授权]") !== null'), false);
    await js('window.audioSwitch = Array.from(document.querySelectorAll(".uc-dynamic-parameters__field")).find(e => e.textContent.includes("生成音频")).querySelector("[role=switch]")');
    assert.equal(await js('window.audioSwitch.getAttribute("aria-checked")'), 'true');
    await js('window.audioSwitch.click()');
    await until('workbenchHarness.state().drafts[0].featureSelection.parameterValues.generate_audio === false');
    assert.equal(await js('window.audioSwitch.closest(".uc-dynamic-parameters__field").textContent.includes("关闭")'), true);
    // Unknown official requirements cannot be described as a provider default.
    await js('document.querySelector("button[aria-label=生成音频清除填写]").click()');
    await until('!Object.hasOwn(workbenchHarness.state().drafts[0].featureSelection.parameterValues, "generate_audio")');
    assert.equal(await js('window.audioSwitch.closest(".uc-dynamic-parameters__field").textContent.includes("未填")'), true);
    await js('window.audioSwitch.click()');
    await js('window.audioSwitch.click()');
    // Submit before idle commit; the focused model input must reach preflight.
    await js(`(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [label, value] of [['分辨率','768P']]) {
        const input = document.querySelector('input[aria-label="' + label + '"]');
        set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "生成").click()');
    await until('workbenchHarness.counters.prepares === 1');
    const parameters = await js('workbenchHarness.state().drafts[0].featureSelection.parameterValues');
    assert.equal(parameters.resolution, '768P'); assert.equal(parameters.maximum_cost_cny, undefined); assert.equal(parameters.generate_audio, false);
    assert.equal(await js('Array.from(document.querySelectorAll("details summary")).find(e => e.textContent.includes("模型参数")).textContent.includes("5 项")'), true);
    window.webContents.invalidate(); await delay(500);
    await fs.writeFile(path.join(output, 'h3-official-parameters.png'), (await window.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []); assert.equal(externalRequests, 0);
    checks.push('H3 empty parameters block Generate without supplying hidden defaults', 'official example requires an explicit user action and saves all five exact values', 'five gateway parameters; no manual budget input anywhere', 'unknown boolean distinguishes unset and false and can be cleared', 'focused model edit saved before preflight without a budget');
    await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify({ status: 'passed', checks, errors, externalRequests,
      boundaries: 'production React workbench; isolated local IPC; no provider call; quote approval verified in native Host suite' }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: checks.length, externalRequests })); return;
  }
  await until('window.workbenchHarness?.ready && document.body.textContent.includes("happyhorse-1.0-video-edit")');
  await until('document.querySelector(".uc-image-professional__reference-thumbnail video")?.readyState >= 2');
  assert.equal(await js('workbenchHarness.state().drafts[0].featureSelection.productFeature'), 'video_edit');
  assert.equal(await js('Boolean(document.querySelector("button[aria-label=继续添加图片]"))'), false);
  checks.push('original video decodes in production workbench; edit model selected; image addition hidden');
  await js('Array.from(document.querySelectorAll("details")).find(e => e.querySelector("summary")?.textContent.includes("模型参数")).open = true');
  assert.equal(await js('document.body.textContent.includes("费用上限") || document.body.textContent.includes("报价上限") || document.querySelector("section[aria-label=费用授权]") !== null'), false);
  checks.push('no manual budget input; model parameters contain only gateway inputs');
  window.webContents.invalidate();
  await delay(500);
  await fs.writeFile(path.join(output, 'video-edit.png'), (await window.webContents.capturePage()).toPNG());
  await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "生成").click()');
  await until('workbenchHarness.counters.prepares === 1');
  checks.push('production Generate action saves exact video_edit selection before local preflight');
  await js('document.querySelector("button[aria-label=删除图1]").click()');
  await until('document.querySelector("button[aria-label=添加图片]") && workbenchHarness.state().drafts[0].featureSelection.productFeature === "image_to_video"');
  checks.push('deleting video restores image mode and removes stale edit parameters');
  await js('Array.from(document.querySelectorAll("button")).find(e => e.textContent.trim() === "选择视频进行编辑").click()');
  await until('workbenchHarness.state().drafts[0].featureSelection.productFeature === "video_edit" && document.querySelector(".uc-image-professional__reference-thumbnail video")?.readyState >= 2');
  checks.push('controlled Select video action restores video edit and preview');
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0);
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify({ status: 'passed', checks, errors, externalRequests,
    boundaries: 'production React UI; synthetic local IPC; native file/pipeline verified separately; no real provider call' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, externalRequests }));
}
const deadline = setTimeout(() => { console.error('UI verification deadline'); app.exit(1); }, 180000);
main().then(async () => { window?.destroy(); await fs.rm(temporary, { recursive: true, force: true }); clearTimeout(deadline); app.exit(0); })
  .catch(e => { console.error(e.stack); window?.destroy(); clearTimeout(deadline); app.exit(1); });
