const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { app, session, dialog, nativeImage } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/generation-history-app');
const temporary = fs.mkdtempSync(path.join(root, 'outputs/history-app-isolated-'));
const project = path.join(temporary, 'project');
let chosenDirectory = project;
fs.mkdirSync(project);
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
// Measure rendering opportunities consistently when Codex overlaps this window.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
delete process.env.VITE_DEV_SERVER_URL;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosenDirectory] });
let win;
const report = { scope: 'Production renderer/main/preload/IPC and real isolated project storage; seeded results, no provider calls.', checks: [], layouts: [], metrics: {}, errors: [] };
app.on('browser-window-created', (_event, window) => {
  win = window;
  win.setAlwaysOnTop(true);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer exited: ${details.reason}`)));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
});
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true })));
require(path.join(root, 'dist-electron/electron/main.js'));
const p = require(path.join(root, 'dist-electron/src/platform'));
const js = source => win.webContents.executeJavaScript(source);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  for (let i = 0; i < 240; i++) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
const modes = [
  ['quick_image', '快速生图', 'image'], ['professional_image', '专业生图', 'image'],
  ['quick_video', '快速视频', 'video'], ['text_to_video', '文生视频', 'video'], ['image_to_video', '图生视频', 'video']
];
let storage, projectId, videoBytes;
let tasks = [], executions = [], works = [], files = [];
const t0 = '2026-09-24T00:00:00.000Z';
async function save() {
  for (const [key, entities] of [['tasks', tasks], ['executions', executions], ['works', works], ['fileReferences', files]]) {
    await storage.writeJsonAtomically(p.projectStoragePaths.entities[key], { schemaVersion: 2, revision: 1, entities });
  }
}
function addTask(mode, mediaKind, index, state = 'completed', count = 1) {
  const id = `${mode}-${index}`;
  const executionId = `execution-${id}`;
  const createdAt = new Date(Date.parse(t0) + index * 1000).toISOString();
  const common = { mode, modelId: 'model-fixture', capabilityEvidenceId: 'evidence-fixture', providerId: 'provider-fixture',
    connectionId: 'connection-fixture', recipientName: 'Local fixture', accessCategory: 'local', outboundScope: 'local_device',
    costState: 'unknown', privacyState: 'unknown', regionState: 'unknown', parameters: {} };
  const confirmation = mediaKind === 'image' ? { ...common, purpose: 'image_generation',
    confirmations: { recipient: true, outboundScope: true, cost: true, finalPrompt: true, model: true } } : {
    ...common, purpose: 'video_generation', materials: [], contextReferences: [],
    input: mode === 'quick_video' ? { mode } : mode === 'text_to_video' ? { mode, sourceKind: 'short_idea', shots: [] } : {
      mode, mustKeep: [], allowedChanges: [], prohibited: [], subjectAction: '', cameraMovement: '', pace: '', depthOfField: '' },
    confirmations: { recipient: true, outboundScope: true, materials: true, costPrivacyRegion: true, finalPrompt: true, model: true }
  };
  tasks.push({ schemaVersion: 1, id, projectId, sourceDraftId: `deleted-draft-${mode}`, createdAt,
    executionIds: [executionId], submission: { kind: `${mediaKind}_generation`,
      prompt: { originalInput: id, finalPrompt: id, systemSupplements: [] }, assetIds: [], confirmedAt: createdAt,
      [mediaKind]: confirmation } });
  executions.push({ schemaVersion: 1, id: executionId, taskId: id, attempt: 1, state, createdAt, updatedAt: createdAt });
  for (let n = 0; n < count; n++) {
    const fileId = `file-${id}-${n}`;
    const png = nativeImage.createFromBitmap(Buffer.alloc(240 * 160 * 4, Buffer.from([40 + n * 40, 100, 180, 255])), { width: 240, height: 160 }).toPNG();
    const bytes = mediaKind === 'video' ? videoBytes : png;
    const relativePath = `files/${fileId}.${mediaKind === 'video' ? 'mp4' : 'png'}`;
    fs.mkdirSync(path.join(project, 'files'), { recursive: true });
    fs.writeFileSync(path.join(project, relativePath), bytes);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    files.push({ schemaVersion: 1, id: fileId, projectId, sourceExecutionId: executionId,
      locator: { kind: 'project', relativePath }, state: 'available', sizeBytes: bytes.length, checksumSha256,
      lastVerification: { sizeBytes: bytes.length, checksumSha256, matchesExpected: true, verifiedAt: createdAt }, createdAt, updatedAt: createdAt });
    works.push({ schemaVersion: 1, id: `work-${id}-${n}`, projectId, sourceTaskId: id, sourceExecutionId: executionId,
      fileId, mediaKind, name: `结果 ${id} ${n + 1}`, createdAt });
  }
}
async function navigate(mode, label, kind) {
  const parent = kind === 'image' ? 'image-creation' : 'video-creation';
  await js(`(() => { const b=document.getElementById('${parent}-navigation-trigger'); if(b.getAttribute('aria-expanded')!=='true') b.click(); })()`);
  await until(() => js(`Array.from(document.querySelectorAll('.nav-subitem')).some(b=>b.textContent.trim()==='${label}')`), label);
  await js(`Array.from(document.querySelectorAll('.nav-subitem')).find(b=>b.textContent.trim()==='${label}').click()`);
  await until(() => js(`!!document.querySelector('[data-task-id="${mode}-0"]')`), `${mode} history`);
}
async function measure() {
  return js(`Array.from(document.querySelectorAll('.uc-generation-history__current,.uc-generation-history__timeline,.uc-generation-history__task-card')).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})`);
}
async function settleLayout() {
  let previous = '';
  let stable = 0;
  await until(async () => {
    const current = JSON.stringify(await measure());
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    return stable >= 8;
  }, 'layout and page scroll settled');
}
async function resize(width, height) {
  win.show(); win.focus();
  win.setContentSize(width, height);
  await until(() => js(`innerWidth===${width} && innerHeight===${height}`), `viewport ${width}x${height}`);
  await settleLayout();
}
async function run() {
  report.phase = 'setup';
  await fsp.mkdir(output, { recursive: true });
  const tooling = await import('./media-engine-common.mjs');
  const engine = await tooling.readMediaEngineManifest(root);
  const ffmpeg = process.env.HISTORY_TEST_FFMPEG ?? tooling.resolveMediaEngineInstallation(root, engine).ffmpegPath;
  const videoPath = path.join(temporary, 'fixture.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=240x160:rate=12',
    '-t', '1', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', videoPath], { windowsHide: true });
  videoBytes = await fsp.readFile(videoPath);
  await until(async () => win && !win.webContents.isLoading() && await js('!!document.querySelector(".sidebar")'), 'app loaded');
  await resize(1280, 900);
  const created = await js(`unicomp.storage.createProject('History isolated acceptance')`);
  assert.equal(created.ok, true);
  projectId = created.value.session.projectId;
  storage = new p.NodeProjectStorage(project);
  for (const [mode, , kind] of modes) {
    const draft = await js(`unicomp.${kind}Workspaces.create('${mode}')`);
    assert.equal(draft.ok, true);
    addTask(mode, kind, 0, 'completed', 2);
    addTask(mode, kind, 1, 'processing', 0);
    if (mode === 'quick_image') {
      tasks.find(task => task.id === 'quick_image-0').sourceDraftId = draft.value.draftId;
      await save();
      assert.equal((await js(`unicomp.imageWorkspaces.create('quick_image')`)).ok, true);
      await new p.JsonImageWorkspaceRepository(storage, projectId).remove(draft.value.draftId);
      assert.equal(await new p.JsonImageWorkspaceRepository(storage, projectId).get(draft.value.draftId), undefined);
    }
  }
  await save();
  win.webContents.reload();
  await until(() => js('!!document.querySelector(".sidebar")'), 'reload project context');
  await delay(1000);
  for (const [mode, label, kind] of modes) {
    report.phase = mode;
    const query = { projectId, draftId: 'different-current-draft', workspaceMode: mode, mediaKind: kind, limit: 50 };
    const history = await js(`unicomp.storage.listGenerationHistory(${JSON.stringify(query)})`);
    assert.equal(history.ok, true, JSON.stringify(history));
    assert.deepEqual(history.value.issues, []);
    assert.equal(history.value.items.length, 1);
    assert.equal(history.value.activeItems.length, 1);
    assert.ok(history.value.items.every(item => item.taskId.startsWith(mode)));
    await navigate(mode, label, kind);
    assert.equal(await js('document.querySelectorAll(".uc-generation-history__node").length'), 2);
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('.uc-generation-history__task-card')).map(e=>e.querySelectorAll('.uc-generation-history__work,.uc-generation-history__status-button').length)`), [1, 1]);
    await js(`document.querySelector('[data-task-id="${mode}-0"] [aria-label="下一件作品"]').click()`);
    await until(() => js(`document.querySelector('[data-task-id="${mode}-0"]').textContent.includes('作品 2／2')`), 'switch second result');
    await until(() => js(kind === 'image'
      ? `!!document.querySelector('.uc-generation-history__preview img')?.naturalWidth`
      : `document.querySelector('.uc-generation-history__preview video')?.readyState >= 2`), 'real local media preview');
    const before = await measure();
    const active = executions.find(e => e.taskId === `${mode}-1`);
    active.state = 'failed'; active.updatedAt = new Date().toISOString();
    await save();
    await until(() => js(`document.querySelector('[data-task-id="${mode}-1"]').textContent.includes('失败')`), 'real storage monitor refresh');
    assert.deepEqual(await measure(), before);
    report.layouts.push({ mode, viewport: '1280x900', geometry: before });
    await fsp.writeFile(path.join(output, `${mode}.png`), (await win.webContents.capturePage()).toPNG());
    report.checks.push(`${mode}: real IPC mode isolation, missing source draft, one preview, persisted status refresh and stable layout`);
    await resize(800, 720);
    await js(`document.documentElement.dataset.theme='light'`);
    await settleLayout();
    await js(`document.querySelector('.uc-generation-history__timeline').scrollIntoView({block:'end',behavior:'instant'})`);
    await settleLayout();
    const scrollBefore = await js(`document.querySelector('main.workspace').scrollTop`);
    const narrow = await measure();
    await fsp.writeFile(path.join(output, `${mode}-narrow-before.png`), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(await measure(), narrow, 'page remains stable before switching Work');
    await js(`window.frameTrace=[];window.traceObserver=new MutationObserver(()=>{const m=document.querySelector('main.workspace');const h=document.querySelector('.uc-generation-history');frameTrace.push({scroll:m.scrollTop,height:m.scrollHeight,history:h.getBoundingClientRect().height,media:!!h.querySelector('img')})});traceObserver.observe(document.querySelector('.uc-generation-history'),{subtree:true,childList:true})`);
    await js(`document.querySelector('[data-task-id="${mode}-0"] [aria-label="上一件作品"]').click()`);
    await settleLayout();
    const narrowAfter = await measure();
    const transitions = await js('traceObserver.disconnect();frameTrace');
    assert.ok(transitions.length > 0);
    for (const frame of transitions) {
      assert.equal(frame.history, narrow[0].height + narrow[1].height, 'preview does not collapse during media replacement');
      assert.equal(frame.scroll, scrollBefore, 'media replacement preserves page scroll');
    }
    assert.deepEqual(narrowAfter, narrow);
    report.layouts.push({ mode, viewport: await js('`${innerWidth}x${innerHeight}`'), geometry: narrowAfter, transitions });
    await fsp.writeFile(path.join(output, `${mode}-light-800.png`), (await win.webContents.capturePage()).toPNG());
    await resize(1280, 900);
    await js(`document.documentElement.dataset.theme='dark'`);
  }
  await navigate(...modes[0]);
  report.phase = 'navigation and paging';
  await js(`document.querySelector('[data-task-id="quick_image-0"] [aria-label="下一件作品"]').click()`);
  await until(() => js(`document.querySelector('[data-task-id="quick_image-0"]').textContent.includes('作品 2／2')`), 'second Work');
  await navigate(...modes[1]);
  await navigate(...modes[0]);
  assert.equal(await js(`document.querySelector('[data-task-id="quick_image-0"]').textContent.includes('作品 2／2')`), true);
  report.checks.push('navigation away/back preserves selected task and second Work');
  await navigate(...modes[1]);
  for (let i = 2; i < 105; i++) addTask('quick_image', 'image', i, i >= 100 ? 'processing' : i % 3 === 0 ? 'failed' : 'completed', i >= 100 || i % 3 === 0 ? 0 : 1);
  await save();
  await until(async()=>{
    const page=await js(`unicomp.storage.listGenerationHistory(${JSON.stringify({projectId,draftId:'fixture',workspaceMode:'quick_image',mediaKind:'image',limit:50})})`);
    return page.ok && page.value.items.length===50 && page.value.activeItems.length===5;
  },'storage monitor has invalidated the old two-task snapshot');
  await new Promise(resolve => { win.webContents.once('did-finish-load',resolve); win.webContents.reload(); });
  await until(()=>js('!!document.querySelector(".sidebar")'),'fresh paginated view');
  await js(`(() => {const b=document.getElementById('image-creation-navigation-trigger');if(b.getAttribute('aria-expanded')!=='true')b.click()})()`);
  await until(()=>js(`Array.from(document.querySelectorAll('.nav-subitem')).some(b=>b.textContent.trim()==='快速生图')`),'quick image navigation');
  await js(`Array.from(document.querySelectorAll('.nav-subitem')).find(b=>b.textContent.trim()==='快速生图').click()`);
  await until(() => js('document.querySelectorAll(".uc-generation-history__node").length===30'), 'latest 30 tasks across all states');
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-task-id]')).map(e=>e.dataset.taskId)`),Array.from({length:30},(_,i)=>`quick_image-${75+i}`));
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='加载更早任务')`),false);
  report.checks.push('Real storage: exactly the latest 30 tasks, including failed/active tasks, without pagination');
  await js(`window.historyLongTasks=[];window.historyObserver=new PerformanceObserver(list=>historyLongTasks.push(...list.getEntries().map(e=>e.duration)));historyObserver.observe({type:'longtask'})`);
  win.webContents.setBackgroundThrottling(false);
  win.show(); win.focus();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const durations = [];
  report.phase = 'selection measurements';
  for (let i = 0; i < 30; i++) durations.push(await js(`new Promise(resolve=>{const start=performance.now();document.querySelector('[data-task-id="quick_image-${100+i%5}"] .uc-generation-history__status-button').click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})`));
  durations.sort((a,b)=>a-b);
  report.metrics = { platformKey: tooling.currentPlatformKey(), cpu: os.cpus()[0].model, electron: process.versions.electron,
    renderer: await js('({visibility:document.visibilityState, focused:document.hasFocus()})'),
    samples: durations.length, selectionToTwoFramesMs: { p50: durations[14], p95: durations[28] } };
  for (const action of ['input', 'scroll']) {
    report.phase = `${action} measurements`;
    const samples = [];
    const details = [];
    for (let i=0;i<30;i++) details.push(await js(`new Promise(resolve=>{const start=performance.now();let timer;setTimeout(()=>timer=performance.now()-start,20);
      ${action === 'input' ? `const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'验收输入 ${i}');e.dispatchEvent(new Event('input',{bubbles:true}));`
        : `document.querySelector('.uc-generation-history__timeline-scroll').scrollLeft=${i*120};`}
      requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({frame:performance.now()-start,timer,visibility:document.visibilityState,focused:document.hasFocus()})))})`));
    samples.push(...details.map(row=>row.frame));
    report.metrics[`${action}Samples`] = details;
    report.metrics.window = {visible:win.isVisible(),minimized:win.isMinimized(),focused:win.isFocused(),bounds:win.getBounds()};
    samples.sort((a,b)=>a-b);
    report.metrics[`${action}ToTwoFramesMs`] = { p50: samples[14], p95: samples[28] };
  }
  report.metrics.longTasksDuringInteraction = await js('historyLongTasks');
  report.phase = 'native wheel during generation';
  await js(`document.querySelector('.uc-generation-history__timeline-scroll').scrollLeft=2000;window.nativeWheelSamples=[];window.nativeWheelProbe=e=>{const start=performance.now();const timeline=document.querySelector('.uc-generation-history__timeline-scroll');const before=timeline.scrollLeft;requestAnimationFrame(()=>requestAnimationFrame(()=>nativeWheelSamples.push({elapsed:performance.now()-start,before,after:timeline.scrollLeft,prevented:e.defaultPrevented,page:document.querySelector('main.workspace').scrollTop}))) };document.querySelector('.uc-generation-history__timeline-scroll').addEventListener('wheel',nativeWheelProbe,{capture:true})`);
  const wheelPoint = await js(`(()=>{const r=document.querySelector('.uc-generation-history__timeline-scroll').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+60)}})()`);
  const generation = executions.find(e=>e.taskId==='quick_image-102');
  await js(`window.transitionCard=document.querySelector('[data-task-id="quick_image-102"]');window.completionFrames=[];window.completionObserver=new MutationObserver(()=>{const cards=Array.from(document.querySelectorAll('[data-task-id]'));const card=document.querySelector('[data-task-id="quick_image-102"]');const r=card.getBoundingClientRect();completionFrames.push({count:cards.length,unique:new Set(cards.map(c=>c.dataset.taskId)).size,same:card===transitionCard,y:r.y,height:r.height,previews:card.querySelectorAll('.uc-generation-history__work,.uc-generation-history__status-button').length})});completionObserver.observe(document.querySelector('.uc-generation-history'),{subtree:true,childList:true})`);
  let sampleIndex=0;
  const dispatchDurations=[];
  for(const state of ['processing','remote_completed','downloading','verifying_file','registering_work','completed']) {
    generation.state=state; generation.updatedAt=new Date().toISOString();
    if(state==='registering_work') {
      const file={...files.find(f=>f.id==='file-quick_image-0-0'),id:'file-native-result',sourceExecutionId:generation.id};
      files.push(file);
      works.push({...works.find(w=>w.id==='work-quick_image-0-0'),id:'work-native-result',sourceTaskId:generation.taskId,sourceExecutionId:generation.id,fileId:file.id});
    }
    const writing=save();
    for(let i=0;i<10;i++) {
      const dispatchedAt=performance.now();
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:sampleIndex%2?120:-120});
      sampleIndex++;
      await until(()=>js(`nativeWheelSamples.length>=${sampleIndex}`),'native wheel painted');
      dispatchDurations.push(performance.now()-dispatchedAt);
    }
    await writing;
  }
  await until(()=>js(`document.querySelector('[data-task-id="quick_image-102"] .uc-generation-history__work')!==null`),'completed task replaces its status slot with one Work');
  const wheelSamples=await js('nativeWheelSamples');
  const completionFrames=await js('completionObserver.disconnect();completionFrames');
  report.completionFrames = completionFrames;
  report.metrics.nativeWheelRaw = wheelSamples;
  assert.ok(completionFrames.length>0);
  for(const frame of completionFrames) {
    assert.equal(frame.count,30);assert.equal(frame.unique,30);assert.equal(frame.same,true);assert.equal(frame.previews,1);
    assert.equal(frame.y,completionFrames[0].y);assert.equal(frame.height,completionFrames[0].height);
  }
  for(const sample of wheelSamples) {assert.equal(sample.prevented,true);assert.equal(Math.abs(sample.after-sample.before),120);}
  const wheelDurations=wheelSamples.map(s=>s.elapsed).sort((a,b)=>a-b);
  report.metrics.nativeWheelDuringGeneration={samples:wheelSamples.length,p50:wheelDurations[29],p95:wheelDurations[56],max:wheelDurations.at(-1)};
  dispatchDurations.sort((a,b)=>a-b);
  report.metrics.nativeDispatchToObservedPaint={p95:dispatchDurations[56],max:dispatchDurations.at(-1)};
  assert.ok(wheelDurations[56]<100 && wheelDurations.at(-1)<250,'Native generation scroll must not stall for 2 seconds');
  assert.ok(dispatchDurations.at(-1)<250,'Input dispatch through observed paint must not stall');
  report.metrics.longTasksDuringInteraction = await js('historyLongTasks');
  report.checks.push('60 native wheel events during real storage generation transitions: no scroll rollback, no duplicate/intermediate replacement card or timeline displacement');
  chosenDirectory = path.join(temporary, 'other-project');
  await fsp.mkdir(chosenDirectory);
  const other = await js(`unicomp.storage.createProject('Other isolated project')`);
  assert.equal(other.ok, true);
  const otherHistory = await js(`unicomp.storage.listGenerationHistory(${JSON.stringify({ projectId: other.value.session.projectId,
    draftId: 'unrelated-draft', workspaceMode: 'quick_image', mediaKind: 'image' })})`);
  assert.deepEqual(otherHistory.value, { items: [], activeItems: [], issues: [] });
  assert.equal((await js(`unicomp.storage.openRecentProject('${projectId}')`)).ok, true);
  report.checks.push('Deleted real temporary image draft retains its task/results; another real project does not inherit history');
  report.phase = 'verified';
  await fsp.writeFile(path.join(output, 'paged.png'), (await win.webContents.capturePage()).toPNG());
}
const watchdog = setTimeout(() => finish(new Error('Full-app verification exceeded 120 seconds')), 120000);
let finished = false;
async function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  if (error) {
    report.failure = error.stack;
    report.ui = await js(`({title:document.querySelector('h1')?.textContent,cards:Array.from(document.querySelectorAll('[data-task-id]')).map(e=>e.dataset.taskId),text:document.querySelector('.uc-generation-history')?.textContent})`).catch(()=>null);
  }
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!error && process.argv.includes('--acceptance-window')) {
    tasks = tasks.filter(task => Number(task.id.split('-').at(-1)) < 2);
    const ids = new Set(tasks.map(task => task.id));
    executions = executions.filter(execution => ids.has(execution.taskId));
    works = works.filter(work => ids.has(work.sourceTaskId));
    const fileIds = new Set(works.map(work => work.fileId));
    files = files.filter(file => fileIds.has(file.id));
    await save();
    win.webContents.reload();
    await until(() => js('!!document.querySelector(".sidebar")'), 'inspection reload');
    await navigate(...modes[0]);
    win.setTitle('UniComp · 生成历史验收（隔离样例）');
    win.setAlwaysOnTop(false);
    win.show(); win.focus();
    await fsp.writeFile(path.join(output, 'acceptance-window.json'), JSON.stringify({ project, profile: app.getPath('userData'), ready: true }, null, 2));
    console.log('Acceptance window ready: UniComp · 生成历史验收（隔离样例）');
    return;
  }
  app.exit(error ? 1 : 0);
}
run().then(() => finish(), finish).catch(error => { console.error(error); app.exit(1); });
