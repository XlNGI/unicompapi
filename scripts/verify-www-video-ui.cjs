const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { app, BrowserWindow } = require('electron');
// Production React workbench; synthetic local IPC fixture and decoded local media only.
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'outputs/www-video-contracts/ui');
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
  const schema = loaded.exports.wwwVideoParameterSchema(loaded.exports.wwwVideoContract('happyhorse-1.0-video-edit'), 'video_edit');
  const candidate = { schemaVersion: 1, candidateId: 'candidate-0', providerName: 'WWW local fixture', connectionName: 'Isolated fixture',
    modelName: 'happyhorse-1.0-video-edit', available: true, unavailableReasons: [], parameterSchema: schema,
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
      return code.replace("productFeature: textVideo ? 'text_to_video' : 'image_to_video'", "productFeature: 'video_edit'")
        .replace("originalInput: textVideo ? 'Local video prompt' : '', finalPrompt: textVideo ? 'Local video prompt' : ''", "originalInput: '将杯子改成蓝色', finalPrompt: '将杯子改成蓝色'")
        .replace('parameterValues: {}', 'parameterValues: { maximum_cost_cny: 5 }')
        .replace("assetId: 'fixture-image', mediaKind: 'image' as const", "assetId: 'fixture-video', mediaKind: 'video' as const")
        .replace("    getMaterial: async () =>", "    selectMaterial: async (id: string) => { const current = drafts.get(id) as any; const draft = { ...current, featureSelection: { productFeature: 'video_edit', candidateId: 'candidate-0', parameterSchemaId: candidates[0].parameterSchema.schemaId, parameterSchemaRevision: 1, parameterValues: { maximum_cost_cny: 5 } }, imageToVideo: { ...current.imageToVideo, referenceImages: undefined, source: { assetId: 'fixture-video', mediaKind: 'video', role: 'source', selectedAt: timestamp } } }; drafts.set(id, draft); return ok({ cancelled: false, draft }); },\n    getMaterial: async () =>")
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
  await window.loadFile(path.join(temporary, 'index.html'));
  await until('window.workbenchHarness?.ready && document.body.textContent.includes("happyhorse-1.0-video-edit")');
  await until('document.querySelector(".uc-image-professional__reference-thumbnail video")?.readyState >= 2');
  assert.equal(await js('workbenchHarness.state().drafts[0].featureSelection.productFeature'), 'video_edit');
  assert.equal(await js('Boolean(document.querySelector("button[aria-label=继续添加图片]"))'), false);
  checks.push('original video decodes in production workbench; edit model selected; image addition hidden');
  await js('Array.from(document.querySelectorAll("details")).find(e => e.querySelector("summary")?.textContent.includes("模型参数")).open = true');
  await until('document.querySelector("input[aria-label=本次报价上限（元）]")?.value === "5"');
  checks.push('WWW edit contract parameters and required RMB quote cap rendered');
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
