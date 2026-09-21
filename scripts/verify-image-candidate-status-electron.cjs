const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'outputs', 'image-candidate-status');
app.setPath('userData', path.join(os.tmpdir(), `unicomp-image-status-${process.pid}`));
app.disableHardwareAcceleration();
const checks = [];
const errors = [];
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source);
async function until(source) {
  for (let n = 0; n < 100; n++) { if (await js(source)) return; await delay(30); }
  throw new Error(`Timed out: ${source}`);
}
async function configure(value) { await js(`imageHarness.configure(${JSON.stringify(value)})`); await delay(100); }
async function textIncludes(value) { await until(`document.body.textContent.includes(${JSON.stringify(value)})`); }
async function run() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  const build = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-image-status-build-'));
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: build, emptyOutDir: true, rollupOptions: { onwarn(w, warn) { if(w.code !== 'MODULE_LEVEL_DIRECTIVE') warn(w); } },
      lib: { entry: path.join(workspace, 'tests/harness/image-candidate-status-harness.tsx'), formats: ['iife'], name: 'ImageHarness', fileName: () => 'harness.js' } } });
  await fs.writeFile(path.join(build, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, level, message) => { if(level >= 3) errors.push(message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_r, done) => done({cancel:true}));
  await win.loadFile(path.join(build, 'index.html'));
  await textIncludes('模型读取失败');
  assert.equal(await js('document.body.textContent.includes("尚未配置可用模型")'), false);
  assert.equal(await js('document.body.textContent.includes("sk-secret")'), false);
  checks.push('IPC failure is distinct from empty results and hides raw errors');
  await fs.writeFile(path.join(output,'failed.png'),(await win.webContents.capturePage()).toPNG());
  await js('imageHarness.response("ready"); Array.from(document.querySelectorAll(".uc-image-feature-panel button")).find(b=>b.textContent.includes("重试读取")).click()');
  await textIncludes('请选择模型');
  await until('document.querySelector("[role=combobox]")?.getAttribute("aria-disabled") !== "true"');
  checks.push('retry recovers candidates');
  const before = await js('imageHarness.state().requests');
  await configure({ emptyPrompt:true }); await textIncludes('请输入提示词');
  assert.equal(await js('imageHarness.state().requests'), before);
  await configure({ reference:true, emptyPrompt:true }); await textIncludes('请输入提示词，并添加一张参考图');
  await configure({ reference:true }); await textIncludes('请添加一张参考图');
  assert.equal(await js('imageHarness.state().requests'), before);
  checks.push('missing prompt and image skip candidate IPC and show a single input warning');
  await fs.writeFile(path.join(output,'required.png'),(await win.webContents.capturePage()).toPNG());
  await configure({reference:true,image:true,response:'empty'}); await textIncludes('暂无可用的图生图模型');
  assert.equal(await js('document.querySelectorAll(".uc-image-quick__preflight").length'),1);
  await fs.writeFile(path.join(output,'empty.png'),(await win.webContents.capturePage()).toPNG());
  await js('Array.from(document.querySelectorAll(".uc-image-feature-panel button")).find(b=>b.textContent.trim()==="模型与服务商").click()');
  await until('imageHarness.state().navigations === 1');
  checks.push('valid image input with zero matches explains current feature and offers navigation after flush');
  await configure({response:'empty',flushAllowed:false}); await textIncludes('暂无可用的文生图模型');
  await js('Array.from(document.querySelectorAll(".uc-image-feature-panel button")).find(b=>b.textContent.trim()==="模型与服务商").click()');
  await delay(100); assert.equal(await js('imageHarness.state().navigations'),1);
  checks.push('failed save blocks navigation');
  await configure({response:'throw'}); await textIncludes('模型读取失败');
  await configure({response:'unavailable',selected:true}); await textIncludes('连接不可用');
  assert.equal(await js('document.querySelector(".uc-image-feature-panel__primary").disabled'),true);
  checks.push('exception and unavailable candidate remain distinct');
  await configure({response:'slow',id:'old'});
  await configure({response:'empty',reference:true,image:true,id:'new'}); await textIncludes('暂无可用的图生图模型');
  await js('imageHarness.resolve()'); await delay(100); await textIncludes('暂无可用的图生图模型');
  checks.push('late response from old draft cannot overwrite new mode');
  await configure({selected:true}); await textIncludes('Fixture image');
  await configure({selected:true,dirty:true}); await textIncludes('正在保存');
  assert.equal(await js('document.body.textContent.includes("Fixture image")'),true);
  assert.equal(await js('document.querySelector(".uc-image-feature-panel__primary").disabled'),true);
  checks.push('editing retains selection while generation waits for saved candidates');
  await configure({blocked:'请先清理旧上下文'}); await textIncludes('当前不能生成');
  for (const config of [{workspace:true}, {workspace:true,professional:true}, {workspace:true,reference:true,image:true}]) {
    await configure({...config,response:'failed'}); await textIncludes('模型读取失败');
    await js('imageHarness.response("empty"); Array.from(document.querySelectorAll(".uc-image-feature-panel button")).find(b=>b.textContent.includes("重试读取")).click()');
    await textIncludes(config.reference ? '暂无可用的图生图模型' : '暂无可用的文生图模型');
    assert.equal(await js('document.querySelectorAll(".uc-image-quick__preflight").length'),1);
    const label = config.reference ? 'professional-reference' : config.professional ? 'professional-text' : 'quick';
    await fs.writeFile(path.join(output,`${label}.png`),(await win.webContents.capturePage()).toPNG());
    await js('Array.from(document.querySelectorAll(".uc-image-feature-panel button")).find(b=>b.textContent.trim()==="模型与服务商").click()');
  }
  assert.equal(await js('imageHarness.state().navigations'),4);
  checks.push('real quick and professional workspaces share failure, retry, feature-specific empty state and navigation');
  win.setSize(1024,768); await delay(150);
  await js('document.querySelector(".uc-image-quick__preflight").scrollIntoView({block:"center"})');
  await delay(150);
  await fs.writeFile(path.join(output,'professional-narrow.png'),(await win.webContents.capturePage()).toPNG());
  await configure({workspace:true,selected:true}); await textIncludes('Fixture image');
  await js(`(() => {
    const input=document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'New prompt');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await textIncludes('正在保存');
  assert.equal(await js('imageHarness.state().draft.featureSelection.candidateId'),'candidate');
  checks.push('editing the actual quick prompt preserves the selected candidate');
  await configure({response:'parameters',selected:true,professional:true});
  await textIncludes('请修正模型参数');
  assert.equal(await js('document.querySelectorAll(".uc-image-quick__preflight").length'),1);
  assert.equal(await js('document.querySelector(".uc-image-feature-panel__primary").disabled'),true);
  await configure({selected:true}); await textIncludes('Fixture image');
  assert.equal(await js('document.querySelector(".uc-image-feature-panel__primary").disabled'),false);
  checks.push('required parameter errors block generation; a valid selected model enables it');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,scope:'Real shared image submission component in AppLayout; synthetic IPC, no provider requests'},null,2));
  console.log(JSON.stringify({checks,errors},null,2));
}
const timer=setTimeout(()=>{console.error('Image status deadline');app.exit(1);},90000);
run().then(()=>finish(0),e=>{console.error(e);return finish(1);});
async function finish(code){clearTimeout(timer);if(win)win.destroy();app.exit(code);}
