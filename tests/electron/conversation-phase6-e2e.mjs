import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-phase6-electron-project-'));
const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-phase6-electron-user-'));
const projectId = 'project-phase6-electron';
const threadCount = Math.max(1, Math.min(1000, Number(process.env.UNICOMP_E2E_THREADS ?? 3)));
const conversationIds = Array.from({ length: threadCount }, (_, index) =>
  `conversation-phase6-electron-${index.toString(36).padStart(3, '0')}`
);
const conversationId = conversationIds[0];
const useThreadFile = process.env.UNICOMP_E2E_THREAD_FILE !== '0';
const messageCount = Number(process.env.UNICOMP_E2E_MESSAGES ?? 120);
const collectTrace = process.env.UNICOMP_E2E_TRACE === '1';
const now = '2026-10-09T00:00:00.000Z';
const buildMessages = (threadId, threadIndex) => Array.from({ length: messageCount }, (_, index) => ({
  schemaVersion: 1,
  id: `message-phase6-${threadIndex}-${index}`,
  conversationId: threadId,
  revision: 0,
  role: index % 2 === 0 ? 'user' : 'assistant',
  state: 'completed',
  content: index % 2 === 0 ? `用户请求 ${threadIndex}-${index}` : `助手回复 ${threadIndex}-${index}\n\n${'```ts'}\nconst value${index} = ${index};\n${'```'}\n\n${index % 10 === 1 ? 'Long Markdown paragraph '.repeat(80) : ''}`,
  reasoningContent: index % 2 === 1 ? `reasoning-${threadIndex}-${index}` : undefined,
  attachments: [],
  createdAt: now,
  updatedAt: now,
  completedAt: now,
  streamSequence: 0
}));
const conversationDocument = {
  schemaVersion: 1,
  revision: 1,
  updatedAt: now,
  conversations: conversationIds.map((threadId, index) => ({
    schemaVersion: 1,
    id: threadId,
    revision: 1,
    projectId,
    title: `Electron phase 6 ${index + 1}`,
    status: 'active',
    messages: buildMessages(threadId, index),
    createdAt: now,
    updatedAt: now
  }))
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForUrl(url, timeoutMs = 30_000, json = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return json ? await response.json() : await response.text(); } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
function spawnProcess(command, args, env) {
  const child = spawn(command, args, { cwd: path.resolve('.'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  child.stdout.on('data', chunk => process.stderr.write(`[${path.basename(command)}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${path.basename(command)}] ${chunk}`));
  return child;
}
async function stopProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); killer.once('close', resolve); killer.once('error', resolve); });
  } else child.kill('SIGTERM');
}

class CdpClient {
  constructor(socketUrl) { this.socket = new WebSocket(socketUrl); this.nextId = 0; this.pending = new Map(); this.events = new Map(); this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve); this.socket.addEventListener('error', reject); }); this.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id !== undefined) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); return; } const listeners = this.events.get(message.method); if (!listeners) return; for (const listener of [...listeners]) listener(message.params); }); }
  async call(method, params = {}) { await this.ready; const id = ++this.nextId; const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); this.socket.send(JSON.stringify({ id, method, params })); return result; }
  waitForEvent(method, timeoutMs = 30_000) { return new Promise((resolve, reject) => { const listeners = this.events.get(method) ?? new Set(); this.events.set(method, listeners); const timer = setTimeout(() => { listeners.delete(onEvent); reject(new Error(`Timed out waiting for CDP event ${method}`)); }, timeoutMs); const onEvent = params => { clearTimeout(timer); listeners.delete(onEvent); resolve(params); }; listeners.add(onEvent); }); }
  async evaluate(expression, attempts = 5) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed');
        return result.result?.value;
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/iu.test(String(error)) || attempt === attempts - 1) throw error;
        await sleep(250);
      }
    }
    throw new Error('CDP evaluation retry exhausted');
  }
  close() { this.socket.close(); }
}

async function readCdpStream(cdp, handle) {
  let data = '';
  while (true) {
    const chunk = await cdp.call('IO.read', { handle });
    data += chunk.data ?? '';
    if (chunk.eof) break;
  }
  await cdp.call('IO.close', { handle });
  return data;
}
async function waitForExpression(cdp, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(expression)) return; } catch { /* retry while React mounts */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}
async function waitForCdpTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch('http://127.0.0.1:9229/json/list').then(response => response.json());
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch { /* retry while Electron initializes */ }
    await sleep(100);
  }
  throw new Error('Electron page target not found');
}

