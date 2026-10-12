// Synthetic, local-only persistence benchmark. Never opens a user project.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const domain = require('../dist-electron/src/domain');
const { NodeProjectStorage } = require('../dist-electron/src/platform/storage/node-project-storage');
const current = require('../dist-electron/src/platform/repositories/json-conversation-response-execution-repository');
const { ConversationResponseExecutionLifecycle } = require('../dist-electron/src/platform/providers/conversation-response-streaming');
const { ConversationProductionTraceStore } = require('../dist-electron/src/platform/conversation-production-trace');

const sourcePath = 'src/platform/repositories/json-conversation-response-execution-repository.ts';
const baselineSource = execFileSync('git', ['show', `78718ed:${sourcePath}`], { encoding: 'utf8' });
const baselineModule = new Module(path.resolve('dist-electron', sourcePath.replace(/\.ts$/, '.js')), module);
baselineModule.filename = baselineModule.id;
baselineModule.paths = module.paths;
baselineModule._compile(ts.transpileModule(baselineSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} }).outputText, baselineModule.filename);
const baseline = baselineModule.exports;
const projectId = 'project-synthetic-history';
const timestamp = '2026-10-12T00:00:00.000Z';
function execution(index) {
  return domain.createConversationResponseExecution({ id: `execution-${index}`, projectId,
    providerInvocationAttemptId: `attempt-${index}`, createdAt: timestamp,
    snapshot: { schemaVersion: 1, responseDraftId: `draft-${index}`, responseDraftRevision: 1,
      conversationId: `conversation-${index}`, conversationRevision: 1, userMessageId: `user-${index}`,
      userMessageRevision: 0, assistantMessageId: `assistant-${index}`, productFeature: 'text_chat',
      routeSnapshotId: `route-${index}`, outboundUserTextSnapshot: 'Synthetic request', contextSnapshots: [],
      candidate: { schemaVersion: 1, providerId: 'provider-test', connectionId: 'connection-test',
        connectionRevision: 1, modelId: 'model-test', modelRevision: 1, profileId: 'profile.chat',
        profileRevision: 1, protocolBindingId: 'binding-test', protocolBindingRevision: 1,
        runtimeSource: 'newapi_gateway' } } });
}
function event(executionId, sequence, type, extra = {}) {
  return domain.createConversationResponseStreamEvent({ id: `${executionId}-event-${sequence}`,
    responseExecutionId: executionId, sequence, type, occurredAt: timestamp, ...extra });
}
const document = { schemaVersion: 1, revision: 165, executions: [], events: [] };
for (let index = 0; index < 165; index++) {
  const item = execution(index);
  const count = 133 + (index < 92 ? 1 : 0);
  const events = [event(item.id, 1, 'execution_created'), event(item.id, 2, 'stream_started')];
  for (let sequence = 3; sequence < count; sequence++) events.push(event(item.id, sequence, 'content_delta', { contentDelta: 'x'.repeat(100) }));
  events.push(event(item.id, count, 'stream_completed'));
  document.executions.push({ ...item, state: 'completed' });
  document.events.push(...events);
}
assert.equal(document.events.length, 22037);
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(value => Math.round(value * 10) / 10),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 };
}
function parseBenchmark(parse) {
  parse(document, projectId);
  const times = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now(); parse(document, projectId); times.push(performance.now() - start);
  }
  return stats(times);
}
async function appendBenchmark(root, Repository, atomicSnapshot) {
  const storage = new NodeProjectStorage(root);
  await mkdir(path.join(root, 'entities'), { recursive: true });
  await writeFile(path.join(root, 'entities/conversation-response-executions.json'), JSON.stringify(document, null, 2));
  const repository = new Repository(storage, projectId);
  if (!atomicSnapshot) repository.getSnapshot = undefined;
  const live = execution('live');
  await repository.create(live, event(live.id, 1, 'execution_created'));
  let counter = 0;
  const lifecycle = new ConversationResponseExecutionLifecycle(repository, {
    nextConversationResponseStreamEventId: () => `live-appended-${++counter}`
  }, undefined, () => timestamp);
  await lifecycle.start(live.id);
  const times = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    await lifecycle.appendContent(live.id, 'synthetic delta');
    times.push(performance.now() - start);
  }
  return stats(times);
}
async function traceBenchmark(root) {
  const storage = new NodeProjectStorage(root);
  await mkdir(path.join(root, 'entities'), { recursive: true });
  const events = Array.from({ length: 7103 }, (_, index) => ({ schemaVersion: 1, projectId,
    conversationId: 'conversation-trace', sourceMessageId: 'user-trace', traceId: 'trace-history',
    sequence: index + 1, code: 'model_response', status: 'progress', occurredAt: timestamp,
    facts: { purpose: 'content', contentCharacters: index + 1 } }));
  await writeFile(path.join(root, 'entities/conversation-production-trace.json'), JSON.stringify({
    schemaVersion: 1, projectId, sequence: events.length, events
  }, null, 2));
  const store = new ConversationProductionTraceStore(storage, projectId);
  const times = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    await store.append({ rootDirectory: root, projectId, conversationId: 'conversation-trace',
      sourceMessageId: 'user-trace', traceId: 'trace-history' }, {
      code: 'model_response', status: 'progress', facts: { purpose: 'content', contentCharacters: 7200 + sample }
    });
    times.push(performance.now() - start);
  }
  return stats(times);
}
(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-synthetic-history-'));
  try {
    const report = { schemaVersion: 1, paidRequests: 0, baseline: '78718ed',
      history: { executions: 165, events: 22037, traceEvents: 7103, responseBytes: Buffer.byteLength(JSON.stringify(document, null, 2)) },
      parser: { baseline: parseBenchmark(baseline.parseConversationResponseExecutionDocument),
        current: parseBenchmark(current.parseConversationResponseExecutionDocument) },
      responseAppend: {
        baseline: await appendBenchmark(path.join(root, 'baseline'), baseline.JsonConversationResponseExecutionRepository, false),
        current: await appendBenchmark(path.join(root, 'current'), current.JsonConversationResponseExecutionRepository, true)
      }, traceAppend: await traceBenchmark(path.join(root, 'trace')) };
    console.log(JSON.stringify(report, null, 2));
    const output = process.argv[2];
    if (output) await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  } finally { await rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
