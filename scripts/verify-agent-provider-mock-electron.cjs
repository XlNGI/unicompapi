const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const platform = require('../dist-electron/src/platform');
const fixture = require('./lib/r45-built-fixture.cjs');
const { registerChatContextIpcHandlers } = require('../dist-electron/electron/ipc/chat-context-ipc');
const { registerDocumentGenerationIpcHandlers } = require('../dist-electron/electron/ipc/document-generation-ipc');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});

const projectId = fixture.projectId;
const rootDirectoryPromise = mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-mock-electron-project-'));
const userDataPromise = mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-mock-electron-user-'));
let browserWindow;
let lifecycle;
let documentLifecycle;
let additionalRootDirectory;
let newApiRuntime;
let deepSeekRuntime;
let requestCount = 0;
let semanticRequestCount = 0;
let artDirectionRequestCount = 0;
const expectTemplateFallback = process.argv.includes('--template-fallback');
const nativeDocuments = process.argv.includes('--conversation-documents');
let nativeOfficeKind;
let abortCount = 0;
let transportMode = 'normal';
let toolCallCount = 0;
let toolCallId;
let streamGates;
const hostDiagnostics = [];

function sseResponse(model, text) {
  const chunk = { id: 'agent-mock-electron', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from(body); })() };
}

function sseToolCallResponse(model) {
  toolCallCount += 1;
  toolCallId = `mock-generate-pptx-${toolCallCount}`;
  const call = { index: 0, id: toolCallId, type: 'function', function: {
    name: 'generate_pptx', arguments: JSON.stringify({
      title: 'Electron Tool Calling 验收',
      content: '# Electron Tool Calling 验收\n\n## 受控 Office 工具\n真实 Electron 中执行隔离 PPT 生成。',
      presentationTemplate: 'business_minimal', requestedTotalPages: 3
    })
  } };
  const chunk = { id: 'agent-mock-tool-call', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from(body); })() };
}

function sseBusinessToolResponse(model, name, args) {
  const call = { index: 0, id: `mock-native-${++toolCallCount}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  const chunk = { id: 'native-document-audit', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] };
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`); })() };
}

function sseStreamResumeResponse(model) {
  if (!streamGates) throw new Error('Stream resume gates are not initialized');
  const packet = (content, finishReason = null) => `data: ${JSON.stringify({
    id: 'agent-mock-stream-resume', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }]
  })}\n\n`;
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: (async function* () {
    yield Buffer.from(packet('第一段到达。'));
    await streamGates.first;
    yield Buffer.from(packet('离页期间继续。'));
    await streamGates.final;
    yield Buffer.from(packet('返回后更新。', 'stop'));
    yield Buffer.from('data: [DONE]\n\n');
  })() };
}

function createStreamGates() {
  let releaseFirst;
  let releaseFinal;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const final = new Promise(resolve => { releaseFinal = resolve; });
  return { releaseFirst, releaseFinal, first, final };
}

