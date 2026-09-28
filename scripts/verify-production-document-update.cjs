const { createHash, randomUUID } = require('node:crypto');
const { copyFile, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { app, safeStorage } = require('electron');

// Run only after a production build. Default mode performs local setup without
// decrypting provider credentials or making a network request. The live mode
// needs the owner's explicit two-case authorization and never retries.
const { values } = parseArgs({ options: {
  'dry-run': { type: 'boolean', default: false },
  'authorized-update-case': { type: 'boolean', default: false },
  model: { type: 'string' }
} });
const requestedModel = values.model ?? 'kimi-k3';
const live = values['authorized-update-case'] && !values['dry-run'];
const workspace = path.resolve(__dirname, '..');
const sourceData = path.join(app.getPath('appData'), require('../package.json').name);
const temporaryRootAtStartup = mkdtempSync(path.join(os.tmpdir(), 'unicomp-production-read-'));
const isolatedProfileAtStartup = path.join(temporaryRootAtStartup, 'profile');
const isolatedProjectAtStartup = path.join(temporaryRootAtStartup, 'project');
mkdirSync(isolatedProfileAtStartup);
mkdirSync(isolatedProjectAtStartup);
const localStateSource = path.join(sourceData, 'Local State');
const localStateDestination = path.join(isolatedProfileAtStartup, 'Local State');
let encryptionContextFailure;
if (existsSync(localStateSource)) {
  try {
    const sourceState = JSON.parse(readFileSync(localStateSource, 'utf8'));
    if (sourceState.os_crypt && typeof sourceState.os_crypt === 'object') {
      writeFileSync(localStateDestination, JSON.stringify({ os_crypt: sourceState.os_crypt }), { mode: 0o600 });
    } else if (live && process.platform === 'win32') encryptionContextFailure = 'encrypted_context_unavailable';
  } catch { encryptionContextFailure = 'encrypted_context_unavailable'; }
} else if (live && process.platform === 'win32') encryptionContextFailure = 'encrypted_context_unavailable';
app.setPath('userData', isolatedProfileAtStartup);
const report = {
  schemaVersion: 2, ...(requestedModel ? { requestedModel: safeModel(requestedModel) } : {}), mode: live ? 'real_provider' : 'dry_run', status: 'in_progress',
  startedAt: new Date().toISOString(),
  outboundScope: 'One synthetic PPT text update and real-file element readback; no user files or prior user conversations.',
  entryPoint: 'createChatContextRuntime.responses.start -> canonical read/update -> coordinator -> candidate Work/manifest -> head CAS -> real-file read -> final answer',
  maximumNetworkRequests: 6, maximumRequestsPerCase: 6, maximumOutputTokensPerRequest: 1024,
  automaticRetries: 0, cost: 'unknown', cases: [], networkRequests: 0
};
let stage = 'setup';
let temporaryRoot = temporaryRootAtStartup;
let runtime;
let proxy;
let proxyAdapter;
let deepSeekRuntime;
let newApiRuntime;
let activeCase;
let processDeadline;
const lifecycleAbort = new AbortController();
const protectedHashes = new Map();
const sensitiveValues = new Set([sourceData]);
const originalText = '年度销售目标';
const updatedText = '2027 年全球销售目标';
let hostVerification;
let fixtureState;
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});

