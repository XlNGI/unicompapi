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
  'authorized-two-synthetic-cases': { type: 'boolean', default: false },
  'authorized-generation-case': { type: 'boolean', default: false },
  model: { type: 'string' }
} });
const generationMode = values['authorized-generation-case'];
const requestedModel = values.model;
const liveGeneration = generationMode && !values['dry-run'];
const live = (values['authorized-two-synthetic-cases'] || liveGeneration) && !values['dry-run'];
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
  outboundScope: generationMode ? 'One synthetic PPT generation followed by structure reading; no user files, attachments or conversation history.' : 'Two synthetic PPT reading requests and tool observations only; no user files, attachments or conversation history.',
  entryPoint: generationMode ? 'createChatContextRuntime.responses.start -> canonical generate -> actual registered PPTX read -> final answer' : 'createChatContextRuntime.responses.start -> production dispatch -> canonical read tool',
  maximumNetworkRequests: 4, maximumRequestsPerCase: generationMode ? 4 : 2, maximumOutputTokensPerRequest: 1024,
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
const markers = ['BLUE-ORBIT-471', 'GREEN-VALLEY-829'];
const syntheticGenerationContent = ['# 合成闭环验收', '## 第一部分', `核验标记 ${markers[0]}。`, '## 第二部分', `核验标记 ${markers[1]}。`].join('\n\n');
let hostVerification;
let generatedVerification;
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

