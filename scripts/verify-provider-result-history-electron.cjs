const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const baselineRef = process.argv[2] ?? 'HEAD';
const output = path.join(root, 'outputs/provider-result-history', String(Date.now()));
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const compiled = relative => require(path.join(root, 'dist-electron/src', relative));
const { NodeProjectStorage } = compiled('platform/storage/node-project-storage');
const { ProjectMetadataUnitOfWork } = compiled('platform/storage/project-metadata-unit-of-work');
const { ProjectSubmissionAcceptanceStore } = compiled('platform/storage/project-submission-acceptance');
const { JsonProviderOperationRepository } = compiled('platform/repositories/json-provider-operation-repository');
const { SubmissionIntentJournal } = compiled('platform/storage/submission-intent-journal');
const { ProviderSubmissionOrchestrator } = compiled('platform/providers/provider-submission-orchestrator');
const { prepareProviderResultHistory } = compiled('platform/storage/provider-result-history-maintenance');
const { projectStoragePaths } = compiled('platform/storage/project-paths');
const metadataPath = projectStoragePaths.entities.metadataUnit;
const operationsPath = projectStoragePaths.entities.providerOperations;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let window;

function loadTypescript(source, relative) {
  const filename = path.join(root, 'dist-electron', relative.replace(/\.ts$/, '.js'));
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, filename);
  return loaded.exports;
}

