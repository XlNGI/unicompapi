// Local-only synthetic benchmark. No user projects, credentials or Provider requests.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const { NodeProjectStorage } = require('../dist-electron/src/platform/storage/node-project-storage');
const current = require('../dist-electron/src/platform/storage/project-metadata-unit-of-work');

const baselineRef = 'c9c5cf3';
const sourcePath = 'src/platform/storage/project-metadata-unit-of-work.ts';
const baselineSource = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { encoding: 'utf8' });
const baselineModule = new Module(path.resolve('dist-electron', sourcePath.replace(/\.ts$/, '.js')), module);
baselineModule.filename = baselineModule.id;
baselineModule.paths = module.paths;
baselineModule._compile(ts.transpileModule(baselineSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} }).outputText, baselineModule.filename);
const baseline = baselineModule.exports;
const timestamp = '2026-10-12T00:00:00.000Z';
const document = { schemaVersion: 1, revision: 1, updatedAt: timestamp, entries: [
  { key: 'provider.submission.acceptances.v1', value: {
    records: Array.from({ length: 25 }, (_, index) => ({ id: `synthetic-${index}`,
      result: index < 13 ? { content: 'A'.repeat(Math.floor(31000000 / 13)), encoding: 'base64' }
        : { reference: `local-result-${index}` } }))
  } },
  { key: 'conversation.agent.runtime.v1', value: {
    events: Array.from({ length: 1028 }, (_, index) => ({ sequence: index + 1,
      code: 'synthetic_progress', content: 'x'.repeat(1200) }))
  } },
  { key: 'conversation.agent.session.v1', value: { status: 'accepted', revision: 1 } }
] };
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(value => Math.round(value * 10) / 10),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 };
}
async function coreBenchmark(Unit) {
  // Measure only the synchronous transaction callback with a fresh immutable
  // input each call; real filesystem/backup costs are measured separately below.
  const unit = new Unit({ mutateJsonAtomically: async (_path, mutate) => mutate(document) }, () => timestamp);
  const transact = () => unit.transact(1, draft => draft.set('conversation.agent.session.v1', { status: 'streaming', revision: 2 }));
  await transact();
  const times = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now(); await transact(); times.push(performance.now() - start);
  }
  const originalClone = global.structuredClone;
  let clonedValueBytes = 0;
  global.structuredClone = value => {
    clonedValueBytes += Buffer.byteLength(JSON.stringify(value));
    return originalClone(value);
  };
  try { await transact(); } finally { global.structuredClone = originalClone; }
  assert.equal(document.entries[2].value.status, 'accepted');
  return { ...stats(times), clonedValueBytes };
}
async function diskBenchmark(root, Unit) {
  await mkdir(path.join(root, 'entities'), { recursive: true });
  await writeFile(path.join(root, 'entities/project-metadata.json'), JSON.stringify(document, null, 2) + '\n');
  const unit = new Unit(new NodeProjectStorage(root), () => timestamp);
  await unit.transact(1, draft => draft.set('conversation.agent.session.v1', { status: 'streaming', revision: 2 }));
  const times = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    await unit.transact(2 + sample, draft => draft.set('conversation.agent.session.v1', { status: 'streaming', revision: 3 + sample }));
    times.push(performance.now() - start);
  }
  const loaded = await unit.load();
  assert.equal(loaded.source, 'primary');
  assert.equal(loaded.document.revision, 7);
  assert.deepEqual(loaded.document.entries.find(entry => entry.key === document.entries[0].key), document.entries[0]);
  return stats(times);
}
(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-synthetic-metadata-'));
  try {
    const report = { schemaVersion: 1, date: '2026-10-12', paidRequests: 0, baseline: baselineRef,
      fixture: { metadataBytes: Buffer.byteLength(JSON.stringify(document, null, 2)), entries: document.entries.length,
        acceptanceRecords: 25, largePayloads: 13, canonicalEvents: 1028 },
      transactionCore: { baseline: await coreBenchmark(baseline.ProjectMetadataUnitOfWork),
        current: await coreBenchmark(current.ProjectMetadataUnitOfWork) },
      transactionWithAtomicBackup: {
        baseline: await diskBenchmark(path.join(root, 'baseline'), baseline.ProjectMetadataUnitOfWork),
        current: await diskBenchmark(path.join(root, 'current'), current.ProjectMetadataUnitOfWork)
      } };
    console.log(JSON.stringify(report, null, 2));
    const output = process.argv[2];
    if (output) await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  } finally {
    // Verify the exact resolved cleanup target before any recursive removal.
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('unicomp-synthetic-metadata-'));
    await rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
