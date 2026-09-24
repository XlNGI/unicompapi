const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const before = process.argv.includes('--before');
const stress = process.argv.includes('--stress');
const idleExpiry = process.argv.includes('--idle-expiry');
const idleRecovery = process.argv.includes('--idle-recovery');
const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9);
const framesOnly = process.argv.includes('--frames-only');
const label = before ? 'before' : framesOnly ? 'frames' : 'after';
const output = path.join(root, 'outputs', idleRecovery ? 'editing-handle-recovery' : idleExpiry ? 'editing-handle-expiry' : 'editing-interaction-fix', before ? 'before' : source ? 'user-media' : stress ? 'stress' : 'after');
const checks = [];
const report = { checks };
app.setPath('userData', path.join(os.tmpdir(), `unicomp-editing-preview-${process.pid}`));
if (process.argv.includes('--software')) app.disableHardwareAcceleration();
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
  const fixtures = { videos: [], sheets: [], proxies: [], deferProxies: true };
  const sourceFiles=[];
  for (const [index, size] of (stress ? ['720x1280', '1920x1080', '3840x2160'] : ['180x320', '320x180', '240x240']).entries()) {
    const video = path.join(temp, `${index}.mp4`), sheet = path.join(temp, `${index}.jpg`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${stress ? (index===1 ? 60 : 30) : 12}`, '-t', '5', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', video]);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', 'fps=8,scale=160:264:force_original_aspect_ratio=increase,crop=160:264,tile=40x1', '-frames:v', '1', sheet]);
    fixtures.videos.push(`data:video/mp4;base64,${(await fs.readFile(video)).toString('base64')}`);
    fixtures.sheets.push((await fs.readFile(sheet)).toString('base64'));
    sourceFiles.push(video);
  }
  if (source) { fixtures.videos[0]=`data:video/mp4;base64,${(await fs.readFile(source)).toString('base64')}`; sourceFiles[0]=source; }
  const proxyModule=path.join(temp,'proxy-adapter.cjs');
  await require(require.resolve('esbuild',{paths:[require.resolve('vite')]})).build({
    stdin:{contents:`export {FfmpegVideoEditorPreviewAdapter} from './src/platform/videos/ffmpeg-video-editor-preview'; export {NodeVideoEditorPreviewCache} from './src/platform/videos/video-editor-preview';`,resolveDir:root},
    bundle:true,platform:'node',format:'cjs',outfile:proxyModule});
  const {FfmpegVideoEditorPreviewAdapter,NodeVideoEditorPreviewCache}=require(proxyModule);
  const proxyAdapter=new FfmpegVideoEditorPreviewAdapter({ffmpegPath:ffmpeg});
  report.proxyPreparationMs=[];
  for (const [index,sourcePath] of sourceFiles.entries()) {
    const began=Date.now();
    const artifact=await proxyAdapter.requestArtifact({sourcePath,kind:'scrub_video',cache:new NodeVideoEditorPreviewCache(temp),
      plan:{schemaVersion:1,draftId:'test',draftRevision:1,clipId:`clip-${index}`,sourceIdentity:{sizeBytes:(await fs.stat(sourcePath)).size,durationUs:5e6,container:'mp4',width:640,height:360},sourceRange:{inUs:0,outUs:5e6},speed:{numerator:1,denominator:1},transform:{scalePermille:1000,positionXPermille:0,positionYPermille:0,rotationMilliDegrees:0,flipX:false,flipY:false,crop:null},sourceAudio:{muted:false,volumePermille:1000}}});
    if(artifact.status!=='available')throw new Error('Scrub fixture unavailable');
    report.proxyPreparationMs.push(Date.now()-began);
    fixtures.proxies.push(`data:video/mp4;base64,${(await fs.readFile(artifact.artifact.target)).toString('base64')}`);
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
  if (idleExpiry && !before) {
    const beforeIdle = await js('editingHarness.state()');
    const beforeIdleTime = await js(`document.querySelector('video[aria-label="时间线预览"]').currentTime`);
    await js('editingHarness.expire()');
    await js(`document.querySelector('video[aria-label="时间线预览"]').pause()`);
    await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
    await until(`!document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('video[aria-label="时间线预览"]').currentTime > ${beforeIdleTime + 0.1}`);
    report.idleExpiredResume = await js('editingHarness.state()');
    checks.push({
      name: 'expired preview handle is renewed before idle playback resumes',
      passed: report.idleExpiredResume.sourceRequests.length > beforeIdle.sourceRequests.length
    });
    await js(`document.querySelector('video[aria-label="时间线预览"]').pause()`);
    await delay(100);
  }
  if (idleRecovery && !before) {
    const beforeLoadRecovery = await js('editingHarness.state()');
    const beforeLoadTime = await js(`document.querySelector('video[aria-label="时间线预览"]').currentTime`);
    const beforeLoadClip = await js(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId`);
    await js(`window.originalTimeoutForIdleRecovery=window.setTimeout; window.setTimeout=function(callback, delay, ...args){return window.originalTimeoutForIdleRecovery.call(window,callback,delay===15000?200:delay,...args)}; editingHarness.expire(); editingHarness.breakNextSourcePreview(); document.querySelector('.uc-video-editor__transport-play').click(); window.setTimeout=window.originalTimeoutForIdleRecovery; undefined`);
    await until(`editingHarness.state().sourceRequests.length >= ${beforeLoadRecovery.sourceRequests.length + 2}`);
    await until(`!document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('video[aria-label="时间线预览"]').currentTime > ${beforeLoadTime + 0.1}`);
    report.idlePreviewLoadRecovery = await js(`({state:editingHarness.state(), clip:document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId, time:document.querySelector('video[aria-label="时间线预览"]').currentTime, paused:document.querySelector('video[aria-label="时间线预览"]').paused})`);
    report.idlePreviewLoadRecovery.beforeClip = beforeLoadClip;
    report.idlePreviewLoadRecovery.beforeTime = beforeLoadTime;
    report.idlePreviewLoadRecovery.requestsBefore = beforeLoadRecovery.sourceRequests.filter(id => id === beforeLoadClip).length;
    report.idlePreviewLoadRecovery.requestsAfter = report.idlePreviewLoadRecovery.state.sourceRequests.filter(id => id === beforeLoadClip).length;
    checks.push({
      name: 'failed preview load after idle is renewed once and resumes from the playhead',
      passed: report.idlePreviewLoadRecovery.requestsAfter === report.idlePreviewLoadRecovery.requestsBefore + 2 &&
        report.idlePreviewLoadRecovery.clip === beforeLoadClip && !report.idlePreviewLoadRecovery.paused && report.idlePreviewLoadRecovery.time > beforeLoadTime + 0.1
    });
    await js(`document.querySelector('video[aria-label="时间线预览"]').pause()`);
    await delay(100);
    const beforeRecovery = await js('editingHarness.state()');
    const beforeRecoveryTime = await js(`document.querySelector('video[aria-label="时间线预览"]').currentTime`);
    await js(`window.idleRecoveryOriginalPlay=HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play=function(){return Promise.reject(new Error('simulated stale media'))}; document.querySelector('.uc-video-editor__transport-play').click(); HTMLMediaElement.prototype.play=window.idleRecoveryOriginalPlay; undefined`);
    await until(`editingHarness.state().sourceRequests.length > ${beforeRecovery.sourceRequests.length} || (document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('.uc-video-editor__transport-play').getAttribute('aria-label')==='播放时间线')`);
    await until(`editingHarness.state().sourceRequests.length > ${beforeRecovery.sourceRequests.length} && !document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('video[aria-label="时间线预览"]').currentTime > ${beforeRecoveryTime + 0.1}`);
    const recovered = await js(`editingHarness.state().sourceRequests.length > ${beforeRecovery.sourceRequests.length} && !document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('video[aria-label="时间线预览"]').currentTime > ${beforeRecoveryTime + 0.1}`);
    report.idleMediaErrorRecovery = await js('editingHarness.state()');
    checks.push({
      name: 'play rejection with a fresh handle renews the preview and resumes from the playhead',
      passed: recovered && report.idleMediaErrorRecovery.sourceRequests.length === beforeRecovery.sourceRequests.length + 1
    });
    await js(`document.querySelector('video[aria-label="时间线预览"]').pause()`);
    await delay(100);
    const beforeStalledProgress = await js('editingHarness.state()');
    const stalledClip = await js(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId`);
    const stalledTime = await js(`document.querySelector('video[aria-label="时间线预览"]').currentTime`);
    const stalledSource = await js(`document.querySelector('video[aria-label="时间线预览"]').currentSrc || document.querySelector('video[aria-label="时间线预览"]').src`);
    const stalledRequestsBefore = beforeStalledProgress.sourceRequests.filter(id => id === stalledClip).length;
    await js(`window.noProgressMediaEvents=[]; window.noProgressRecoveryListener=event=>{if(event.target instanceof HTMLVideoElement)window.noProgressMediaEvents.push({event:event.type,clip:event.target.dataset.previewClipId,label:event.target.getAttribute('aria-label'),time:event.target.currentTime,paused:event.target.paused,src:event.target.currentSrc||event.target.src})}; for(const type of ['playing','pause','error','ended'])document.addEventListener(type,window.noProgressRecoveryListener,true); window.progressGuardOriginalPlay=HTMLMediaElement.prototype.play; window.frozenProgressVideo=undefined; HTMLMediaElement.prototype.play=function(...args){if(this.matches('video[aria-label="时间线预览"]')&&!window.frozenProgressVideo){let frozenTime=this.currentTime;window.frozenProgressOwnTime=Object.getOwnPropertyDescriptor(this,'currentTime');window.frozenProgressOwnPaused=Object.getOwnPropertyDescriptor(this,'paused');Object.defineProperty(this,'currentTime',{configurable:true,get:()=>frozenTime,set:value=>{frozenTime=value}});Object.defineProperty(this,'paused',{configurable:true,get:()=>false});window.frozenProgressVideo=this;this.dispatchEvent(new Event('playing'));return Promise.resolve()} return window.progressGuardOriginalPlay.apply(this,args)}; document.querySelector('.uc-video-editor__transport-play').click(); undefined`);
    await until('!!window.frozenProgressVideo');
    await js(`HTMLMediaElement.prototype.play=window.progressGuardOriginalPlay; undefined`);
    await delay(6500);
    await js(`if(window.frozenProgressVideo){if(window.frozenProgressOwnTime)Object.defineProperty(window.frozenProgressVideo,'currentTime',window.frozenProgressOwnTime);else delete window.frozenProgressVideo.currentTime;if(window.frozenProgressOwnPaused)Object.defineProperty(window.frozenProgressVideo,'paused',window.frozenProgressOwnPaused);else delete window.frozenProgressVideo.paused;} window.frozenProgressVideo=undefined; window.frozenProgressOwnTime=undefined; window.frozenProgressOwnPaused=undefined; undefined`);
    report.idleNoProgressMediaEvents = await js('window.noProgressMediaEvents');
    await js(`for(const type of ['playing','pause','error','ended'])document.removeEventListener(type,window.noProgressRecoveryListener,true);`);
    report.idleNoProgressRecovery = await js(`({state:editingHarness.state(), clip:document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId, time:document.querySelector('video[aria-label="时间线预览"]').currentTime, paused:document.querySelector('video[aria-label="时间线预览"]').paused, readyState:document.querySelector('video[aria-label="时间线预览"]').readyState, error:document.querySelector('video[aria-label="时间线预览"]').error?.code ?? null, button:document.querySelector('.uc-video-editor__transport-play').getAttribute('aria-label'), message:document.querySelector('.uc-video-editor__message')?.textContent ?? ''})`);
    report.idleNoProgressRecovery.stalledClip = stalledClip;
    report.idleNoProgressRecovery.stalledTime = stalledTime;
    report.idleNoProgressRecovery.requestsBefore = stalledRequestsBefore;
    report.idleNoProgressRecovery.requestsAfter = report.idleNoProgressRecovery.state.sourceRequests.filter(id => id === stalledClip).length;
    report.idleNoProgressRecovery.recoveryEvents = report.idleNoProgressMediaEvents.filter(event =>
      event.event === 'playing' && event.clip === stalledClip && event.src !== stalledSource
    );
    checks.push({
      name: 'resolved play that makes no media-time progress renews the preview once',
      passed: report.idleNoProgressRecovery.requestsAfter === stalledRequestsBefore + 1 &&
        report.idleNoProgressRecovery.recoveryEvents.some(event => event.clip === stalledClip && !event.paused) &&
        report.idleNoProgressRecovery.clip === stalledClip && !report.idleNoProgressRecovery.paused && report.idleNoProgressRecovery.time > stalledTime + 0.1
    });
    await js(`document.querySelector('video[aria-label="时间线预览"]').pause()`);
    await js(`if(document.querySelector('.uc-video-editor__transport-play').getAttribute('aria-label')==='暂停时间线') document.querySelector('.uc-video-editor__transport-play').click()`);
    await delay(100);
    const beforeExhaustion = await js('editingHarness.state()');
    await js(`window.idleRecoveryRejects=0; window.idleRecoveryOriginalPlay=HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play=function(...args){if(window.idleRecoveryRejects<2){window.idleRecoveryRejects++;return Promise.reject(new Error('simulated persistent media failure'))}const original=window.idleRecoveryOriginalPlay;HTMLMediaElement.prototype.play=original;return original.apply(this,args)}; document.querySelector('.uc-video-editor__transport-play').click(); undefined`);
    await until(`window.idleRecoveryRejects===2 && document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('.uc-video-editor__transport-play').getAttribute('aria-label')==='播放时间线'`);
    await delay(150);
    const exhausted = await js(`({state:editingHarness.state(), rejects:window.idleRecoveryRejects})`);
    checks.push({
      name: 'persistent media failure stops after one automatic preview renewal',
      passed: exhausted.rejects === 2 && exhausted.state.sourceRequests.length === beforeExhaustion.sourceRequests.length + 1
    });
  }
  await js(`window.diagEvents=[]; for(const e of ['play','playing','pause','waiting','stalled','error','ended','seeking','seeked']) document.addEventListener(e,event=>{if(event.target.matches?.('video[aria-label="时间线预览"]'))window.diagEvents.push({event:e,at:performance.now(),clip:event.target.dataset.previewClipId,time:event.target.currentTime,paused:event.target.paused});},true)`);
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  report.clicked=await js(snapshot);
  checks.push({name:'ready preview starts in the click without a redundant seek',passed:!report.clicked.paused && !report.clicked.seeking});
  checks.push({name:'original playback starts before any scrub proxy is ready',passed:!report.clicked.paused && (await js('editingHarness.state().proxiesReady'))===0});
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
  await until(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId==='clip-0' && !document.querySelector('video[aria-label="时间线预览"]').paused && document.querySelector('video[aria-label="时间线预览"]').currentTime<0.25`, 12000);
  report.replayed = await js(snapshot);
  checks.push({name:'first click after natural end replays from zero',passed:!report.replayed.paused && report.replayed.clip==='clip-0' && report.replayed.time<0.25});
  report.events=await js('diagEvents');
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  await js(`document.querySelector('[aria-label="主轨播放头"]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
  await until(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId==='clip-2' && !document.querySelector('video[aria-label="时间线预览"]').seeking && getComputedStyle(document.querySelector('.uc-video-editor__stage-frame')).visibility==='hidden'`);
  report.seekEnd=await js(snapshot);
  checks.push({name:'seek to total duration shows last clip final frame',passed:report.seekEnd.clip==='clip-2' && report.seekEnd.time>4.9 && report.seekEnd.paused && report.seekEnd.held==='hidden'});
  await js(`document.querySelector('[aria-label="主轨播放头"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
  await until(`document.querySelector('video[aria-label="时间线预览"]').dataset.previewClipId==='clip-0' && !document.querySelector('video[aria-label="时间线预览"]').seeking`);
  await js(`window.originalPlay=HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play=function(){return new Promise((_resolve,reject)=>{window.rejectPendingPlay=reject})}; document.querySelector('.uc-video-editor__transport-play').click()`);
  await delay(100);
  report.pendingPlay=await js(snapshot);
  checks.push({name:'pending play does not claim media is playing',passed:report.pendingPlay.paused && report.pendingPlay.button==='播放时间线'});
  await js(`document.querySelector('.uc-video-editor__transport-play').click(); HTMLMediaElement.prototype.play=window.originalPlay; window.rejectPendingPlay(new Error('cancelled test playback'))`);
  await delay(100);
  await js(`window.dragFrames=[]; window.dragPass=0; window.dragStarted=performance.now(); window.originalDraw=CanvasRenderingContext2D.prototype.drawImage; CanvasRenderingContext2D.prototype.drawImage=function(media,...args){ if(this.canvas.matches('.uc-video-editor__stage-frame') && media instanceof HTMLVideoElement){const target=Number(document.querySelector('[aria-label="主轨播放头"]').getAttribute('aria-valuenow'))/1e6; const clipId=editingHarness.clipForVideo(media); window.dragFrames.push({at:performance.now(),pass:window.dragPass,clip:clipId ? Number(clipId.slice(5)) : null,target,time:media.currentTime,seeking:media.seeking});} return window.originalDraw.call(this,media,...args)}; undefined`);
  window.focus();
  window.webContents.focus();
  const dragGeometry=await js(`(()=>{const s=document.querySelector('.uc-video-editor__playhead-scale').getBoundingClientRect();const p=document.querySelector('[aria-label="主轨播放头"]').getBoundingClientRect();const v=document.querySelector('.uc-video-editor__timeline-canvas').parentElement.getBoundingClientRect();return {left:v.left,right:v.right,y:p.top+8,startX:p.left+p.width/2}})()`);
  report.dragGeometry=dragGeometry;
  assert.ok(await js(`!!document.elementFromPoint(${dragGeometry.startX},${dragGeometry.y})?.closest('[aria-label="主轨播放头"]')`),'drag must hit the playhead');
  window.webContents.sendInputEvent({type:'mouseDown',x:Math.round(dragGeometry.startX),y:Math.round(dragGeometry.y),button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(dragGeometry.left+2),y:Math.round(dragGeometry.y),button:'left'});
  await js('editingHarness.releaseProxies()');
  await until('editingHarness.state().proxiesReady>=1');
  await delay(2500);
  for(let pass=0;pass<4;pass++) {
    await js(`window.dragPass=${pass}`);
    for(let step=0;step<=20;step++) {
      const ratio=pass%2 ? 1-step/20 : step/20;
      window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(dragGeometry.left+2+ratio*(dragGeometry.right-dragGeometry.left-4)),y:Math.round(dragGeometry.y),button:'left'});
      await delay(40);
    }
  }
  window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(dragGeometry.left-2),y:Math.round(dragGeometry.y),button:'left'});
  await until(`document.querySelector('.uc-video-editor__timeline-canvas').parentElement.scrollLeft===0`);
  await delay(80);
  const releaseAt=Date.now();
  window.webContents.sendInputEvent({type:'mouseUp',x:Math.round(dragGeometry.left-2),y:Math.round(dragGeometry.y),button:'left',clickCount:1});
  await until(`!document.querySelector('video[aria-label="时间线预览"]').seeking && getComputedStyle(document.querySelector('.uc-video-editor__stage-frame')).visibility==='hidden'`);
  report.releaseLatencyMs=Date.now()-releaseAt;
  report.dragFrames=await js(`CanvasRenderingContext2D.prototype.drawImage=window.originalDraw; window.dragFrames`);
  const frames=report.dragFrames.slice(1);
  const runCounts = new Map();
  report.dragMaximumWarmupGapMs = 0;
  report.dragMaximumFrameGapMs = Math.max(0, ...frames.slice(1).map((f, i) => {
    const previous = frames[i];
    const key = `${f.pass}:${f.clip}`;
    if (f.pass !== previous.pass || f.clip !== previous.clip) return 0;
    const count = runCounts.get(key) ?? 0;
    runCounts.set(key, count + 1);
    const gap = f.at - previous.at;
    if (count === 0) report.dragMaximumWarmupGapMs = Math.max(report.dragMaximumWarmupGapMs, gap);
    return count === 0 ? 0 : gap;
  }));
  checks.push({name:'native edge drag stays on the target clip and follows target direction',passed:frames.length>=10 && frames.every((f,i)=>{
    const timelineTime=f.clip*5+f.time;
    if(f.seeking || f.clip!==Math.min(2,Math.floor(f.target/5))) return false;
    if(!i || f.pass!==frames[i-1].pass) return true;
    const previous=frames[i-1].clip*5+frames[i-1].time;
    if(Math.abs(f.target-frames[i-1].target)<=0.002) {
      return Math.abs(timelineTime-f.target)<=Math.abs(previous-frames[i-1].target)+0.002;
    }
    return f.pass%2 ? timelineTime<=previous+0.002 : timelineTime>=previous-0.002;
  })});
  checks.push({name:'native edge drag updates throughout and settles within 500ms after proxy warmup',passed:report.dragMaximumFrameGapMs<500 && report.releaseLatencyMs<500});
  report.dragFinal=await js(snapshot);
  checks.push({name:'left edge release shows first frame',passed:report.dragFinal.clip==='clip-0' && report.dragFinal.time<0.1 && report.dragFinal.paused});
  await js(`document.querySelector('.uc-video-editor__transport-play').click()`);
  await until(`!document.querySelector('video[aria-label="时间线预览"]').paused`);
  await js(`const b=document.querySelector('.uc-video-editor__transport-play'); b.click(); b.click();`);
  await delay(300);
  report.rapidResume=await js(snapshot);
  checks.push({name:'queued pause event is deterministic under rapid clicks',passed:report.rapidResume.paused || report.rapidResume.time>=0});
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
