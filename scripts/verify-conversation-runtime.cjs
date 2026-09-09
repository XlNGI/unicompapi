const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Synthetic, offline integration smoke: production preload + production IPC handlers.
// This does not exercise a paid model or claim successful Office generation.
const workspace = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let temporaryRoot;
let window;
let lifecycle;
let documents;
let exitCode = 1;
const deadline = setTimeout(() => {
  process.stderr.write('Conversation IPC smoke exceeded its 60 second deadline.\n');
  app.exit(1);
}, 60_000);
const cleanupWithDeadline = (promise, milliseconds = 2_000) => Promise.race([
  Promise.resolve(promise).catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, milliseconds))
]);

async function run() {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-conversation-smoke-'));
  const userData = path.join(temporaryRoot, 'user-data');
  const projectRoot = path.join(temporaryRoot, 'project');
  await Promise.all([mkdir(userData), mkdir(projectRoot)]);
  app.setPath('userData', userData);
  await app.whenReady();
  const platform = require('../dist-electron/src/platform');
  const { registerChatContextIpcHandlers } = require('../dist-electron/electron/ipc/chat-context-ipc');
  const { registerDocumentGenerationIpcHandlers } = require('../dist-electron/electron/ipc/document-generation-ipc');
  const sessionRegistry = new platform.StorageProjectSessionRegistry();
  sessionRegistry.set({ projectId: 'project-smoke', projectName: 'Synthetic conversation smoke', rootDirectory: projectRoot });
  lifecycle = registerChatContextIpcHandlers({
    getSession: () => sessionRegistry.get(),
    providerRegistry: new platform.JsonProviderRegistryStore(path.join(userData, 'providers.json')),
    providerPackages: new platform.ProviderPackageRegistry([])
  });
  documents = registerDocumentGenerationIpcHandlers({ sessionRegistry });
  const fixture = path.join(temporaryRoot, 'synthetic-report.txt');
  await writeFile(fixture, '合成测试资料：季度销售额 120，成本 80。\n最后一节风险：供应链交付延迟。', 'utf8');
  const html = path.join(temporaryRoot, 'smoke.html');
  await writeFile(html, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Conversation IPC smoke</title>', 'utf8');
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(workspace, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      spellcheck: false,
      partition: `conversation-smoke-${process.pid}`
    }
  });
  let deniedNetworkRequests = 0;
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(?:file|data):/u.test(details.url);
    if (!allowed) deniedNetworkRequests += 1;
    callback({ cancel: !allowed });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(html);
  const invoke = (method, args) => window.webContents.executeJavaScript(
    `window.unicomp.chatContexts[${JSON.stringify(method)}](...${JSON.stringify(args)})`
  );
  const start = (content, extra = {}) => invoke('startWorkflow', [{
    clientCommandId: `smoke-${crypto.randomUUID()}`, conversation: null,
    title: content.slice(0, 80), content, ...extra
  }]);
  const succeeded = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const results = [];
  assert.equal(await window.webContents.executeJavaScript('typeof window.unicomp.chatContexts.cancelPlanning'), 'function');
  const polite = succeeded(await start('可不可以帮我做一份 PPT，介绍如何提高销售额'));
  assert.equal(polite.workflow.status, 'ready');
  assert.equal(polite.workflow.plan.documentKind, 'ppt');
  succeeded(await invoke('cancelWorkflow', [polite.workflow.workflowId, polite.workflow.revision]));
  results.push('polite_ppt_and_explicit_cancel');

  const vague = succeeded(await start('帮我做个总结'));
  assert.equal(vague.workflow.status, 'needs_clarification');
  const cancelled = succeeded(await invoke('answerWorkflow', [{
    clientCommandId: `smoke-answer-${crypto.randomUUID()}`,
    workflowId: vague.workflow.workflowId, expectedWorkflowRevision: vague.workflow.revision,
    expectedConversationRevision: vague.conversation.revision, content: '不用做 PPT 了，取消'
  }]));
  assert.equal(cancelled.workflow.status, 'cancelled');
  assert.equal(succeeded(await invoke('getPendingWorkflow', [vague.conversation.conversationId])), null);
  results.push('clarification_natural_cancel');

  const multiple = succeeded(await start('做一份 Word 和 PPT，介绍公司的产品'));
  assert.deepEqual(multiple.workflow.plan.deliverables, ['word', 'ppt'], JSON.stringify(multiple.workflow));
  const reordered = succeeded(await invoke('answerWorkflow', [{
    clientCommandId: `smoke-order-${crypto.randomUUID()}`,
    workflowId: multiple.workflow.workflowId, expectedWorkflowRevision: multiple.workflow.revision,
    expectedConversationRevision: multiple.conversation.revision, content: '先做 PPT'
  }]));
  assert.equal(reordered.workflow.plan.documentKind, 'ppt');
  assert.deepEqual(reordered.workflow.plan.deliverables, ['ppt', 'word']);
  assert.equal(reordered.workflow.deliveries.length, 2);
  succeeded(await invoke('cancelWorkflow', [reordered.workflow.workflowId, reordered.workflow.revision]));
  results.push('office_multiple_delivery_order');

  const imported = succeeded(await window.webContents.executeJavaScript(
    `window.unicomp.documentAttachments.importAttachment(${JSON.stringify({ sourcePath: fixture })})`
  ));
  assert.equal(imported.extraction.status, 'extracted');
  const answer = succeeded(await start('总结主要观点，在这里回复就行', { attachmentFileIds: [imported.fileId] }));
  assert.equal(answer.workflow.plan.kind, 'chat');
  const source = answer.conversation.messages.find((item) => item.messageId === answer.workflow.sourceMessageId);
  assert.equal(source.attachments[0].fileReferenceId, imported.fileId);
  assert.equal(source.content, '总结主要观点，在这里回复就行');
  const cleared = succeeded(await invoke('answerWorkflow', [{
    clientCommandId: `smoke-clear-${crypto.randomUUID()}`,
    workflowId: answer.workflow.workflowId, expectedWorkflowRevision: answer.workflow.revision,
    expectedConversationRevision: answer.conversation.revision,
    content: '不再使用附件，在这里解释销售额是什么', attachmentFileIds: []
  }]));
  assert.deepEqual(cleared.conversation.messages.at(-1).attachments, []);
  assert.equal(cleared.conversation.messages.at(-1).attachmentSelection, 'replace');
  results.push('attachment_question_and_explicit_clear');

  const fresh = succeeded(await start('谢谢'));
  assert.equal(fresh.workflow.plan.kind, 'chat');
  assert.equal(fresh.conversation.messages.every((item) => item.attachments.length === 0), true);
  results.push('new_conversation_attachment_isolation');
  const invalid = await start('做 PPT', { permissions: ['arbitrary-code'] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'invalid_request');
  results.push('renderer_request_schema_rejection');
  assert.equal(deniedNetworkRequests, 0);
  await lifecycle.waitForMutations();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1, status: 'passed', checks: results,
    runtime: { electron: process.versions.electron },
    networkRequests: 0, modelCalls: 0,
    scope: 'Real Electron preload and IPC with synthetic local project; no paid generation.'
  }, null, 2)}\n`);
  exitCode = 0;
  // Electron can retain Chromium profile handles after all assertions pass;
  // force a bounded exit so this smoke check cannot hang CI. The directory is
  // dedicated to this check and cleanup is best effort in the finally block.
  setTimeout(() => process.exit(exitCode), 2_000);
}

run().catch((error) => {
  process.exitCode = 1;
  process.stderr.write(`${error.stack ?? error}\n`);
}).finally(async () => {
  clearTimeout(deadline);
  await cleanupWithDeadline(lifecycle?.waitForMutations());
  await cleanupWithDeadline(documents?.waitForOperations());
  if (window && !window.isDestroyed()) {
    await cleanupWithDeadline(window.webContents.session.closeAllConnections());
    window.destroy();
  }
  if (temporaryRoot) {
    // Resolve and check the exact generated temporary directory before removal.
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('unicomp-conversation-smoke-')) {
      process.stderr.write('Refusing cleanup outside the dedicated smoke directory.\n');
      exitCode = 1;
    } else {
      try { await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
      catch (error) {
        // Electron may release Chromium profile journals just after app.exit.
        // The directory is still isolated and can be removed by the OS on reboot.
        process.stderr.write(`Temporary cleanup deferred by Electron lock: ${error.message}\n`);
      }
    }
  }
  process.exitCode = exitCode;
  app.exit(exitCode);
  setTimeout(() => process.exit(exitCode), 1_000).unref();
});