function requireCondition(condition, code) {
  if (!condition) {
    report.firstFailedCheck ??= code;
    throw Object.assign(new Error(code), { code });
  }
}
function resultValue(result, code) {
  requireCondition(result?.ok === true, typeof result?.error?.code === 'string'
    ? `controller_${result.error.code}` : code);
  return result.value;
}
function safeCode(error) {
  const code = error?.safeCode ?? error?.code;
  return typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(code) ? code : 'acceptance_failed';
}
function safeErrorSummary(error) {
  const code = safeCode(error);
  if (code !== 'acceptance_failed') return code;
  const name = typeof error?.name === 'string' ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : 'acceptance_failed';
}
function safeModel(value) {
  return typeof value === 'string' && /^[\p{L}\p{N} ._:/()-]{1,120}$/u.test(value) ? value : 'configured_text_model';
}
async function hashFile(file) {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
}
async function copyOptionalFile(source, destination) {
  try { await copyFile(source, destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function rememberProtectedFiles() {
  for (const relative of ['provider-registry.json', 'secure-credentials.json', 'project-catalog.json',
    'runtime-authorization-ledger.json', 'settings/settings.json', 'settings/settings.json.bak', 'settings/proxy-credentials.json']) {
    const file = path.join(sourceData, relative);
    protectedHashes.set(file, await hashFile(file));
  }
  protectedHashes.set(localStateSource, await hashFile(localStateSource));
}
async function resolveConfiguredRoute(platform, isolatedProfile) {
  stage = 'configured_route';
  await copyFile(path.join(sourceData, 'provider-registry.json'), path.join(isolatedProfile, 'provider-registry.json'));
  const registry = new platform.JsonProviderRegistryStore(path.join(isolatedProfile, 'provider-registry.json'));
  // load() can purge soft-deleted records, so it must run against the copy.
  const snapshot = await registry.load();
  const catalog = JSON.parse(await readFile(path.join(sourceData, 'project-catalog.json'), 'utf8'));
  const projects = [...(catalog.entries ?? [])].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  for (const project of projects.slice(0, 5)) {
    if (!path.isAbsolute(project.rootDirectory)) continue;
    sensitiveValues.add(project.rootDirectory);
    let routes;
    let executions;
    try {
      routes = JSON.parse(await readFile(path.join(project.rootDirectory, 'entities/provider-execution-route-snapshots.json'), 'utf8'));
      executions = JSON.parse(await readFile(path.join(project.rootDirectory, 'entities/conversation-response-executions.json'), 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const recent = [...(executions.executions ?? [])].filter(item => item.state === 'completed' &&
      ['text_chat', 'text_reasoning'].includes(item.snapshot?.productFeature))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const execution of recent) {
      const route = routes.snapshots?.find(item => item.id === execution.snapshot.routeSnapshotId);
      const model = snapshot.models.find(item => item.id === route?.modelId);
      const connection = snapshot.connections.find(item => item.id === route?.connectionId);
      const provider = snapshot.providers.find(item => item.id === route?.providerId);
      if (!route || !model?.enabled || (requestedModel && model.providerModelKey !== requestedModel) || !connection?.credentialReference || !provider ||
        connection.state !== 'available' || connection.credentialVersionId !== route.credentialVersionId ||
        model.providerModelKey !== route.providerModelKey ||
        ![platform.NEWAPI_CHAT_ADAPTER_ID, platform.DEEPSEEK_CHAT_ADAPTER_ID].includes(route.adapterKey)) continue;
      sensitiveValues.add(connection.credentialReference);
      report.model = safeModel(model.providerModelKey);
      report.routeSource = requestedModel ? 'Explicit exact providerModelKey selection, revalidated against copied registry and fresh candidate eligibility; no fallback.' : 'Most recent completed text route, revalidated against copied current registry and fresh candidate eligibility.';
      return { registry, model, connection, provider, route };
    }
  }
  throw Object.assign(new Error('configured_text_route_unavailable'), { code: requestedModel ? 'requested_model_route_unavailable' : 'configured_text_route_unavailable' });
}

async function verifyActualUpdate() {
  const { platform, projectId, projectRoot, storage } = hostVerification;
  const { DocumentMutationHeadStore } = require('../dist-electron/src/platform/documents/document-mutation-head-store');
  const { DocumentIdentityIndexStore } = require('../dist-electron/src/platform/documents/document-identity-index-store');
  const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
  const { readIdentityElementTexts } = require('../dist-electron/src/platform/documents/presentation-identity-manifest');
  const head = await new DocumentMutationHeadStore(storage).get(fixtureState.identity.documentLineageId);
  requireCondition(head?.runtimeRevision === 2 && head.headWorkId !== fixtureState.generated.work.id, 'head_revision_not_committed');
  const manifest = await new DocumentIdentityIndexStore(storage).getForWork(head.headWorkId);
  const actual = await new RegisteredPresentationReader({ rootDirectory: projectRoot, projectId }).read(head.headWorkId);
  requireCondition(manifest?.fileId === head.fileId && manifest.sourceExecutionId === head.sourceExecutionId &&
    manifest.workId === head.headWorkId && manifest.revision === 2 && manifest.identityIndexVersion === 1 &&
    manifest.artifactChecksumSha256 === head.checksumSha256 && actual.file.checksumSha256 === head.checksumSha256 &&
    actual.work.parentWorkId === fixtureState.generated.work.id, 'registered_version_pin_mismatch');
  const values = await readIdentityElementTexts(actual.buffer, manifest);
  requireCondition(values.get(fixtureState.target.elementId) === updatedText, 'target_text_not_updated');
  requireCondition(values.get(fixtureState.duplicate.elementId) === originalText, 'duplicate_text_wrongly_updated');
  requireCondition(JSON.stringify(manifest.pages.map(page => page.pageId)) === JSON.stringify(fixtureState.identity.pages.map(page => page.pageId)) &&
    JSON.stringify(manifest.elements.map(element => element.elementId)) === JSON.stringify(fixtureState.identity.elements.map(element => element.elementId)),
  'business_identity_drift');
  for (const old of fixtureState.identity.elements) if (old.elementId !== fixtureState.target.elementId) {
    requireCondition(values.get(old.elementId) === old.text, 'untargeted_object_changed');
  }
  const works = await new platform.JsonWorkRepository(storage, projectId).list(projectId);
  requireCondition(works.length === 2, 'duplicate_mutation_or_work');
  const old = await new RegisteredPresentationReader({ rootDirectory: projectRoot, projectId }).read(fixtureState.generated.work.id);
  requireCondition(old.file.checksumSha256 === fixtureState.generated.file.checksumSha256 &&
    createHash('sha256').update(old.buffer).digest('hex') === old.file.checksumSha256, 'old_artifact_changed');
  for (const value of [actual.work.id, actual.file.id, actual.work.sourceExecutionId, head.checksumSha256,
    actual.file.locator.relativePath]) sensitiveValues.add(value);
  activeCase.actualFile = { oldNewChecksumDifferent: head.checksumSha256 !== old.file.checksumSha256,
    registeredWorkCount: works.length, identityIndexVersion: 1, authoritativeRevision: head.runtimeRevision,
    manifestPinVerified: true, targetIdentityStable: true, untouchedIdentitiesStable: true,
    duplicateTextUnchanged: true, originalArtifactPreserved: true, readByRegisteredPresentationReader: true };
}
async function inspectOutbound(request, domain, expectedModel) {
  requireCondition(live && activeCase && !lifecycleAbort.signal.aborted, 'network_not_authorized');
  requireCondition(report.networkRequests < report.maximumNetworkRequests, 'request_budget_exceeded');
  requireCondition(request.method === 'POST' && new URL(request.url).pathname.endsWith('/chat/completions'), 'unexpected_network_operation');
  const payload = JSON.parse(Buffer.from(request.body ?? []).toString('utf8'));
  requireCondition(payload.model === expectedModel && payload.model === requestedModel && payload.stream === true, 'wrong_model');
  report.actualWireModel = safeModel(payload.model);
  const limit = payload.max_completion_tokens ?? payload.max_tokens;
  requireCondition(Number.isSafeInteger(limit) && limit > 0 && limit <= 1024, 'output_budget_missing');
  const registry = domain.createCanonicalToolRegistry();
  const available = payload.tools?.map(tool => tool.function.name).sort();
  requireCondition(JSON.stringify(available) === JSON.stringify(['read_document_structure', 'update_element']), 'unexpected_available_set');
  for (const tool of payload.tools) requireCondition(JSON.stringify(tool.function.parameters) ===
    JSON.stringify(domain.canonicalToolInputSchema(registry.get(tool.function.name))), 'schema_not_canonical');
  const calls = [];
  const matched = new Set();
  const structure = [];
  let updatedResult = false;
  for (const message of payload.messages ?? []) {
    const summary = { role: message.role, contentType: typeof message.content };
    for (const call of message.tool_calls ?? []) {
      requireCondition(message.role === 'assistant' && !calls.some(previous => previous.id === call.id), 'invalid_call_order');
      const contract = registry.get(call.function.name);
      requireCondition(contract && available.includes(contract.toolId), 'unexpected_tool');
      const args = domain.validateCanonicalToolArguments(contract, JSON.parse(call.function.arguments));
      if (contract.toolId === 'update_element') requireCondition(args.elementId === fixtureState.target.elementId && args.text === updatedText, 'wrong_update_target');
      else requireCondition(args.scope === 'page' && args.ordinal === 2, 'wrong_read_scope');
      calls.push({ id: call.id, name: call.function.name, args });
      summary.tool = call.function.name; summary.callRef = 'call-' + calls.length;
    }
    if (message.role === 'tool') {
      const call = calls.find(call => call.id === message.tool_call_id);
      requireCondition(call && !matched.has(call.id), 'tool_call_id_mismatch');
      matched.add(call.id);
      const result = JSON.parse(message.content);
      requireCondition(result.status === 'success', 'tool_failed');
      const callRef = 'call-' + (calls.indexOf(call) + 1);
      summary.callRef = callRef;
      if (!activeCase.toolCalls.some(item => item.callRef === callRef)) activeCase.toolCalls.push({ callRef, toolId: call.name });
      if (call.name === 'update_element') {
        requireCondition(!updatedResult && result.observation?.elementId === fixtureState.target.elementId &&
          result.observation.changed === true && result.observation.field === 'text' && !result.irPatch, 'invalid_update_result');
        updatedResult = true;
        await verifyActualUpdate();
        activeCase.updateExecuted = true;
      } else {
        const element = result.observation?.page?.elements?.find(item => item.elementId === fixtureState.target.elementId);
        requireCondition(result.observation?.source === 'verified_pptx_objects' && element, 'element_observation_missing');
        requireCondition(element.text === (updatedResult ? updatedText : originalText), 'wrong_element_observation');
        if (updatedResult) activeCase.finalObservationFromRealFile = true;
        else activeCase.targetDiscoveredByRead = true;
      }
    }
    structure.push(summary);
  }
  requireCondition(calls.length === matched.size, 'orphan_tool_call');
  if (report.networkRequests === 0) requireCondition(calls.length === 0 && !JSON.stringify(payload).includes(fixtureState.target.elementId), 'identity_preinjected');
  for (const [index, previous] of (fixtureState.calls ?? []).entries()) {
    requireCondition(previous.id === calls[index]?.id && previous.name === calls[index]?.name, 'historic_call_id_changed');
  }
  fixtureState.calls = calls;
  const text = JSON.stringify(payload) + '\n' + (payload.messages ?? []).filter(message => message.role === 'tool').map(message => message.content).join('\n');
  const leaked = [...sensitiveValues].some(value => value && text.includes(value)) ||
    /(?:[A-Za-z]:\\|file:\/\/|\/Users\/|\/home\/)/u.test(text) ||
    /"(?:currentVersionPin|documentLineageId|checksumSha256|rootDirectory|relativePath|slidePart|shapeId|manifest|fileId|workId|authorization|abortSignal|checkpoint|taskContext|projectContext|currentDocumentIR)"\s*:/u.test(text);
  requireCondition(!leaked, 'runtime_data_leak');
  activeCase.pathOrRuntimeContextLeak = false;
  activeCase.toolCallIdMatched = true;
  activeCase.schemasCanonical = true;
  (activeCase.requestStructures ??= []).push({ round: report.networkRequests + 1, availableTools: available, messages: structure });
  activeCase.networkRequests += 1; report.networkRequests += 1;
}
async function createSyntheticDocument(platform, rootDirectory, projectId) {
  stage = 'synthetic_ppt';
  const outline = platform.parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '合成文本修改验收', sections: [
    { heading: '目标页', level: 1, blocks: [{ type: 'paragraph', text: originalText }] },
    { heading: '重复文本页', level: 1, blocks: [{ type: 'paragraph', text: originalText }] }
  ] }));
  const renderer = platform.createConfiguredOfficeRenderAdapter();
  requireCondition(Boolean(renderer), 'office_renderer_unavailable');
  const generated = await new platform.DocumentGenerationRunner({ rootDirectory, projectId, renderPreview: renderer, requireRenderForPpt: true }).run({
    kind: 'ppt', title: outline.title, outline, sourceDraftId: 'synthetic-update-' + randomUUID(), draftRevision: 1,
    contentFingerprint: createHash('sha256').update(JSON.stringify(outline)).digest('hex'), signal: lifecycleAbort.signal, presentationTemplate: 'business_minimal'
  });
  const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
  const { buildPresentationIdentityManifest } = require('../dist-electron/src/platform/documents/presentation-identity-manifest');
  const { DocumentIdentityIndexStore } = require('../dist-electron/src/platform/documents/document-identity-index-store');
  const actual = await new RegisteredPresentationReader({ rootDirectory, projectId }).read(generated.work.id);
  const identity = await new DocumentIdentityIndexStore(new platform.NodeProjectStorage(rootDirectory)).ensureForWork({
    workId: generated.work.id, build: () => buildPresentationIdentityManifest({ buffer: actual.buffer,
      documentLineageId: 'lineage-' + randomUUID(), workId: generated.work.id, fileId: generated.file.id,
      sourceExecutionId: generated.work.sourceExecutionId, revision: 1 })
  });
  const targetPage = identity.pages.find(page => page.physicalPageNumber === 2);
  const target = identity.elements.find(element => element.pageId === targetPage.pageId && element.text === originalText);
  const duplicate = identity.elements.find(element => element.elementId !== target?.elementId && element.text === originalText);
  requireCondition(target && duplicate, 'duplicate_fixture_missing');
  for (const value of [rootDirectory, generated.work.id, generated.file.id, generated.work.sourceExecutionId,
    generated.file.locator.relativePath, generated.file.checksumSha256, identity.documentLineageId]) sensitiveValues.add(value);
  report.fixture = { registeredByExistingRunner: true, actualRenderQa: true, physicalPages: actual.pages.length, duplicateTextObjects: 2 };
  fixtureState = { generated, identity, target, duplicate, outline, fileName: actual.fileName };
  return fixtureState;
}
async function seedConversation(platform, domain, storage, projectId, fixture) {
  const now = domain.toIsoTimestamp(new Date().toISOString());
  let conversation = domain.createConversation({ id: domain.toConversationId('conversation-update-' + randomUUID()), projectId, title: '合成文本修改验收', createdAt: now });
  const repository = new platform.JsonProjectConversationRepository(storage, projectId);
  await repository.create(conversation);
  const messageId = domain.toMessageId('source-document-' + randomUUID());
  let previous = conversation.revision;
  conversation = domain.addCompletedAssistantMessage(conversation, { id: messageId, content: '合成 PPT 已生成。', createdAt: now });
  await repository.save(conversation, previous);
  previous = conversation.revision;
  conversation = domain.attachDocumentResultToMessage(conversation, messageId, {
    workId: fixture.generated.work.id, kind: 'ppt', fileName: fixture.fileName,
    sizeBytes: fixture.generated.file.sizeBytes, validatedContent: JSON.stringify(fixture.outline)
  }, now);
  await repository.save(conversation, previous);
  return conversation;
}
async function executeCase(platform, domain, storage, projectId, fixture, candidate, parameterValues) {
  stage = 'update_production_loop';
  const conversation = await seedConversation(platform, domain, storage, projectId, fixture);
  activeCase = { case: 'real_element_update', status: 'in_progress', networkRequests: 0, toolCalls: [] };
  report.cases.push(activeCase);
  const started = resultValue(await runtime.responses.start({
    clientCommandId: 'update-acceptance-' + randomUUID(),
    conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null },
    title: '合成文本修改验收',
    content: '请把当前 PPT 第二页的“年度销售目标”改成“2027 年全球销售目标”，其他对象保持不变。请实际修改文件并再次读取第二页核验，最后简短告诉我核验的文字。',
    productFeature: 'text_chat', candidateId: candidate.candidateId, contextSelections: [], parameterValues, confirmed: true
  }), 'response_start_failed');
  let execution = started.execution;
  const deadline = Date.now() + 300_000;
  while (!terminalStates.has(execution.state) && Date.now() < deadline && !lifecycleAbort.signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 150));
    execution = resultValue(await runtime.responses.getExecution({ responseExecutionId: started.execution.responseExecutionId }), 'response_read_failed');
  }
  if (!terminalStates.has(execution.state)) {
    await runtime.responses.cancelExecution({ responseExecutionId: started.execution.responseExecutionId });
    requireCondition(false, 'case_deadline_exceeded');
  }
  activeCase.terminalState = execution.state;
  const { ConversationProductionTraceStore } = require('../dist-electron/src/platform/conversation-production-trace');
  const trace = await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id });
  activeCase.trace = trace.filter(event => ['tool_authorization', 'tool_call', 'tool_result', 'plan_validation'].includes(event.code))
    .map(event => ({ code: event.code, status: event.status, ...(event.operationId ? { operationId: event.operationId } : {}) }));
  requireCondition(execution.state === 'completed', 'provider_response_not_completed');
  await verifyActualUpdate();
  activeCase.answerUsesObservation = execution.content.includes(updatedText) && activeCase.finalObservationFromRealFile === true;
  requireCondition(activeCase.updateExecuted && activeCase.targetDiscoveredByRead && activeCase.answerUsesObservation &&
    activeCase.toolCallIdMatched && activeCase.toolCalls.filter(call => call.toolId === 'update_element').length === 1, 'update_roundtrip_not_verified');
  requireCondition(report.networkRequests >= 3 && report.networkRequests <= 6, 'unexpected_request_count');
  activeCase.status = 'passed'; activeCase = undefined;
}