async function inspectOutbound(request, domain, expectedModel) {
  requireCondition(live && activeCase && !lifecycleAbort.signal.aborted, 'network_not_authorized');
  const generationCase = activeCase.case === 'generate_and_read';
  requireCondition(report.networkRequests < report.maximumNetworkRequests && activeCase.networkRequests < (generationCase ? 4 : 2), 'request_budget_exceeded');
  requireCondition(request.method === 'POST' && new URL(request.url).pathname.endsWith('/chat/completions'), 'unexpected_network_operation');
  const payloadText = Buffer.from(request.body ?? []).toString('utf8');
  const payload = JSON.parse(payloadText);
  requireCondition(payload.model === expectedModel && payload.stream === true, 'unexpected_provider_payload');
  const tokenLimit = payload.max_completion_tokens ?? payload.max_tokens;
  requireCondition(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 1024, 'output_budget_missing');
  if (generationCase && activeCase.networkRequests > 0) await verifyGeneratedFile();
  report.actualWireModel = safeModel(payload.model);
  const inspectionText = payloadText + '\n' + (payload.messages ?? []).filter(message => message.role === 'tool').map(message => message.content).join('\n');
  const pathLeak = /(?:[a-zA-Z]:\\|file:\/\/|\/Users\/|\/home\/)/u.test(inspectionText) ||
    [...sensitiveValues].some(value => value && inspectionText.includes(value));
  const contextLeak = /"(?:rootDirectory|relativePath|filePath|currentDocumentId|currentDocumentIR|authorization|abortSignal|taskContext|checkpoint)"\s*:/u.test(inspectionText);
  activeCase.pathOrRuntimeContextLeak ||= pathLeak || contextLeak;
  requireCondition(!pathLeak && !contextLeak, 'outbound_runtime_data_leak');
  if (generationCase) {
    const expectedToolId = activeCase.networkRequests === 0 ? 'generate_pptx' : 'read_document_structure';
    const registry = domain.createCanonicalToolRegistry();
    const schema = domain.canonicalToolInputSchema(registry.get(expectedToolId));
    requireCondition(Array.isArray(payload.tools) && payload.tools.length === 1 &&
      payload.tools[0].type === 'function' && payload.tools[0].function?.name === expectedToolId &&
      JSON.stringify(payload.tools[0].function.parameters) === JSON.stringify(schema), 'generation_schema_not_canonical');
    const calls = [];
    const results = new Set();
    const structure = [];
    for (const message of payload.messages ?? []) {
      const summary = { role: message.role, contentType: typeof message.content };
      for (const call of message.tool_calls ?? []) {
        requireCondition(message.role === 'assistant' && call.type === 'function' && typeof call.id === 'string' &&
          !calls.some(item => item.id === call.id), 'duplicate_or_invalid_tool_call_id');
        const callContract = registry.get(call.function?.name);
        requireCondition(callContract?.exposure === 'provider', 'unexpected_generation_tool');
        const args = domain.validateCanonicalToolArguments(callContract, JSON.parse(call.function.arguments));
        const expectedCall = calls.length === 0 ? 'generate_pptx' : 'read_document_structure';
        requireCondition(calls.length < 2 && call.function.name === expectedCall, 'unexpected_tool_sequence');
        if (call.function.name === 'read_document_structure') requireCondition(args.scope === 'document', 'unexpected_tool_scope');
        calls.push({ id: call.id, toolId: call.function.name, args });
        summary.tool = call.function.name;
        summary.callRef = 'call-' + calls.length;
      }
      if (message.role === 'tool') {
        const linked = calls.find(call => call.id === message.tool_call_id);
        requireCondition(Boolean(linked) && !results.has(message.tool_call_id), 'tool_call_id_mismatch');
        results.add(message.tool_call_id);
        const result = JSON.parse(message.content);
        requireCondition(result.status === 'success', 'generation_or_read_tool_failed');
        const callRef = 'call-' + (calls.indexOf(linked) + 1);
        summary.callRef = callRef;
        if (!activeCase.toolCalls.some(item => item.callRef === callRef)) {
          activeCase.toolCalls.push({ callRef, toolId: linked.toolId,
            ...(linked.toolId === 'read_document_structure' ? { scope: linked.args.scope } : {}) });
        }
        activeCase.toolCallIdMatched = true;
        if (linked.toolId === 'generate_pptx') {
          requireCondition(result.observation?.generated === true && result.artifactRefs?.some(ref => ref.kind === 'work'), 'generation_artifact_missing');
          activeCase.artifactVerified = Boolean(generatedVerification);
        } else {
          const observation = result.observation;
          requireCondition(observation?.scope === 'document' && observation.structureUnit === 'physical_page' &&
            observation.pageCount === generatedVerification.pages.length && observation.totalPages === generatedVerification.pages.length &&
            observation.revision === generatedVerification.revision, 'physical_observation_metadata_mismatch');
          requireCondition(observation.sections?.length === generatedVerification.pages.length, 'physical_page_count_mismatch');
          for (const [index, page] of generatedVerification.pages.entries()) {
            const section = observation.sections[index];
            const text = section.blocks?.map(block => block.text ?? '').join('');
            requireCondition(section.heading === `第 ${page.pageNumber} 页` && text?.trim() === page.contentText.trim(), 'physical_page_text_mismatch');
          }
          requireCondition(markers.every(marker => message.content.includes(marker)), 'generated_marker_missing');
          activeCase.observationContainsExpectedFacts = true;
          activeCase.observationMatchesPhysicalFile = true;
        }
      }
      structure.push(summary);
    }
    requireCondition(calls.length === results.size && calls.length === Math.min(activeCase.networkRequests, 2), 'tool_roundtrip_missing');
    const identities = calls.map(call => ({ id: call.id, toolId: call.toolId }));
    if (activeCase.historicCalls) requireCondition(activeCase.historicCalls.every((call, index) =>
      call.id === identities[index]?.id && call.toolId === identities[index]?.toolId), 'historic_call_id_changed');
    Object.defineProperty(activeCase, 'historicCalls', { value: identities, writable: true, configurable: true, enumerable: false });
    (activeCase.requestStructures ??= []).push({ round: activeCase.networkRequests + 1,
      model: safeModel(payload.model), availableTools: payload.tools.map(tool => tool.function.name),
      messages: structure, toolChoiceType: typeof payload.tool_choice, responseFormatPresent: Boolean(payload.response_format),
      previousResponseIdPresent: Boolean(payload.previous_response_id || payload.response_id) });
    activeCase.networkRequests += 1;
    report.networkRequests += 1;
    return;
  }
  const contract = domain.createCanonicalToolRegistry().get('read_document_structure');
  const schema = domain.canonicalToolInputSchema(contract);
  requireCondition(Array.isArray(payload.tools) && payload.tools.length === 1, 'unexpected_available_tools');
  const tool = payload.tools[0];
  requireCondition(tool.type === 'function' && tool.function?.name === contract.toolId, 'unexpected_available_tools');
  requireCondition(JSON.stringify(tool.function.parameters) === JSON.stringify(schema), 'provider_schema_not_canonical');
  activeCase.schemasCanonical &&= true;
  const calls = new Map();
  for (const message of payload.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      requireCondition(call.function?.name === contract.toolId, 'unexpected_called_tool');
      const args = domain.validateCanonicalToolArguments(contract, JSON.parse(call.function.arguments));
      requireCondition(args.scope === activeCase.expectedScope &&
        (activeCase.expectedScope !== 'page' || args.ordinal === 2), 'unexpected_tool_scope');
      requireCondition(!calls.has(call.id), 'duplicate_tool_call_id');
      calls.set(call.id, args);
    }
  }
  const messages = (payload.messages ?? []).filter(message => message.role === 'tool');
  if (activeCase.networkRequests === 0) {
    requireCondition(messages.length === 0 && markers.every(marker => !payloadText.includes(marker)), 'document_content_preinjected');
    activeCase.documentContentFromObservationOnly = true;
  } else {
    requireCondition(messages.length === 1 && calls.size === 1, 'tool_roundtrip_missing');
    for (const message of messages) {
      const args = calls.get(message.tool_call_id);
      requireCondition(Boolean(args), 'tool_call_id_mismatch');
      const result = JSON.parse(message.content);
      requireCondition(result.status === 'success' && result.observation, 'read_tool_failed');
      activeCase.toolCalls.push({ toolId: contract.toolId, scope: args.scope,
        ...(args.ordinal === undefined ? {} : { ordinal: args.ordinal }) });
      activeCase.toolCallIdMatched = true;
      activeCase.observationContainsExpectedFacts = activeCase.expectedScope === 'page'
        ? message.content.includes(markers[0]) && !message.content.includes(markers[1])
        : markers.every(marker => message.content.includes(marker));
      requireCondition(activeCase.observationContainsExpectedFacts, 'incorrect_document_observation');
    }
  }
  activeCase.networkRequests += 1;
  report.networkRequests += 1;
}