function original(relative) {
  return loadTypescript(execFileSync('git', ['show', `${baselineRef}:${relative}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true
  }), relative);
}

const beforeAcceptance = original('src/platform/storage/project-submission-acceptance.ts').ProjectSubmissionAcceptanceStore;
const beforeOperations = original('src/platform/repositories/json-provider-operation-repository.ts').JsonProviderOperationRepository;
const report = { synthetic: true, providerRequests: 0, scenarios: [],
  baselineCommit: execFileSync('git', ['rev-parse', baselineRef], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
  wheelMethod: 'Electron sendInputEvent scheduled on main thread; not physical mouse input' };

async function sizes(directory) {
  return {
    metadataBytes: (await fs.stat(path.join(directory, metadataPath))).size,
    operationBytes: (await fs.stat(path.join(directory, operationsPath))).size
  };
}

async function measure(operation) {
  window.show();
  window.focus();
  await delay(150);
  await window.webContents.executeJavaScript('window.samples = []; window.wheels = []; window.previous = performance.now(); window.scrollTo(0, 0)');
  let last = performance.now();
  let maximumLagMs = 0;
  let wheelDispatches = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maximumLagMs = Math.max(maximumLagMs, now - last - 8);
    last = now;
  }, 8);
  const wheelTimer = setInterval(() => {
    wheelDispatches += 1;
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: 300, y: 200,
      deltaY: -25, deltaX: 0, canScroll: true });
  }, 40);
  const start = performance.now();
  let durationMs;
  try {
    await operation();
    durationMs = performance.now() - start;
    await delay(80);
  } finally {
    clearInterval(heartbeat);
    clearInterval(wheelTimer);
  }
  const renderer = await window.webContents.executeJavaScript(`({
    wheelEvents: window.wheels.length, scrollTop: window.scrollY,
    maximumFrameGapMs: Math.max(0, ...window.samples),
    maximumWheelGapMs: Math.max(0, ...window.wheels.slice(1).map((time,index) => time-window.wheels[index]))
  })`);
  return { durationMs, maximumLagMs, wheelDispatches, ...renderer };
}

function orchestration(directory, mode, index, useOriginal, fixture, writes) {
  const storage = new NodeProjectStorage(directory, {
    onAtomicWriteStage: event => {
      if (event.stage === 'after_replace') writes.push(event.targetPath);
    }
  });
  const acceptance = fixture.createAcceptance(index, { includeResult: false });
  const routeTemplate = { ...acceptance.routeSnapshot };
  for (const key of ['schemaVersion', 'id', 'projectId', 'runtimeAuthorizationClaimId', 'createdAt']) delete routeTemplate[key];
  routeTemplate.productFeature = mode === 'image' ? 'text_to_image' : 'text_to_video';
  const acceptances = new (useOriginal ? beforeAcceptance : ProjectSubmissionAcceptanceStore)(new ProjectMetadataUnitOfWork(storage));
  const operations = new (useOriginal ? beforeOperations : JsonProviderOperationRepository)(storage);
  const candidate = { routeTemplate, providerDisplayName: 'Local test fixture' };
  const subject = { projectId: acceptance.intent.projectId, subject: acceptance.intent.subject };
  const tokenRecord = { idempotencyKey: acceptance.intent.idempotencyKey, nonce: `nonce-${index}` };
  const receipt = fixture.createAcceptance(index).providerOperationRecord;
  receipt.mediaKind = mode;
  receipt.executionLifecycle = mode === 'image' ? 'synchronous_completed' : 'asynchronous_polling';
  receipt.outcome = mode === 'image' ? {
    kind: 'completed_sync', providerOperationId: `operation-${index}`,
    results: [{ kind: 'base64', value: Buffer.alloc(800 * 1024, index % 256).toString('base64'), mimeType: 'image/png' }]
  } : { kind: 'accepted_async', providerOperationId: `operation-${index}`, state: 'queued' };
  let eventIndex = 0;
  let journalIndex = 0;
  let dispatched = 0;
  const orchestrator = new ProviderSubmissionOrchestrator({
    inspectPreparedSubmission: () => tokenRecord,
    validatePreparedSubmission: async () => ({ subject, candidate, tokenRecord }),
    consumePreparedSubmission: () => undefined
  }, acceptances, {
    claimSubmission: async () => undefined,
    markRequestStarted: async () => undefined,
    recordOutcome: async () => undefined,
    releaseBeforeRequest: async () => undefined
  }, new SubmissionIntentJournal(storage), {
    create: async () => ({ subjectArtifacts: acceptance.subjectArtifacts, dispatchRequest: {} })
  }, {
    submit: async input => {
      await input.beforeRequestStarted();
      dispatched += 1;
      return { kind: mode === 'image' ? 'completed_sync' : 'accepted_async',
        providerOperationId: receipt.outcome.providerOperationId, providerOperationRecord: receipt };
    }
  }, {
    nextSubmissionIntentId: () => acceptance.intent.id,
    nextRouteSnapshotId: () => acceptance.routeSnapshot.id,
    nextProviderInvocationAttemptId: () => acceptance.invocationAttempt.id,
    nextProviderInvocationEventId: () => `event-${index}-${++eventIndex}`,
    nextAuthorizationClaimId: () => acceptance.intent.authorizationClaimId,
    nextJournalEventId: () => `journal-${index}-${++journalIndex}`
  });
  return async () => {
    const input = { subject: acceptance.intent.subject, routeSelectionToken: 'fixture-token',
      confirmation: { schemaVersion: 1, confirmationId: 'fixture-confirmation', confirmed: true } };
    const result = await orchestrator.submitDraft(input);
    assert.equal(result.status, mode === 'image' ? 'completed' : 'provider_accepted');
    const saved = await acceptances.get(result.submissionIntentId);
    await operations.save({ ...saved.providerOperationRecord, id: `lifecycle-${index}` });
    await orchestrator.submitDraft(input);
    assert.equal(dispatched, 1);
  };
}

async function run() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  const fixture = loadTypescript(await fs.readFile(path.join(root, 'tests/fixtures/provider-result-history.ts'), 'utf8'),
    'tests/fixtures/provider-result-history.ts');
  window = new BrowserWindow({ show: true, width: 1000, height: 800,
    webPreferences: { backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => {
    report.providerRequests += 1; callback({ cancel: true });
  });
  await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
    <style>body{height:100000px;background:repeating-linear-gradient(#eee 0 79px,#ccc 80px 160px)}</style>
    <h1>Local submission storage wheel probe</h1><script>
    window.samples=[];window.wheels=[];window.previous=performance.now();
    function frame(now){window.samples.push(now-window.previous);window.previous=now;requestAnimationFrame(frame)}
    requestAnimationFrame(frame);addEventListener('wheel',()=>window.wheels.push(performance.now()),{passive:true});
    </script>`));
  const history = fixture.createProviderResultHistoryFixture();
  for (let index = 0; index < history.operations.length; index += 1) {
    const result = { kind: 'base64', value: Buffer.alloc(800 * 1024, index + 1).toString('base64'), mimeType: 'image/png' };
    history.operationDocument.records[index].outcome.results = [result];
    history.metadataDocument.entries[0].value[index].providerOperationRecord.outcome.results = [result];
  }
  report.fixture = { acceptances: 267, imageReceipts: 52, uniquePayloads: 52, payloadBytes: 800 * 1024 };
  for (const mode of ['video', 'image']) {
    for (const version of ['before', 'after']) {
      const directory = path.join(output, `${mode}-${version}`);
      const storage = new NodeProjectStorage(directory);
      await storage.writeJsonAtomically(metadataPath, history.metadataDocument);
      await storage.writeJsonAtomically(operationsPath, history.operationDocument);
      const beforeSizes = await sizes(directory);
      let migration;
      if (version === 'after') migration = await measure(() => prepareProviderResultHistory(directory));
      const compactSizes = await sizes(directory);
      for (let repetition = 0; repetition < 2; repetition += 1) {
        const writes = [];
        const submit = orchestration(directory, mode, 1000 + repetition, version === 'before', fixture, writes);
        const metrics = await measure(submit);
        const writtenBytes = (await Promise.all(writes.map(async file => (await fs.stat(file)).size))).reduce((sum, size) => sum + size, 0);
        report.scenarios.push({ mode, version, repetition, beforeSizes, compactSizes,
          ...(repetition === 0 && migration ? { migration } : {}), metrics, writtenBytesEstimated: writtenBytes, writes: writes.length });
        assert.ok(metrics.wheelEvents > 0, 'Wheel input must reach the renderer');
        assert.ok(metrics.scrollTop > 0, 'Wheel input must scroll the test page');
        console.log(JSON.stringify(report.scenarios.at(-1)));
      }
      if (version === 'after') {
        assert.ok(compactSizes.metadataBytes < beforeSizes.metadataBytes / 10);
        assert.ok(compactSizes.operationBytes < beforeSizes.operationBytes / 10);
      }
    }
  }
  assert.equal(report.providerRequests, 0);
  for (const mode of ['image', 'video']) {
    const scenarios = report.scenarios.filter(item => item.mode === mode);
    const sum = (version, key) => scenarios.filter(item => item.version === version).reduce((total, item) => total + item.metrics[key], 0);
    assert.ok(sum('after', 'durationMs') < sum('before', 'durationMs') / 2);
    assert.ok(sum('after', 'maximumLagMs') < sum('before', 'maximumLagMs') / 2);
  }
  report.passed = true;
}

run().then(async () => {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${path.join(output, 'report.json')}`);
  window?.destroy(); app.exit(0);
}).catch(async error => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, error: String(error) }, null, 2));
  console.error(error); window?.destroy(); app.exit(1);
});