async function run() {
  requireCondition(!encryptionContextFailure, encryptionContextFailure ?? 'encrypted_context_unavailable');
  await rememberProtectedFiles();
  sensitiveValues.add(temporaryRoot);
  const profile = isolatedProfileAtStartup;
  const projectRoot = isolatedProjectAtStartup;
  await app.whenReady();
  const platform = require('../dist-electron/src/platform');
  const domain = require('../dist-electron/src/domain');
  for (const Adapter of [platform.NewApiChatAdapter, platform.DeepSeekChatAdapter]) {
    const submit = Adapter.prototype.submit;
    Adapter.prototype.submit = async function (...args) {
      try { return await submit.apply(this, args); }
      catch (error) {
        (report.adapterErrorSummaries ??= []).push(safeErrorSummary(error));
        throw error;
      }
    };
  }
  const selected = await resolveConfiguredRoute(platform, profile);
  const projectId = domain.toProjectId(`project-synthetic-read-${randomUUID()}`);
  sensitiveValues.add(projectId);
  const storage = new platform.NodeProjectStorage(projectRoot);
  const fixture = await createSyntheticDocument(platform, projectRoot, projectId);
  hostVerification = { platform, storage, projectId, projectRoot };
  const authorization = new platform.RuntimeAuthorizationLedger(
    new platform.JsonRuntimeAuthorizationLedgerStore(path.join(profile, 'runtime-authorization-ledger.json')));
  const { LedgerRuntimeAuthorizationSync } = require('../dist-electron/electron/ipc/runtime-authorization-sync');
  await new LedgerRuntimeAuthorizationSync(authorization).syncConnectionPolicy({
    providerPackageId: selected.route.packageId, connectionId: selected.connection.id, allowed: true });
  const protector = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: () => { throw Object.assign(new Error('credential_write_forbidden'), { code: 'credential_write_forbidden' }); },
    unprotect: value => {
      requireCondition(live, 'dry_run_credential_access_forbidden');
      return safeStorage.decryptString(Buffer.from(value));
    }
  };
  const vault = new platform.SecureCredentialVault(path.join(sourceData, 'secure-credentials.json'), protector);
  const { ElectronNewApiHttpTransport } = require('../dist-electron/electron/ipc/management-adapters');
  const realTransport = new ElectronNewApiHttpTransport();
  const transport = { async send(request) {
    await inspectOutbound(request, domain, selected.model.providerModelKey);
    return realTransport.send({ ...request, signal: AbortSignal.any([request.signal, lifecycleAbort.signal]) });
  } };
  let proxyMode = { kind: 'system_default' };
  if (live) {
    stage = 'isolated_proxy';
    await mkdir(path.join(profile, 'settings'));
    // Match the production repository's primary -> backup -> default policy.
    // Missing files are normal for a profile that never changed its settings.
    // Invalid settings still fail in JsonSettingsRepository; do not mask them.
    await Promise.all(['settings.json', 'settings.json.bak'].map(name =>
      copyOptionalFile(path.join(sourceData, 'settings', name), path.join(profile, 'settings', name))));
    const settings = await new platform.JsonSettingsRepository(path.join(profile, 'settings/settings.json')).load();
    report.settingsSource = settings.source;
    proxyMode = settings.document.network.proxy;
    const { ElectronProxyAdapter } = require('../dist-electron/electron/ipc/settings-platform-adapters');
    proxyAdapter = new ElectronProxyAdapter();
    proxy = new platform.ProxyService(proxyAdapter,
      new platform.SecureCredentialVault(path.join(sourceData, 'settings/proxy-credentials.json'), protector));
    await proxy.activate(proxyMode);
  }
  const options = { transport, proxy: () => proxyMode, defaultTimeoutMs: 60_000,
    defaultStreamIdleTimeoutMs: 60_000, defaultStreamTotalTimeoutMs: 120_000 };
  deepSeekRuntime = new platform.DeepSeekSharedRuntime(options);
  newApiRuntime = new platform.NewApiSharedRuntime(options);
  runtime = platform.createChatContextRuntime({ userDataDirectory: profile,
    getSession: () => ({ projectId, projectName: '合成只读工具验收', rootDirectory: projectRoot }),
    providerRegistry: selected.registry, runtimeAuthorization: authorization,
    textSubmission: { credentialVault: vault, deepSeekRuntime, newApiRuntime },
    onError: error => {
      report.runtimeErrorObserved = true;
      (report.runtimeErrorSummaries ??= []).push(safeErrorSummary(error));
    }
  });
  stage = 'fresh_candidate';
  const candidates = resultValue(await runtime.responses.listTextCandidates({ productFeature: 'text_chat' }), 'candidate_listing_failed');
  const matches = candidates.filter(candidate => candidate.available && candidate.modelName === selected.model.displayName &&
    candidate.providerName === selected.provider.name && candidate.connectionName === selected.connection.name);
  requireCondition(matches.length === 1, 'fresh_candidate_not_unique');
  const candidate = matches[0];
  const field = candidate.parameterSchema.fields.find(item => item.fieldId === 'max_completion_tokens') ??
    candidate.parameterSchema.fields.find(item => item.fieldId === 'max_tokens');
  requireCondition(field && (field.minimum ?? 1) <= 1024, 'bounded_output_unavailable');
  const parameterValues = { [field.fieldId]: Math.min(field.maximum ?? 1024, 1024) };
  if (live) {
    requireCondition(safeStorage.isEncryptionAvailable(), 'credential_encryption_unavailable');
    await executeCase(platform, domain, storage, projectId, fixture, candidate, parameterValues);
    const observations = await new platform.JsonProviderUsageObservationRepository(storage).list();
    report.usage = observations.map(item => ({ status: item.status, sourceStage: item.sourceStage,
      facts: item.facts.filter(fact => /^[a-z_]{1,50}$/.test(fact.metricId) && /^\d+(?:\.\d+)?$/.test(fact.quantity))
        .map(fact => ({ metricId: fact.metricId, quantity: fact.quantity, unit: fact.unit, source: fact.source })) }));
    report.status = 'passed';
  } else {
    await seedConversation(platform, domain, storage, projectId, fixture);
    report.status = 'dry_run_passed';
    report.dryRun = { isolatedCandidateReady: true, syntheticPptRegistered: true, duplicateTextFixture: true, providerCredentialsDecrypted: false,
      seededConversations: 1, providerRequests: 0, productionRoundtripExecuted: false };
  }
}

