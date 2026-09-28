import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCompletedAssistantMessage, addProjectContextDraftFragment, addUserMessage, attachDocumentResultToMessage,
  createProjectContextDraft, createProjectConversation, createConversationWorkflow, createProvider, createProviderConnection,
  createProviderModel, createProviderProtocolBinding, registerProjectContextDraft,
  toConnectionId, toConversationId, toConversationWorkflowId, toExecutionId, toFileReferenceId, toIsoTimestamp, toMessageId, toModelId,
  toProjectContextDraftId, toProjectContextFragmentId, toProjectContextId, toProjectId, toProtocolBindingId,
  toProviderId, toTaskId, toWorkId, type Conversation, type FileReference, type Work
} from '../../src/domain';
import { canonicalToolInputSchema, createCanonicalToolRegistry } from '../../src/domain/entities/canonical-tool-contract';
import {
  createChatContextRuntime, DeepSeekSharedRuntime, NewApiSharedRuntime, JsonProviderRegistryStore,
  RuntimeAuthorizationLedger, JsonRuntimeAuthorizationLedgerStore, SecureCredentialVault,
  NodeProjectStorage, JsonFileReferenceRepository, JsonWorkRepository, JsonProjectConversationRepository,
  JsonProjectContextRepository, JsonDocumentTaskRuntimeRepository, JsonConversationWorkflowRepository,
  DEEPSEEK_PROVIDER_PACKAGE_ID, DEEPSEEK_PROVIDER_PACKAGE_VERSION, DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION, DEEPSEEK_CHAT_PROTOCOL_ID, DEEPSEEK_CHAT_PROTOCOL_VERSION,
  DEEPSEEK_CREDENTIAL_SCHEMA_ID, DEEPSEEK_ENDPOINT_POLICY_ID, DEEPSEEK_OFFICIAL_TEMPLATE_ID,
  deepSeekModelDefinitions, type DeepSeekHttpTransportResponse
} from '../../src/platform';
import { ConversationProductionTraceStore } from '../../src/platform/conversation-production-trace';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const projectId = toProjectId('project-production-read-loop');
const now = toIsoTimestamp('2026-09-27T12:00:00.000Z');
const markers = ['READ-PHYSICAL-TWO-471', 'READ-PHYSICAL-THREE-829'];
const oldMarker = 'STALE-HISTORY-CONTEXT-999';
const contract = createCanonicalToolRegistry().get('read_document_structure')!;

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
});

interface WireMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly { readonly id: string; readonly type: string;
    readonly function: { readonly name: string; readonly arguments: string } }[];
}
interface WireRequest {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly tools?: readonly { readonly type: string; readonly function: {
    readonly name: string; readonly description?: string; readonly parameters: Record<string, unknown>;
    readonly requiresExistingDocument?: boolean;
  } }[];
}