const transport = {
  send: async ({ body, signal }) => {
    requestCount += 1;
    const payload = JSON.parse(Buffer.from(body).toString('utf8'));
    if (!payload.tools && payload.messages.some(message => message.role === 'system' && message.content.includes('UniComp 会话语义规划器'))) {
      semanticRequestCount += 1;
      const input = JSON.parse(payload.messages.find(message => message.role === 'user').content);
      const current = input.currentRequest;
      if (current === '随便生成吧，现在是测试' && (!input.context.recentUserMessages.includes('我现在要制作一个ppt，先讨论内容') ||
          !input.context.recentConversationMessages.some(message => message.role === 'assistant'))) {
        throw new Error('Semantic planning lost the preceding PPT discussion');
      }
      if (transportMode === 'discussion' || !/(?:生成|制作|颜色|排版|克制|专业)/u.test(current)) return sseResponse(payload.model, JSON.stringify({
        schemaVersion: 1, kind: 'chat', parameters: {}, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false
      }));
      const kind = /Word/iu.test(current) ? 'word' : /Excel/iu.test(current) ? 'excel' : 'ppt';
      const revise = /颜色|排版|克制|专业/u.test(current);
      return sseResponse(payload.model, JSON.stringify({ schemaVersion: 1, kind: 'document', action: revise ? 'revise' : 'create', documentKind: kind,
        ...(revise ? { targetHint: { unit: 'page', ordinal: 2, name: input.context.latestDocument?.fileName } } : {}), parameters: { topic: '合成文档验收', requirements: current },
        sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false }));
    }
    if (!payload.tools && payload.messages.some(message => message.role === 'system' && message.content.includes('Art Direction'))) {
      artDirectionRequestCount += 1;
      if (expectTemplateFallback) return sseResponse(payload.model, '{truncated');
      const serialized = payload.messages.find(message => typeof message.content === 'string' && message.content.includes('INPUT_DATA_BEGIN'))?.content;
      const begin = serialized?.lastIndexOf('INPUT_DATA_BEGIN');
      const end = serialized?.lastIndexOf('INPUT_DATA_END');
      const planningInput = begin >= 0 && end > begin ? JSON.parse(serialized.slice(begin + 'INPUT_DATA_BEGIN'.length, end).trim()) : undefined;
      if (planningInput?.designFeedback) {
        const prior = planningInput.designFeedback.previousDesign;
        return sseResponse(payload.model, JSON.stringify({ ...prior, pages: prior.pages.map(page => {
          if (!planningInput.designFeedback.targetPages.includes(page.pageNumber)) return page;
          const content = planningInput.outline.pages.find(item => item.pageNumber === page.pageNumber).contentRefs;
          const leaves = content.filter(ref => !content.some(other => other.startsWith(ref + '.')));
          return { ...page, designTree: { schemaVersion: 1, root: { nodeId: 'native-row', type: 'row', gap: 0.04,
            children: leaves.map((contentRef, index) => ({ nodeId: `native-${index}`, type: 'content', contentRef,
              weight: index === 0 ? 45 : 55, style: { fontSize: 26 } })) } } };
        }) }));
      }
      const brief = '# Electron Tool Calling 验收\n\n## 受控 Office 工具\n真实 Electron 中执行隔离 PPT 生成。';
      const { PlatformDocumentDraftCompiler } = require('../dist-electron/src/platform/documents/document-generation-application-adapters');
      const outline = new PlatformDocumentDraftCompiler().compile({ content: brief, kind: 'ppt', operation: 'create' });
      const design = require('../dist-electron/src/domain/entities/presentation-design-contract');
      const initial = design.buildFallbackPresentationDesignIR(outline);
      const inventory = design.buildPresentationArtDirectionInput({ outline, userRequirement: 'Synthetic offline autonomous composition' });
      const direction = { ...initial, pages: initial.pages.map((page, index) => {
        const refs = inventory.outline.pages[index].contentRefs;
        const leaves = refs.filter(ref => !refs.some(child => child.startsWith(ref + '.')));
        return { ...page, designTree: { schemaVersion: 1, root: { nodeId: 'mock-root', type: 'column', gap: 0.03,
          children: leaves.map((contentRef, item) => ({ nodeId: `mock-leaf-${item}`, type: 'content', contentRef, style: { fontSize: 28 } })) } } };
      }) };
      return sseResponse(payload.model, JSON.stringify(direction));
    }
    if (transportMode === 'stream-resume') return sseStreamResumeResponse(payload.model);
    if (transportMode === 'discussion') {
      const names = payload.tools?.map(tool => tool.function.name) ?? [];
      if (payload.tool_choice === 'required' || names.some(name => /^(?:generate_|revise_|write_|update_|delete_|add_)/u.test(name))) throw new Error('Discussion exposed document write tools');
      return sseResponse(payload.model, '先讨论天空主题的受众和内容，不生成文件。');
    }
    if (transportMode === 'native-office') {
      if (payload.messages.some(message => message.role === 'user' && message.content?.includes('【UniComp 受控文档生成合同】') &&
        message.content.includes('不要输出路径、凭证、Provider、模型选择、工具调用'))) throw new Error('Native Office workflow still forbids the business generation tool');
      const names = payload.tools?.map(tool => tool.function.name) ?? [];
      const name = nativeOfficeKind === 'word' ? 'generate_docx' : 'generate_xlsx';
      if (names.includes(name)) return sseBusinessToolResponse(payload.model, name, { title: '原生 Office 端到端验收',
        content: JSON.stringify({ kind: nativeOfficeKind, title: '原生 Office 端到端验收', sections: [{ heading: '验证事实', level: 1,
          blocks: nativeOfficeKind === 'word' ? [{ type: 'paragraph', text: 'NATIVE_OFFICE_ELECTRON_FACT' }]
            : [{ type: 'table', header: ['项目', '数量'], rows: [['NATIVE_OFFICE_ELECTRON_FACT', '3']] }] }] }) });
      if (names.includes('read_document_structure')) return sseBusinessToolResponse(payload.model, 'read_document_structure', { scope: 'document' });
      return sseResponse(payload.model, '文件已生成，真实文件读回已确认。');
    }
    if (transportMode === 'native-revision' || transportMode === 'native-noop') {
      const names = payload.tools?.map(tool => tool.function.name) ?? [];
      if (names.includes('revise_presentation')) return sseBusinessToolResponse(payload.model, 'revise_presentation', { scope: 'page', ordinal: 2,
        request: transportMode === 'native-noop' ? '第二页颜色更克制一些' : '保留事实，将第二页改为左右两区构图' });
      if (names.includes('read_document_structure')) return sseBusinessToolResponse(payload.model, 'read_document_structure', { scope: 'page', ordinal: 2 });
      return sseResponse(payload.model, transportMode === 'native-noop' ? '当前配色已经符合要求，本次保留原文件。' : '第二页已重新排版，其他页保持原样。');
    }
    if (transportMode === 'cancel') {
      await new Promise((resolve, reject) => {
        const onAbort = () => { abortCount += 1; reject(Object.assign(new Error('synthetic abort'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        void resolve;
      });
    }
    if (transportMode === 'tool-call') {
      return payload.messages.some(message => message.role === 'tool')
        ? sseResponse(payload.model, '隔离 PPT 已生成，工具观察结果已回传。')
        : sseToolCallResponse(payload.model);
    }
    const lastUser = [...payload.messages].reverse().find(message => message.role === 'user')?.content ?? '';
    if (lastUser.includes('WORD_FIXTURE')) return sseResponse(payload.model, '# Word Electron 验收\n\n## 文档正文\n受控 Provider 驱动的 Word 物理文件验收。');
    if (lastUser.includes('EXCEL_FIXTURE')) return sseResponse(payload.model, '# Excel Electron 验收\n\n## 数据\n项目,数量\nOffice Agent,1');
    return sseResponse(payload.model, '真实 Electron 中的受控 Provider 替身响应。');
  }
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const rootDirectory = await rootDirectoryPromise;
  const userData = await userDataPromise;
  await mkdir(path.join(rootDirectory, 'entities'), { recursive: true });
  app.setPath('userData', userData);
  await app.whenReady();
  const providers = await fixture.providerFixture(userData, true);
  newApiRuntime = new platform.NewApiSharedRuntime({ transport });
  deepSeekRuntime = new platform.DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('unexpected deepseek request'); } } });
  const sessions = new platform.StorageProjectSessionRegistry();
  sessions.set({ projectId, projectName: 'Agent mock Electron', rootDirectory });
  lifecycle = registerChatContextIpcHandlers({
    getSession: () => sessions.get(),
    providerRegistry: providers.registry,
    providerPackages: new platform.ProviderPackageRegistry([
      platform.deepSeekProviderPackageDescriptor,
      platform.kimiProviderPackageDescriptor,
      platform.unicompapiProviderPackageDescriptor,
      platform.newApiProviderPackageDescriptor
    ]),
    runtimeAuthorization: providers.authorization,
    onError: error => {
      const messages = [];
      for (let depth = 0, current = error; depth < 5 && current; depth += 1, current = current.cause) {
        messages.push(current instanceof Error ? current.stack : String(current));
      }
      hostDiagnostics.push(messages.join('\nCaused by: '));
    },
    textSubmission: { credentialVault: providers.vault, deepSeekRuntime, newApiRuntime }
  });
  documentLifecycle = registerDocumentGenerationIpcHandlers({
    getConversationRepository: lifecycle.getConversationRepository,
    sessionRegistry: sessions,
    providerRegistry: providers.registry,
    providerPackages: new platform.ProviderPackageRegistry([
      platform.deepSeekProviderPackageDescriptor,
      platform.kimiProviderPackageDescriptor,
      platform.unicompapiProviderPackageDescriptor,
      platform.newApiProviderPackageDescriptor
    ]),
    runtimeAuthorization: providers.authorization,
    textSubmission: { credentialVault: providers.vault, deepSeekRuntime, newApiRuntime }
  });
  const html = path.join(rootDirectory, 'agent-mock.html');
  await writeFile(html, '<!doctype html><meta charset="utf-8"><title>Agent mock E2E</title>');
  browserWindow = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(path.resolve('.'), 'dist-electron/electron/preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false
  } });
  await browserWindow.loadFile(html);
  const js = source => browserWindow.webContents.executeJavaScript(source);
  const candidateResult = await js('window.unicomp.chatContexts.listTextCandidates("text_chat")');
  if (!candidateResult?.ok || !candidateResult.value?.length) throw new Error(`No synthetic candidate: ${JSON.stringify(candidateResult)}`);
  const candidateId = candidateResult.value[0].candidateId;
  if (process.argv.includes('--ui-navigation')) {
    streamGates = createStreamGates();
    const result = await require('./lib/verify-document-navigation.cjs')({ browserWindow, lifecycle,
      session: sessions.get(), candidateId, setTransportMode: mode => { transportMode = mode; },
      releaseStream: part => part === 'first' ? streamGates.releaseFirst() : streamGates.releaseFinal() });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const request = (id, content) => ({ clientCommandId: id, conversation: null, title: 'Agent mock Electron', content,
    productFeature: 'text_chat', candidateId, contextSelections: [], parameterValues: {} });
  const discussionCases = [];
  async function verifyDiscussion(id, content, conversationId) {
    await lifecycle.waitForMutations?.();
    transportMode = 'discussion';
    const storage = new platform.NodeProjectStorage(rootDirectory);
    const works = new platform.JsonWorkRepository(storage, projectId);
    const before = (await works.list(projectId)).map(work => work.id).sort();
    const current = conversationId ? await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(conversationId)})`) : undefined;
    const beforeMessages = new Set(current?.value?.messages.map(message => message.messageId) ?? []);
    const beforeRequests = requestCount;
    const beforePlanningRequests = semanticRequestCount;
    const input = { ...request(id, content), ...(conversationId ? { conversation: { conversationId, expectedRevision: current.value.revision, editedMessageId: null } } : {}) };
    const started = await js(`window.unicomp.chatContexts.startAgentResponse(${JSON.stringify(input)})`);
    if (!started?.ok || !started.value.execution) throw new Error(`Discussion start failed: ${JSON.stringify(started)}; scope: ${JSON.stringify({ id, conversationId, readOk: current?.ok, revision: current?.value?.revision })}; diagnostics: ${JSON.stringify(hostDiagnostics.slice(-3))}`);
    let execution;
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(started.value.execution.responseExecutionId)})`);
      if (read?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(read.value.state)) { execution = read.value; break; }
      await delay(100);
    }
    await lifecycle.waitForMutations?.();
    const after = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(started.value.execution.conversationId)})`);
    if (execution?.state !== 'completed' || requestCount !== beforeRequests + 2 ||
      JSON.stringify(before) !== JSON.stringify((await works.list(projectId)).map(work => work.id).sort()) ||
      after.value.messages.some(message => !beforeMessages.has(message.messageId) && message.role === 'assistant' && (message.documentResult || message.content.includes('本次制作不联网搜索')))) throw new Error(`Discussion produced generation state or failed: ${JSON.stringify(execution)}`);
    discussionCases.push({ case: id, state: 'completed', registeredNewWorks: 0, semanticPlannerCalls: semanticRequestCount - beforePlanningRequests, writeToolsExposed: false, externalProviderCalls: 0 });
    return execution.conversationId;
  }
  if (process.argv.includes('--semantic-transition')) {
    const conversationId = await verifyDiscussion('semantic-discussion', '我现在要制作一个ppt，先讨论内容');
    const discussionRequestCount = requestCount;
    const beforeSemantic = semanticRequestCount;
    transportMode = 'tool-call';
    const current = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(conversationId)})`);
    const input = { ...request('semantic-authorized-generation', '随便生成吧，现在是测试'),
      conversation: { conversationId, expectedRevision: current.value.revision, editedMessageId: null } };
    const started = await js(`window.unicomp.chatContexts.startAgentResponse(${JSON.stringify(input)})`);
    if (!started?.ok || !started.value.execution) throw new Error(`Semantic transition start failed: ${JSON.stringify(started)}; diagnostics: ${JSON.stringify(hostDiagnostics)}`);
    let execution;
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(started.value.execution.responseExecutionId)})`);
      if (result?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(result.value.state)) { execution = result.value; break; }
      await delay(250);
    }
    await lifecycle.waitForMutations();
    const after = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(conversationId)})`);
    const storage = new platform.NodeProjectStorage(rootDirectory);
    const works = await new platform.JsonWorkRepository(storage, projectId).list(projectId);
    const artifact = after?.value.messages.find(message => message.documentResult)?.documentResult;
    if (execution?.state !== 'completed' || works.length !== 1 || artifact?.workId !== works[0].id ||
        semanticRequestCount !== beforeSemantic + 1) throw new Error(`Semantic transition did not deliver one PPT: ${JSON.stringify({ execution, works: works.length, artifact, semanticRequestCount, hostDiagnostics })}`);
    const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
    const physical = await new RegisteredPresentationReader({ rootDirectory, projectId }).read(works[0].id);
    if (!physical.pages.length || !physical.buffer.length) throw new Error('Semantic transition produced no readable physical PPT');
    const report = { status: 'passed', threadFirst: process.env.UNICOMP_THREAD_FIRST !== '0',
      discussion: { text: '我现在要制作一个ppt，先讨论内容', modelRequests: discussionRequestCount, registeredWorks: 0, exposedWriteTools: false },
      generation: { text: '随便生成吧，现在是测试', semanticPlannerRequests: semanticRequestCount - beforeSemantic,
        state: execution.state, registeredWorks: works.length, physicalPages: physical.pages.length, bytes: physical.buffer.length,
        documentReceipt: artifact }, requestCount, semanticRequestCount, externalProviderCalls: 0,
      boundary: 'production IPC + preload + Thread/Legacy Host + injected Provider transport; actual local PPT, no external generation' };
    const output = path.resolve(`outputs/conversation-phase6/semantic-task-transition-${report.threadFirst ? 'thread' : 'legacy'}.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const normal = await js(`window.unicomp.chatContexts.startAgentResponse(${JSON.stringify(request('mock-normal', '普通聊天'))})`);
  if (!normal?.ok || !normal.value?.execution?.responseExecutionId) throw new Error(`Normal Agent start failed: ${JSON.stringify(normal)}`);
  let normalRead;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    normalRead = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(normal.value.execution.responseExecutionId)})`);
    if (normalRead?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(normalRead.value.state)) break;
    await delay(100);
  }
  if (!normalRead?.ok || normalRead.value.state !== 'completed') throw new Error(`Normal execution not completed: ${JSON.stringify(normalRead)}`);
  if (nativeDocuments) {
    const discussionId = await verifyDiscussion('discussion-sky-content', '我要制作一个ppt，关于天空的，现在先讨论一下内容？');
    await verifyDiscussion('discussion-reject-generation', '我让你先讨论一下，你给我生成一个ppt干什么！', discussionId);
    transportMode = 'normal';
  }
  let threadRuntimeControls;
  if (process.env.UNICOMP_THREAD_FIRST !== '0') {
    const detail = await js(`window.unicomp.chatContexts.getThread(${JSON.stringify(normal.value.execution.conversationId)})`);
    threadRuntimeControls = Boolean(detail?.ok && detail.value.parentRuns?.some(run =>
      run.responseExecutionId === normal.value.execution.responseExecutionId) && Array.isArray(detail.value.agentSessions));
    if (!threadRuntimeControls) throw new Error('Thread detail lost Runtime execution/session controls');
  }

  transportMode = 'cancel';
  await js(`window.__agentMockPending = window.unicomp.chatContexts.startAgentResponse(${JSON.stringify(request('mock-cancel', '取消测试'))})`);
  await js('window.__agentMockPending.then(value => { window.__agentMockStartResult = value; }, error => { window.__agentMockStartResult = { ok: false, error: { message: String(error) } }; })');
  let cancelStartResult;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    cancelStartResult = await js('window.__agentMockStartResult');
    if (cancelStartResult !== undefined) break;
    await delay(100);
  }
  if (cancelStartResult?.ok && cancelStartResult.value?.execution?.responseExecutionId) {
    const cancelled = await js(`window.unicomp.chatContexts.cancelResponseExecution(${JSON.stringify(cancelStartResult.value.execution.responseExecutionId)})`);
    if (!cancelled?.ok) throw new Error(`Cancel execution failed: ${JSON.stringify(cancelled)}`);
  } else {
    const cancelledStart = await js('window.unicomp.chatContexts.cancelResponseStart({ projectId: "project-r45-built-offline", clientCommandId: "mock-cancel" })');
    if (!cancelledStart?.ok) throw new Error(`Cancel start failed: ${JSON.stringify(cancelledStart)}`);
  }
  await js('window.__agentMockPending');

  transportMode = 'tool-call';
  const compatibilityToolEntry = process.env.UNICOMP_MOCK_COMPATIBILITY === '1';
  const toolRequest = compatibilityToolEntry
    ? { ...request('mock-tool-call-compatibility', '生成3页PPT，主题是产品研发进展，受众是管理层，简洁商务风格，现在直接生成。'), confirmed: true }
    : request('mock-tool-call', '生成一个测试 PPT');
  const toolStart = await js(`window.unicomp.chatContexts.${compatibilityToolEntry ? 'startResponse' : 'startAgentResponse'}(${JSON.stringify(toolRequest)})`);
  if (!toolStart?.ok || !toolStart.value?.execution?.responseExecutionId) throw new Error(`Tool-call Agent start failed: ${JSON.stringify(toolStart)}`);
  let toolExecution;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(toolStart.value.execution.responseExecutionId)})`);
    if (current?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.value.state)) {
      toolExecution = current.value;
      break;
    }
    await delay(250);
  }
  if (!toolExecution) throw new Error('Tool-call execution did not reach a terminal state');
  const toolConversation = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(toolExecution.conversationId)})`);
  const artifactMessage = toolConversation?.ok && toolConversation.value.messages?.find(message => message.documentResult);
  const generatedWorks = await new platform.JsonWorkRepository(new platform.NodeProjectStorage(rootDirectory), projectId).list(projectId);
  if (toolExecution.state !== 'completed' || !artifactMessage?.documentResult || generatedWorks.length !== 1 ||
      generatedWorks[0].id !== artifactMessage.documentResult.workId) {
    throw new Error('Isolated tool case did not settle exactly one registered Work');
  }
  const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
  const { readRegisteredPresentationProductionPlan } = require('../dist-electron/src/platform/documents/presentation-production-plan-reader');
  const source = await new RegisteredPresentationReader({ rootDirectory, projectId }).read(generatedWorks[0].id);
  const admitted = await readRegisteredPresentationProductionPlan({ rootDirectory, projectId, work: source.work, file: source.file, buffer: source.buffer });
  if (artDirectionRequestCount !== (expectTemplateFallback ? 3 : 1) || !admitted || (expectTemplateFallback
    ? admitted.plan.snapshot.designPath !== 'legacy-fallback' || admitted.plan.designIR !== undefined || admitted.plan.snapshot.fallbackReason !== 'art_direction_invalid'
    : !admitted.plan.designIR?.pages.every(page => page.designTree) || admitted.plan.snapshot.designExecution?.status !== 'passed')) {
    throw new Error('Autonomous Art Direction did not reach the registered production plan');
  }
  let threadArtifact;
  let threadDocumentReceipt;
  let threadToolParentState;
  let threadToolFacts;
  if (process.env.UNICOMP_THREAD_FIRST !== '0') {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const page = await js(`window.unicomp.chatContexts.getThreadItemsPage(${JSON.stringify({ threadId: toolExecution.conversationId, limit: 200, direction: 'older', cursor: null })})`);
      threadArtifact = page?.ok
        ? page.value.items.find(item => item.itemType === 'document_artifact_projection')
        : undefined;
      threadDocumentReceipt = page?.ok
        ? page.value.items.find(item => item.itemType === 'assistant_message' && item.message?.documentResult)?.message.documentResult
        : undefined;
      threadToolFacts = page?.ok ? page.value.items.filter(item => ['tool_call_projection', 'tool_result_projection'].includes(item.itemType)) : [];
      const detail = await js(`window.unicomp.chatContexts.getThread(${JSON.stringify(toolExecution.conversationId)})`);
      threadToolParentState = detail?.value?.parentRuns?.find(run => run.responseExecutionId === toolExecution.responseExecutionId)?.state;
      if (threadArtifact?.artifact?.workId && threadDocumentReceipt?.workId === threadArtifact.artifact.workId &&
        (compatibilityToolEntry || threadToolParentState === 'completed') &&
        threadToolFacts.some(item => item.itemType === 'tool_call_projection') && threadToolFacts.some(item => item.itemType === 'tool_result_projection')) break;
      await delay(100);
    }
    if (!threadDocumentReceipt?.workId || threadDocumentReceipt.workId !== threadArtifact?.artifact?.workId ||
        (!compatibilityToolEntry && threadToolParentState !== 'completed') ||
        !threadToolFacts.some(item => item.itemType === 'tool_call_projection') || !threadToolFacts.some(item => item.itemType === 'tool_result_projection')) {
      const detail = await js(`window.unicomp.chatContexts.getThread(${JSON.stringify(toolExecution.conversationId)})`);
      const tasks = await new platform.JsonDocumentTaskRuntimeRepository(new platform.NodeProjectStorage(rootDirectory), projectId).list();
      throw new Error('Thread Assistant lost the verified document receipt; ' + JSON.stringify({
        state: toolExecution.state, parentRuns: detail?.value?.parentRuns, threadArtifact: Boolean(threadArtifact),
        threadDocumentReceipt: Boolean(threadDocumentReceipt), threadToolFacts,
        tasks: tasks.filter(task => task.executionId === toolExecution.responseExecutionId).map(task => ({ status: task.status,
          tools: task.toolCalls.map(call => ({ toolId: call.toolId, status: call.status })), observations: task.observations.length })), hostDiagnostics }));
    }
  }
  const toolCalling = {
    state: toolExecution.state,
    toolCallCount,
    toolCallId,
    observationReturned: toolExecution.content?.includes('工具观察结果') ?? false,
    artifactRegistered: Boolean(artifactMessage?.documentResult),
    generatedWorkCount: generatedWorks.length,
    autonomousDesignExecuted: !expectTemplateFallback,
    ...(admitted.plan.snapshot.designExecution ? { designExecution: admitted.plan.snapshot.designExecution } : {}),
    designPath: admitted.plan.snapshot.designPath,
    ...(admitted.plan.snapshot.fallbackReason ? { fallbackReason: admitted.plan.snapshot.fallbackReason } : {}),
    documentResult: artifactMessage?.documentResult ?? null,
    threadDocumentReceipt: threadDocumentReceipt ?? null,
    threadToolParentState,
    entry: compatibilityToolEntry ? 'responses.start' : 'responses.startAgent',
    threadToolFacts: threadToolFacts?.map(item => ({ itemType: item.itemType, status: item.status,
      eventSystem: item.projectionSource?.eventSystem, responseExecutionId: item.projectionSource?.responseExecutionId })) ?? null,
    threadArtifact: threadArtifact ? {
      workId: threadArtifact.artifact?.workId ?? null,
      fileName: threadArtifact.artifact?.fileName ?? null,
      kind: threadArtifact.artifact?.kind ?? null,
      sizeBytes: threadArtifact.artifact?.sizeBytes ?? null
    } : null
  };

  async function generateDocumentFixture(id, content, kind) {
    transportMode = nativeDocuments ? 'native-office' : 'normal';
    nativeOfficeKind = kind;
    const startRequest = nativeDocuments ? request(id, `现在生成${kind === 'word' ? 'Word' : 'Excel'}文件 ${content}`) : { ...request(id, content), confirmed: true };
    const started = await js(`window.unicomp.chatContexts.${nativeDocuments ? 'startAgentResponse' : 'startResponse'}(${JSON.stringify(startRequest)})`);
    if (!started?.ok || !started.value?.execution?.responseExecutionId) throw new Error(`${kind} Agent start failed: ${JSON.stringify(started)}`);
    let execution;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const current = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(started.value.execution.responseExecutionId)})`);
      if (current?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.value.state)) { execution = current.value; break; }
      await delay(100);
    }
    if (!execution || execution.state !== 'completed') throw new Error(`${kind} response failed: ${JSON.stringify(execution)}`);
    const conversation = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(execution.conversationId)})`);
    const assistant = conversation?.ok && conversation.value.messages?.find(message => message.messageId === execution.assistantMessageId);
    if (!assistant) throw new Error(`${kind} assistant message missing`);
    if (nativeDocuments) {
      await lifecycle.waitForMutations?.();
      const current = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(execution.conversationId)})`);
      const receipt = current?.ok && current.value.messages.find(message => message.messageId === execution.assistantMessageId)?.documentResult;
      if (!receipt || receipt.kind !== kind) throw new Error(`Native ${kind} file receipt missing or wrong: ${JSON.stringify(receipt)}`);
      const page = process.env.UNICOMP_THREAD_FIRST !== '0' ? await js(`window.unicomp.chatContexts.getThreadItemsPage(${JSON.stringify({ threadId: execution.conversationId, limit: 200, direction: 'older', cursor: null })})`) : undefined;
      const artifact = page?.ok && page.value.items.find(item => item.itemType === 'document_artifact_projection' && item.artifact?.workId === receipt.workId);
      if (page && (!artifact || artifact.artifact.kind !== kind)) throw new Error(`Native ${kind} Thread artifact missing`);
      return { ...receipt, nativeBusinessTool: true, threadArtifact: Boolean(artifact) };
    }
    const prepared = await js(`window.unicomp.documentGeneration.prepareGeneration(${JSON.stringify({ conversationId: execution.conversationId, expectedRevision: conversation.value.revision, messageId: assistant.messageId, kind })})`);
    if (!prepared?.ok) throw new Error(`${kind} prepare failed: ${JSON.stringify(prepared)}`);
    const generated = await js(`window.unicomp.documentGeneration.generateFromMessage(${JSON.stringify({ conversationId: execution.conversationId, expectedRevision: conversation.value.revision, messageId: assistant.messageId, kind })})`);
    if (!generated?.ok) throw new Error(`${kind} generation failed: ${JSON.stringify(generated)}`);
    if (process.env.UNICOMP_THREAD_FIRST !== '0') {
      const page = await js(`window.unicomp.chatContexts.getThreadItemsPage(${JSON.stringify({ threadId: execution.conversationId, limit: 200, direction: 'older', cursor: null })})`);
      const receipt = page?.ok && page.value.items.find(item => item.itemType === 'assistant_message' && item.message?.documentResult?.workId === generated.value.workId);
      const artifact = page?.ok && page.value.items.find(item => item.itemType === 'document_artifact_projection' && item.artifact?.workId === generated.value.workId);
      if (!receipt || !artifact || receipt.message.documentResult.kind !== kind || artifact.artifact.kind !== kind) throw new Error(`${kind} generated Work lost its Thread receipt or Artifact`);
      return { ...generated.value, threadDocumentReceipt: true, threadArtifact: true };
    }
    return generated.value;
  }
  let nativeRevision;
  if (nativeDocuments && !expectTemplateFallback) {
    transportMode = 'native-revision';
    await lifecycle.waitForMutations?.();
    const current = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(toolExecution.conversationId)})`);
    const started = await js(`window.unicomp.chatContexts.startAgentResponse(${JSON.stringify({ ...request('native-ppt-revision', '保留事实，重新排版当前 PPT 第二页，其他页不要动。'),
      conversation: { conversationId: toolExecution.conversationId, expectedRevision: current.value.revision, editedMessageId: null } })})`);
    if (!started?.ok) throw new Error(`Native PPT revision start failed: ${JSON.stringify(started)}`);
    let execution;
    for (let attempt = 0; attempt < 160; attempt++) {
      const value = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(started.value.execution.responseExecutionId)})`);
      if (value?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.value.state)) { execution = value.value; break; }
      await delay(100);
    }
    if (execution?.state !== 'completed') throw new Error(`Native PPT revision failed: ${JSON.stringify(execution)}`);
    await lifecycle.waitForMutations?.();
    const revisedConversation = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(toolExecution.conversationId)})`);
    const receipt = revisedConversation.value.messages.find(message => message.messageId === execution.assistantMessageId)?.documentResult;
    if (!receipt || receipt.workId === source.work.id) throw new Error('Native PPT revision did not deliver a new verified Work');
    const revised = await new (require('../dist-electron/src/platform/documents/registered-presentation-reader').RegisteredPresentationReader)({ rootDirectory, projectId }).read(receipt.workId);
    const JSZip = require('jszip');
    const [beforeZip, afterZip] = await Promise.all([JSZip.loadAsync(source.buffer), JSZip.loadAsync(revised.buffer)]);
    for (const number of [1, 3]) {
      if (await beforeZip.file(`ppt/slides/slide${number}.xml`).async('string') !== await afterZip.file(`ppt/slides/slide${number}.xml`).async('string')) throw new Error('Native revision changed a non-target page');
    }
    if (await beforeZip.file('ppt/slides/slide2.xml').async('string') === await afterZip.file('ppt/slides/slide2.xml').async('string')) throw new Error('Native revision had no visible page change');
    nativeRevision = { status: 'passed', targetPage: 2, untouchedPagesPreserved: true, fileReadBack: true, workId: receipt.workId };
    transportMode = 'native-noop';
    const beforeNoop = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(toolExecution.conversationId)})`);
    const noop = await js(`window.unicomp.chatContexts.startAgentResponse(${JSON.stringify({ ...request('native-ppt-unchanged', '当前 PPT 第二页颜色更克制一些'),
      conversation: { conversationId: toolExecution.conversationId, expectedRevision: beforeNoop.value.revision, editedMessageId: null } })})`);
    if (!noop?.ok || !noop.value.execution) {
      const detail = await js(`window.unicomp.chatContexts.getThread(${JSON.stringify(toolExecution.conversationId)})`);
      const summary = detail?.ok ? { revision: detail.value.revision,
        parentRuns: detail.value.parentRuns?.map(item => ({ id: item.runId, responseExecutionId: item.responseExecutionId, state: item.state, status: item.status })),
        agentSessions: detail.value.agentSessions?.map(item => ({ id: item.sessionId, state: item.state, waiting: item.waiting?.reason })) } : detail?.error;
      throw new Error(`Unchanged revision start failed: ${JSON.stringify(noop)}; scope: ${JSON.stringify(summary)}`);
    }
    let noopExecution;
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await js(`window.unicomp.chatContexts.getResponseExecution(${JSON.stringify(noop.value.execution.responseExecutionId)})`);
      if (value?.ok && ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.value.state)) { noopExecution = value.value; break; }
      await delay(100);
    }
    if (noopExecution?.state !== 'completed') throw new Error(`Unchanged revision failed: ${JSON.stringify(noopExecution)}`);
    await lifecycle.waitForMutations?.();
    const afterNoop = await js(`window.unicomp.chatContexts.getConversation(${JSON.stringify(toolExecution.conversationId)})`);
    const noopReceipt = afterNoop.value.messages.find(message => message.messageId === noopExecution.assistantMessageId)?.documentResult;
    if (noopReceipt?.workId !== receipt.workId || (await new platform.JsonWorkRepository(new platform.NodeProjectStorage(rootDirectory), projectId).list(projectId)).length !== 2) {
      throw new Error('Already-compliant visual request duplicated or lost the existing Work');
    }
    nativeRevision.unchangedRequestReusedWork = true;
  }
  additionalRootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-mock-electron-docs-'));
  if (nativeDocuments) await verifyDiscussion('discussion-existing-ppt', '我让你先讨论一下，你给我生成一个ppt干什么！', toolExecution.conversationId);
  await mkdir(path.join(additionalRootDirectory, 'entities'), { recursive: true });
  sessions.set({ projectId: `${projectId}-docs`, projectName: 'Agent mock Office docs', rootDirectory: additionalRootDirectory });
  const wordResult = await generateDocumentFixture('mock-word', 'WORD_FIXTURE', 'word');
  const excelResult = await generateDocumentFixture('mock-excel', 'EXCEL_FIXTURE', 'excel');
  const report = { schemaVersion: 1, status: 'passed',
    boundary: 'real Electron BrowserWindow + production preload + production IPC + controlled in-process Provider transport',
    checks: ['normal Agent response', 'persistent execution identity', 'cancel start boundary', 'Provider tool call through the real Electron IPC path', 'Word physical file generation', 'Excel physical file generation'],
    requestCount, artDirectionRequestCount, abortCount, toolCalling, threadRuntimeControls, discussionCases,
    office: { word: wordResult, excel: excelResult }, ...(nativeRevision ? { nativeRevision } : {}),
    externalProvider: 'blocked: no authorized external credentials used', externalProviderCalls: 0 };
  const output = path.resolve(`outputs/conversation-phase6/agent-provider-mock${nativeDocuments ? '-conversation-documents' : ''}${expectTemplateFallback ? '-template-fallback' : ''}-e2e.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function cleanup() {
  const bounded = (promise, ms = 1_500) => Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, ms))
  ]);
  await bounded(lifecycle?.interruptActiveResponses?.());
  await bounded(lifecycle?.waitForMutations?.());
  await bounded(documentLifecycle?.waitForOperations?.());
  newApiRuntime?.dispose();
  deepSeekRuntime?.dispose();
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  await bounded(rm(await rootDirectoryPromise, { recursive: true, force: true }));
  if (additionalRootDirectory) await bounded(rm(additionalRootDirectory, { recursive: true, force: true }));
  await bounded(rm(await userDataPromise, { recursive: true, force: true }));
}

run().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; })
  .finally(async () => {
    await cleanup();
    app.exit(process.exitCode ?? 0);
  });
