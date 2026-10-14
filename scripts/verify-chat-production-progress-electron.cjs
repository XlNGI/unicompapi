const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { mkdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, clipboard } = require('electron');

const workspace = path.resolve(__dirname, '..');
const r0136 = process.argv.includes('--r0136');
const retainedResults = process.argv.includes('--retained-results');
const r45 = process.argv.includes('--r45');
const codexStyle = process.argv.includes('--codex-style');
const composerBoundary = process.argv.includes('--composer-boundary');
const copyMessages = process.argv.includes('--copy-messages');
const progressSummary = codexStyle || process.argv.includes('--progress-summary');
const output = path.join(workspace, 'outputs', 'chat-production-progress', ...(copyMessages ? ['copy-messages'] : composerBoundary ? ['composer-boundary'] : progressSummary ? [codexStyle ? 'codex-style' : 'summary'] : r45 ? ['r45'] : retainedResults ? ['retained-results'] : r0136 ? ['r0136'] : []));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'unicomp-chat-progress-'));
const buildDirectory = path.join(temporary, 'build');
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const checks = [];
const errors = [];
const blockedRequests = [];
const consoleMessages = [];
let window;
const strictMode = process.argv.includes('--strict-mode');
const deadline = setTimeout(() => { console.error('Chat progress verification timed out'); app.exit(1); }, 120000);
const js = (source) => window.webContents.executeJavaScript(source);
async function until(source) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await js(source)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${source}`);
}
async function snapshot() {
  return js(`({
    text: document.body.innerText,
    progress: document.querySelectorAll('[aria-label="生产进度"]').length,
    summaries: Array.from(document.querySelectorAll('.uc-chat-document-progress__summary')).map(e => e.textContent),
    details: document.querySelectorAll('.uc-chat-document-progress__details').length,
    disclosureStates: Array.from(document.querySelectorAll('.uc-chat-document-progress__details')).map(e => ({
      open: e.open, summaryVisible: e.querySelector('summary').getBoundingClientRect().height > 0,
      traceVisible: e.querySelector('.uc-chat-production-trace')?.checkVisibility({contentVisibilityAuto:true}) ?? false
    })),
    steps: Array.from(document.querySelectorAll('.uc-chat-document-progress__step-list li')).map(e => e.textContent),
    trace: Array.from(document.querySelectorAll('.uc-chat-production-trace > li')).map(e => ({ code: e.dataset.eventCode, status: e.dataset.status, text: e.textContent })),
    assistants: document.querySelectorAll('li.uc-chat-page__message-item--assistant').length,
    bodies: Array.from(document.querySelectorAll('[aria-label="生成正文"]')).map(e => e.innerText),
    bodyOutsideTrace: Array.from(document.querySelectorAll('[aria-label="生成正文"]')).every(e => !e.closest('details, .uc-chat-production-trace')),
    remoteImages: document.querySelectorAll('[aria-label="生成正文"] img[src^="http"]').length,
    replyStatus: document.querySelectorAll('[aria-label="回复状态"]').length,
    oldCards: document.querySelectorAll('.uc-chat-document-progress__steps,.uc-chat-page__activity,.uc-chat-page__reasoning').length
  })`);
}
async function assertClean() {
  const value = await snapshot();
  assert.equal(value.oldCards, 0);
  assert.doesNotMatch(value.text, /PRIVATE_REASONING|PRIVATE_OUTLINE|PRIVATE_PATH|AI 工作过程|模型返回的思考内容|生成步骤/);
  assert.equal(value.bodyOutsideTrace, true, 'document body remains outside collapsed execution facts');
  return value;
}
function assertCollapsed(value) {
  assert.equal(value.disclosureStates.length, 1, 'one native disclosure owns the real execution facts');
  assert.deepEqual(value.disclosureStates[0], { open: false, summaryVisible: true, traceVisible: false },
    'execution facts are collapsed while their status summary stays visible');
}
async function capture(name) {
  await delay(100);
  await writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
}
async function captureBody(name) {
  // Let streamed Markdown settle, then scroll the actual conversation viewport as a reader would.
  await delay(350);
  await js(`(() => {
    const body = document.querySelector('[aria-label="生成正文"]');
    const viewport = body.closest('.uc-chat-page__messages');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
    body.scrollIntoView({block:'center', behavior:'instant'});
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
  })()`);
  await delay(100);
  const bounds = await js(`(() => { const r = document.querySelector('[aria-label="生成正文"]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`);
  assert.ok(bounds.top >= 80 && bounds.bottom < 650, `Body must be visible in screenshot: ${JSON.stringify(bounds)}`);
  await capture(name);
}
async function verifyDisclosure() {
  assertCollapsed(await assertClean());
  await js(`(() => {
    const details = document.querySelector('.uc-chat-document-progress__details');
    window.stableDisclosure = details;
    window.stableGeneratedBody = document.querySelector('[aria-label="生成正文"]');
    details.querySelector('summary').click();
  })()`);
  await until('document.querySelector(".uc-chat-document-progress__details").open');
  assert.equal(await js('document.querySelector(".uc-chat-progress-phases").checkVisibility({contentVisibilityAuto:true})'), true);
  assert.equal(await js('document.querySelector(".uc-chat-production-trace").checkVisibility({contentVisibilityAuto:true})'), false);
  await js('document.querySelector(".uc-chat-document-progress__records > summary").click()');
  await until('document.querySelector(".uc-chat-document-progress__records").open');
  await js('chatProgressHarness.emitTrace("model_response", "progress", {purpose:"content",contentCharacters:2200}, "assistant")');
  await until('document.querySelector(".uc-chat-production-trace").textContent.includes("2200")');
  assert.equal(await js('document.querySelector(".uc-chat-document-progress__details") === window.stableDisclosure && window.stableDisclosure.open'), true,
    'a stream update preserves the reader choice and disclosure node');
  assert.equal(await js('document.querySelector("[aria-label=生成正文]") === window.stableGeneratedBody'), true,
    'a stream update preserves the readable body sibling');
  await capture('codex-expanded.png');
  await js('document.querySelector(".uc-chat-document-progress__details > summary").focus()');
  assert.equal(await js('document.activeElement === document.querySelector(".uc-chat-document-progress__details > summary")'), true);
  // CDP delivers trusted renderer keys without bringing this offscreen window to the desktop.
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await js('document.querySelector(".uc-chat-document-progress__details > summary").focus()');
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until('!document.querySelector(".uc-chat-document-progress__details").open');
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await until('document.querySelector(".uc-chat-document-progress__details").open');
  await js('document.querySelector(".uc-chat-document-progress__details > summary").click()');
  await until('!document.querySelector(".uc-chat-document-progress__details").open');
  await js('chatProgressHarness.emitTrace("model_response", "progress", {purpose:"content",contentCharacters:2300}, "assistant")');
  await until('document.querySelector(".uc-chat-production-trace").textContent.includes("2300")');
  assertCollapsed(await assertClean());
  checks.push('native execution-fact disclosure opens by click, Enter and Space, and retains open/closed reader choice across stream updates');
}
async function verifyProgressSummary() {
  const layouts = [];
  for (const [width, theme] of [[1280, 'light'], [800, 'light'], [540, 'dark'], [340, 'light']]) {
    window.setSize(width, 820);
    await js(`chatProgressHarness.mount('saved-completed', ${JSON.stringify(theme)})`);
    await until('document.querySelector("[aria-label=生成正文]") && document.body.innerText.includes("合成模型")');
    await js(`(() => {
      chatProgressHarness.emitTrace('request_received', 'completed');
      chatProgressHarness.emitTrace('model_response', 'completed', {purpose:'planning'});
      for (let i = 0; i < 16; i++) {
        chatProgressHarness.emitTrace('tool_authorization', 'completed', {purpose:'content'});
        chatProgressHarness.emitTrace('model_request', 'started', {purpose:'content'});
        chatProgressHarness.emitTrace('model_response', 'progress', {purpose:'content',contentCharacters:i*900});
        chatProgressHarness.emitTrace('model_response', 'completed', {purpose:'content',contentCharacters:(i+1)*900});
      }
      chatProgressHarness.emitTrace('document_compile', 'started', {documentKind:'ppt'});
      chatProgressHarness.emitTrace('document_compile', 'completed', {documentKind:'ppt',totalPages:10});
      chatProgressHarness.emitTrace('document_render', 'completed', {totalPages:10});
      chatProgressHarness.emitTrace('document_structure_check', 'completed', {totalPages:10});
      chatProgressHarness.emitTrace('document_hash_check', 'completed', {bytes:1024});
      chatProgressHarness.emitTrace('document_publish', 'completed');
      chatProgressHarness.emitTrace('document_register', 'completed');
      chatProgressHarness.emitTrace('task_complete', 'completed');
    })()`);
    await until('document.querySelectorAll(".uc-chat-progress-phases > li").length === 4');
    assertCollapsed(await assertClean());
    await js('document.querySelector(".uc-chat-document-progress__details > summary").click()');
    await until('document.querySelector(".uc-chat-document-progress__details").open');
    await js(`(() => {
      const viewport = document.querySelector('.uc-chat-page__messages');
      viewport.scrollTop = 0; viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
    })()`);
    await delay(150);
    const layout = await js(`(() => {
      const panel = document.querySelector('.uc-chat-document-progress__details');
      const phases = [...document.querySelectorAll('.uc-chat-progress-phases > li')];
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return {width:innerWidth,theme:${JSON.stringify(theme)},panelWidth:rect.width,panelHeight:rect.height,
        actions:phases.map(e => e.querySelector('.uc-chat-progress-phases__content').textContent),statuses:phases.map(e => e.dataset.status),
        borderWidth:style.borderTopWidth,background:style.backgroundColor,
        maxRowHeight:Math.max(...phases.map(e => e.getBoundingClientRect().height)),
        statusBadges:document.querySelectorAll('.uc-chat-progress-phases__status').length,
        elapsed:document.querySelector('.uc-chat-document-progress__elapsed')?.textContent,
        rawRows:document.querySelectorAll('.uc-chat-production-trace > li').length,
        rawVisible:document.querySelector('.uc-chat-production-trace').checkVisibility({contentVisibilityAuto:true}),
        overflow:document.documentElement.scrollWidth > innerWidth,
        composerTop:document.querySelector('.uc-chat-page__composer').getBoundingClientRect().top,
        panelBottom:rect.bottom};
    })()`);
    assert.deepEqual(layout.actions, ['已检查任务与执行条件','已接收生成内容','已制作文档','已检查并保存文件']);
    assert.ok(layout.statuses.every(status => status === 'completed'));
    assert.ok(layout.rawRows > 50 && !layout.rawVisible);
    assert.ok(layout.panelWidth <= width && layout.panelHeight < 220 && !layout.overflow);
    assert.equal(layout.borderWidth, '0px');
    assert.equal(layout.background, 'rgba(0, 0, 0, 0)');
    assert.ok(layout.maxRowHeight <= 26 && layout.statusBadges === 0);
    assert.match(layout.elapsed, /用时 1分13秒/);
    assert.ok(layout.panelBottom < layout.composerTop, 'overview is clear of the composer');
    layouts.push(layout);
    await capture(`summary-${width}-${theme}.png`);
    if (width === 1280) {
      const rect = await js(`(() => {const r=document.querySelector('.uc-chat-document-progress__details').getBoundingClientRect();
        return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)};})()`);
      await writeFile(path.join(output, 'summary-detail.png'), (await window.webContents.capturePage(rect)).toPNG());
    }
    await js('document.querySelector(".uc-chat-document-progress__records > summary").click()');
    await until('document.querySelector(".uc-chat-document-progress__records").open');
    const records = await js(`(() => {
      const viewport = document.querySelector('.uc-chat-document-progress__record-viewport');
      viewport.focus(); viewport.scrollTop = viewport.scrollHeight;
      const last = viewport.querySelector('li:last-child').getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      return {height:bounds.height,scrollable:viewport.scrollHeight>viewport.clientHeight,
        focused:document.activeElement===viewport,lastReachable:last.bottom<=bounds.bottom+1};
    })()`);
    assert.ok(records.height <= 328 && records.scrollable && records.focused && records.lastReachable);
    if (width === 1280) {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
      await js('document.querySelector(".uc-chat-document-progress__records > summary").focus()');
      for (const [key, code, keyCode, text, open] of [['Enter','Enter',13,'\r',false], [' ','Space',32,' ',true]]) {
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,text,unmodifiedText:text});
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});
        await until(`document.querySelector('.uc-chat-document-progress__records').open === ${open}`);
      }
      await js(`(() => {
        document.activeElement.blur();
        document.querySelector('.uc-chat-document-progress__record-viewport').scrollTop = 0;
        document.querySelector('.uc-chat-page__messages').scrollTop = 0;
      })()`);
      await capture('execution-records.png');
    }
  }
  window.setSize(1280, 820);
  await js('chatProgressHarness.mount("saved-document", "light")');
  await until('document.body.innerText.includes("合成模型")');
  await js('chatProgressHarness.emitTrace("model_response", "progress", {purpose:"content",contentCharacters:11}, "assistant")');
  await until('document.querySelector("[data-phase=content]")?.dataset.status === "progress"');
  await js(`(() => {
    document.querySelector('.uc-chat-document-progress__details > summary').click();
    window.savedProgressPanel = document.querySelector('.uc-chat-document-progress__details');
    window.savedBody = document.querySelector('[aria-label="生成正文"]');
  })()`);
  for (let i = 0; i < 25; i++) {
    await js(`chatProgressHarness.emitTrace('model_response','progress',{purpose:'content',contentCharacters:${1000+i}},'assistant')`);
  }
  await until('document.querySelector("[data-phase=content]")?.textContent.includes("1,024")');
  assert.ok(await js(`document.querySelector('.uc-chat-document-progress__details')===savedProgressPanel && savedProgressPanel.open &&
    document.querySelector('[aria-label="生成正文"]')===savedBody && !document.querySelector('.uc-chat-document-progress__records').open`));
  await js('chatProgressHarness.emitTrace("document_render", "failed", undefined, "assistant")');
  await until('document.querySelector("[data-phase=compose]")?.dataset.status === "failed"');
  assert.equal(await js('document.querySelectorAll(".uc-chat-progress-phases [data-status=progress]").length'), 0);
  await js('chatProgressHarness.emitTrace("task_complete", "cancelled", {stopReason:"cancelled"}, "assistant")');
  await until('document.querySelector("[aria-label=生产进度]")?.dataset.status === "cancelled"');
  const clean = await assertClean();
  assert.ok(clean.bodyOutsideTrace);
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, []);
  const report = {scope:'Real ChatPage/DocumentProgress in isolated Electron; synthetic IPC, HTTP(S) denied, no model calls',
    presentation:'Borderless Codex-style activity log with small icons, muted single-line actions, recorded duration and expandable execution records',
    layouts,streamUpdates:25,disclosureAndBodyRetained:true,recordsScrollableAndKeyboardFocusable:true,keyboardDisclosureVerified:true,
    failedAndCancelledStatesVerified:true,errors,blockedRequests};
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function verifyComposerBoundary() {
  const layouts = [];
  const configurations = [
    ['codex-conversation', 1280, 820, 'light'], ['codex-document', 1280, 820, 'light'],
    ['codex-conversation', 800, 600, 'light'], ['codex-document', 540, 768, 'dark'],
    ['codex-conversation', 340, 768, 'light']
  ];
  for (const [scenario, width, height, theme] of configurations) {
    window.setSize(width, height);
    await js(`chatProgressHarness.mount(${JSON.stringify(scenario)}, ${JSON.stringify(theme)})`);
    await until('document.querySelector(".uc-markdown-message table") && document.body.innerText.includes("合成模型")');
    for (const multiline of [false, true]) {
      if (multiline) {
        await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
        await window.webContents.insertText(Array.from({length:12}, (_, i) => `草稿第 ${i+1} 行`).join('\n'));
      }
      await delay(200);
      if (multiline) {
        const following = await js(`(() => {
          const p=document.querySelector('.uc-chat-page__messages');
          return Math.abs(p.scrollTop-(p.scrollHeight-p.clientHeight))<=1;
        })()`);
        assert.ok(following, 'growing the composer retains following of the last reply');
      }
      for (const position of ['top', 'middle', 'bottom']) {
        await js(`(() => {
          const messages = document.querySelector('.uc-chat-page__messages');
          messages.scrollTop = ${position === 'top' ? '0' : position === 'middle' ? '(messages.scrollHeight - messages.clientHeight)/2' : 'messages.scrollHeight'};
          messages.dispatchEvent(new Event('scroll', {bubbles:true}));
        })()`);
        await delay(100);
        const layout = await js(`(() => {
          const pane=document.querySelector('.uc-chat-page__messages'), region=document.querySelector('.uc-chat-page__composer-region');
          const composer=document.querySelector('.uc-chat-page__composer'), textarea=document.querySelector('textarea[aria-label="对话输入"]');
          const p=pane.getBoundingClientRect(), c=composer.getBoundingClientRect(), r=region.getBoundingClientRect();
          const hitSamples=[];
          for(const x of [p.left+4, (p.left+p.right)/2, p.right-4]) {
            for(const y of [r.top+2, c.top+4, Math.min(innerHeight-2,c.bottom+4), innerHeight-2]) {
              const hit=document.elementFromPoint(x,y);
              hitSamples.push({x,y,messageBelow:!!hit?.closest('.uc-chat-page__messages')});
            }
          }
          const last=pane.querySelector('.uc-chat-page__message-item:last-child'), lastRect=last?.getBoundingClientRect();
          return {scenario:${JSON.stringify(scenario)},width:innerWidth,height:innerHeight,theme:${JSON.stringify(theme)},
            multiline:${multiline},position:${JSON.stringify(position)},messageBottom:p.bottom,regionTop:r.top,composerTop:c.top,
            composerBottom:c.bottom,textareaHeight:textarea.getBoundingClientRect().height,scrollTop:pane.scrollTop,
            maxScroll:pane.scrollHeight-pane.clientHeight,lastBottom:lastRect?.bottom,
            overflow:document.documentElement.scrollWidth>innerWidth,hitSamples};
        })()`);
        assert.ok(layout.messageBottom <= layout.regionTop + 1, `message viewport must end above input region: ${JSON.stringify(layout)}`);
        assert.ok(layout.composerBottom <= layout.height && !layout.overflow);
        assert.ok(layout.hitSamples.every(sample => !sample.messageBelow), 'no message content is painted in or below the composer region');
        if (multiline) assert.ok(layout.textareaHeight >= 100, 'real multiline draft must grow the composer');
        if (position === 'bottom') {
          assert.ok(Math.abs(layout.scrollTop-layout.maxScroll) <= 1);
          assert.ok(layout.lastBottom <= layout.messageBottom + 1, 'last reply remains reachable above the input');
        }
        if (position === 'middle' && !multiline) {
          await until('document.querySelector("button[aria-label=回到最新消息]")');
          const jump = await js(`(() => {
            const b=document.querySelector('button[aria-label="回到最新消息"]');
            const r=b.getBoundingClientRect(), c=document.querySelector('.uc-chat-page__composer-region').getBoundingClientRect();
            const visible=r.bottom<=c.top+1; b.click(); return {visible};
          })()`);
          assert.ok(jump.visible, 'jump-to-latest stays above the composer');
          await until(`(() => {const p=document.querySelector('.uc-chat-page__messages');return Math.abs(p.scrollTop-(p.scrollHeight-p.clientHeight))<=1;})()`);
          await js(`(() => {
            const p=document.querySelector('.uc-chat-page__messages');
            p.scrollTop=(p.scrollHeight-p.clientHeight)/2; p.dispatchEvent(new Event('scroll',{bubbles:true}));
          })()`);
        }
        layouts.push(layout);
        if (!multiline && position === 'middle' && width === 1280) await capture(`${scenario}-middle.png`);
      }
      if (multiline) await capture(`${scenario}-${width}-multiline.png`);
    }
  }
  window.setSize(1280,820);
  await js('chatProgressHarness.mount("saved-document", "light")');
  await until('document.querySelector("[aria-label=生成正文]")');
  await js('chatProgressHarness.emitTrace("model_response","progress",{purpose:"content",contentCharacters:100},"assistant")');
  await until('document.querySelector(".uc-chat-document-progress__details")');
  for(let i=0;i<20;i++) await js(`chatProgressHarness.emitTrace('model_response','progress',{purpose:'content',contentCharacters:${200+i}},'assistant')`);
  const stream = await js(`(() => {
    const p=document.querySelector('.uc-chat-page__messages').getBoundingClientRect();
    const c=document.querySelector('.uc-chat-page__composer-region').getBoundingClientRect();
    return {messageBottom:p.bottom,composerRegionTop:c.top,progress:document.querySelector('[data-phase=content]')?.dataset.status};
  })()`);
  assert.ok(stream.messageBottom<=stream.composerRegionTop+1 && stream.progress==='progress');
  await assertClean();
  assert.deepEqual(errors,[]);
  assert.deepEqual(blockedRequests,[]);
  const report={scope:'Real ChatPage in isolated Electron renderer; synthetic IPC, no provider or HTTP(S) calls',
    layouts,stream,errors,blockedRequests,checks:['ordinary and document replies at top/middle/bottom',
      'multiline drafts resize input row and retain following','message pane clipped above composer','last reply reachable',
      'jump-to-latest stays above input and works','stream progress preserves boundary']};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({scope:report.scope,layoutCases:layouts.length,stream,errors,blockedRequests},null,2));
}
async function verifyMessageCopy() {
  // Keep the user's supported clipboard formats in memory, never in logs or evidence.
  const original = {text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage()};
  const copied = [];
  let productionPreload;
  try {
    const browser = await js(`(async()=>{try{await navigator.clipboard.writeText('isolated-browser-copy-probe');
      return {ok:true,focused:document.hasFocus()};}catch(e){return {ok:false,name:e.name,focused:document.hasFocus()};}})()`);
    for (const scenario of ['codex-conversation', 'codex-document', 'saved-completed']) {
      await js(`chatProgressHarness.mount(${JSON.stringify(scenario)}, 'light')`);
      await until('document.querySelector(".uc-chat-page__message-item--assistant button[aria-label=复制消息]")');
      const expected = await js(`(() => {
        const row=document.querySelector('.uc-chat-page__message-item--assistant');
        const body=row.querySelector('[aria-label="生成正文"]') ?? row.querySelector('.uc-chat-page__message-content');
        return {bodyText:body.innerText,first:body.querySelector('h1,h2,h3,p')?.textContent};
      })()`);
      await js(`(() => {
        const b=document.querySelector('.uc-chat-page__message-item--assistant button[aria-label="复制消息"]');
        b.scrollIntoView({block:'center'}); b.click();
      })()`);
      await until('document.querySelector(".uc-chat-page__message-item--assistant button[aria-label=已复制]")');
      const text=clipboard.readText();
      assert.ok(text.includes(expected.first), 'clipboard contains the displayed reply');
      assert.doesNotMatch(text,/PRIVATE_REASONING|PRIVATE_OUTLINE|PRIVATE_PATH|"sections"|"blocks"/);
      if(scenario==='saved-completed') assert.match(text,/# 年度经营报告\s+## 增长概览/);
      copied.push({scenario,characters:text.length,containsReadableBody:true,noRawOutlineOrPrivateFields:true});
      await capture(`${scenario}-copied.png`);
      await delay(1700);
      assert.ok(await js('Boolean(document.querySelector(".uc-chat-page__message-item--assistant button[aria-label=复制消息]"))'), 'copy feedback resets');
    }
    // Exercise the actual production preload, not only the shared native writer.
    productionPreload = new BrowserWindow({show:false,width:400,height:300,
      webPreferences:{preload:path.join(workspace,'dist-electron/electron/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false}});
    await writeFile(path.join(buildDirectory,'clipboard.html'),'<!doctype html><html><body>Clipboard preload verification</body></html>');
    await productionPreload.loadFile(path.join(buildDirectory,'clipboard.html'));
    await productionPreload.webContents.executeJavaScript(`window.unicomp.clipboard.writeText('生产 preload 剪贴板验证 ✅')`);
    assert.equal(clipboard.readText(),'生产 preload 剪贴板验证 ✅');
    const bounded = await productionPreload.webContents.executeJavaScript(`(async()=>{
      try{await window.unicomp.clipboard.writeText({text:'invalid'});return false;}catch{return true;}})()`);
    assert.ok(bounded);
    assert.equal(clipboard.readText(),'生产 preload 剪贴板验证 ✅');
    assert.deepEqual(errors,[]);
    assert.deepEqual(blockedRequests,[]);
    const report={scope:'Real ChatPage/Electron clipboard writer and production preload; synthetic conversation IPC, no provider calls',
      browserProbe:browser,copied,productionPreloadWriteVerified:true,invalidInputRejected:true,
      successFeedbackReset:true,clipboardRestored:true,errors,blockedRequests};
    await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally {
    if(productionPreload && !productionPreload.isDestroyed()) productionPreload.destroy();
    clipboard.write(original);
  }
}
async function verifyConversationLayout(scenario, width, height, theme, screenshot) {
  window.setSize(width, height);
  await js(`chatProgressHarness.mount(${JSON.stringify(scenario)}, ${JSON.stringify(theme)})`);
  await until(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && document.querySelector(".uc-markdown-message table")`);
  await delay(150);
  await js(`(() => {
    const viewport = document.querySelector('.uc-chat-page__messages');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
  })()`);
  await delay(100);
  assertCollapsed(await assertClean());
  const geometry = await js(`(() => {
    const viewport = document.querySelector('.uc-chat-page__messages');
    const list = document.querySelector('.uc-chat-page__message-list');
    const bubble = document.querySelector('.uc-chat-page__message-item--user > .uc-chat-page__message-bubble');
    const assistant = document.querySelector('.uc-chat-page__message-item--assistant');
    const composer = document.querySelector('.uc-chat-page__composer');
    const rect = e => { const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
    return {theme:document.documentElement.dataset.theme, window:{width:innerWidth,height:innerHeight},
      root:{width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},
      viewport:{...rect(viewport),width:viewport.clientWidth,scrollWidth:viewport.scrollWidth},
      list:rect(list), bubble:rect(bubble), composer:rect(composer),
      assistant:{background:getComputedStyle(assistant).backgroundColor,border:getComputedStyle(assistant).borderTopWidth},
      localScroll:Array.from(document.querySelectorAll('.uc-markdown-message pre,.uc-markdown-message table')).map(e => ({
        tag:e.tagName,width:e.clientWidth,scrollWidth:e.scrollWidth,overflow:getComputedStyle(e).overflowX,...rect(e)
      })),
      body:document.querySelector('[aria-label="生成正文"]') ? rect(document.querySelector('[aria-label="生成正文"]')) : undefined};
  })()`);
  assert.ok(geometry.root.scrollWidth <= geometry.root.width + 1, `page must not scroll horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.viewport.scrollWidth <= geometry.viewport.width + 1, `message viewport must not scroll horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.bubble.right - geometry.list.right) <= 2, 'user bubble aligns to the right of the reading column');
  assert.ok(geometry.bubble.width <= geometry.list.width * (width < 681 ? 0.95 : 0.81), 'user bubble remains bounded');
  assert.equal(geometry.assistant.background, 'rgba(0, 0, 0, 0)', 'assistant content uses the page surface');
  assert.equal(geometry.assistant.border, '0px', 'assistant content has no outer card border');
  assert.equal(geometry.localScroll.length, 2);
  assert.ok(geometry.localScroll.every(e => e.width > 0 && e.scrollWidth > e.width && ['auto', 'scroll'].includes(e.overflow)),
    'wide table and code have their own horizontal scroll regions');
  assert.ok(geometry.localScroll.every(e => e.left >= geometry.viewport.left && e.right <= geometry.viewport.right + 1),
    'wide content stays inside the conversation viewport');
  assert.ok(geometry.composer.left >= 0 && geometry.composer.right <= geometry.window.width + 1 && geometry.composer.bottom <= geometry.window.height,
    'composer remains inside the window');
  if (geometry.body) assert.ok(geometry.body.top < geometry.composer.top, 'document text is visible before the composer');
  await capture(screenshot);
  checks.push(`${scenario}: ${width}px ${theme} viewport has readable body, right-aligned user bubble, bounded composer and local table/code scrolling`);
  return geometry;
}
async function verifyStreamStability() {
  await js('chatProgressHarness.mount("document")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('制作一份年度经营报告 PPT');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending');
  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().subscribed');
  await js('chatProgressHarness.emitDocumentChunk("paragraph")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("营收增长来自")');
  await delay(200);
  const samples = await js(`(async () => {
    const body = document.querySelector('[aria-label="生成正文"]');
    const viewport = body.closest('.uc-chat-page__messages');
    const composer = document.querySelector('.uc-chat-page__composer');
    const disclosure = document.querySelector('.uc-chat-document-progress__details');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const initial = {height:body.offsetHeight, text:body.textContent, top:body.getBoundingClientRect().top,
      composerTop:composer.getBoundingClientRect().top, scroll:viewport.scrollTop,
      rows:document.querySelectorAll('.uc-chat-production-trace > li').length};
    const samples = [];
    for (let i = 0; i < 25; i++) {
      chatProgressHarness.emitTrace('model_response', 'progress', {purpose:'content', contentCharacters:1000+i}, 'assistant');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const current = document.querySelector('[aria-label="生成正文"]');
      samples.push({sameNode:current===body, textRetained:current.textContent===initial.text,
        bodyOutsideTrace:!current.closest('details,.uc-chat-production-trace'),
        disclosureRetained:document.querySelector('.uc-chat-document-progress__details')===disclosure, disclosureClosed:!disclosure.open,
        heightDelta:current.offsetHeight-initial.height, topDelta:current.getBoundingClientRect().top-initial.top,
        composerDelta:composer.getBoundingClientRect().top-initial.composerTop, scrollDelta:viewport.scrollTop-initial.scroll,
        addedRows:document.querySelectorAll('.uc-chat-production-trace > li').length-initial.rows});
    }
    window.stableBody = body;
    return samples;
  })()`);
  assert.ok(samples.every(s => s.sameNode), 'progress updates must retain the body DOM node');
  assert.ok(samples.every(s => s.bodyOutsideTrace && s.disclosureRetained && s.disclosureClosed),
    'progress updates retain a collapsed disclosure and its independent body sibling');
  assert.ok(samples.every(s => s.textRetained), 'progress updates must never clear visible body text');
  assert.ok(samples.every(s => s.heightDelta === 0 && s.topDelta === 0 && s.composerDelta === 0 && s.scrollDelta === 0 && s.addedRows === 0),
    `progress-only updates must not move the reading position: ${JSON.stringify(samples)}`);
  await js('chatProgressHarness.emitDocumentChunk("rest")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("客户留存稳定")');
  assert.equal(await js('window.stableBody === document.querySelector("[aria-label=生成正文]")'), true);
  await js('chatProgressHarness.finishDocument()');
  await until('chatProgressHarness.state().localGenerationPending');
  assert.equal(await js('window.stableBody === document.querySelector("[aria-label=生成正文]")'), true);
  await js('chatProgressHarness.finishLocalDocument()');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告（已校验）")');
  assert.equal(await js('window.stableBody === document.querySelector("[aria-label=生成正文]")'), true);
  await assertClean();
  assert.deepEqual(errors, []);
  if (strictMode) {
    const lifecycleWarnings = consoleMessages.filter(({ message }) =>
      /Maximum update depth exceeded|Cannot update a component|Uncaught|Unhandled|ReferenceError|TypeError|controlled input/i.test(message));
    assert.deepEqual(lifecycleWarnings, [], 'StrictMode lifecycle warnings');
  }
  assert.deepEqual(blockedRequests, []);
  await capture(strictMode ? 'stream-stability-strict-mode.png' : 'stream-stability.png');
  const report = {scope:'Real ChatPage, synthetic IPC, isolated profile; no model or network calls', strictMode, samples,
    bodyRetainedThroughContentAndCompletion:true, errors, blockedRequests};
  await writeFile(path.join(output, strictMode ? 'stream-stability-strict-mode.json' : 'stream-stability.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function verifyR45Continuations() {
  await js('chatProgressHarness.enableContinuations()');
  const initialCounters = await js('chatProgressHarness.state().counters');
  const mount = async scenario => {
    await js(`chatProgressHarness.mount(${JSON.stringify(scenario)})`);
    await until('document.querySelector("[aria-label=原任务等待状态]") && document.body.innerText.includes("合成模型")');
  };
  const input = async value => {
    await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
    await window.webContents.insertText(value);
    await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  };
  const send = async () => js('document.querySelector("button[aria-label=发送消息]").click()');

  await mount('r45-waiting');
  const first = (await js('chatProgressHarness.state().agentSessions'))[0];
  await capture('r45-waiting.png');
  await input('主题是龙的传说，给小学生看'); await send();
  await until('chatProgressHarness.state().continuationRequests.length === 1 && document.querySelector("textarea[aria-label=对话输入]").value === ""');
  let state = await js('chatProgressHarness.state()');
  assert.deepEqual(state.continuationRequests[0].continuation, {
    sessionId: first.sessionId, expectedRevision: first.revision, resumeToken: first.resumeToken, action: 'reply'
  });
  assert.equal(state.agentSessions[0].sessionId, first.sessionId);
  assert.equal(state.agentSessions[0].deadlineAt, first.deadlineAt);
  checks.push('waiting answer carries the original parent, revision and nonce while preserving its deadline');

  await mount('r45-authorization');
  const authorization = (await js('chatProgressHarness.state().agentSessions'))[0];
  await js('(() => { const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("确认执行原任务")); b.click(); b.click(); })()');
  await until('chatProgressHarness.state().continuationRequests.length === 1 && chatProgressHarness.state().agentSessions[0].state === "waiting_user" && !document.querySelector("button[aria-label=停止生成]")');
  state = await js('chatProgressHarness.state()');
  assert.equal(state.continuationRequests.length, 1);
  assert.deepEqual(state.continuationRequests[0].continuation, {
    sessionId: authorization.sessionId, expectedRevision: authorization.revision, resumeToken: authorization.resumeToken, action: 'authorize'
  });
  checks.push('two confirmation clicks before the IPC reply consume one versioned continuation');

  await mount('r45-waiting');
  const beforeRestart = (await js('chatProgressHarness.state().agentSessions'))[0];
  await js('chatProgressHarness.rotateContinuationChallenge(); chatProgressHarness.mount("reopen")');
  await until('document.querySelector("[aria-label=原任务等待状态]") && document.body.innerText.includes("合成模型")');
  const restarted = (await js('chatProgressHarness.state().agentSessions'))[0];
  assert.notEqual(restarted.resumeToken, beforeRestart.resumeToken); assert.equal(restarted.sessionId, beforeRestart.sessionId);
  assert.equal(restarted.deadlineAt, beforeRestart.deadlineAt);
  assert.equal((await js('chatProgressHarness.state().continuationRequests')).length, 0);
  await input('补充企业培训主题'); await send();
  await until('chatProgressHarness.state().continuationRequests.length === 1 && document.querySelector("textarea[aria-label=对话输入]").value === ""');
  assert.equal((await js('chatProgressHarness.state().continuationRequests'))[0].continuation.resumeToken, restarted.resumeToken);
  checks.push('reopened waiting UI uses the refreshed Host nonce without dispatching on mount');

  await mount('r45-expired-and-waiting');
  assert.doesNotMatch(await js('document.querySelector("[aria-label=原任务等待状态]").textContent'), /达到时限|发起新任务/);
  const newest = (await js('chatProgressHarness.state().agentSessions'))[1];
  await input('新任务主题为销售培训'); await send();
  await until('chatProgressHarness.state().continuationRequests.length === 1 && document.querySelector("textarea[aria-label=对话输入]").value === ""');
  assert.equal((await js('chatProgressHarness.state().continuationRequests'))[0].continuation.sessionId, newest.sessionId);
  await capture('r45-new-waiting-over-old-expired.png');
  checks.push('an older expired row cannot hide the new waiting parent or its nonce');

  await mount('r45-unknown-planning');
  await js('(() => { const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("确认关闭本次任务")); b.click(); b.click(); })()');
  await until('!document.querySelector("[aria-label=原任务等待状态]")');
  state = await js('chatProgressHarness.state()');
  assert.equal(state.sessionCloseRequests.length, 1); assert.equal(state.sessionCloseRequests[0].closeUnknown, true);
  assert.equal(state.closedPlanningEvidence, true); assert.equal(state.continuationRequests.length, 0);
  assert.equal(state.agentSessions[0].registeredWorkCount, 1);
  await capture('r45-planning-unknown-explicit-close.png');
  checks.push('explicit planning-only close preserves unknown evidence and Work count without any continuation');

  await mount('r45-unknown-response');
  assert.equal(await js('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("确认关闭本次任务"))'), false);
  await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("核对执行结果")).click()');
  await until('document.querySelector("[aria-label=确认关闭待核对任务]")');
  await js('document.querySelector("[aria-label=确认关闭待核对任务] input").click()');
  await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("确认关闭任务")&&!b.disabled)');
  await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("确认关闭任务")).click()');
  await until('!document.querySelector("[aria-label=原任务等待状态]")');
  assert.equal((await js('chatProgressHarness.state().sessionCloseRequests')).length, 0);
  checks.push('bound unknown response retains the inspected acknowledgement flow and refreshes the closed parent');

  await mount('r45-unknown-expired');
  await input('继续'); await send();
  await until('document.body.innerText.includes("请先核对未知结果")');
  state = await js('chatProgressHarness.state()');
  assert.equal(state.continuationRequests.length, 0); assert.equal(state.sessionCloseRequests.length, 0);
  assert.equal(await js('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("发起新任务"))'), false);
  assert.equal(state.agentSessions[0].state, 'needs_reconciliation');
  await capture('r45-unknown-after-deadline.png');
  checks.push('an unknown result still blocks sending and new-task controls beyond its deadline');

  const final = await js('chatProgressHarness.state().counters');
  assert.equal(final.starts, initialCounters.starts); assert.equal(final.workflows, initialCounters.workflows);
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  if (strictMode) assert.deepEqual(consoleMessages.filter(({ message }) => /Maximum update depth exceeded|Cannot update a component|Uncaught|Unhandled|ReferenceError|TypeError|controlled input/i.test(message)), []);
  const report = { scope: 'Real ChatPage in isolated Electron; synthetic continuation IPC, HTTP(S) denied, no provider calls', strictMode,
    environment: { platform: os.platform(), electron: process.versions.electron, chromium: process.versions.chrome },
    checks, errors, blockedRequests, counters: final,
    limitations: ['Restart nonce is a synthetic Host reply; durable recovery and primary metadata checks are covered by production Host tests.'] };
  await writeFile(path.join(output, strictMode ? 'report-r45-strict-mode.json' : 'report-r45.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function run() {
  await mkdir(output, { recursive: true });
  await app.whenReady();
  await require('vite').build({ configFile: false, root: workspace, logLevel: 'silent',
    mode: strictMode ? 'development' : 'production',
    define: { 'process.env.NODE_ENV': strictMode ? '"development"' : '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: buildDirectory, emptyOutDir: false, minify: false,
      rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
      lib: { entry: path.join(workspace, 'tests/harness/chat-production-progress-harness.tsx'), formats: ['iife'],
        name: 'ChatProgressHarness', fileName: () => 'harness.js' } }
  });
  // The isolated conversation host can be narrower than the full app's 800px minimum.
  await writeFile(path.join(buildDirectory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>html,body,#root{margin:0;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}#root>.uc-chat-page{height:100%}</style></head><body><div id="root" class="workspace workspace--chat"></div><script src="harness.js"></script></body></html>');
  const copyPreload = path.join(buildDirectory,'copy-preload.cjs');
  if(copyMessages) await writeFile(copyPreload, `const {contextBridge}=require('electron');
    const {textClipboard}=require(${JSON.stringify(path.join(workspace,'dist-electron/electron/text-clipboard.js'))});
    contextBridge.exposeInMainWorld('__unicompClipboardForVerification',textClipboard);`);
  window = new BrowserWindow({ show: false, width: 1280, height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false, offscreen: true,
      ...(copyMessages ? {preload:copyPreload,sandbox:false} : {}) } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    blockedRequests.push(new URL(request.url).origin);
    callback({ cancel: true });
  });
  window.webContents.on('console-message', (_event, level, message) => {
    consoleMessages.push({ level, message });
    if (level >= 3) errors.push(message);
  });
  await window.loadFile(path.join(buildDirectory, 'index.html'));
  if (r0136) await js('chatProgressHarness.enableCanonicalTrace()');
  await until('window.chatProgressHarness?.ready && document.querySelector("[aria-label=生产进度]")');
  await until('document.body.innerText.includes("合成模型")');
  if (copyMessages) return verifyMessageCopy();
  if (composerBoundary) return verifyComposerBoundary();
  if (progressSummary) return verifyProgressSummary();
  if (r45) return verifyR45Continuations();
  if (process.argv.includes('--stream-stability')) return verifyStreamStability();
  let value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.summaries.length, 1);
  assert.equal(value.details, 0, 'no completed events means no fabricated step list');
  assert.equal(value.replyStatus, 0);
  assert.doesNotMatch(value.text, /当前没有已登记的文本候选/);
  checks.push('saved document: one summary, no fabricated stages, no raw outline or reasoning');
  await capture('saved-document.png');

  await js('chatProgressHarness.mount("new-chat")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('请分析这些资料。');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending && document.querySelectorAll(".uc-chat-production-trace > li").length === 2');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.assistants, 1);
  assert.equal(value.details, 1);
  assertCollapsed(value);
  assert.equal((await js('chatProgressHarness.state().counters')).starts, 0);
  await until('chatProgressHarness.state().commandSubscriptions === 0 && chatProgressHarness.state().conversationSubscriptions === 1');
  assert.deepEqual(value.trace.map(e => e.code), ['request_received', 'model_request']);
  assert.match(value.trace[0].text, /请分析这些资料/);
  assert.match(value.trace[1].text, /本地 → 模型.*发送模型请求.*已开始/);
  checks.push('new-conversation planning: events appear before workflow returns, then command subscription hands off to one conversation subscription');
  await capture('planning-pending.png');

  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().subscribed && document.querySelectorAll(".uc-chat-production-trace > li").length === 8');
  await until('document.body.innerText.includes("这是合成的普通回复正文")');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.replyStatus, 0);
  assert.equal(value.assistants, 1, 'the temporary planning message must bind to the actual response');
  assert.equal(value.details, 1, 'real trace facts are available in one collapsed disclosure');
  assertCollapsed(value);
  assert.match(value.text, /这是合成的普通回复正文/);
  assert.equal(value.bodies.length, 0, 'ordinary chat keeps its normal reply without a second generated-body panel');
  assert.equal(value.text.match(/这是合成的普通回复正文/g).length, 1);
  const traceText = value.trace.map((item) => item.text).join('\n');
  assert.match(traceText, /模型 → 本地/);
  assert.match(traceText, /本地工具/);
  checks.push('model response: all eight real events stay available in a collapsed disclosure alongside visible ordinary content');
  await capture('ordinary-reply.png');

  await js('chatProgressHarness.completeResponse()');
  await until('!chatProgressHarness.state().subscribed');
  await js('chatProgressHarness.emitTrace("document_compile", "started", {documentKind:"ppt"}, "assistant"); chatProgressHarness.emitTrace("document_compile", "completed", {documentKind:"ppt"}, "assistant"); chatProgressHarness.emitTrace("document_render", "failed", undefined, "assistant")');
  await until('document.querySelector(".uc-chat-document-progress__summary")?.textContent.includes("渲染文档 · 失败")');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.summaries.length, 1);
  assert.equal(value.replyStatus, 0);
  assert.equal(value.assistants, 1);
  assert.equal(value.trace.length, 11, 'streaming model-response progress is shown as one stable row');
  assert.deepEqual(value.trace.slice(-3).map(e => e.status), ['started', 'completed', 'failed']);
  assertCollapsed(value);
  assert.match(value.text, /渲染文档\s*·\s*失败/, 'failure remains visible while execution details are collapsed');
  assert.match(value.text, /这是合成的普通回复正文/, 'task progress must retain ordinary reply content');
  checks.push('local document events continue after text streaming ends, and a failed event is visibly marked as failure');
  await capture('production-progress-expanded.png');

  await js('chatProgressHarness.emitTrace("document_structure_check", "completed", {totalPages:3}, "assistant"); chatProgressHarness.emitTrace("document_hash_check", "completed", {bytes:1024}, "assistant"); chatProgressHarness.emitTrace("document_publish", "completed", undefined, "assistant"); chatProgressHarness.emitTrace("document_register", "completed", undefined, "assistant"); chatProgressHarness.emitTrace("task_complete", "completed", undefined, "assistant")');
  await until('document.querySelector(".uc-chat-document-progress__summary")?.textContent.includes("结束任务 · 已完成")');
  await js('chatProgressHarness.replay()');
  value = await assertClean();
  assert.equal(value.summaries.length, 1);
  assert.equal(value.trace.length, 16, 'duplicate and out-of-order replay must not add duplicate events');
  assert.deepEqual(value.trace.slice(-5).map(e => e.code), ['document_structure_check', 'document_hash_check', 'document_publish', 'document_register', 'task_complete']);
  assert.match(value.text, /这是合成的普通回复正文/);
  checks.push('publication: structure, file integrity, publish and registration events remain ordered after duplicate reversed replay');
  if (r0136) {
    await js('chatProgressHarness.replay(true)');
    value = await assertClean();
    assert.equal(value.trace.length, 16, 'canonical replay with a different project sequence remains one row per run event');
    assert.deepEqual(value.trace.slice(-5).map(e => e.code), ['document_structure_check', 'document_hash_check', 'document_publish', 'document_register', 'task_complete']);
    assert.doesNotMatch(value.text, /private-canonical-run|private-run-event/);
    const state = await js('chatProgressHarness.state()');
    assert.equal(state.canonicalTraceCount, state.traceCount);
    checks.push('canonical run event replay: different projection sequences preserve row count and order without displaying internal IDs');
  }
  window.setSize(1024, 768);
  await capture('production-progress-compact.png');

  await js('chatProgressHarness.mount("reopen")');
  await until('document.querySelectorAll(".uc-chat-production-trace > li").length === 16');
  value = await assertClean();
  assert.equal(value.assistants, 1);
  assert.equal(value.details, 1);
  assertCollapsed(value);
  checks.push('history reopening restores saved facts on the original assistant in one collapsed disclosure');
  await js('chatProgressHarness.issue()');
  await until('document.body.innerText.includes("生产记录不完整")');
  checks.push('a recording issue is shown explicitly instead of implying a complete execution history');
  await capture('production-progress-history.png');

  await js('chatProgressHarness.mount("saved-completed")');
  await until('document.querySelector("[aria-label=生产进度]")?.textContent.includes("文档已生成并保存")');
  value = await assertClean();
  assert.equal(value.progress, 1);
  assert.equal(value.details, 0);
  checks.push('reopened completed document hides historical reasoning and does not invent completed events');
  await js('chatProgressHarness.mount("saved-terminal-stale")');
  await until('document.querySelectorAll(".uc-chat-production-trace > li").length === 1');
  value = await assertClean();
  assert.match(value.summaries[0], /文档已生成并保存/);
  assert.equal(value.trace[0].status, 'started');
  assertCollapsed(value);
  assert.doesNotMatch(value.summaries[0], /已开始/);
  checks.push('persisted document completion takes summary precedence over a truncated trace whose last event only started');

  await js('chatProgressHarness.mount("saved-markdown")');
  await until('document.querySelector("[aria-label=生成正文]")');
  value = await assertClean();
  assert.match(value.text, /年度报告/);
  assert.match(value.text, /收入保持增长/);
  checks.push('plain Markdown document content falls back to readable body rendering');

  await js('chatProgressHarness.mount("document")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('制作一份年度经营报告 PPT');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending && document.querySelectorAll(".uc-chat-production-trace > li").length === 2');
  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().counters.starts >= 2 && chatProgressHarness.state().subscribed');
  assert.equal((await snapshot()).bodies.length, 0, 'an empty model response must not fabricate document body');
  await js('chatProgressHarness.emitDocumentChunk("title")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营")');
  value = await assertClean();
  assert.equal(value.bodies.length, 1);
  assert.doesNotMatch(value.bodies[0], /增长概览|营收增长来自/);
  await js('chatProgressHarness.emitDocumentChunk("paragraph")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告") && document.querySelector("[aria-label=生成正文]")?.textContent.includes("增长概览") && document.querySelector("[aria-label=生成正文]")?.textContent.includes("营收增长来自")');
  value = await assertClean();
  assert.match(value.text, /增长概览/);
  assert.match(value.text, /营收增长来自/);
  assert.equal(value.bodies.length, 1);
  assertCollapsed(value);
  assert.equal(value.remoteImages, 0, 'document body must not load remote image Markdown');
  assert.equal(value.text.match(/营收增长来自/g).length, 1);
  assert.doesNotMatch(value.text, /PRIVATE_REASONING|PRIVATE_PATH|sections|blocks/);
  checks.push('document body renders readable text while canonical JSON is still arriving in chunks');
  await captureBody('document-body-streaming.png');
  await js('chatProgressHarness.emitDocumentChunk("rest")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("客户留存稳定")');
  await js('chatProgressHarness.finishDocument()');
  await until('!chatProgressHarness.state().subscribed && chatProgressHarness.state().localGenerationPending');
  value = await assertClean();
  assert.equal(value.bodies.length, 1);
  assert.match(value.bodies[0], /营收增长来自核心业务的持续改善/);
  assert.equal(value.trace.at(-1).code, 'document_compile');
  assert.equal(value.trace.at(-1).status, 'started');
  checks.push('local document events continue after body stream completion while the body stays readable');
  await js('chatProgressHarness.finishLocalDocument()');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告（已校验）")');
  value = await assertClean();
  assert.match(value.text, /年度经营报告（已校验）/);
  assert.equal(value.bodies.length, 1);
  assert.doesNotMatch(value.bodies[0], /客户留存稳定|现金流改善/, 'the validated body replaces the original streamed payload');
  assert.doesNotMatch(value.text, /PRIVATE_REASONING|PRIVATE_PATH|sections|blocks/);
  checks.push('validated document body replaces the streamed draft after response completion');
  await captureBody('document-body-validated.png');
  await js('chatProgressHarness.mount("reopen")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("年度经营报告（已校验）")');
  value = await assertClean();
  assert.equal(value.bodies.length, 1);
  assert.equal(value.assistants, 1);
  assert.match(value.bodies[0], /营收增长来自核心业务的持续改善/);
  assert.doesNotMatch(value.bodies[0], /客户留存稳定|现金流改善/);
  checks.push('history restores the validated document body and all saved execution events on one assistant');
  await captureBody('document-body-history.png');

  await js('chatProgressHarness.mount("document-cancel")');
  await until('document.querySelector("textarea[aria-label=对话输入]") && document.body.innerText.includes("合成模型")');
  await js('document.querySelector("textarea[aria-label=对话输入]").focus()');
  await window.webContents.insertText('制作一份可取消的报告');
  await until('!document.querySelector("button[aria-label=发送消息]").disabled');
  await js('document.querySelector("button[aria-label=发送消息]").click()');
  await until('chatProgressHarness.state().planningPending');
  await js('chatProgressHarness.finishPlanning()');
  await until('chatProgressHarness.state().counters.starts >= 3 && chatProgressHarness.state().subscribed');
  await js('chatProgressHarness.emitDocumentChunk("paragraph")');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("营收增长来自")');
  await js('chatProgressHarness.cancelDocument(); chatProgressHarness.finishDocument()');
  await until('!chatProgressHarness.state().subscribed');
  await until('document.querySelector("[aria-label=生成正文]")?.textContent.includes("增长概览")');
  value = await assertClean();
  assert.match(value.text, /营收增长来自/);
  assert.equal(value.bodies.length, 1);
  assertCollapsed(value);
  assert.match(value.text, /已取消/, 'cancellation remains visible outside collapsed execution details');
  assert.doesNotMatch(value.bodies[0], /核心业务的持续改善/);
  checks.push('cancelled document response keeps the already streamed readable body fragment');
  await captureBody('document-body-cancelled.png');
  const visualGeometry = [];
  visualGeometry.push(await verifyConversationLayout('codex-conversation', 1280, 820, 'light', 'codex-desktop.png'));
  visualGeometry.push(await verifyConversationLayout('codex-conversation', 760, 768, 'light', 'codex-compact.png'));
  visualGeometry.push(await verifyConversationLayout('codex-conversation', 540, 768, 'light', 'codex-narrow.png'));
  visualGeometry.push(await verifyConversationLayout('codex-conversation', 1280, 820, 'dark', 'codex-dark.png'));
  visualGeometry.push(await verifyConversationLayout('codex-document', 1280, 820, 'light', 'codex-document.png'));
  await verifyDisclosure();
  visualGeometry.push(await verifyConversationLayout('codex-document', 540, 768, 'dark', 'codex-document-narrow.png'));
  window.setSize(1280, 820);
  await js('chatProgressHarness.mount("codex-preview", "light")');
  await until('document.querySelector(".uc-markdown-message")?.textContent.includes("各地赋予龙不同的含义")');
  await delay(150);
  await js(`(() => {
    const viewport = document.querySelector('.uc-chat-page__messages');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', {bubbles:true}));
  })()`);
  await delay(100);
  const copyVisible = await js(`(() => {
    const copy = document.querySelector('.uc-chat-page__message-item--assistant button[aria-label="复制消息"]');
    return copy?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) &&
      copy.getBoundingClientRect().bottom < document.querySelector('.uc-chat-page__composer').getBoundingClientRect().top;
  })()`);
  assert.equal(copyVisible, true, 'the representative preview includes the visible assistant copy action');
  await capture('codex-preview.png');
  checks.push('representative short conversation preview keeps the assistant copy action visible above the composer');
  if (process.argv.includes('--r0289')) {
    const before = await js('chatProgressHarness.state().counters');
    await js('chatProgressHarness.mount("frozen-parent")');
    await until('document.querySelector("[aria-label=任务结果待核对]")');
    assert.doesNotMatch(await js('document.querySelector(".uc-chat-document-progress__summary")?.textContent ?? ""'), /正在生成文档/);
    await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("核对执行结果")).click()');
    await until('document.querySelector("[aria-label=确认关闭待核对任务]")');
    assert.equal(await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("确认关闭任务")).disabled'), true);
    assert.equal((await js('chatProgressHarness.state().counters')).acknowledgements, before.acknowledgements);
    await capture('r0289-reconciliation.png');
    await js('document.querySelector("[aria-label=确认关闭待核对任务] input").click()');
    await until('Array.from(document.querySelectorAll("button")).some(b => b.textContent.includes("确认关闭任务") && !b.disabled)');
    await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("确认关闭任务")).click()');
    await until('document.body.innerText.includes("本次任务已确认关闭")');
    const after = await js('chatProgressHarness.state().counters');
    assert.equal(after.inspections, before.inspections + 1);
    assert.equal(after.acknowledgements, before.acknowledgements + 1);
    assert.equal(after.starts, before.starts, 'closing reconciliation never resubmits a model request');
    assert.equal(after.workflows, before.workflows);
    assert.match(await js('document.body.innerText'), /未知结果记录仍保留/);
    checks.push('unknown parent state remains visible; explicit checked confirmation closes it once without starting a model or tool');
  }
  if (retainedResults) {
    for (const [scenario, status] of [['saved-retained-failed', 'failed'], ['saved-retained-cancelled', 'cancelled'], ['saved-retained-unknown', 'interrupted']]) {
      const before = await js('chatProgressHarness.state().counters');
      await js(`chatProgressHarness.mount(${JSON.stringify(scenario)})`);
      await until('document.querySelector("[aria-label=\\\"已保留的 PPT 文件\\\"]")');
      const current = await assertClean();
      assert.equal(await js('document.querySelectorAll("[aria-label=\\\"已保留的 PPT 文件\\\"]").length'), 1);
      assert.match(current.text, /已保留 6 页 PPT，12 页规划目标尚未达到/);
      assert.equal(await js('document.querySelector("[aria-label=生产进度]").dataset.status'), status);
      assert.equal(await js('document.querySelectorAll("[aria-label=\\\"生成的 Office 文档\\\"]").length'), 0);
      if (scenario === 'saved-retained-unknown') assert.ok(await js('Boolean(document.querySelector("[aria-label=任务结果待核对]"))'));
      await capture(`${scenario}.png`);
      await js('chatProgressHarness.mount("reopen")');
      await until('document.querySelector("[aria-label=\\\"已保留的 PPT 文件\\\"]")');
      assert.equal(await js('document.querySelectorAll("[aria-label=\\\"已保留的 PPT 文件\\\"]").length'), 1);
      const after = await js('chatProgressHarness.state().counters');
      assert.equal(after.starts, before.starts);
      assert.equal(after.workflows, before.workflows);
      assert.equal(after.acknowledgements, before.acknowledgements);
      checks.push(`${scenario}: verified file remains visible once after reopening, with its original stopped/unknown task state and no new request`);
    }
    await js('chatProgressHarness.mount("saved-retained-legacy")');
    await until('document.querySelector("[aria-label=\\\"已保留的 PPT 文件\\\"]")');
    const card = await js('document.querySelector("[aria-label=\\\"已保留的 PPT 文件\\\"]").textContent');
    assert.match(card, /已保留 6 页 PPT/);
    assert.doesNotMatch(card, /12 页|规划目标/);
    checks.push('old publication receipt without a structured goal displays only physical pages');
  }
  assert.deepEqual(errors, [], 'renderer errors');
  if (strictMode) {
    const lifecycleWarnings = consoleMessages.filter(({ message }) =>
      /Maximum update depth exceeded|Cannot update a component|Uncaught|Unhandled|ReferenceError|TypeError|controlled input/i.test(message));
    assert.deepEqual(lifecycleWarnings, [], 'StrictMode lifecycle warnings');
  }
  assert.deepEqual(blockedRequests, [], 'the isolated UI must not attempt external requests');
  const report = { scope: 'Real ChatPage and DocumentProgress; synthetic IPC, isolated userData, HTTP(S) denied, no model calls', strictMode,
    environment: { platform: os.platform(), electron: process.versions.electron, chromium: process.versions.chrome },
    checks, visualGeometry, errors, blockedRequests, consoleMessages, counters: await js('chatProgressHarness.state().counters'),
    limitations: ['Component-level real Electron renderer with synthetic IPC; full AppLayout/preload and OS-level input are outside this harness.',
      '760px/540px cases constrain the component host below the production shell minimum of 800px; shell sizing is unchanged.',
      'No provider calls, credentials, network requests or document creation are used for this UI verification.'] };
  const reportName = retainedResults ? strictMode ? 'report-retained-strict-mode.json' : 'report-retained.json'
    : r0136 ? strictMode ? 'report-r0136-strict-mode.json' : 'report-r0136.json'
    : process.argv.includes('--r0289') ? strictMode ? 'report-r0289-strict-mode.json' : 'report-r0289.json'
    : strictMode ? 'report-strict-mode.json' : 'report.json';
  await writeFile(path.join(output, reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
async function finish(code) {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) {
    await js('window.chatProgressHarness?.unmount()').catch(() => undefined);
    window.destroy();
  }
  // Chromium can hold the isolated profile until process exit on Windows.
  // Remove only the generated build here; the profile stays in the OS temp area.
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.equal(path.dirname(path.resolve(buildDirectory)), path.resolve(temporary));
  await rm(buildDirectory, { recursive: true, force: true });
  console.log(`CHAT_PRODUCTION_PROGRESS_VERIFICATION_EXIT=${code}`);
  app.exit(code);
}
run().then(() => finish(0), async (error) => {
  console.error(error, errors);
  if (window && !window.isDestroyed()) console.error(await snapshot().catch(() => ({})));
  await finish(1);
});