async function fixture(mode: 'document' | 'page' | 'workflow' | 'revoked' | 'chat') {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-production-read-loop-'));
  roots.push(rootDirectory);
  const userDataDirectory = path.join(rootDirectory, 'test-profile');
  await mkdir(userDataDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const works = new JsonWorkRepository(storage, projectId);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  for (const text of ['生产读取测试封面', `第二页真实事实 ${markers[0]}`, `第三页真实事实 ${markers[1]}`]) {
    pptx.addSlide().addText(text, { x: 1, y: 1, w: 10, h: 1, fontSize: 22 });
  }
  const buffer = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
  const fileName = '真实合成读取.pptx';
  const relativePath = `files/documents/${fileName}`;
  const absolutePath = path.join(rootDirectory, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  const file: FileReference = { schemaVersion: 1, id: toFileReferenceId('file-production-read'), projectId,
    sourceExecutionId: toExecutionId('generation-production-read'), state: 'available', locator: { kind: 'project', relativePath },
    sizeBytes: buffer.length, checksumSha256: createHash('sha256').update(buffer).digest('hex'), createdAt: now, updatedAt: now };
  const work: Work = { schemaVersion: 1, id: toWorkId('work-production-read'), projectId, fileId: file.id,
    sourceTaskId: toTaskId('task-generated-read'), sourceExecutionId: file.sourceExecutionId!, mediaKind: 'document',
    name: '真实合成读取', createdAt: now };
  await files.save(file);
  await works.save(work);
  let conversation: Conversation = createProjectConversation({ id: toConversationId('conversation-production-read'),
    projectId, title: '生产 Tool Calling 读取', createdAt: now });
  await conversations.create(conversation);
  const saveConversation = async (next: Conversation) => {
    await conversations.save(next, conversation.revision);
    conversation = next;
  };
  const sourceId = toMessageId('source-production-read');
  await saveConversation(addUserMessage(conversation, { id: sourceId, content: `生成演示文稿，旧资料为 ${oldMarker}`, createdAt: now }));
  const documentMessageId = toMessageId('document-production-read');
  await saveConversation(addCompletedAssistantMessage(conversation, { id: documentMessageId,
    content: `旧大纲认为每页事实均为 ${oldMarker}`, createdAt: now }));
  await saveConversation(attachDocumentResultToMessage(conversation, documentMessageId, {
    kind: 'ppt', workId: work.id, fileName, sizeBytes: buffer.length, validatedContent: oldMarker
  }, now));
  const contexts = new JsonProjectContextRepository(storage, projectId, () => now);
  let draft = createProjectContextDraft({ id: toProjectContextDraftId('old-context-draft'), projectId,
    conversationId: conversation.id, createdAt: now });
  await contexts.createDraft(draft);
  draft = addProjectContextDraftFragment(draft, { id: toProjectContextFragmentId('old-context-fragment'),
    conversationId: conversation.id, messageId: sourceId, messageRevision: 0, messageRole: 'user',
    selection: { schemaVersion: 1, startUtf16: 0, endUtf16: oldMarker.length }, contentSnapshot: oldMarker }, now);
  await contexts.saveDraft(draft, 0);
  const registeredContext = registerProjectContextDraft(draft, toProjectContextId('old-project-context'), now);
  await contexts.registerDraft(draft.id, draft.revision, registeredContext);
  const workflows = new JsonConversationWorkflowRepository(storage, projectId, () => now);
  const workflowUserId = toMessageId('workflow-source-original');
  const workflow = mode === 'workflow' ? createConversationWorkflow({ id: toConversationWorkflowId('workflow-read-multiturn'),
    projectId, conversationId: conversation.id, sourceMessageId: workflowUserId,
    plan: { schemaVersion: 1, kind: 'chat', parameters: { requirements: '请读取当前 PPT 的第 2 页，回答真实内容。' },
      sourcePolicy: 'internal', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false },
    pendingQuestions: [], createdAt: now }) : undefined;
  if (workflow) {
    await saveConversation(addUserMessage(conversation, { id: workflowUserId, content: '请读取当前 PPT。', createdAt: now }));
    await saveConversation(addCompletedAssistantMessage(conversation, { id: toMessageId('workflow-question'), content: '希望查看哪一页？', createdAt: now }));
    await saveConversation(addUserMessage(conversation, { id: toMessageId('workflow-followup'), content: '第 2 页，回答真实内容。', createdAt: now }));
    expect(workflow.status).toBe('ready');
    await workflows.create(workflow);
  }

  const { registry, authorization, vault, modelKey } = await providerFixture(userDataDirectory);
  const requests: WireRequest[] = [];
  const errors: unknown[] = [];
  const readSpy = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
  let readsBeforeRevocation = 0;
  const toolCall = { id: 'read-from-provider-1', type: 'function', function: { name: contract.toolId,
    arguments: JSON.stringify(mode === 'page' || mode === 'workflow' ? { scope: 'page', ordinal: 2 } : { scope: 'document' }) } };
  const transport = { send: async (request: { readonly body?: Uint8Array }): Promise<DeepSeekHttpTransportResponse> => {
    const payload = JSON.parse(Buffer.from(request.body!).toString('utf8')) as WireRequest;
    requests.push(payload);
    if (mode === 'chat') return stream(modelKey, { content: '普通聊天完成' }, 'stop');
    if (requests.length === 1) {
      if (mode === 'revoked') {
        readsBeforeRevocation = readSpy.mock.calls.length;
        await files.save({ ...file, state: 'missing', updatedAt: toIsoTimestamp('2026-09-27T12:00:01.000Z') });
      }
      return stream(modelKey, { tool_calls: [{ index: 0, ...toolCall }] }, 'tool_calls');
    }
    if (requests.length !== 2) throw new Error('Unexpected repeated provider call');
    const result = JSON.parse(payload.messages.find(message => message.role === 'tool')!.content) as {
      status: string; observation?: { sections?: readonly { blocks: readonly { text: string }[] }[]; page?: { text: string } };
    };
    const response = result.status !== 'success' ? '文档读取被拒绝，未使用旧资料。' : mode === 'page' || mode === 'workflow'
      ? result.observation!.page!.text
      : result.observation!.sections!.flatMap(section => section.blocks.map(block => block.text)).join('\n');
    return stream(modelKey, { content: response }, 'stop');
  } };
  const deepSeekRuntime = new DeepSeekSharedRuntime({ transport });
  const newApiRuntime = new NewApiSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected provider'); } } });
  const runtime = createChatContextRuntime({ userDataDirectory, providerRegistry: registry, runtimeAuthorization: authorization,
    getSession: () => ({ projectId, projectName: 'Production read test', rootDirectory }),
    textSubmission: { credentialVault: vault, deepSeekRuntime, newApiRuntime }, now: () => now,
    onError: error => errors.push(error)
  });
  cleanups.push(async () => {
    await runtime.interruptActiveResponses();
    await runtime.waitForMutations();
    deepSeekRuntime.dispose();
    newApiRuntime.dispose();
  });
  const candidates = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
  if (!candidates.ok) throw new Error(`Candidates failed: ${candidates.error.code}`);
  const candidate = candidates.value.find(item => item.available);
  if (!candidate) throw new Error(`No candidate: ${JSON.stringify(candidates.value)}`);
  async function run() {
    const query = mode === 'chat' ? '你好，请简单打个招呼。' : mode === 'page' ? '请读取当前 PPT 第 2 页的内容。' : '请读取当前 PPT 的整篇文档并总结。';
    const started = await runtime.responses.start({ clientCommandId: `start-${mode}`,
      conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null },
      title: conversation.title, content: workflow ? '【内部整理后的问答请求】用户先要求读取当前 PPT，补充要求第 2 页。请依据实际内容回答。' : query,
      productFeature: 'text_chat', candidateId: candidate!.candidateId,
      ...(workflow ? { workflow: { workflowId: workflow.id, expectedRevision: workflow.revision } } : {}),
      contextSelections: [{ contextId: registeredContext.id, contextRevision: registeredContext.currentRevision, includeInPrompt: true }],
      parameterValues: {}, confirmed: true });
    if (!started.ok) throw new Error(`Start failed: ${started.error.code}; ${errors.map(String).join('; ')}`);
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(async () => {
      const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
      expect(current).toMatchObject({ ok: true, value: { state: 'completed' } });
    }, { timeout: 5_000, interval: 20 });
    const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
    if (!current.ok) throw new Error(`Execution missing: ${current.error.code}`);
    await runtime.waitForMutations();
    const traces = await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id });
    const runtimes = await new JsonDocumentTaskRuntimeRepository(storage, projectId).list();
    return { execution: current.value, traces, runtimes };
  }
  return { run, requests, errors, readSpy, rootDirectory, work, file, buffer, absolutePath, works, toolCall,
    get readsBeforeRevocation() { return readsBeforeRevocation; } };
}

