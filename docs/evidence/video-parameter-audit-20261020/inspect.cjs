// Read-only product audit. All transport/credentials below are synthetic.
// The production compiler runs with a write-capturing fs facade in a VM.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const workspace = path.resolve(__dirname, '../../..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const relative = filename => path.relative(workspace, filename).replaceAll('\\', '/');
const read = filename => fs.readFileSync(path.resolve(workspace, filename), 'utf8');
const originalResolver = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('.') && parent?.filename?.startsWith(workspace + path.sep) && !path.extname(request)) {
    for (const extension of ['.ts', '.tsx']) {
      const candidate = path.resolve(path.dirname(parent.filename), request + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return originalResolver.call(this, request, parent, ...rest);
};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (entry, filename) => entry._compile(
  // The Node-only harness disables Vite's development performance probe.
  // Parameter projection/validation and provider logic execute unmodified.
  ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({ DEV: false })'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, filename);
let externalRequestAttempts = 0;
globalThis.fetch = async () => { externalRequestAttempts++; throw new Error('Network forbidden in offline audit'); };
const source = filename => require(path.join(workspace, filename));
const { validateParameterValues } = source('src/domain/entities/product-feature.ts');
const { validateDynamicParameterValues } = source('src/components/dynamic-parameter-validation.ts');
const { toDynamicParameterFields } = source('src/components/DynamicParameterForm.tsx');
const { listWwwVideoContracts, wwwVideoParameterSchema } = source('src/platform/providers/newapi/www-video-contracts.ts');
const { wwwAdapterFixture, wwwConnection, wwwRoute } = source('tests/fixtures/www-video.ts');
const { WwwVideoAdapter } = source('src/platform/providers/newapi/www-video-adapter.ts');
const { NewApiSharedRuntime } = source('src/platform/providers/newapi/newapi-runtime.ts');
const { UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID } = source('src/platform/providers/newapi/unicompapi-contracts.ts');
const { inspectImageBuffer } = source('src/platform/files/node-image-inspector.ts');
const { ProjectImageMaterialResolver } = source('src/platform/providers/vidu/controlled-image-material.ts');
const { NodeProjectStorage } = source('src/platform/storage/node-project-storage.ts');
const { JsonAssetRepository, JsonFileReferenceRepository } = source('src/platform/repositories/json-repositories.ts');
const { createAsset, createFileReference, transitionFile } = source('src/domain/index.ts');
const docsPath = 'outputs/video-parameter-audit-20261020/sources.json';
const docs = JSON.parse(read(docsPath));
const contracts = listWwwVideoContracts();
const byKey = key => contracts.find(c => c.modelKey === key);
function hashes() {
  const files = Object.keys(require.cache).filter(file => file.startsWith(workspace + path.sep) &&
    !file.includes(path.sep + 'node_modules' + path.sep) && /\.(tsx?|json)$/.test(file));
  files.push(path.join(workspace, 'scripts/compile-www-video-contracts.cjs'));
  for (const file of ['scripts/collect-www-video-contracts.cjs', 'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
    'src/platform/ipc/video-feature-runtime.ts', 'src/platform/providers/video-feature-submission.ts',
    'tests/domain/dynamic-parameter-validation.test.ts', 'tests/domain/product-feature.test.ts',
    'tests/platform/dynamic-parameter-buffer.test.ts', 'tests/platform/www-video.test.ts', 'tests/platform/project-video-feature.test.ts',
    'tests/ui/dynamic-parameter-form.test.mjs', 'tests/ui/dynamic-parameter-candidate-stability.test.mjs']) files.push(path.join(workspace, file));
  return Object.fromEntries([...new Set(files)].sort().map(file => [relative(file), sha256(fs.readFileSync(file))]));
}
function validate(key, values, feature = byKey(key).features[0]) {
  const schema = wwwVideoParameterSchema(byKey(key), feature);
  const ui = validateDynamicParameterValues(toDynamicParameterFields(schema.fields), values);
  try { validateParameterValues(schema, 'full', values); return { hostValid: true, uiValid: ui.valid, uiErrors: ui.errors }; }
  catch (error) { return { hostValid: false, hostCode: error.code, uiValid: ui.valid, uiErrors: ui.errors }; }
}
async function replay(key, values, prompt, feature, requestOverrides = {}) {
  const f = wwwAdapterFixture(key, feature);
  f.setApproval(false); // Exit after a successful synthetic quote, before any generation.
  const result = await f.adapter.submit({ routeSnapshot: f.route,
    request: { ...f.request, parameterValues: values, ...(prompt === undefined ? {} : { prompt }), ...requestOverrides } });
  const calls = f.calls.map(call => {
    const body = call.headers['content-type'] === 'application/json'
      ? JSON.parse(new TextDecoder().decode(call.body)) : undefined;
    return { path: new URL(call.url).pathname, method: call.method,
      ...(body ? { operation: body.operation ?? (new URL(call.url).pathname.endsWith('/quote') ? 'quote' : 'submit'), parameterValues: body.parameters } : {}) };
  });
  assert.ok(calls.every(c => c.path === '/v1/assets' || c.path.endsWith('/quote') || c.operation === 'quote'), 'No generation even on the synthetic transport');
  return { ...validate(key, values, f.route.productFeature), result,
    syntheticQuoteCalls: calls.filter(call => call.operation === 'quote').length,
    syntheticUploadCalls: calls.filter(call => call.path === '/v1/assets').length,
    approvalCalls: f.approvals.length, calls };
}
function compileWithoutWriting(sourceFile) {
  const writes = {};
  const scriptFile = path.join(workspace, 'scripts/compile-www-video-contracts.cjs');
  const scriptRequire = Module.createRequire(scriptFile);
  const localFs = {
    readFileSync: (file, encoding) => fs.readFileSync(path.resolve(workspace, file), encoding),
    writeFileSync: (file, contents) => { writes[file] = String(contents); },
    mkdirSync: () => {}
  };
  vm.runInNewContext(read('scripts/compile-www-video-contracts.cjs'), {
    require: name => name === 'node:fs' ? localFs : scriptRequire(name),
    process: { argv: ['node', scriptFile, sourceFile] }
  }, { filename: scriptFile, timeout: 5000 });
  const generated = JSON.parse(writes['src/platform/providers/newapi/www-video-catalog.json']);
  const differences = generated.contracts.flatMap(next => {
    const current = byKey(next.modelKey);
    return next.fields.filter(field => JSON.stringify(field) !== JSON.stringify(current.fields.find(f => f.name === field.name)))
      .map(field => ({ modelKey: next.modelKey, field: field.name,
        committed: current.fields.find(f => f.name === field.name), compiled: field }));
  });
  return { sourceFile, capturedWritePaths: Object.keys(writes), fieldDifferences: differences };
}
const cleanHtml = text => text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
// A real RGBA PNG containing transparent pixels, constructed entirely in memory.
function syntheticPng(width, height, opaqueRgb = false) {
  const zlib = require('node:zlib');
  function chunk(type, data) {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); bytes.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = opaqueRgb ? 2 : 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * (opaqueRgb ? 3 : 4) + 1) * height), { level: opaqueRgb ? 0 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}
async function alphaReplay() {
  const route = wwwRoute('wan3.0-video-ali', 'image_to_video');
  const bytes = syntheticPng(300, 300);
  const calls = [];
  const runtime = new NewApiSharedRuntime({ transport: { async send(request) {
    const url = new URL(request.url);
    calls.push({ path: url.pathname, method: request.method });
    const body = url.pathname === '/v1/assets' ? { data: { id: 'synthetic-transparent-image' } }
      : { currency: 'CNY_MICRO', input_digest: 'a'.repeat(64), price_version: 'synthetic-price', quoted_amount: 1000000, closed_reasons: [] };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
  } } });
  const adapter = new WwwVideoAdapter(runtime, { get: async () => wwwConnection() },
    { useCredential: async (_input, action) => action({ schemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
      values: { api_key: 'synthetic-offline-key' } }) },
    { resolve: async ({ assetId }) => ({ assetId, mimeType: 'image/png', width: 300, height: 300, sizeBytes: bytes.length, bytes }) },
    { append: async () => {} }, { nextProviderUsageObservationId: () => 'usage-synthetic' }, undefined,
    { confirm: async () => false });
  const result = await adapter.submit({ routeSnapshot: route, request: { projectId: route.projectId,
    invocationAttemptId: 'attempt-alpha-audit', prompt: 'Synthetic public audit image.', parameterValues: { generation_mode: 'first_frame' },
    assetId: 'asset-alpha-audit' } });
  return { input: { pngColorType: bytes[25], alphaChannel: true, allPixelsFullyTransparent: true, productionHeaderInspection: inspectImageBuffer(bytes),
    width: 300, height: 300, sizeBytes: bytes.length, sha256: sha256(bytes) }, result, syntheticCalls: calls };
}
async function materialSizeReplay() {
  const root = fs.mkdtempSync(path.join(workspace, 'outputs/video-parameter-audit-20261020/material-size-'));
  const bytes = syntheticPng(2400, 2400, true);
  const projectId = 'project-material-size-audit', assetId = 'asset-material-size-audit';
  const timestamp = '2026-10-20T00:00:00.000Z';
  const storage = new NodeProjectStorage(root);
  fs.mkdirSync(path.join(root, 'files'), { recursive: true });
  fs.writeFileSync(path.join(root, 'files/input.png'), bytes);
  const pending = createFileReference({ id: 'file-material-size-audit', projectId,
    locator: { kind: 'project', relativePath: 'files/input.png' }, createdAt: timestamp });
  const available = transitionFile(transitionFile(pending, 'verifying', timestamp), 'available', timestamp,
    { sizeBytes: bytes.length, checksumSha256: sha256(bytes) });
  await new JsonFileReferenceRepository(storage, projectId).save(available);
  await new JsonAssetRepository(storage, projectId).save(createAsset({ id: assetId, projectId, fileId: available.id,
    name: 'input.png', mediaKind: 'image', origin: 'imported',
    imageMetadata: { mimeType: 'image/png', width: 2400, height: 2400 }, createdAt: timestamp }));
  const session = { projectId, projectName: 'Synthetic audit only', rootDirectory: root };
  const resolver = new ProjectImageMaterialResolver({ getSession: () => session });
  let defaultLimitError;
  try { await resolver.resolve({ projectId, assetId }); } catch (error) { defaultLimitError = error.code; }
  assert.equal(defaultLimitError, 'material_too_large');
  const explicitResolver = new ProjectImageMaterialResolver({ getSession: () => session, maximumInputBytes: 20 * 1024 * 1024 });
  const resolved = await explicitResolver.resolve({ projectId, assetId });
  assert.equal(resolved.sizeBytes, bytes.length);
  return { syntheticRoot: relative(root), productionHeaderInspection: inspectImageBuffer(bytes), pngColorType: bytes[25],
    defaultLimitBytes: 15 * 1024 * 1024, defaultLimitError, explicit20MiBLimitAcceptsSameFile: true,
    withinAllCurrentWwwImageByteLimits: contracts.every(c => bytes.length < c.imageLimits.maximumBytes) };
}
async function main() {
  const beforeHashes = hashes();
  const sourceRecords = docs.records.map(record => {
    const html = read(`outputs/video-parameter-audit-20261020/${record.modelKey}.html`);
    assert.equal(sha256(html), record.sha256);
    assert.equal(record.status, 200);
    return { modelKey: record.modelKey, url: record.url, retrievedAt: record.retrievedAt, status: record.status, sha256: record.sha256,
      relevantNotes: [...new Set(record.notes)].filter(note => /字符|frames为|不提供单尾帧|图片须无透明通道/.test(note)),
      modeRows: [...(html.match(/<section id="modes"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
        .map(row => [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => cleanHtml(cell[1]))) };
  });
  const fieldMatrix = contracts.map(contract => {
    const record = docs.records.find(r => r.modelKey === contract.modelKey);
    return { modelKey: contract.modelKey, revision: contract.revision, fields: contract.fields.map(field => ({
      ...field, documentedTableRow: record.tables.find(row => row[0]?.match(/^parameters\.([a-z_]+)/)?.[1] === field.name) ?? null,
      projections: contract.features.map(feature => ({ feature,
        field: wwwVideoParameterSchema(contract, feature).fields.find(f => f.fieldId === field.name) ?? null }))
    })), maximumPromptLength: contract.maximumPromptLength };
  });
  assert.equal(fieldMatrix.flatMap(c => c.fields).length, 58);
  assert.equal(docs.records.flatMap(r => r.tables.filter(row => row[0]?.startsWith('parameters.'))).length, 53);
  const controls = [];
  for (const contract of contracts) for (const feature of contract.features) {
    const schema = wwwVideoParameterSchema(contract, feature);
    for (const field of schema.fields) {
      const base = feature === 'image_to_video' && schema.fields.some(f => f.fieldId === 'generation_mode') ? { generation_mode: 'first_frame' } : {};
      const raw = contract.fields.find(f => f.name === field.fieldId).schema;
      const valid = raw.enum?.find(value => field.options?.includes(value)) ?? (raw.type === 'boolean' ? false : raw.type === 'string' ? 'synthetic' : raw.minimum ?? 0);
      const wrongType = raw.type === 'string' ? 1 : raw.type === 'boolean' ? 'false' : '5';
      const probes = [ ['valid_value', valid, true], ['wrong_type', wrongType, false] ];
      if (field.options) probes.push(['outside_enum', raw.type === 'integer' ? 999999999999 : '__outside_enum__', false]);
      if (raw.minimum !== undefined) probes.push(['below_minimum', raw.minimum - 1, false]);
      if (raw.maximum !== undefined) probes.push(['above_maximum', raw.maximum + 1, false]);
      if (field.fieldId === 'frames') probes.push(['wrong_frame_increment', 30, false]);
      for (const [probe, value, expected] of probes) {
        const actual = validate(contract.modelKey, { ...base, [field.fieldId]: value }, feature);
        assert.equal(actual.hostValid, expected, `${contract.modelKey}/${feature}/${field.fieldId}/${probe} host`);
        assert.equal(actual.uiValid, expected, `${contract.modelKey}/${feature}/${field.fieldId}/${probe} ui`);
        controls.push({ modelKey: contract.modelKey, feature, field: field.fieldId, probe, value, ...actual });
      }
    }
  }
  const h3 = {};
  for (const [name, values] of Object.entries({ empty: {}, partial: { duration: 5 }, arbitrary_strings: { resolution: '__invalid__', ratio: '__invalid__' },
    zero_duration: { duration: 0 }, huge_duration: { duration: 999999999 }, negative_duration: { duration: -1 } })) {
    h3[name] = await replay('MiniMax-H3', values);
  }
  assert.equal(h3.empty.syntheticQuoteCalls, 1);
  assert.equal(h3.negative_duration.hostValid, true);
  assert.equal(h3.negative_duration.uiValid, false);
  const seedanceKey = 'doubao-seedance-2-0-260128';
  const seedance = {
    prompt2500Ascii: await replay(seedanceKey, {}, 'a'.repeat(2500)),
    prompt3000Ascii: await replay(seedanceKey, {}, 'a'.repeat(3000)),
    prompt1500UnicodeCodePoints: await replay(seedanceKey, {}, '😀'.repeat(1500)),
    framesOnly: await replay(seedanceKey, { frames: 29 }),
    durationOnly: await replay(seedanceKey, { duration_seconds: 4 }),
    framesAndDuration: await replay(seedanceKey, { frames: 29, duration_seconds: 4 }),
    firstLastFrameWithOneImage: await replay(seedanceKey, { generation_mode: 'first_last_frame' }, undefined, 'image_to_video'),
    firstLastFrameWithTwoImages: await replay(seedanceKey, { generation_mode: 'first_last_frame' }, undefined, 'image_to_video',
      { assetId: undefined, assetIds: ['asset-synthetic-first', 'asset-synthetic-last'] })
  };
  assert.equal(seedance.prompt2500Ascii.syntheticQuoteCalls, 1);
  assert.equal(seedance.prompt3000Ascii.syntheticQuoteCalls, 0);
  assert.equal(seedance.prompt1500UnicodeCodePoints.syntheticQuoteCalls, 0);
  assert.equal(seedance.framesAndDuration.hostValid, true);
  assert.equal(seedance.framesAndDuration.uiValid, true);
  assert.equal(seedance.framesAndDuration.syntheticQuoteCalls, 0);
  assert.equal(seedance.firstLastFrameWithOneImage.uiValid, true);
  assert.equal(seedance.firstLastFrameWithOneImage.syntheticQuoteCalls, 0);
  assert.equal(seedance.firstLastFrameWithTwoImages.calls.filter(c => c.path.endsWith('/quote')).length, 1);
  const alpha = await alphaReplay();
  assert.equal(alpha.syntheticCalls.filter(c => c.path === '/v1/assets').length, 1);
  assert.equal(alpha.syntheticCalls.filter(c => c.path.endsWith('/quote')).length, 1);
  const materialSize = await materialSizeReplay();
  const compilerReplays = [ 'outputs/www-video-contracts/official-reviewed-20261019/sources.json', docsPath ].map(compileWithoutWriting);
  assert.equal(compilerReplays[0].fieldDifferences.length, 0, 'Retained source reproduces the committed fields');
  assert.ok(compilerReplays[1].fieldDifferences.some(d => d.field === 'output_format' && d.compiled.schema.enum.includes('mov')));
  const afterHashes = hashes();
  for (const [file, hash] of Object.entries(beforeHashes)) assert.equal(afterHashes[file], hash, file);
  assert.equal(externalRequestAttempts, 0);
  const result = { auditedAt: new Date().toISOString(), sourceRecords, fieldMatrix,
    controls: { count: controls.length, allExpected: true, rows: controls }, replays: { h3, seedance, aliTransparentPng: alpha, materialSize, compilerReplays },
    boundaries: { auditOnly: true, productChanges: 0, realCredentialReads: 0, userProjectReads: 0,
      offlineExternalRequestAttempts: externalRequestAttempts, realGenerationRequests: 0, settlementRequests: 0, modelFeesCny: 0,
      publicDocumentationGets: docs.records.length, publicDocumentationScope: 'Nine public WWW model documentation URLs; no credentials or project data',
      syntheticProjectWrites: true,
      productSourceHashesUnchanged: true }, sourceHashes: beforeHashes };
  fs.writeFileSync(path.join(__dirname, 'inspection.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ fields: 58, controls: controls.length, h3: Object.keys(h3),
    seedancePrompt3000: seedance.prompt3000Ascii, alpha, compilerReplays,
    productSourceHashesUnchanged: true, offlineExternalRequestAttempts: externalRequestAttempts }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