async function verifyGeneratedFile() {
  const { platform, storage, projectId, projectRoot } = hostVerification;
  const works = await new platform.JsonWorkRepository(storage, projectId).list(projectId);
  requireCondition(works.length === 1, 'expected_one_generated_work');
  const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
  const actual = await new RegisteredPresentationReader({ rootDirectory: projectRoot, projectId }).read(works[0].id);
  requireCondition(actual.pages.length >= 4 && markers.every(marker => actual.pages.some(page => page.text.includes(marker))), 'generated_physical_file_invalid');
  const checksum = createHash('sha256').update(actual.buffer).digest('hex');
  requireCondition(checksum === actual.file.checksumSha256 && actual.buffer.length === actual.file.sizeBytes &&
    actual.work.fileId === actual.file.id && actual.work.sourceExecutionId === actual.file.sourceExecutionId, 'registered_file_identity_mismatch');
  const pin = JSON.stringify([actual.work.id, actual.file.id, actual.work.sourceExecutionId, checksum, actual.file.updatedAt]);
  if (generatedVerification) requireCondition(generatedVerification.pin === pin, 'generated_file_changed_during_readback');
  generatedVerification = { pin, pages: actual.pages,
    revision: Number.parseInt(createHash('sha256').update(pin).digest('hex').slice(0, 12), 16) };
  for (const sensitive of [actual.work.id, actual.file.id, actual.work.sourceExecutionId, checksum,
    actual.file.locator.kind === 'project' ? actual.file.locator.relativePath : '']) if (sensitive) sensitiveValues.add(sensitive);
  activeCase.physicalFile = { registeredWorkCount: works.length, physicalPages: actual.pages.length,
    hashVerified: true, sizeVerified: true, sourceExecutionMatched: true, independentReaderUsed: true,
    coverAndClosingIncluded: true, repeatedPinMatched: true };
}