describe('production read-only Document Tool Loop through responses.start', () => {
  it.each(['document', 'page', 'workflow'] as const)('reads %s from the registered PPT and answers only after the tool result', async mode => {
    const data = await fixture(mode);
    const { execution, traces, runtimes } = await data.run();
    expect(data.errors).toEqual([]);
    expect(data.requests).toHaveLength(2);
    for (const request of data.requests) {
      expect(request.tools).toHaveLength(1);
      expect(request.tools![0].function.name).toBe(contract.toolId);
      expect(request.tools![0].function.parameters).toEqual(canonicalToolInputSchema(contract));
      expect(request.tools![0].function).not.toHaveProperty('requiresExistingDocument');
    }
    const initial = JSON.stringify(data.requests[0]);
    expect(initial).not.toContain(oldMarker);
    for (const marker of markers) expect(initial).not.toContain(marker);
    expect(data.requests[0].messages.some(message => message.role === 'tool')).toBe(false);
    const continuation = data.requests[1];
    expect(continuation.messages.find(message => message.role === 'assistant')?.tool_calls).toEqual([data.toolCall]);
    const toolMessage = continuation.messages.find(message => message.role === 'tool')!;
    expect(toolMessage.tool_call_id).toBe(data.toolCall.id);
    expect(JSON.parse(toolMessage.content)).toMatchObject({ status: 'success', observation: { scope: mode === 'document' ? 'document' : 'page' } });
    expect(toolMessage.content).toContain(markers[0]);
    expect(execution.content).toContain(markers[0]);
    if (mode !== 'document') {
      expect(toolMessage.content).not.toContain(markers[1]);
      expect(execution.content).not.toContain(markers[1]);
      expect(JSON.parse(toolMessage.content)).toMatchObject({ observation: { ordinal: 2, page: { pageNumber: 2, totalPages: 3 } } });
    } else expect(execution.content).toContain(markers[1]);
    if (mode === 'workflow') expect(initial).toContain('内部整理后的问答请求');
    expect(JSON.stringify(continuation)).not.toContain(oldMarker);
    for (const hidden of [data.rootDirectory, data.work.id, data.file.id, 'currentDocumentIR', 'currentDocumentId', 'authorization', 'rootDirectory']) {
      expect(JSON.stringify(data.requests)).not.toContain(hidden);
    }
    expect(traces.filter(trace => trace.facts?.tool === contract.diagnostics.traceType && ['tool_authorization', 'tool_call', 'tool_result'].includes(trace.code)).map(trace => [trace.code, trace.status]))
      .toEqual([['tool_authorization', 'completed'], ['tool_call', 'started'], ['tool_result', 'completed']]);
    expect(traces.some(trace => trace.code === 'model_response' && trace.status === 'completed')).toBe(true);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].toolCalls).toMatchObject([{ id: data.toolCall.id, toolId: contract.toolId, status: 'completed' }]);
    expect(JSON.stringify(runtimes)).not.toContain(markers[0]);
    expect(await readFile(data.absolutePath)).toEqual(data.buffer);
    expect(await data.works.list(projectId)).toHaveLength(1);
  });

  it('rejects a revoked file binding after advertising tools without returning document text or running the reader again', async () => {
    const data = await fixture('revoked');
    const { execution, traces } = await data.run();
    expect(data.requests).toHaveLength(2);
    expect(data.requests[0].tools).toHaveLength(1);
    expect(data.requests[1]).not.toHaveProperty('tools');
    expect(data.readsBeforeRevocation).toBeGreaterThan(0);
    expect(data.readSpy).toHaveBeenCalledTimes(data.readsBeforeRevocation);
    const observation = data.requests[1].messages.find(message => message.role === 'tool')!;
    expect(observation.tool_call_id).toBe(data.toolCall.id);
    expect(JSON.parse(observation.content)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'authorization_or_revision_invalid' }] });
    expect(traces.some(trace => trace.code === 'tool_result' && trace.status === 'failed')).toBe(true);
    expect(traces.some(trace => trace.code === 'tool_call' && trace.status === 'started')).toBe(false);
    expect(execution.content).toBe('文档读取被拒绝，未使用旧资料。');
    for (const marker of [...markers, oldMarker]) expect(JSON.stringify(data.requests)).not.toContain(marker);
  });

  it('keeps ordinary chat on its existing path without any document tools', async () => {
    const data = await fixture('chat');
    const { execution, traces, runtimes } = await data.run();
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0]).not.toHaveProperty('tools');
    expect(data.readSpy).not.toHaveBeenCalled();
    expect(execution.content).toBe('普通聊天完成');
    expect(runtimes).toHaveLength(0);
    expect(traces.some(trace => trace.code === 'tool_call')).toBe(false);
  });
});

