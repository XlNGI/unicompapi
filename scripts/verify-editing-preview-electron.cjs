const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const framesOnly = process.argv.includes('--frames-only');
const label = before ? 'before' : framesOnly ? 'frames' : 'after';
const output = path.join(root, 'outputs/editing-preview-fix', label);
const checks = [];
const report = { checks };
app.setPath('userData', path.join(os.tmpdir(), `unicomp-editing-preview-${process.pid}`));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Deadline exceeded'); app.exit(1); }, 150000);
let window;
const js = source => window.webContents.executeJavaScript(source);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(source, limit = 20000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await js(source)) return; await delay(50); }
  throw new Error(`Timed out: ${source}`);
}
async function screenshot(name) { await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG()); }
async function click(text) {
  await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
const frameState = `Array.from(document.querySelectorAll('.uc-video-editor__seg')).map(s => ({
  poster: !!s.querySelector('.uc-video-editor__seg-poster')?.naturalWidth,
  slots: Array.from(s.querySelectorAll('.uc-video-editor__thumbnail')).map(e => {
    const i = e.querySelector('img'); const r = e.getBoundingClientRect(); const ir = i?.getBoundingClientRect();
    return { loaded: !!i?.naturalWidth, width: r.width, height: r.height, imageWidth: ir?.width, imageHeight: ir?.height, background: getComputedStyle(e).backgroundColor };
  })
}))`;
async function run() {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-editing-preview-build-'));
  const tooling = await import('./media-engine-common.mjs');
  const engine = await tooling.readMediaEngineManifest(root);
  const ffmpeg = tooling.resolveMediaEngineInstallation(root, engine).ffmpegPath;
  const fixtures = { videos: [], sheets: [] };
  for (const [index, size] of ['180x320', '320x180', '240x240'].entries()) {
    const video = path.join(temp, `${index}.mp4`), sheet = path.join(temp, `${index}.jpg`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=12`, '-t', '5', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', video]);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', 'fps=8,scale=160:264:force_original_aspect_ratio=increase,crop=160:264,tile=40x1', '-frames:v', '1', sheet]);
    fixtures.videos.push(`data:video/mp4;base64,${(await fs.readFile(video)).toString('base64')}`);
    fixtures.sheets.push((await fs.readFile(sheet)).toString('base64'));
  }
  await app.whenReady();
  await require('vite').build({ configFile: false, root, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: temp, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(root, 'tests/harness/video-editing-preview-harness.tsx'), formats: ['iife'], name: 'EditingHarness', fileName: () => 'harness.js' } } });
  await fs.writeFile(path.join(temp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script>window.editingFixtures=${JSON.stringify(fixtures)}</script><script src="harness.js"></script></body></html>`);
  window = new BrowserWindow({ show: true, width: 1280, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await window.loadFile(path.join(temp, 'index.html'));
  await until(`document.querySelectorAll('.uc-video-editor__seg').length === 3`);
  await until(`Array.from(document.querySelectorAll('.uc-video-editor__seg-poster')).length === 3`);
  report.initial = await js(frameState);
  await screenshot('timeline');
  report.initialRequests = await js('editingHarness.state()');
  checks.push({ name: 'three clips have visible decoded thumbnail cells', passed: report.initial.every(s => s.slots.length && s.slots.every(t => t.loaded && t.imageHeight > 0 && t.imageWidth > 0)) });
  await js('editingHarness.expire()');
  // A resize changes visible thumbnail slots, as scrolling/zooming does.
  window.setSize(1360, 850);
  await delay(2000);
  report.expired = await js('editingHarness.state()');
  checks.push({ name: 'expired contact sheets reacquired on viewport change', passed: report.expired.requests.length > report.initialRequests.requests.length });
  if (!before) {
    await until(`Array.from(document.querySelectorAll('.uc-video-editor__thumbnail img')).every(i => i.naturalWidth > 0)`);
    await js(`document.querySelector('.uc-video-editor__contact-sheet').src='data:image/jpeg;base64,broken'`);
    await until(`!document.querySelector('.uc-video-editor__thumbnail img[src="data:image/jpeg;base64,broken"]')`);
    await until(`Array.from(document.querySelectorAll('.uc-video-editor__seg'))[0].querySelectorAll('.uc-video-editor__thumbnail > img').length > 0`);
    checks.push({ name: 'image load error recovers with Canvas without re-request loop', passed: (await js('editingHarness.state()')).requests.length === report.expired.requests.length });
    for (let i = 0; i < 3; i++) await js(`document.querySelector('[aria-label="放大时间线"]').click()`);
    await js(`document.querySelector('.uc-video-editor__timeline-viewport').scrollLeft=600`);
    await until(`document.querySelector('.uc-video-editor__seg').querySelectorAll('.uc-video-editor__thumbnail > img').length > 0 && Array.from(document.querySelectorAll('.uc-video-editor__thumbnail img')).every(i => i.naturalWidth > 0)`);
    checks.push({ name: 'rapid zoom and horizontal scroll retain decoded visible frames', passed: await js(`document.querySelector('.uc-video-editor__timeline-viewport').scrollLeft > 0`) });
  }
  if (!framesOnly) {
    window.setSize(1280, 850);
    await click('导出');
    await until(`!!document.querySelector('.uc-video-editor__export-preview-video')?.videoWidth`);
    await js(`document.querySelector('.uc-video-editor__export-result').scrollIntoView({block:'end'})`);
    report.buttons = await js(`Array.from(document.querySelectorAll('.uc-video-editor__export-result .uc-video-editor__export-actions button')).map(e => { const r=e.getBoundingClientRect(); return {text:e.textContent, x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}; })`);
    checks.push({ name: 'result buttons share one row with complete labels', passed: report.buttons.length === 2 && Math.abs(report.buttons[0].y - report.buttons[1].y) < 2 && report.buttons.every(b => b.scrollWidth <= b.clientWidth) });
    await screenshot('buttons');
    report.expanded = [];
    for (const index of [0, 1, 2]) {
      await js(`(() => { const v=document.querySelector('.uc-video-editor__export-preview-video');v.src=editingHarness.video(${index});v.muted=true; })()`);
      await until(`document.querySelector('.uc-video-editor__export-preview-video').readyState >= 2`);
      await js(`document.querySelector('.uc-video-editor__export-preview-video').currentTime=1`);
      await until(`!document.querySelector('.uc-video-editor__export-preview-video').seeking && Math.abs(document.querySelector('.uc-video-editor__export-preview-video').currentTime-1)<0.1`);
      await js(`document.querySelector('.uc-video-editor__export-preview-fullscreen').click()`);
      await delay(100);
      const geometry = await js(`(() => {const v=document.querySelector('.uc-video-editor__export-preview-video'); const r=v.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right,viewportHeight:innerHeight,viewportWidth:innerWidth,fit:getComputedStyle(v).objectFit,sourceWidth:v.videoWidth,sourceHeight:v.videoHeight,time:v.currentTime};})()`);
      report.expanded.push(geometry);
      checks.push({ name: `expanded aspect ${index} fits viewport without losing position`, passed: geometry.bottom <= geometry.viewportHeight && geometry.top >= 0 && geometry.right <= geometry.viewportWidth && geometry.left >= 0 && geometry.fit === 'contain' && Math.abs(geometry.time - 1) < 0.1 });
      await screenshot(`expanded-${index}`);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
      await until(`!document.querySelector('.uc-video-editor__export-preview--expanded')`);
      assert.notEqual(await js('document.body.style.overflow'), 'hidden');
    }
    if (!before) {
      await js(`document.querySelector('.uc-video-editor__export-preview-video').play()`);
      const startTime = await js(`document.querySelector('.uc-video-editor__export-preview-video').currentTime`);
      await js(`document.querySelector('.uc-video-editor__export-preview-fullscreen').click()`);
      await until(`document.querySelector('.uc-video-editor__export-preview-video').currentTime > ${startTime + 0.1}`);
      await js(`document.querySelector('.uc-video-editor__export-preview-fullscreen').click()`);
      checks.push({ name: 'playing video stays playing across expand and collapse', passed: await js(`!document.querySelector('.uc-video-editor__export-preview-video').paused`) });
      await js(`document.querySelector('.uc-video-editor__export-preview-video').pause()`);
      report.responsive = [];
      for (const theme of ['light', 'dark']) {
        await js(`editingHarness.theme('${theme}')`);
        await until(`document.documentElement.dataset.theme === '${theme}' && document.body.classList.contains('rs-theme-${theme}')`);
        for (const width of [1079, 1295, 1440]) {
          window.setSize(width, 850);
          await delay(100);
          const state = await js(`(() => {const buttons=Array.from(document.querySelectorAll('.uc-video-editor__export-result .uc-video-editor__export-actions button'));const r=buttons.map(b=>b.getBoundingClientRect());const p=buttons[0].parentElement.getBoundingClientRect();return {sameRow:Math.abs(r[0].y-r[1].y)<2,contained:r[1].right<=p.right+1,labelsFit:buttons.every(b=>b.scrollWidth<=b.clientWidth)};})()`);
          report.responsive.push({theme,width,...state});
          checks.push({name:`buttons ${theme} ${width}px`,passed:state.sameRow && state.contained && state.labelsFit});
        }
      }
      await click('在文件管理器中定位');
      await click('打开作品库');
      checks.push({name:'result actions retain reveal and library destinations',passed:(await js('editingHarness.state()')).navigation.join(',') === 'reveal,library'});
      await js(`editingHarness.theme('light')`);
      await until(`document.body.classList.contains('rs-theme-light')`);
      window.setSize(1295,850);
      await js(`document.querySelector('.uc-video-editor__export-result').scrollIntoView({block:'end'})`);
      await delay(100);
      await screenshot('light-result');
    }
  }
  await js('editingHarness.reset(true, false)');
  await until(`document.querySelectorAll('.uc-video-editor__seg-poster').length === 3`);
  await until(`(() => {
    const segments = Array.from(document.querySelectorAll('.uc-video-editor__seg'));
    return segments.length === 3 && segments.every(segment => {
      const slots = Array.from(segment.querySelectorAll('.uc-video-editor__thumbnail'));
      return slots.length > 0 && slots.every(slot => slot.querySelector('img')?.naturalWidth > 0);
    });
  })()`);
  report.fallback = await js(frameState);
  checks.push({ name: 'contact sheet unavailable uses decoded video frames', passed: report.fallback.every(s => s.slots.length && s.slots.every(t => t.loaded)) });
  await js('editingHarness.reset(true, true)');
  await until(`document.querySelectorAll('.uc-video-editor__seg').length === 3 && document.querySelectorAll('.uc-video-editor__seg-poster').length === 0`);
  await delay(150);
  checks.push({ name: 'missing frames never draw opaque empty thumbnail slots', passed: await js(`document.querySelectorAll('.uc-video-editor__thumbnail').length === 0`) });
  await screenshot('unavailable');
  report.final = await js('editingHarness.state()');
  checks.push({ name: 'no draft writes or mutation', passed: report.final.writes === 0 && report.final.draftUnchanged });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks, evidence: path.relative(root, output) }));
  if (!before) assert.ok(checks.every(c => c.passed), 'Preview acceptance failed');
}
run().then(() => {clearTimeout(deadline);app.exit(0);}).catch(async error => {
  report.error = String(error);
  await fs.mkdir(output, {recursive:true});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report,null,2));
  console.error(error);clearTimeout(deadline);app.exit(1);
});