async function seedGenerationConversation(platform, domain, storage, projectId) {
  const now = domain.toIsoTimestamp(new Date().toISOString());
  let conversation = domain.createConversation({ id: domain.toConversationId('conversation-synthetic-generation-' + randomUUID()),
    projectId, title: '合成生成读回验收', createdAt: now });
  const repository = new platform.JsonProjectConversationRepository(storage, projectId);
  await repository.create(conversation);
  let previousRevision = conversation.revision;
  conversation = domain.addUserMessage(conversation, { id: domain.toMessageId('requirement-' + randomUUID()),
    content: '请制作一份简单 PPT，内容如下：\n' + syntheticGenerationContent, createdAt: now });
  await repository.save(conversation, previousRevision);
  previousRevision = conversation.revision;
  conversation = domain.addCompletedAssistantMessage(conversation, { id: domain.toMessageId('confirmation-' + randomUUID()),
    content: '内容已明确。现在开始生成吗？', createdAt: now });
  await repository.save(conversation, previousRevision);
  return conversation;
}

async function createSyntheticDocument(platform, rootDirectory, projectId) {
  stage = 'synthetic_ppt';
  const outline = platform.parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '合成文档工具验收', sections: [
    { heading: '合成第一部分', level: 1, blocks: [{ type: 'paragraph', text: `核验标记 ${markers[0]}。本页说明合成项目的第一项计划。` }] },
    { heading: '合成第二部分', level: 1, blocks: [{ type: 'paragraph', text: `核验标记 ${markers[1]}。本页说明合成项目的第二项计划。` }] }
  ] }));
  const renderer = platform.createConfiguredOfficeRenderAdapter();
  requireCondition(Boolean(renderer), 'local_office_renderer_unavailable');
  const generated = await new platform.DocumentGenerationRunner({ rootDirectory, projectId,
    renderPreview: renderer, requireRenderForPpt: true }).run({
    kind: 'ppt', title: outline.title, outline,
    sourceDraftId: `synthetic-read-${randomUUID()}`, draftRevision: 1,
    contentFingerprint: createHash('sha256').update(JSON.stringify(outline)).digest('hex'),
    requestedTotalPages: 4, presentationTemplate: 'business_minimal', signal: lifecycleAbort.signal
  });
  sensitiveValues.add(generated.work.id);
  sensitiveValues.add(generated.file.id);
  if (generated.file.locator.kind === 'project') sensitiveValues.add(generated.file.locator.relativePath);
  const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
  const read = await new RegisteredPresentationReader({ rootDirectory, projectId }).read(generated.work.id);
  requireCondition(read.pages.length === 4 && read.pages[1].text.includes(markers[0]) &&
    read.pages[2].text.includes(markers[1]), 'synthetic_physical_pages_invalid');
  report.fixture = { registeredByExistingRunner: true, localRenderAndQaPassed: true,
    physicalPages: read.pages.length, physicalPageTwoVerified: true };
  return { outline, generated, fileName: read.fileName };
}

async function seedConversation(platform, domain, storage, projectId, fixture, label) {
  const now = domain.toIsoTimestamp(new Date().toISOString());
  const id = domain.toConversationId(`conversation-synthetic-read-${label}-${randomUUID()}`);
  let conversation = domain.createConversation({ id, projectId, title: '合成只读工具验收', createdAt: now });
  const repository = new platform.JsonProjectConversationRepository(storage, projectId);
  await repository.create(conversation);
  const messageId = domain.toMessageId(`message-synthetic-document-${randomUUID()}`);
  const revision = conversation.revision;
  conversation = domain.addCompletedAssistantMessage(conversation, { id: messageId, content: '合成 PPT 已生成。', createdAt: now });
  await repository.save(conversation, revision);
  const documentRevision = conversation.revision;
  conversation = domain.attachDocumentResultToMessage(conversation, messageId, {
    workId: fixture.generated.work.id, kind: 'ppt', fileName: fixture.fileName,
    sizeBytes: fixture.generated.file.sizeBytes, validatedContent: JSON.stringify(fixture.outline)
  }, now);
  await repository.save(conversation, documentRevision);
  return conversation;
}

