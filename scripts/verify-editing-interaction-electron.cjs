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
const output = path.join(root, 'outputs/editing-interaction-fix', before ? 'before' : 'after');
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
  window = new BrowserWindow({ show: true, width: 1720, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await window.loadFile(path.join(temp, 'index.html'));
  await until(`document.querySelectorAll('.uc-video-editor__seg').length === 3`);
  await until(`Array.from(document.querySelectorAll('.uc-video-editor__seg-poster')).length === 3`);
  await until(`document.querySelector('video[aria-label="时间线预览"]')?.readyState>=2 && !document.querySelector('video[aria-label="时间线预览"]').seeking`);
  const snapshot = `(()=>{const v=document.querySelector('video[aria-label="时间线预览"]');return {clip:v.dataset.previewClipId,time:v.currentTime,paused:v.paused,seeking:v.seeking,readyState:v.readyState,error:v.error?.code??null,button:document.querySelector('.uc-video-editor__transport-play').getAttribute('aria-label'),label:document.querySelector('.uc-video-editor__transport-time').textContent,held:getComputedStyle(document.querySelector('.uc-video-editor__stage-frame')).visibility};})()`;
  const geometry = `(() => {const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}};return {page:rect('main'),timeline:rect('.uc-video-editor__timeline'),heading:rect('.uc-video-editor__timeline-heading'),ruler:rect('.uc-video-editor__ruler'),button:rect('.uc-video-editor__transport-play'),transport:rect('.uc-video-editor__transport'),rootHeight:document.documentElement.scrollHeight}})()`;
  report.geometry=await js(geometry);
  report.menus=[];
  for (const label of ['预览缩放','画布比例']) {
    await js(`document.querySelector('[aria-label="${label}"]').click()`);
    await delay(150);
    report.menus.push({label, geometry:await js(geometry), menu:await js(`Array.from(document.querySelectorAll('.rs-dropdown-menu')).filter(e=>e.getBoundingClientRect().height>0).map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,viewport:innerHeight}})`) });
    await screenshot(label==='预览缩放'?'zoom-menu':'ratio-menu');
    await js(`document.querySelector('[aria-label="${label}"]').click()`);
  }
  checks.push({name:'menus do not grow document or timeline scroll height',passed:report.menus.every(m=>m.geometry.rootHeight===report.geometry.rootHeight && m.geometry.timeline.scrollHeight===report.geometry.timeline.scrollHeight)});
  checks.push({name:'all three tracks fit without vertical overflow',passed:report.geometry.timeline.scrollHeight<=report.geometry.timeline.clientHeight});
  checks.push({name:'ruler immediately follows toolbar',passed:Math.abs(report.geometry.ruler.y-report.geometry.heading.bottom)<=1});
  await js(`window.diagEvents=[]; for(const e of ['play','playing','pause','waiting','stalled','error','ended','seeking','seeked']) document.addEventListener(e,event=>{if(event.target.matches?.('video[aria-label="时间线预览"]'))window.diagEvents.push({event:e,at:performance.now(),clip:event.target.dataset.previewClipId,time:event.target.currentTime,paused:event.target.paused});},true)`);
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  report.clicked=await js(snapshot);
  report.internalText=await js(`!!document.querySelector('.uc-video-editor__transport-status')`);
  checks.push({name:'no preparation text overlays play button',passed:!report.internalText});
  await until(`document.querySelector('video[aria-label="时间线预览"]').currentTime > 0.4`);
  report.started=await js(snapshot);
  await js(`document.querySelector('video[aria-label="时间线预览"]').pause()`);
  await delay(100);
  report.mediaPause=await js(snapshot);
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  await delay(600);
  report.afterFirstClick=await js(snapshot);
  checks.push({name:'unexpected pause resumes with one click',passed:!report.afterFirstClick.paused && report.afterFirstClick.time>report.mediaPause.time+0.1});
  if (report.afterFirstClick.paused) await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  await until(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId==='clip-1' && document.querySelector('video[aria-label="时间线预览"]').currentTime>0.2`);
  report.crossClip=await js(snapshot);
  await until(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId==='clip-2' && document.querySelector('video[aria-label="时间线预览"]').currentTime>0.2`);
  await js(`(() => { const v=document.querySelector('video[aria-label="时间线预览"]'); v.currentTime=Math.max(0,v.duration-0.08); })()`);
  await until(`document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('.uc-video-editor__transport-play').getAttribute('aria-label')==='播放时间线'`, 12000);
  report.ended = await js(snapshot);
  checks.push({name:'natural end stops at the timeline end',passed:report.ended.paused && report.ended.button==='播放时间线' && report.ended.label.startsWith('00:15')});
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  await until(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId==='clip-0' && document.querySelector('video[aria-label="时间线预览"]').currentTime<0.25`, 12000);
  report.replayed = await js(snapshot);
  checks.push({name:'first click after natural end replays from zero',passed:!report.replayed.paused && report.replayed.clip==='clip-0' && report.replayed.time<0.25});
  report.events=await js('diagEvents');
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  await screenshot('timeline');
  report.final=await js('editingHarness.state()');
  checks.push({name:'isolated fixture only, zero draft writes',passed:report.final.writes===0 && report.final.draftUnchanged});
  report.boundary='Real React and Chromium decoder, synthetic local media and isolated IPC; no real project writes.';
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks,normalCrossClip:report.normalCrossClip,mediaPause:report.mediaPause,afterIdle:report.afterIdle,afterSecondClick:report.afterSecondClick,evidence:output}));
  if (!before) assert.ok(checks.every(c=>c.passed));
}
run().then(()=>{clearTimeout(deadline);app.exit(0)}).catch(async error=>{report.error=String(error);await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error(error);clearTimeout(deadline);app.exit(1)});
