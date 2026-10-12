const { ipcMain } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const domain = require('../../dist-electron/src/domain');
const { JsonWorkRepository, NodeProjectStorage } = require('../../dist-electron/src/platform');
const { PlatformDocumentGenerationExecutor } = require('../../dist-electron/src/platform/documents/document-generation-application-adapters');
const { registerConversationProductionIpcHandlers } = require('../../dist-electron/electron/ipc/conversation-production-ipc');

// Isolated renderer uses production React, preload, IPC, Tool runtime and local
// Office generation. Only Provider transport and a bounded render wait are fake.
module.exports = async function verifyDocumentNavigation({ browserWindow, lifecycle, session, candidateId, setTransportMode }) {
  const vite = await require('vite').createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
  const js = source => browserWindow.webContents.executeJavaScript(source);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (condition, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await delay(100);
    }
    throw new Error(`Document navigation: ${label}; renderer=${await js('document.body.innerText.slice(-3000)')}`);
  };
  const channels = ['storage:get-project-session', 'storage:list-projects'];
  const production = registerConversationProductionIpcHandlers({ getSession: () => session });
  ipcMain.handle(channels[0], () => ({ ok: true, value: { projectId: session.projectId,
    projectName: session.projectName, projectPath: session.rootDirectory } }));
  ipcMain.handle(channels[1], () => ({ ok: true, value: [] }));
  const outputDirectory = path.resolve('outputs/document-navigation');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let generationCount = 0;
  const run = PlatformDocumentGenerationExecutor.prototype.run;
  PlatformDocumentGenerationExecutor.prototype.run = async function (input) {
    generationCount += 1;
    await gate;
    return run.call(this, input);
  };
  try {
    await vite.listen();
    const origin = vite.resolvedUrls.local[0];
    const url = new URL('tests/electron/document-navigation.html', origin);
    url.searchParams.set('projectId', session.projectId);
    url.searchParams.set('candidateId', candidateId);
    await browserWindow.setSize(1280, 820);
    await browserWindow.loadURL(url.href);
    await wait(() => js('Boolean(document.querySelector("textarea[aria-label=对话输入]:not(:disabled)"))'), 'composer ready');
    setTransportMode('tool-call');
    await js(`(()=>{const input=document.querySelector('textarea[aria-label="对话输入"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'帮我生成一个测试ppt');
      input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(() => js('Boolean(document.querySelector("[aria-label=发送消息]:not(:disabled)"))'), 'draft ready');
    await js('document.querySelector("[aria-label=发送消息]").click()');
    await wait(() => generationCount === 1, 'generation tool started');
    const before = await js(`(async()=>{const list=await window.unicomp.chatContexts.listThreadSummaries({includeArchived:true,includeDeleted:false,limit:100});
      const thread=list.value.items.find(item=>item.title.includes('帮我生成'));return window.unicomp.chatContexts.getThread(thread.threadId);})()`);
    const active = before.value.parentRuns.find(item => item.state === 'executing_tool');
    if (!active) throw new Error('Expected live document task');
    const visits = [];
    for (let visit = 0; visit < 3; visit += 1) {
      await js('document.getElementById("fixture-leave").click()');
      await wait(() => js('!document.querySelector(".uc-chat-page")'), 'page unmounted');
      await js('document.getElementById("fixture-return").click()');
      await wait(() => js('Boolean(document.querySelector("[aria-label=停止生成]"))'), 'stop control restored');
      const execution = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(active.responseExecutionId)})`);
      if (!execution.ok || execution.value.state !== 'streaming' || execution.value.parentRun.state !== 'executing_tool') {
        throw new Error('Navigation changed the running task: ' + JSON.stringify(execution));
      }
      visits.push({ visit, state: execution.value.state, parentState: execution.value.parentRun.state, stopRestored: true });
    }
    release();
    await wait(async () => {
      const result = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(active.responseExecutionId)})`);
      return result.ok && result.value.state === 'completed' && result.value.parentRun?.state === 'completed';
    }, 'single generation completed');
    await wait(() => js('Boolean(document.querySelector(\'[aria-label="生成的 Office 文档"]\'))'), 'document receipt displayed');
    if (generationCount !== 1) throw new Error('Navigation duplicated generation');
    await js('document.getElementById("fixture-leave").click()');
    await wait(() => js('!document.querySelector(".uc-chat-page")'), 'completed page unmounted');
    await js('document.getElementById("fixture-return").click()');
    await wait(() => js('Boolean(document.querySelector(\'[aria-label="生成的 Office 文档"]\'))'), 'completed receipt restored');
    const generatedWorkCount = (await new JsonWorkRepository(new NodeProjectStorage(session.rootDirectory), session.projectId).list(session.projectId)).length;
    if (generatedWorkCount !== 1) throw new Error('Expected exactly one registered Work');

    // Historical JSON has no Work: render only the readable draft after each
    // remount. A tall composer must leave the last message reachable above it.
    const repository = await lifecycle.getConversationRepository(session);
    const now = domain.toIsoTimestamp(new Date().toISOString());
    let conversation = domain.createProjectConversation({ id: domain.toConversationId('document-navigation-draft'),
      projectId: session.projectId, title: '保留的文档草稿', createdAt: now });
    conversation = domain.addUserMessage(conversation, { id: domain.toMessageId('draft-user'), content: '生成一个测试ppt', createdAt: now });
    conversation = domain.addCompletedAssistantMessage(conversation, { id: domain.toMessageId('draft-disclosure'), content: '本次制作不联网搜索。',
      workflowReply: { workflowId: 'sources-navigation-0', revision: 0 }, createdAt: now });
    conversation = domain.addCompletedAssistantMessage(conversation, { id: domain.toMessageId('draft-outline'),
      content: JSON.stringify({ kind: 'ppt', title: '长文档草稿', sections: Array.from({ length: 15 }, (_, index) => ({
        heading: `第 ${index + 1} 页`, blocks: [{ type: 'paragraph', text: '导航后保留可读正文。'.repeat(30) }]
      })) }), createdAt: now });
    await repository.createImportedSnapshot(conversation);
    url.searchParams.set('conversationId', conversation.id);
    await browserWindow.loadURL(url.href);
    await wait(() => js('Boolean(document.querySelector("[aria-label=生成正文]"))'), 'draft preview restored');
    await js(`(()=>{const input=document.querySelector('textarea[aria-label="对话输入"]');input.style.height='180px';
      document.querySelector('.uc-chat-page__messages').scrollTo(0,1000000);})()`);
    await delay(700);
    await wait(() => js(`(()=>{const rows=[...document.querySelectorAll('[data-virtual-item-id]')];
      return rows.at(-1).getBoundingClientRect().bottom<=document.querySelector('.uc-chat-page__composer-region').getBoundingClientRect().top;})()`), 'last message clears tall composer');
    const layout = await js(`(()=>{const rows=[...document.querySelectorAll('[data-virtual-item-id]')];
      const composer=document.querySelector('.uc-chat-page__composer-region').getBoundingClientRect();
      const last=rows.at(-1).getBoundingClientRect();const pane=document.querySelector('.uc-chat-page__messages');
      return {lastBottom:last.bottom,composerTop:composer.top,scrollTop:pane.scrollTop,scrollHeight:pane.scrollHeight,
        composerHeight:composer.height,clientHeight:pane.clientHeight,paneBottom:pane.getBoundingClientRect().bottom,
        clearance:getComputedStyle(pane).getPropertyValue('--uc-chat-composer-clearance'),
        padding:getComputedStyle(document.querySelector('.uc-chat-page__messages-inner')).paddingBottom,
        readable:!!document.querySelector('[aria-label="生成正文"]'),rawJsonVisible:document.querySelector('.uc-chat-page__messages').innerText.includes('"sections":'),
        gaps:rows.slice(1).map((row,index)=>row.getBoundingClientRect().top-rows[index].getBoundingClientRect().bottom),
        truthfulStatus:document.querySelector('.uc-chat-page__messages').innerText.includes('尚未生成可交付文件')};})()`);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'draft-layout.png'), (await browserWindow.webContents.capturePage()).toPNG());
    if (!layout.readable || layout.rawJsonVisible || !layout.truthfulStatus || layout.lastBottom > layout.composerTop || layout.gaps.some(gap => gap < 23)) {
      throw new Error('Document layout regression: ' + JSON.stringify(layout));
    }
    const report = { status: 'passed', externalRequests: 0, generationCount, generatedWorkCount, completedReceiptRestored: true, visits, layout };
    await writeFile(path.join(outputDirectory, 'electron-navigation.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    release();
    PlatformDocumentGenerationExecutor.prototype.run = run;
    channels.forEach(channel => ipcMain.removeHandler(channel));
    await production.clearSubscriptions();
    await vite.close();
  }
};
