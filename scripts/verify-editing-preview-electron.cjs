const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, protocol } = require('electron');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const realIdle = process.argv.includes('--real-idle');
const staticIdle = process.argv.includes('--static-idle');
const exportIdle = process.argv.includes('--export-idle');
const framesOnly = process.argv.includes('--frames-only');
const label = before ? 'before' : framesOnly ? 'frames' : 'after';
const output = path.join(root, realIdle ? 'outputs/editing-real-idle' : staticIdle ? 'outputs/editing-static-idle' : exportIdle ? 'outputs/editing-export-idle' : 'outputs/editing-preview-fix', label);
if (staticIdle || realIdle) protocol.registerSchemesAsPrivileged([{scheme:'unicomp-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
let staticExpired = false;
const checks = [];
const report = { checks };
app.setPath('userData', path.join(os.tmpdir(), `unicomp-editing-preview-${process.pid}`));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Deadline exceeded'); app.exit(1); }, realIdle ? 1_380_000 : 150000);
let window;
const js = source => window.webContents.executeJavaScript(source);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(source, limit = 20000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await js(source)) return; await delay(50); }
  throw new Error(`Timed out: ${source}`);
}
async function screenshot(name) { await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG()); }
async function clearImages() {
  await js(`document.querySelector('[aria-label="预览缩放"]').click()`);
  await js(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='清除预览缓存').click()`);
}
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
  const fixtures = { videos: [], sheets: [], controlledMedia: realIdle };
  for (const [index, size] of ['180x320', '320x180', '240x240'].entries()) {
    const video = path.join(temp, `${index}.mp4`), sheet = path.join(temp, `${index}.jpg`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=12`, '-t', '5', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', video]);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', 'fps=8,scale=160:264:force_original_aspect_ratio=increase,crop=160:264,tile=40x1', '-frames:v', '1', sheet]);
    fixtures.videos.push(`data:video/mp4;base64,${(await fs.readFile(video)).toString('base64')}`);
    fixtures.sheets.push((await fs.readFile(sheet)).toString('base64'));
  }
  if (realIdle) {
    await require(require.resolve('esbuild',{paths:[require.resolve('vite')]})).build({
      entryPoints:[path.join(root,'electron/ipc/local-media-response.ts')],bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'media-response.cjs')});
  }
  await app.whenReady();
  if (realIdle) {
    const { createLocalMediaResponse } = require(path.join(temp,'media-response.cjs'));
    protocol.handle('unicomp-media', async request => {
      const url = new URL(request.url);
      const match = /^\/(video|sheet)-([0-2])-[a-z0-9-]+$/.exec(url.pathname);
      if (!match || Date.parse(url.searchParams.get('expires') ?? '') <= Date.now()) return new Response('expired',{status:404});
      return createLocalMediaResponse(path.join(temp,`${match[2]}.${match[1]==='video'?'mp4':'jpg'}`),match[1]==='video'?'video/mp4':'image/jpeg',request.method,request.headers.get('range') ?? undefined);
    });
  }
  if (staticIdle) {
    fixtures.sheetUrls = fixtures.sheets.map((_,i)=>`unicomp-media://local/sheet-${i}`);
    protocol.handle('unicomp-media', request => {
      const i=fixtures.sheetUrls.indexOf(request.url);
      return staticExpired || i<0 ? new Response('expired',{status:404}) : new Response(Buffer.from(fixtures.sheets[i],'base64'),{headers:{'Content-Type':'image/jpeg'}});
    });
  }
  await require('vite').build({ configFile: false, root, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: temp, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(root, 'tests/harness/video-editing-preview-harness.tsx'), formats: ['iife'], name: 'EditingHarness', fileName: () => 'harness.js' } } });
  await fs.writeFile(path.join(temp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script>window.editingFixtures=${JSON.stringify(fixtures)}</script><script src="harness.js"></script></body></html>`);
  window = new BrowserWindow({ show: true, width: 1280, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: realIdle } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await window.loadFile(path.join(temp, 'index.html'));
  await until(`document.querySelectorAll('.uc-video-editor__seg').length === 3`);
  await until(`Array.from(document.querySelectorAll('.uc-video-editor__seg-poster')).length === 3`);
  report.initial = await js(frameState);
  await screenshot('timeline');
  report.initialRequests = await js('editingHarness.state()');
  checks.push({ name: 'three clips have visible decoded thumbnail cells', passed: report.initial.every(s => s.slots.length && s.slots.every(t => t.loaded && t.imageHeight > 0 && t.imageWidth > 0)) });
  const staticImages = `Array.from(document.querySelectorAll('.uc-video-editor__seg-poster,.uc-video-editor__media-frame img,.uc-video-editor__contact-sheet')).map(i=>({src:i.src,loaded:i.naturalWidth>0}))`;
  const beforeStatic = await js(staticImages);
  if (realIdle) {
    await click('导出');
    await until(`document.querySelector('.uc-video-editor__export-preview-video')?.readyState>=2`);
    await js(`window.realTimeline=document.querySelector('video[aria-label="时间线预览"]');window.realExport=document.querySelector('.uc-video-editor__export-preview-video');document.querySelector('.uc-video-editor__transport-play').click()`);
    await until('realTimeline.currentTime>1');
    await js(`document.querySelector('.uc-video-editor__transport-play').click();void realExport.play()`);
    await until('realExport.currentTime>1');
    await js('realExport.pause()');
    const before = await js(`({timeline:realTimeline.currentTime,export:realExport.currentTime,timelineUrl:realTimeline.src,exportUrl:realExport.src,state:editingHarness.state()})`);
    report.beforeIdle=before;
    report.idleStartedAt=new Date().toISOString();
    await screenshot('before-idle');
    const started=Date.now();
    window.minimize();
    window.hide();
    window.once('closed', () => {
      report.windowClosedAt = new Date().toISOString();
      void fs.writeFile(path.join(output,'window-closed.json'),JSON.stringify({at:report.windowClosedAt}));
    });
    console.log('Real idle started:',report.idleStartedAt);
    await fs.writeFile(path.join(output,'progress.json'),JSON.stringify({startedAt:report.idleStartedAt,requiredMs:1_210_000}));
    while(Date.now()-started<1_210_000) {
      if (window.isDestroyed()) throw new Error('Idle test window closed before resume validation');
      await delay(Math.min(30_000,1_210_000-(Date.now()-started)));
    }
    report.actualIdleMs=Date.now()-started;
    if (window.isDestroyed()) throw new Error('Idle test window closed before resume validation');
    window.show();
    window.restore();
    await delay(500);
    const afterImages=await js(staticImages);
    report.afterImages=afterImages;
    checks.push({name:'static thumbnails and posters survive real 20-minute background idle',passed:afterImages.length>0 && afterImages.every(i=>i.loaded && beforeStatic.some(old=>old.src===i.src)) && (await js('editingHarness.state()')).requests.length===before.state.requests.length});
    await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
    await until(`(()=>{const v=document.querySelector('video[aria-label="时间线预览"]');return !v.paused && v.currentTime>${before.timeline+0.15} && v.src!==${JSON.stringify(before.timelineUrl)}})()`);
    checks.push({name:'timeline resumes at original position after real expired handle',passed:true});
    await js(`document.querySelector('.uc-video-editor__transport-play').click();void realExport.play().catch(()=>{})`);
    await until(`!realExport.paused && realExport.currentTime>${before.export+0.15} && realExport.src!==${JSON.stringify(before.exportUrl)}`);
    checks.push({name:'export result resumes at original position after real expired handle',passed:true});
    await js('realExport.pause()');
    checks.push({name:'actual elapsed idle exceeds 20 minutes without clock simulation',passed:report.actualIdleMs>=1_200_000});
    await screenshot('after-idle');
    report.boundary='Windows Electron minimized and hidden for actual elapsed time; real local media protocol, 5-minute TTL and production Range response; synthetic files and isolated IPC, no user project writes, no sleep/lock test.';
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    assert.ok(checks.every(c=>c.passed));
    console.log(JSON.stringify({checks,actualIdleMs:report.actualIdleMs,evidence:output}));
    return;
  }
  if (!exportIdle) await js(`editingHarness.expire(${staticIdle ? 1201000 : 301000})`);
  if (staticIdle) staticExpired = true;
  // A resize changes visible thumbnail slots, as scrolling/zooming does.
  window.setSize(1360, 850);
  await delay(2000);
  report.expired = await js('editingHarness.state()');
  if (!exportIdle) checks.push({ name: 'static sheets do not reload when playback handles expire', passed: report.expired.requests.length === report.initialRequests.requests.length });
  if (staticIdle) {
    report.staticBefore = beforeStatic;
    report.staticAfter = await js(staticImages);
    checks.push({name:'loaded thumbnails and posters keep their original URLs after 20-minute simulated expiry',passed:report.staticAfter.length>0 && report.staticAfter.every(i=>i.loaded && beforeStatic.some(old=>old.src===i.src))});
    await js('editingHarness.reset()');
    await until(`document.querySelectorAll('.uc-video-editor__contact-sheet').length>0 && Array.from(document.querySelectorAll('.uc-video-editor__seg-poster')).length===3`);
    await delay(500);
    const remounted=await js(staticImages);
    checks.push({name:'editor remount reuses loaded sheets and posters without regeneration',passed:remounted.every(i=>i.loaded && beforeStatic.some(old=>old.src===i.src)) && (await js('editingHarness.state()')).requests.length===report.initialRequests.requests.length});
    staticExpired=false;
    await clearImages();
    await until(`editingHarness.state().requests.length>${report.initialRequests.requests.length} && document.querySelectorAll('.uc-video-editor__seg-poster').length===3 && document.querySelectorAll('.uc-video-editor__contact-sheet').length>0`);
    checks.push({name:'explicit clear regenerates static images',passed:(await js(staticImages)).some(i=>!beforeStatic.some(old=>old.src===i.src))});
    report.boundary='Synthetic media, actual Chromium image decode, simulated 20-minute handle expiry; no real elapsed 20-minute or sleep validation.';
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    assert.ok(checks.every(c=>c.passed));
    console.log(JSON.stringify({checks,evidence:output}));
    return;
  }
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
    if (exportIdle) {
      await delay(250);
      const v = `document.querySelector('.uc-video-editor__export-preview-video')`;
      await js(`window.exportVideo=${v}; exportVideo.currentTime=1;exportVideo.volume=0.35;exportVideo.playbackRate=0.75`);
      await until(`!exportVideo.seeking && exportVideo.currentTime>=1`);
      const oldUrl=await js('exportVideo.src');
      await js('editingHarness.expire();void exportVideo.play().catch(()=>{})');
      await until(`exportVideo.src!==${JSON.stringify(oldUrl)} && !exportVideo.paused && exportVideo.currentTime>1.15`, 12000);
      checks.push({name:'expired export URL replaced and playback resumes at saved position',passed:true});
      checks.push({name:'volume and speed survive recovery',passed:await js('exportVideo.volume===0.35 && exportVideo.playbackRate===0.75')});
      await js('exportVideo.pause()');
      const count=await js('editingHarness.state().workRequests');
      await js(`exportVideo.currentTime=0.5;window.originalExportPlay=HTMLMediaElement.prototype.play;window.freezeExport=true;HTMLMediaElement.prototype.play=function(){if(this===exportVideo && window.freezeExport){window.freezeExport=false;this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('playing'));return Promise.resolve()}return window.originalExportPlay.call(this)};void exportVideo.play()`);
      await until(`editingHarness.state().workRequests===${count+1} && !exportVideo.paused && exportVideo.currentTime>0.7`, 12000);
      checks.push({name:'playing without progress recovers even when valid Work URL is reused',passed:true});
      await js('HTMLMediaElement.prototype.play=window.originalExportPlay;exportVideo.pause();editingHarness.failWorkMedia(true);editingHarness.expire();void exportVideo.play().catch(()=>{})');
      await until(`!!document.querySelector('[role="alert"][data-export-preview-error]')`,15000);
      const failedCount=await js('editingHarness.state().workRequests');
      await delay(4500);
      checks.push({name:'persistent failure stops with visible retry and no request loop',passed:await js(`editingHarness.state().workRequests===${failedCount} && exportVideo.paused`)});
      await js(`editingHarness.failWorkMedia(false);document.querySelector('[data-export-preview-error] button').click()`);
      await until('!exportVideo.paused && exportVideo.currentTime>0.9');
      checks.push({name:'explicit retry restores playback',passed:true});
      await js('exportVideo.pause();editingHarness.delayWorkMedia(800);editingHarness.expire();void exportVideo.play().catch(()=>{})');
      await delay(150);
      await js('exportVideo.pause()');
      await delay(1300);
      checks.push({name:'user pause during handle request prevents automatic resume',passed:await js('exportVideo.paused')});
      await js('editingHarness.delayWorkMedia(0)');
      await click('画面');
      await js('editingHarness.expire()');
      await click('导出');
      await until(`${v}?.readyState>=2 && !${v}.seeking`);
      checks.push({name:'opening export inspector with expired URL recovers without autoplay',passed:await js(`${v}.paused`)});
      report.boundary='Real React/Chromium with synthetic media and simulated expiry; not real Windows 20-minute idle or sleep.';
      await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
      assert.ok(checks.every(c=>c.passed));
      console.log(JSON.stringify(report));
      return;
    }
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
  await until(`!!document.querySelector('[aria-label="预览缩放"]')`);
  await clearImages();
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
  await until(`!!document.querySelector('[aria-label="预览缩放"]')`);
  await clearImages();
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