let vite;
let electron;
try {
  await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
  await writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: 'Electron phase 6', createdAt: now, updatedAt: now }, null, 2));
  await writeFile(path.join(projectRoot, 'entities', 'conversations.json'), `${JSON.stringify(conversationDocument)}\n`);
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, 'project-catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [{ projectId, projectName: 'Electron phase 6', rootDirectory: projectRoot, lastOpenedAt: now }] }, null, 2));

  const compiled = require('../../dist-electron/src/platform/repositories/thread-file-repository.js');
  const migrationModule = require('../../dist-electron/src/platform/repositories/thread-migration.js');
  const repository = new compiled.ThreadFileRepository(projectRoot);
  const migration = new migrationModule.LegacyThreadMigration(projectRoot, repository, { migrationId: 'electron-phase6' });
  await new migrationModule.LegacyFileMigrationRunner(path.join(projectRoot, 'entities', 'conversations.json'), migration).run();

  const viteEntry = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const electronCommand = require('electron');
  vite = spawnProcess(process.execPath, [viteEntry, '--host', '127.0.0.1'], { VITE_UNICOMP_THREAD_FILE_READ_PATH: '1', VITE_UNICOMP_E2E: '1' });
  await waitForUrl('http://127.0.0.1:5173', 30_000, false);
  electron = spawnProcess(electronCommand, ['.', '--remote-debugging-port=9229'], { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173', UNICOMP_TEST_USER_DATA: userData, UNICOMP_E2E: '1', ...(useThreadFile ? { UNICOMP_THREAD_FILE_READ_PATH: '1', VITE_UNICOMP_THREAD_FILE_READ_PATH: '1' } : {}) });
  const target = await waitForCdpTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  if (collectTrace) {
    await cdp.call('Tracing.start', {
      categories: 'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,blink.user_timing',
      transferMode: 'ReturnAsStream'
    });
  }
  const openResult = await cdp.evaluate(`window.unicomp.storage.openRecentProject(${JSON.stringify(projectId)})`);
  if (!openResult?.ok) throw new Error(`Project open failed: ${JSON.stringify(openResult)}`);
  await waitForExpression(cdp, `Boolean(document.querySelector('.uc-chat-page'))`);
  await waitForExpression(cdp, `document.querySelectorAll('.uc-chat-page__workspace-conversation').length >= ${Math.min(3, conversationIds.length)}`);
  await cdp.evaluate(`document.querySelector('.uc-chat-page__workspace-conversation')?.click()`);
  await waitForExpression(cdp, `document.querySelectorAll('[data-virtual-item-id]').length > 0`);
  await sleep(300);
  const uiInteraction = await cdp.evaluate(`(async()=>{const buttons=[...document.querySelectorAll('.uc-chat-page__workspace-conversation')];const switchCount=Math.min(buttons.length,3);for(let index=1;index<switchCount;index+=1){buttons[index]?.click();await new Promise(resolve=>setTimeout(resolve,250));}buttons[0]?.click();await new Promise(resolve=>setTimeout(resolve,300));const scroller=document.querySelector('.uc-chat-page__messages');const before={scrollTop:scroller?.scrollTop??0,scrollHeight:scroller?.scrollHeight??0,virtualRows:document.querySelectorAll('[data-virtual-item-id]').length};if(scroller){scroller.scrollTop=0;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));}await new Promise(resolve=>setTimeout(resolve,700));const olderButton=document.querySelector('.uc-chat-page__history-more button');if(olderButton){olderButton.click();await new Promise(resolve=>setTimeout(resolve,900));}return {switchCount,before,after:{scrollTop:scroller?.scrollTop??0,scrollHeight:scroller?.scrollHeight??0,virtualRows:document.querySelectorAll('[data-virtual-item-id]').length},paginationTriggered:Boolean(olderButton)};})()`);
  const readMetrics = await cdp.evaluate(`(async()=>{const listSamples=[],pageSamples=[],loopSamples=[];let summaryCount=0,pageCount=0;for(let sample=0;sample<5;sample+=1){const loop=window.unicomp.e2e?.sampleMainEventLoop(250);let start=performance.now();const summaries=await window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100});listSamples.push(performance.now()-start);start=performance.now();const page=await window.unicomp.chatContexts.getThreadItemsPage({threadId:${JSON.stringify(conversationId)},direction:'older',limit:30});pageSamples.push(performance.now()-start);const loopResult=await loop;if(loopResult)loopSamples.push(loopResult);summaryCount=summaries.value?.items?.length??0;pageCount=page.value?.items?.length??0;}const p=(values,f)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*f))]??0};const body=document.body;return {listSamples,pageSamples,listP50Ms:p(listSamples,.5),listP95Ms:p(listSamples,.95),pageP50Ms:p(pageSamples,.5),pageP95Ms:p(pageSamples,.95),mainLoopDuringRead:loopSamples,summaryCount,pageCount,domMessageRows:document.querySelectorAll('.uc-chat-page__message-item').length,virtualRows:document.querySelectorAll('[data-virtual-item-id]').length,interactive:!!body?.innerText,heapUsedBytes:performance.memory?.usedJSHeapSize??null};})()`);
  const semanticSignature = await cdp.evaluate(`(async()=>{const summaries=await window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100});const page=await window.unicomp.chatContexts.getThreadItemsPage({threadId:${JSON.stringify(conversationId)},direction:'older',limit:30});const value={summaryIds:(summaries.value?.items??[]).map(item=>item.threadId??item.conversationId),items:(page.value?.items??[]).map(item=>({itemId:item.itemId,sequence:item.sequence,messageId:item.message?.messageId,role:item.message?.role,content:item.message?.content,revision:item.message?.revision}))};return JSON.stringify(value);})()`);
  const mainLoop = await cdp.evaluate('window.unicomp.e2e?.sampleMainEventLoop(250)');
  const reactCommits = await cdp.evaluate('window.unicomp.e2e?.getReactMetrics() ?? []');
  const ipcMetrics = await cdp.evaluate('window.unicomp.e2e?.getIpcMetrics() ?? []');
  let recovery = undefined;
  if (process.env.UNICOMP_E2E_RESTART === '1') {
    cdp.close();
    await stopProcess(electron);
    electron = undefined;
    electron = spawnProcess(electronCommand, ['.', '--remote-debugging-port=9229'], { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173', UNICOMP_TEST_USER_DATA: userData, UNICOMP_E2E: '1', ...(useThreadFile ? { UNICOMP_THREAD_FILE_READ_PATH: '1', VITE_UNICOMP_THREAD_FILE_READ_PATH: '1' } : {}) });
    const targetAfterRestart = await waitForCdpTarget();
    const cdpAfterRestart = new CdpClient(targetAfterRestart.webSocketDebuggerUrl);
    await cdpAfterRestart.call('Runtime.enable');
    const reopened = await cdpAfterRestart.evaluate(`window.unicomp.storage.openRecentProject(${JSON.stringify(projectId)})`);
    await waitForExpression(cdpAfterRestart, `Boolean(document.querySelector('.uc-chat-page'))`);
    const afterRestartSignature = await cdpAfterRestart.evaluate(`(async()=>{const summaries=await window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100});const page=await window.unicomp.chatContexts.getThreadItemsPage({threadId:${JSON.stringify(conversationId)},direction:'older',limit:30});return JSON.stringify({summaryIds:(summaries.value?.items??[]).map(item=>item.threadId??item.conversationId),items:(page.value?.items??[]).map(item=>({itemId:item.itemId,sequence:item.sequence,messageId:item.message?.messageId,role:item.message?.role,content:item.message?.content,revision:item.message?.revision}))});})()`);
    recovery = { reopened: Boolean(reopened?.ok), signatureEqual: semanticSignature === afterRestartSignature };
    cdpAfterRestart.close();
  }
  let trace = undefined;
  if (collectTrace) {
    const complete = cdp.waitForEvent('Tracing.tracingComplete');
    await cdp.call('Tracing.end');
    const completed = await complete;
    if (completed.stream) {
      const traceText = await readCdpStream(cdp, completed.stream);
      const traceDirectory = path.resolve('outputs/conversation-phase6/traces');
      await mkdir(traceDirectory, { recursive: true });
      const tracePath = path.join(traceDirectory, `electron-${useThreadFile ? 'thread-file' : 'legacy'}-${conversationIds.length}threads-${messageCount}.json`);
      await writeFile(tracePath, traceText, 'utf8');
      const traceEvents = JSON.parse(traceText).traceEvents ?? [];
      const traceTimestamps = traceEvents.map(event => Number(event.ts)).filter(timestamp => Number.isFinite(timestamp) && timestamp > 0);
      const traceStartUs = traceTimestamps.length ? Math.min(...traceTimestamps) : 0;
      const traceEndUs = traceEvents.reduce((max, event) => {
        const timestamp = Number(event.ts);
        return timestamp > 0 ? Math.max(max, timestamp + Number(event.dur ?? 0)) : max;
      }, traceStartUs);
      trace = {
        path: tracePath,
        eventCount: traceEvents.length,
        layoutEvents: traceEvents.filter(event => ['Layout', 'UpdateLayoutTree'].includes(event.name)).length,
        paintEvents: traceEvents.filter(event => ['Paint', 'PrePaint'].includes(event.name)).length,
        longTaskEvents: traceEvents.filter(event => Number(event.dur ?? 0) >= 50_000).length,
        durationMs: Math.max(0, traceEndUs - traceStartUs) / 1000
      };
    }
  }
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: useThreadFile ? 'thread-file' : 'legacy', messageCount, threadCount: conversationIds.length, environment: { platform: process.platform, node: process.version }, flags: { main: useThreadFile, renderer: useThreadFile }, uiInteraction, readMetrics, semanticSignature, recovery, mainLoop, reactCommits, ipcMetrics, trace, measurementBoundary: 'real Electron renderer via CDP; Provider/Office calls intentionally not started', notMeasured: ['real Provider/Office E2E'] };
  const reportDirectory = path.resolve('outputs/conversation-phase6');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, `electron-e2e-${useThreadFile ? 'thread-file' : 'legacy'}-${conversationIds.length}threads-${messageCount}${process.env.UNICOMP_E2E_RESTART === '1' ? '-restart' : ''}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`conversation-phase6-electron-e2e ${JSON.stringify(result)}`);
  cdp.close();
} finally {
  await stopProcess(electron);
  await stopProcess(vite);
  await rm(projectRoot, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}