async function cleanup() {
  lifecycleAbort.abort();
  await runtime?.interruptActiveResponses().catch(() => undefined);
  await runtime?.waitForMutations().catch(() => undefined);
  deepSeekRuntime?.dispose();
  newApiRuntime?.dispose();
  proxy?.dispose();
  proxyAdapter?.dispose();
  report.protectedUserConfigurationUnchanged = true;
  for (const [file, before] of protectedHashes) {
    if (await hashFile(file) !== before) report.protectedUserConfigurationUnchanged = false;
  }
  if (!report.protectedUserConfigurationUnchanged) {
    report.status = 'failed';
    report.safeCode = 'user_configuration_changed_during_acceptance';
  }
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    requireCondition(path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith('unicomp-production-read-'), 'unsafe_cleanup_target');
    try { await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch { report.temporaryCleanupDeferred = true; }
  }
}

processDeadline = setTimeout(() => {
  lifecycleAbort.abort();
  report.status = 'failed';
  report.safeCode = 'acceptance_deadline_exceeded';
  // Main run observes the signal; the final failsafe cannot leak stacks or paths.
  setTimeout(() => app.exit(1), 10_000).unref();
}, 420_000);
run().catch(error => {
  report.status = 'failed';
  report.failedStage = stage;
  report.safeCode = safeCode(error);
  report.errorSummary = safeErrorSummary(error);
  if (activeCase) activeCase.status = 'failed';
}).finally(async () => {
  try { await cleanup(); }
  catch { report.status = 'failed'; report.safeCode = 'acceptance_cleanup_failed'; }
  clearTimeout(processDeadline);
  report.finishedAt = new Date().toISOString();
  const outputDirectory = path.join(workspace, 'outputs/phase2-batch4-p2-kimi-update');
  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, live ? 'real-provider.json' : 'dry-run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch { report.status = 'failed'; report.safeCode = 'safe_report_write_failed'; }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  app.exit(['passed', 'dry_run_passed'].includes(report.status) ? 0 : 1);
});