async function executeCase(platform, domain, storage, projectId, fixture, candidate, parameterValues, scope) {
  stage = `case_${scope}`;
  const conversation = generationMode ? await seedGenerationConversation(platform, domain, storage, projectId) : await seedConversation(platform, domain, storage, projectId, fixture, scope);
  const entry = { case: liveGeneration ? 'generate_and_read' : scope === 'page' ? 'physical_page_2' : 'whole_document', expectedScope: scope,
    status: 'in_progress', networkRequests: 0, schemasCanonical: true, pathOrRuntimeContextLeak: false,
    toolCalls: [], toolCallIdMatched: false, observationContainsExpectedFacts: false,
    documentContentFromObservationOnly: false };
  activeCase = entry;
  report.cases.push(entry);
  const content = liveGeneration
    ? '确认，现在开始生成这份 PPT。内容如下：\n' + syntheticGenerationContent + '\n请将以上标题、两个小节和核验标记原样作为生成内容，不添加其他内容，不指定固定页数。先调用 generate_pptx 一次，成功后调用 read_document_structure(scope=document) 读取刚生成的真实文件，再依据 Observation 回答：文件页数：N；核验标记：两个标记。完成后结束，不要再次生成。'
    : scope === 'page'
    ? '请读取当前 PPT 的第 2 页，回答本页的核验标记和一句话内容摘要。严格只调用一次可用的读取工具；收到成功 Observation 后立即回答，不要再次调用工具，不要猜测其他页。'
    : '请读取当前 PPT 的整篇文档，回答总页数、每一部分的核验标记和主要内容。严格只调用一次可用的读取工具；收到成功 Observation 后立即回答，不要再次调用工具，不要猜测。';
  const started = resultValue(await runtime.responses.start({
    clientCommandId: `synthetic-read-${randomUUID()}`,
    conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null },
    title: '合成只读工具验收', content, productFeature: 'text_chat', candidateId: candidate.candidateId,
    contextSelections: [], parameterValues, confirmed: true
  }), 'response_start_failed');
  const executionId = started.execution.responseExecutionId;
  const deadline = Date.now() + (generationMode ? 300_000 : 150_000);
  let execution = started.execution;
  while (!terminalStates.has(execution.state) && Date.now() < deadline && !lifecycleAbort.signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 150));
    execution = resultValue(await runtime.responses.getExecution({ responseExecutionId: executionId }), 'response_read_failed');
  }
  if (!terminalStates.has(execution.state)) {
    await runtime.responses.cancelExecution({ responseExecutionId: executionId });
    try {
      const { ConversationProductionTraceStore } = require('../dist-electron/src/platform/conversation-production-trace');
      const timeoutTrace = await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id });
      entry.trace = timeoutTrace.filter(event => ['model_request', 'tool_authorization', 'tool_call', 'tool_result'].includes(event.code))
        .map(event => ({ code: event.code, status: event.status, ...(event.operationId ? { operationId: event.operationId } : {}), ...(event.facts?.tool ? { tool: event.facts.tool } : {}) }));
    } catch { /* keep timeout report bounded */ }
    throw Object.assign(new Error('case_deadline_exceeded'), { code: 'case_deadline_exceeded' });
  }
  entry.terminalState = execution.state;
  const executionEvents = await new platform.JsonConversationResponseExecutionRepository(storage, projectId).listEvents(executionId);
  entry.terminalDiagnostics = executionEvents.flatMap(event =>
    typeof event.safeCode === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(event.safeCode) ? [event.safeCode] : []);
  entry.answerUsesObservation = scope === 'page' ? execution.content.includes(markers[0])
    : markers.every(marker => execution.content.includes(marker));
  if (liveGeneration) {
    await verifyGeneratedFile();
    const reportedPages = /文件页数\s*[：:]\s*(\d+)/u.exec(execution.content);
    entry.finalPhysicalPageCountMatched = Number(reportedPages?.[1]) === generatedVerification.pages.length;
    entry.answerUsesObservation &&= entry.finalPhysicalPageCountMatched && entry.observationMatchesPhysicalFile === true;
  }
  const { ConversationProductionTraceStore } = require('../dist-electron/src/platform/conversation-production-trace');
  const trace = await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id });
  entry.trace = trace.filter(event => ['tool_authorization', 'tool_call', 'tool_result'].includes(event.code))
    .map(event => ({ code: event.code, status: event.status, ...(event.operationId ? { operationId: event.operationId } : {}), ...(event.facts?.tool ? { tool: event.facts.tool } : {}) }));
  requireCondition(execution.state === 'completed', 'provider_response_not_completed');
  requireCondition((liveGeneration ? entry.networkRequests >= 3 && entry.networkRequests <= 4 && entry.toolCalls.length === 2 &&
    entry.toolCalls[0].toolId === 'generate_pptx' && entry.toolCalls[1].toolId === 'read_document_structure' &&
    entry.artifactVerified && entry.toolCallIdMatched && entry.answerUsesObservation && entry.observationMatchesPhysicalFile
    : entry.networkRequests === 2 && entry.toolCalls.length === 1 && entry.toolCallIdMatched && entry.observationContainsExpectedFacts && entry.answerUsesObservation) && !entry.pathOrRuntimeContextLeak,
  'production_tool_roundtrip_not_verified');
  requireCondition(entry.trace.some(item => item.code === 'tool_result' && item.status === 'completed'), 'tool_trace_missing');
  entry.status = 'passed';
  activeCase = undefined;
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
  const fixture = generationMode ? undefined : await createSyntheticDocument(platform, projectRoot, projectId);
  hostVerification = { platform, storage, projectId, projectRoot };
  if (generationMode) {
    requireCondition((await new platform.JsonWorkRepository(storage, projectId).list(projectId)).length === 0, 'generation_project_not_empty');
    report.fixture = { emptyProject: true, seededDocument: false, syntheticConfirmation: true };
  }
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
    if (liveGeneration) await executeCase(platform, domain, storage, projectId, fixture, candidate, parameterValues, 'document');
    else for (const scope of ['document', 'page']) await executeCase(platform, domain, storage, projectId, fixture, candidate, parameterValues, scope);
    requireCondition(report.networkRequests >= (liveGeneration ? 3 : 4), 'unexpected_network_request_count');
    const observations = await new platform.JsonProviderUsageObservationRepository(storage).list();
    report.usage = observations.map(item => ({ status: item.status, sourceStage: item.sourceStage,
      facts: item.facts.filter(fact => /^[a-z_]{1,50}$/.test(fact.metricId) && /^\d+(?:\.\d+)?$/.test(fact.quantity))
        .map(fact => ({ metricId: fact.metricId, quantity: fact.quantity, unit: fact.unit, source: fact.source })) }));
    report.status = 'passed';
  } else {
    if (generationMode) await seedGenerationConversation(platform, domain, storage, projectId);
    else for (const scope of ['document', 'page']) await seedConversation(platform, domain, storage, projectId, fixture, scope);
    report.status = 'dry_run_passed';
    report.dryRun = { isolatedCandidateReady: true, syntheticPptRegistered: !generationMode, emptyGenerationProject: generationMode, providerCredentialsDecrypted: false,
      seededConversations: generationMode ? 1 : 2, providerRequests: 0, productionRoundtripExecuted: false };
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
  const outputDirectory = path.join(workspace, generationMode ? 'outputs/phase2-batch3-kimi-readback' : 'outputs/production-document-read');
  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, live ? 'real-provider.json' : 'dry-run.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch { report.status = 'failed'; report.safeCode = 'safe_report_write_failed'; }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  app.exit(['passed', 'dry_run_passed'].includes(report.status) ? 0 : 1);
});
