const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { app, BrowserWindow, session, dialog } = require('electron');
const p = require('../dist-electron/src/platform');
const d = require('../dist-electron/src/domain');
const { ElectronViduComposition } = require('../dist-electron/electron/ipc/vidu-composition');
const { registerStorageIpcHandlers } = require('../dist-electron/electron/ipc/storage-ipc');
const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
const recover = process.argv.includes('--recover');
const live = process.argv.includes('--live') || recover;
const caseArg = process.argv.find(x => x.startsWith('--live-case='))?.slice('--live-case='.length);
const allowedCases = ['wan3.0-video-ali:image_to_video', 'happyhorse-1.1-t2v:text_to_video', 'happyhorse-1.1-i2v:image_to_video', 'happyhorse-1.1-r2v:image_to_video', 'wan3.0-video-prime-ali:text_to_video'];
if (caseArg) assert.ok(allowedCases.includes(caseArg));
const caseOutput = caseArg ? `live-${caseArg.replace(':', '-')}` : 'live-e2e';
const originalReceipt = recover ? JSON.parse(sync.readFileSync(path.resolve('outputs/www-video-contracts', caseOutput, 'local-receipt.json'), 'utf8')) : undefined;
const userRoot = path.join(app.getPath('appData'), 'unicomp-desktop');
const temporary = recover ? originalReceipt.isolatedRoot : sync.mkdtempSync(path.join(os.tmpdir(), 'unicomp-www-video-e2e-'));
const userData = path.join(temporary, 'profile');
if (!recover) sync.mkdirSync(userData);
if (live && !recover) for (const name of ['Local State', 'provider-registry.json', 'secure-credentials.json']) sync.copyFileSync(path.join(userRoot, name), path.join(userData, name));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const output = live ? path.resolve('outputs/www-video-contracts', caseOutput) : path.resolve('outputs/video-parameter-repair-20261020/electron');
const now = () => d.toIsoTimestamp(new Date().toISOString());
const budgetFile = path.resolve('outputs/www-video-contracts/live/budget.json');
let window, lifecycle, runtime, lock;
let paidPost = 0, externalRequests = 0, rejectSyntheticQuote = false;
const requests = [], checks = [];
const resultTasks = new Map();
const quotedInputs = new Map();
let budget, currentEntry, availableCnyMicro;
const encode = v => new TextEncoder().encode(JSON.stringify(v));
const unwrap = r => { assert.ok(r?.ok, JSON.stringify(r)); return r.value; };
const digest = v => createHash('sha256').update(v).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (!live) dialog.showMessageBox = async (_parent, options) => {
    assert.equal(options.title, '确认本次视频费用');
    assert.ok(options.message.includes('¥1'));
    assert.ok(!options.detail.includes('上限'));
    return { response: 1, checkboxChecked: false };
  };
  await fs.mkdir(output, { recursive: true });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: url.protocol.startsWith('http') && (!live || url.origin !== 'https://www.unicompapi.com') });
  });
  const rootDirectory = path.join(temporary, 'project'); if (!recover) await fs.mkdir(rootDirectory);
  const projectId = d.toProjectId('project-www-electron-e2e');
  const projectSession = { projectId, projectName: 'WWW video acceptance', rootDirectory };
  const sessions = new p.StorageProjectSessionRegistry(); sessions.set(projectSession);
  const composition = new ElectronViduComposition({ getProxyMode: async () => ({ kind: 'system_default' }) });
  const packages = new p.ProviderPackageRegistry([p.deepSeekProviderPackageDescriptor, p.volcengineProviderPackageDescriptor,
    p.klingProviderPackageDescriptor, p.minimaxH3ProviderPackageDescriptor, p.unicompapiStudioH3ProviderPackageDescriptor, p.kimiProviderPackageDescriptor,
    p.newApiProviderPackageDescriptor, p.unicompapiProviderPackageDescriptor, p.unicompapiWwwProviderPackageDescriptor, p.viduProviderPackageDescriptor]);
  const auth = new p.RuntimeAuthorizationLedger(new p.JsonRuntimeAuthorizationLedgerStore(path.join(userData, 'acceptance-authorization.json')));
  const framework = new p.ProviderManagementFramework(packages, composition.registry, composition.credentialVault,
    new p.ProviderManagementAdapterRegistry(packages, []), new p.JsonProviderManagementAuditStore(path.join(userData, 'acceptance-audit.json')));
  let connection;
  const contracts = p.listWwwVideoContracts();
  if (!live) {
    const providerId = d.toProviderId('provider-www-electron-e2e'); const connectionId = d.toConnectionId('connection-www-electron-e2e');
    const bindingId = d.toProtocolBindingId('binding-www-catalog-e2e');
    connection = d.createProviderConnection({ id: connectionId, providerId, name: 'Synthetic WWW', endpoint: p.UNICOMPAPI_WWW_BASE_URL,
      packageId: p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, packageVersion: '1.0.0', templateId: p.UNICOMPAPI_WWW_TEMPLATE_ID, templateKind: 'official',
      credentialSchemaId: p.UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1, credentialVersionId: 'credential-www-e2e-1', credentialReference: 'synthetic-www-e2e',
      connectionPolicyId: 'connection.unicompapi.www-relay', connectionPolicyRevision: 1, discoveryPolicyId: 'discovery.unicompapi.www-models', discoveryPolicyRevision: 1,
      endpointPolicyId: p.UNICOMPAPI_WWW_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1, connectionConfigVersionId: 'config-www-e2e-1', connectionRevision: 1,
      adapterBindings: [{ adapterId: p.NEWAPI_CHAT_ADAPTER_ID, adapterVersion: p.NEWAPI_ADAPTER_VERSION, protocolId: p.NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: now(), updatedAt: now() });
    await composition.registry.mutate(snapshot => ({ result: undefined, snapshot: { ...snapshot,
      providers: [d.createProvider({ id: providerId, name: 'Synthetic WWW', packageId: connection.packageId, packageVersion: '1.0.0', accessCategory: 'online', identityState: 'verified', createdAt: now(), updatedAt: now() })],
      connections: [connection], protocolBindings: [d.createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
        protocolId: p.NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: p.NEWAPI_PROTOCOL_VERSION, adapterKind: p.NEWAPI_CHAT_ADAPTER_ID, mediaKind: 'unknown', authScheme: 'bearer',
        executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: now(), updatedAt: now() })],
      models: contracts.map(c => d.createProviderModel({ id: d.toModelId(`model-www-e2e-${c.modelKey}`), providerId, connectionId, protocolBindingId: bindingId,
        providerModelKey: c.modelKey, displayName: c.modelKey, mediaKind: 'unknown', revision: 1, catalogState: 'present', enabled: false, createdAt: now(), updatedAt: now() }))
    } }));
    await composition.credentialVault.saveRecord('synthetic-www-e2e', { schemaId: p.UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, schemaVersion: 1, values: { api_key: 'synthetic-e2e-key' } });
  } else {
    const all = (await composition.registry.load()).connections.filter(c => c.packageId === p.UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID && c.state === 'available');
    assert.equal(all.length, 1); connection = all[0];
    lock = await fs.open(path.resolve('outputs/www-video-contracts/live/run.lock'), 'wx');
    try { budget = JSON.parse(await fs.readFile(budgetFile, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT' || recover) throw error;
      budget = { maximumCnyMicro: 5_000_000, records: [], createdAt: new Date().toISOString() };
    }
    budget.outboundScope = 'Synthetic cup prompt, generated local reference image/video and documented parameters only; no enterprise project content';
    await fs.writeFile(budgetFile, JSON.stringify(budget, null, 2));
    assert.equal(budget.maximumCnyMicro, 5_000_000);
    if (!recover) {
      assert.ok(budget.records.every(r => ['succeeded', 'failed'].includes(r.state) && r.settlementPending === false && Number.isSafeInteger(r.actualChargedCnyMicro)), 'Reconcile unresolved originals before new generation');
      assert.ok(!budget.records.some(r => r.model === (caseArg?.split(':')[0] ?? 'wan3.0-video-ali') && (r.feature ?? 'text_to_video') === (caseArg?.split(':')[1] ?? 'text_to_video')), 'This acceptance case already exists');
      availableCnyMicro = budget.maximumCnyMicro - budget.records.reduce((sum, r) => sum + r.actualChargedCnyMicro, 0);
      assert.ok(availableCnyMicro > 0);
    }
  }
  await auth.upsertPolicy({ policyId: 'policy-www-e2e', providerPackageId: connection.packageId, connectionId: connection.id,
    state: 'interactive_allowed', revision: 1, allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
  for (const c of recover ? [] : contracts) {
    const m = (await composition.registry.load()).models.find(m => m.connectionId === connection.id && m.providerModelKey === c.modelKey);
    assert.ok(m);
    unwrap(await framework.bindModelApiContract({ modelId: m.id, expectedRevision: m.revision, binding: { schemaVersion: 1, contractId: c.id, contractRevision: c.revision, rules: [] }, confirmed: true }));
    unwrap(await framework.setModelEnabled({ modelId: m.id, enabled: true }));
  }
  const image = path.join(rootDirectory, live ? 'reference.png' : 'reference.jpg'), video = path.join(rootDirectory, 'reference.mp4');
  await fs.copyFile(path.resolve('outputs/www-video-contracts/reference.png'), image);
  if (!live) {
    const { nativeImage } = require('electron');
    // Flatten the synthetic reference to an opaque JPEG for alpha-forbidden models.
    const opaque = path.join(rootDirectory, 'opaque-reference.jpg');
    await fs.writeFile(opaque, nativeImage.createFromPath(image).toJPEG(95));
    await fs.copyFile(opaque, image);
  }
  await fs.copyFile(path.resolve('outputs/www-video-contracts/reference.mp4'), video);
  const mp4 = await fs.readFile(video);
  const transport = { async send(request) {
    const url = new URL(request.url); const operation = request.method === 'GET' ? 'read' : url.pathname === '/v1/assets' ? 'upload' : 'post';
    requests.push({ method: request.method, path: url.pathname, operation });
    if (live) {
      if (recover) assert.equal(request.method, 'GET', 'Recovery is read only; no second paid generation');
      if (request.method === 'POST' && url.pathname === '/v1/videos') {
        assert.equal(paidPost++, 0, 'No second paid submission');
        const body = JSON.parse(Buffer.from(request.body).toString());
        assert.equal(body.model, caseArg?.split(':')[0] ?? 'wan3.0-video-ali');
        assert.ok(Number.isSafeInteger(body.expected_quote_amount) && body.expected_quote_amount > 0 && body.expected_quote_amount <= availableCnyMicro);
        currentEntry = { model: body.model, feature: caseArg?.split(':')[1] ?? 'text_to_video', idempotencyKey: request.headers['Idempotency-Key'], reservedCnyMicro: availableCnyMicro,
          quotedAmount: body.expected_quote_amount, actualChargedCnyMicro: null, state: 'submission_unknown', createdAt: new Date().toISOString() };
        budget.records.push(currentEntry);
        await fs.writeFile(budgetFile, JSON.stringify(budget, null, 2));
      }
      externalRequests++;
      const response = await new ElectronNewApiHttpTransport().send(request);
      if (response.body && url.pathname.startsWith('/v1/videos') && !url.pathname.endsWith('/content')) {
        try {
          const body = JSON.parse(Buffer.from(response.body).toString()); const entry = currentEntry ?? budget.records.find(r => r.taskId === body.id);
          if (entry && typeof body.id === 'string') {
            entry.taskId = body.id; entry.state = body.status;
            if (Number.isSafeInteger(body.billing?.charged_amount)) entry.actualChargedCnyMicro = body.billing.charged_amount;
            entry.settlementPending = body.billing?.settlement_pending;
            await fs.writeFile(budgetFile, JSON.stringify(budget, null, 2));
            await fs.writeFile(path.join(output, 'original-shape.json'), JSON.stringify({ status: body.status, review_phase: body.review_phase, billing: body.billing,
              fields: Object.keys(body), dataFields: body.data?.map(x => Object.keys(x)) }, null, 2));
          }
        } catch { /* Keep durable original reservation if a response is malformed. */ }
      }
      return response;
    }
    const headers = { 'content-type': 'application/json', 'x-unicomp-request-id': 'synthetic-www-request' };
    let data;
    const body = request.body && request.headers['content-type'] === 'application/json' ? JSON.parse(Buffer.from(request.body).toString()) : {};
    if (url.pathname === '/v1/assets') data = { data: { id: `uploaded-${requests.length}` } };
    else if (url.pathname.endsWith('/quote') || body.operation === 'quote') {
      if (rejectSyntheticQuote) return { status: 400, headers: { ...headers, 'x-request-id': 'synthetic-quote-error' },
        body: encode({ error: { code: 'invalid_h3_parameters', message: 'Invalid H3 parameters; synthetic-e2e-key https://example.invalid/private' } }) };
      const input = { ...body }; delete input.operation; const hash = digest(JSON.stringify(input)); quotedInputs.set(hash, input);
      data = { currency: 'CNY_MICRO', quoted_amount: 1_000_000, input_digest: hash, price_version: 'synthetic-price', closed_reasons: [] };
    } else if (request.method === 'POST') {
      const original = { ...body }; for (const key of ['operation', 'expected_input_digest', 'expected_quote_amount', 'expected_price_version']) delete original[key];
      assert.deepEqual(original, quotedInputs.get(body.expected_input_digest ?? digest(JSON.stringify(original))));
      const id = `task-www-${resultTasks.size}`; resultTasks.set(id, { model: body.model, h3: body.model === 'MiniMax-H3', polls: 0 }); data = { id, model: body.model, status: 'queued' };
    } else if (url.pathname.endsWith('/content')) {
      const task = resultTasks.get(url.pathname.split('/').at(-2)); assert.ok(task);
      task.downloads = (task.downloads ?? 0) + 1;
      if (task.h3 && task.downloads === 1) throw new Error('synthetic transient private-content GET failure');
      return { status: 200, headers: { 'content-type': 'video/mp4' }, body: mp4 };
    }
    else {
      const id = url.pathname.split('/').at(-1); const task = resultTasks.get(id); assert.ok(task);
      task.polls++;
      if (task.h3 && task.polls === 1) throw new Error('synthetic transient original-task GET failure');
      if (task.h3 && task.polls === 2) return { status: 200, headers, body: encode({ id, model: task.model, status: 'processing' }) };
      data = { id, model: task.model, status: 'succeeded', billing: { currency: 'CNY_MICRO', charged_amount: 1_000_000, settlement_pending: false },
        ...(task.h3 ? { output_type: 'video', review_phase: undefined,
          data: { asset_id: `asset-${id}`, url: `/v1/videos/${id}/content?asset_id=asset-${id}`, mime_type: 'video/mp4' } } :
          { review_phase: 'output_approved', data: [{ asset_id: `asset-${id}`, url: `${url.pathname}/content?asset_id=asset-${id}` }] }) };
      if (task.h3) assert.equal(url.searchParams.get('refresh'), 'true');
    }
    return { status: 200, headers, body: encode(data) };
  } };
  runtime = new p.NewApiSharedRuntime({ transport });
  lifecycle = registerStorageIpcHandlers({ sessionRegistry: sessions, vidu: composition, providerPackages: packages, runtimeAuthorization: auth,
    providerUsageSchemas: new p.ProviderUsageSchemaRegistry([p.wwwVideoUsageSchema, p.newApiVideoUsageSchema]),
    textSubmission: { credentialVault: composition.credentialVault, newApiRuntime: runtime,
      deepSeekRuntime: new p.DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected external request'); } } }) } });
  const html = path.join(temporary, 'acceptance.html'); await fs.writeFile(html, '<!doctype html><meta charset="utf-8"><title>WWW video acceptance</title>');
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('dist-electron/electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await window.loadFile(html);
  const js = source => window.webContents.executeJavaScript(source);
  const storage = new p.NodeProjectStorage(rootDirectory);
  const workRepo = new p.JsonWorkRepository(storage, projectId);
  const matrix = live ? contracts.filter(c => c.modelKey === (caseArg?.split(':')[0] ?? 'wan3.0-video-ali')).map(c => [c, caseArg?.split(':')[1] ?? 'text_to_video']) : contracts.flatMap(c => c.features.map(f => [c, f]));
  for (const [c, feature] of matrix) {
    if (recover) {
      const recovered = unwrap(await js(`window.unicomp.videoFeatures.recoverResult(${JSON.stringify(originalReceipt.receipt.taskId)})`));
      const works = (await workRepo.list(projectId)).filter(w => w.sourceTaskId === originalReceipt.receipt.taskId);
      assert.equal(works.length, 1); assert.equal(works[0].id, recovered.workId);
      const file = await new p.JsonFileReferenceRepository(storage, projectId).get(works[0].fileId);
      assert.equal(file.state, 'available');
      const local = await p.resolveFileReferencePathSafely(rootDirectory, file);
      assert.equal(digest(await fs.readFile(local)), file.checksumSha256);
      const inspected = await new p.NodeVideoInspector().inspect(local); assert.ok(inspected.durationMs > 0);
      await js(`window.unicomp.videoFeatures.recoverResult(${JSON.stringify(originalReceipt.receipt.taskId)})`);
      assert.equal((await workRepo.list(projectId)).filter(w => w.sourceTaskId === originalReceipt.receipt.taskId).length, 1);
      await fs.copyFile(local, path.join(output, 'accepted-video.mp4'));
      checks.push({ model: c.modelKey, feature, workId: works[0].id, checksumSha256: file.checksumSha256, metadata: inspected, recovery: 'original task only; zero paid POST', state: 'passed' });
      continue;
    }
    let draft = unwrap(await js(`window.unicomp.videoWorkspaces.create(${JSON.stringify(feature === 'text_to_video' ? 'text_to_video' : 'image_to_video')})`));
    draft.prompt = { originalInput: 'Synthetic orange cup, a gentle camera motion.', finalPrompt: 'Synthetic orange cup, a gentle camera motion.', systemSupplements: [] };
    if (feature !== 'text_to_video') {
      const kind = feature === 'video_edit' ? 'video' : 'image';
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [kind === 'video' ? video : image] });
      unwrap(await js(`window.unicomp.videoWorkspaces.selectMaterial(${JSON.stringify(draft.draftId)}, {kind:'image_source'}, ${JSON.stringify(kind)})`));
      draft = unwrap(await js(`window.unicomp.videoWorkspaces.get(${JSON.stringify(draft.draftId)})`));
      draft.prompt = { originalInput: 'Synthetic orange cup.', finalPrompt: 'Synthetic orange cup.', systemSupplements: [] };
    }
    draft.state = 'saved'; draft.featureSelection = { productFeature: feature, parameterValues: {
      ...(!live && c.modelKey === 'MiniMax-H3' ? c.parameterExample : {}),
      ...(feature === 'image_to_video' && c.fields.some(f => f.name === 'generation_mode') ? { generation_mode: 'first_frame' } : {}),
      ...(live ? { resolution: '480P', duration_seconds: c.modelKey.startsWith('happyhorse') ? 3 : 2, ...(c.modelKey.startsWith('wan') ? { generate_audio: false } : {}) } : {}) } };
    draft = unwrap(await js(`window.unicomp.videoWorkspaces.update(${JSON.stringify(draft)})`));
    const candidates = unwrap(await js(`window.unicomp.videoFeatures.listCandidates(${JSON.stringify(draft.draftId)}, ${JSON.stringify(draft.updatedAt)})`));
    const candidate = candidates.find(x => x.modelName === c.modelKey && x.available); assert.ok(candidate, JSON.stringify(candidates));
    draft.featureSelection = { ...draft.featureSelection, candidateId: candidate.candidateId, parameterSchemaId: candidate.parameterSchema.schemaId, parameterSchemaRevision: candidate.parameterSchema.revision };
    if (!live && c.modelKey === 'MiniMax-H3') draft.featureSelection.parameterValues.maximum_cost_cny = 999;
    draft = unwrap(await js(`window.unicomp.videoWorkspaces.update(${JSON.stringify(draft)})`));
    assert.equal(draft.featureSelection.parameterValues.maximum_cost_cny, undefined);
    if (!live && c.modelKey === 'MiniMax-H3') {
      assert.equal(candidate.parameterSchema.requestRules.requireParameters, true);
      assert.deepEqual(candidate.parameterSchema.exampleValues, c.parameterExample);
      assert.deepEqual(candidate.parameterSchema.fields.filter(f => f.required).map(f => f.fieldId), ['resolution', 'ratio', 'duration']);
      assert.ok(candidate.parameterSchema.fields.filter(f => !f.required).every(f => f.requirement === 'unknown'));
      const before = requests.length;
      const empty = { ...draft, featureSelection: { ...draft.featureSelection, parameterValues: {} } };
      const savedEmpty = unwrap(await js(`window.unicomp.videoWorkspaces.update(${JSON.stringify(empty)})`));
      const invalid = await js(`window.unicomp.videoFeatures.prepareSubmission(${JSON.stringify(savedEmpty.draftId)}, ${JSON.stringify(savedEmpty.updatedAt)}, ${JSON.stringify(candidate.candidateId)})`);
      assert.equal(invalid.ok, false);
      assert.equal(requests.length, before);
      for (const parameters of [
        { duration: 5 },
        { ...c.parameterExample, resolution: '480P' },
        { ...c.parameterExample, ratio: 'adaptive' },
        { ...c.parameterExample, duration: 3 },
        { ...c.parameterExample, duration: 16 },
        { ...c.parameterExample, duration: 4.5 },
        { ...c.parameterExample, duration: '5' }
      ]) {
        const invalidDraft = { ...savedEmpty, featureSelection: { ...savedEmpty.featureSelection, parameterValues: parameters } };
        const saved = unwrap(await js(`window.unicomp.videoWorkspaces.update(${JSON.stringify(invalidDraft)})`));
        const rejected = await js(`window.unicomp.videoFeatures.prepareSubmission(${JSON.stringify(saved.draftId)}, ${JSON.stringify(saved.updatedAt)}, ${JSON.stringify(candidate.candidateId)})`);
        assert.equal(rejected.ok, false);
        assert.equal(requests.length, before);
        savedEmpty.updatedAt = saved.updatedAt;
      }
      checks.push({ model: c.modelKey, check: 'native prepare rejects incomplete, invalid-enum, range, fractional and string duration inputs before requests', state: 'passed' });
      draft = unwrap(await js(`window.unicomp.videoWorkspaces.update(${JSON.stringify({ ...draft, updatedAt: savedEmpty.updatedAt })})`));
      checks.push({ model: c.modelKey, check: 'native prepare rejects empty parameters with zero requests', state: 'passed' });
    }
    const prepare = unwrap(await js(`window.unicomp.videoFeatures.prepareSubmission(${JSON.stringify(draft.draftId)}, ${JSON.stringify(draft.updatedAt)}, ${JSON.stringify(candidate.candidateId)})`));
    const receipt = unwrap(await js(`window.unicomp.videoFeatures.submitDraft(${JSON.stringify(draft.draftId)}, ${JSON.stringify(draft.updatedAt)}, ${JSON.stringify(prepare.routeSelectionToken)}, ${JSON.stringify(prepare.confirmation.confirmationId)}, true)`));
    assert.ok(receipt.taskId, JSON.stringify(receipt));
    if (live) await fs.writeFile(path.join(output, 'local-receipt.json'), JSON.stringify({ isolatedRoot: temporary, projectId, draftId: draft.draftId, receipt }, null, 2));
    let works = [];
    for (let i = 0; i < (live ? 600 : 200); i++) { works = (await workRepo.list(projectId)).filter(w => w.sourceTaskId === receipt.taskId); if (works.length) break; await delay(live ? 1000 : 50); }
    assert.equal(works.length, 1, `${c.modelKey}/${feature} no unique local work: ${JSON.stringify(receipt)}`);
    const file = await new p.JsonFileReferenceRepository(storage, projectId).get(works[0].fileId);
    assert.equal(file.state, 'available');
    const local = await p.resolveFileReferencePathSafely(rootDirectory, file);
    assert.equal(digest(await fs.readFile(local)), file.checksumSha256);
    assert.ok((await new p.NodeVideoInspector().inspect(local)).durationMs > 0);
    if (!live) {
      const task = await new p.JsonTaskRepository(storage, projectId).get(receipt.taskId);
      assert.deepEqual(task.submission.video.featureParameters, { schemaId: candidate.parameterSchema.schemaId,
        revision: candidate.parameterSchema.revision, values: draft.featureSelection.parameterValues });
      const execution = await new p.JsonExecutionRepository(storage, projectId).get(receipt.executionId);
      const originalTask = resultTasks.get(execution.remoteOperationId);
      // Consume completion directly and reuse its validated descriptor for landing.
      assert.equal(originalTask.polls, c.modelKey === 'MiniMax-H3' ? 3 : 1);
      assert.equal(originalTask.downloads, c.modelKey === 'MiniMax-H3' ? 2 : 1);
      if (c.modelKey === 'MiniMax-H3') {
        rejectSyntheticQuote = true;
        const failedPrepare = unwrap(await js(`window.unicomp.videoFeatures.prepareSubmission(${JSON.stringify(draft.draftId)}, ${JSON.stringify(draft.updatedAt)}, ${JSON.stringify(candidate.candidateId)})`));
        const failed = unwrap(await js(`window.unicomp.videoFeatures.submitDraft(${JSON.stringify(draft.draftId)}, ${JSON.stringify(draft.updatedAt)}, ${JSON.stringify(failedPrepare.routeSelectionToken)}, ${JSON.stringify(failedPrepare.confirmation.confirmationId)}, true)`));
        rejectSyntheticQuote = false;
        assert.equal(failed.status, 'failed');
        assert.ok(failed.feedback.includes('Invalid H3 parameters'), JSON.stringify(failed));
        assert.ok(!failed.feedback.includes('synthetic-e2e-key') && !failed.feedback.includes('example.invalid'));
        assert.ok(!failed.feedback.includes('报价上限'));
        const failedExecution = await new p.JsonExecutionRepository(storage, projectId).get(failed.executionId);
        assert.ok(failedExecution.failure.message.includes('Invalid H3 parameters'));
        assert.equal(resultTasks.size, 1, 'quote error must never create a second remote generation');
        checks.push({ model: c.modelKey, check: 'HTTP 400 safe diagnostic persists through native runtime and execution history', state: 'passed' });
      }
    }
    // Completed tasks have no download debt. A recovery attempt must not create a second Work or generation.
    const recovery = await js(`window.unicomp.videoFeatures.recoverResult(${JSON.stringify(receipt.taskId)})`);
    assert.ok(recovery.ok || recovery.error.code === 'storage_error');
    assert.equal((await workRepo.list(projectId)).filter(w => w.sourceTaskId === receipt.taskId).length, 1);
    checks.push({ model: c.modelKey, feature, workId: works[0].id, checksumSha256: file.checksumSha256, state: 'passed' });
    if (live) { await fs.copyFile(local, path.join(output, 'accepted-video.mp4')); }
  }
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify({ live, status: 'passed', checks, externalRequests, paidPost, requests,
    budget: live ? { maximumCnyMicro: budget.maximumCnyMicro, records: budget.records } : undefined,
    boundaries: live ? 'one actual model; isolated native preload/IPC/Host, original encrypted credential; no production project modified' : 'injected transport; no real provider acceptance' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', live, cases: checks.length, externalRequests, paidPost }));
}
const deadline = setTimeout(() => { console.error('Bounded acceptance deadline; original requests must be reconciled.'); app.exit(1); }, live ? 720_000 : 180_000);
main().then(async () => { await lifecycle?.dispose(); runtime?.dispose(); window?.destroy(); if (lock) { await lock.close(); await fs.rm(path.resolve('outputs/www-video-contracts/live/run.lock')); }
  clearTimeout(deadline); console.log(JSON.stringify({ retainedIsolatedProject: live ? temporary : undefined })); app.exit(0);
}).catch(async e => { console.error(live ? JSON.stringify({ error: e.code ?? 'acceptance_failed', message: 'Original request and budget retained; no automatic retry.', checks }) : e.stack);
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ live, safeError: e.code ?? 'acceptance_failed', checks, requests, externalRequests, paidPost }, null, 2)).catch(() => {});
  runtime?.dispose(); if (lock) { await lock.close(); await fs.rm(path.resolve('outputs/www-video-contracts/live/run.lock')); } clearTimeout(deadline); app.exit(1); });