function stream(model: string, delta: Record<string, unknown>, finishReason: 'stop' | 'tool_calls'): DeepSeekHttpTransportResponse {
  const content = `data: ${JSON.stringify({ id: 'synthetic-production-read', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`;
  return { status: 200, headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () { yield Buffer.from(content); })() };
}

async function providerFixture(directory: string) {
  const providerId = toProviderId('provider-production-loop');
  const connectionId = toConnectionId('connection-production-loop');
  const bindingId = toProtocolBindingId('binding-production-loop');
  const modelId = toModelId('model-production-loop');
  const definition = deepSeekModelDefinitions[0]!;
  const template = definition.profileTemplates[0]!;
  const registry = new JsonProviderRegistryStore(path.join(directory, 'provider-registry.json'));
  await registry.mutate(snapshot => ({ result: undefined, snapshot: { ...snapshot,
    providers: [createProvider({ id: providerId, name: 'Synthetic provider', packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
      packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION, accessCategory: 'online', identityState: 'verified', createdAt: now, updatedAt: now })],
    connections: [createProviderConnection({ id: connectionId, providerId, name: 'Synthetic connection', endpoint: 'https://api.deepseek.com',
      packageId: DEEPSEEK_PROVIDER_PACKAGE_ID, packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION, templateId: DEEPSEEK_OFFICIAL_TEMPLATE_ID,
      templateKind: 'official', credentialSchemaId: DEEPSEEK_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
      credentialVersionId: 'credential-version-production-loop', credentialReference: 'synthetic-credential-reference',
      connectionPolicyId: 'connection.deepseek.official', connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.deepseek.models', discoveryPolicyRevision: 1,
      endpointPolicyId: DEEPSEEK_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
      connectionConfigVersionId: 'connection-config-production-loop', connectionRevision: 1,
      adapterBindings: [{ adapterId: DEEPSEEK_CHAT_ADAPTER_ID, adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
        protocolId: DEEPSEEK_CHAT_PROTOCOL_ID, protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: now, updatedAt: now })],
    protocolBindings: [createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
      protocolId: DEEPSEEK_CHAT_PROTOCOL_ID, protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION, adapterKind: DEEPSEEK_CHAT_ADAPTER_ID,
      mediaKind: 'unknown', authScheme: 'bearer', executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: now, updatedAt: now })],
    models: [createProviderModel({ id: modelId, providerId, connectionId, protocolBindingId: bindingId,
      providerModelKey: definition.providerModelKey, mediaKind: 'unknown', revision: 1, displayName: 'Synthetic text model',
      activeProfileId: 'profile-production-loop', catalogState: 'present', enabled: true, createdAt: now, updatedAt: now })],
    modelDefinitions: [definition], modelProfiles: [{ schemaVersion: 1, profileId: 'profile-production-loop', revision: 1,
      packageId: definition.packageId, sourceTemplateId: template.templateId, adapterKey: template.adapterKey,
      modelId, modelRevision: 1, protocolBindingId: bindingId, status: 'verified', features: template.features,
      evidenceIds: [], recordedAt: now }]
  } }));
  const authorization = new RuntimeAuthorizationLedger(new JsonRuntimeAuthorizationLedgerStore(path.join(directory, 'authorization.json')), () => now);
  await authorization.upsertPolicy({ policyId: 'policy-production-loop', providerPackageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    connectionId, adapterKey: DEEPSEEK_CHAT_ADAPTER_ID, state: 'interactive_allowed', revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
  const vault = new SecureCredentialVault(path.join(directory, 'synthetic-credentials.json'), {
    isAvailable: () => true, protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8')
  });
  await vault.saveRecord('synthetic-credential-reference', { schemaId: DEEPSEEK_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
    values: { api_key: 'synthetic-unit-test-key' } });
  return { registry, authorization, vault, modelKey: definition.providerModelKey };
}
