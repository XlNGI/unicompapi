import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCompletedAssistantMessage, addUserMessage, attachDocumentResultToMessage,
  createConversationResponseDraft, createProjectConversation, createProvider, createProviderConnection, createProviderModel, createProviderProtocolBinding,
  toConnectionId, toConversationId, toConversationResponseDraftId, toIsoTimestamp, toMessageId, toModelId, toProjectId, toProtocolBindingId, toProviderId, toWorkId,
  type Conversation
} from '../../src/domain';
import { canonicalToolInputSchema, createCanonicalToolRegistry } from '../../src/domain/entities/canonical-tool-contract';
import {
  createChatContextRuntime, createOpenAiCompatibleDefaultTextDefinition, DeepSeekSharedRuntime, NewApiSharedRuntime,
  JsonProviderRegistryStore, RuntimeAuthorizationLedger, JsonRuntimeAuthorizationLedgerStore, SecureCredentialVault,
  NodeProjectStorage, JsonFileReferenceRepository, JsonWorkRepository, JsonProjectConversationRepository,
  JsonDocumentTaskRuntimeRepository, DocumentGenerationRunner, NEWAPI_PROVIDER_PACKAGE_ID, NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_COMPATIBLE_TEMPLATE_ID, NEWAPI_CREDENTIAL_SCHEMA_ID, NEWAPI_ENDPOINT_POLICY_ID, NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_ADAPTER_VERSION, NEWAPI_CHAT_PROTOCOL_ID, NEWAPI_PROTOCOL_VERSION, type NewApiHttpTransportResponse
} from '../../src/platform';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { DocumentIdentityIndexStore } from '../../src/platform/documents/document-identity-index-store';
import { DocumentMutationHeadStore } from '../../src/platform/documents/document-mutation-head-store';
import { buildPresentationIdentityManifest, readIdentityElementText } from '../../src/platform/documents/presentation-identity-manifest';
import * as officeRenderer from '../../src/platform/documents/office-render-adapter';
import { DocumentMutationCoordinator } from '../../src/application/document-mutation-coordinator';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';
import { ConversationResponseExecutionLifecycle } from '../../src/platform/providers/conversation-response-streaming';
import { ConversationDocumentToolSessionService } from '../../src/platform/documents/conversation-document-tool-session';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const projectId = toProjectId('project-production-update-loop');
const now = toIsoTimestamp('2026-09-28T12:00:00.000Z');
const registry = createCanonicalToolRegistry();
const reading = registry.get('read_document_structure')!;
const updating = registry.get('update_element')!;
const adding = registry.get('add_element')!;
const deleting = registry.get('delete_element')!;
const originalText = '年度销售目标';
const firstText = '2027 年全球销售目标';
const secondText = '2028 年全球销售目标';

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
});

interface WireCall { readonly id: string; readonly type: string; readonly function: { readonly name: string; readonly arguments: string } }
interface WireMessage { readonly role: string; readonly content: string; readonly tool_call_id?: string; readonly tool_calls?: readonly WireCall[] }
interface WireRequest { readonly model: string; readonly messages: readonly WireMessage[]; readonly tools?: readonly {
  readonly type: string; readonly function: { readonly name: string; readonly parameters: Record<string, unknown> }
}[] }
interface ElementObservation { readonly elementId: string; readonly pageId?: string; readonly kind: string; readonly text: string }
interface ToolResult { readonly status: string; readonly observation?: { readonly page?: { readonly pageId?: string; readonly elements: readonly ElementObservation[] };
  readonly elementId?: string; readonly changed?: boolean; readonly field?: string } }

async function fixture(revokeBeforeWrite = false, cancelBeforeWrite = false, mutationMode: 'update' | 'add-delete' = 'update', failureMode: 'none' | 'invalid_args' | 'version_conflict' | 'tool_error' = 'none') {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-production-update-'));
  roots.push(rootDirectory);
  const userDataDirectory = path.join(rootDirectory, 'test-profile');
  await mkdir(userDataDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const works = new JsonWorkRepository(storage, projectId);
  const identityStore = new DocumentIdentityIndexStore(storage);
  const headStore = new DocumentMutationHeadStore(storage);
  const render = vi.fn(async (temporaryPath: string) => ({ previewCount: (await readPptxDocument(await readFile(temporaryPath))).length, diagnostics: [] }));
  vi.spyOn(officeRenderer, 'createConfiguredOfficeRenderAdapter').mockReturnValue(render);
  const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '真实元素更新测试', sections: [
    { heading: '目标页', level: 1, blocks: [{ type: 'paragraph', text: originalText }] },
    { heading: '重复文本页', level: 1, blocks: [{ type: 'paragraph', text: originalText }] }
  ] }));
  const source = await new DocumentGenerationRunner({ rootDirectory, projectId, renderPreview: render, requireRenderForPpt: true }).run({
    kind: 'ppt', title: outline.title, contentFingerprint: createHash('sha256').update(JSON.stringify(outline)).digest('hex'),
    draftRevision: 1, sourceDraftId: 'synthetic-update-source', outline
  });
  const sourceRead = await new RegisteredPresentationReader({ rootDirectory, projectId }).read(source.work.id);
  const identity = await identityStore.ensureForWork({ workId: source.work.id, build: () => buildPresentationIdentityManifest({
    buffer: sourceRead.buffer, documentLineageId: 'lineage-production-update', workId: source.work.id,
    fileId: source.file.id, sourceExecutionId: source.work.sourceExecutionId, revision: 1
  }) });
  const targetPage = identity.pages.find(page => page.physicalPageNumber === 2)!;
  const target = identity.elements.find(element => element.pageId === targetPage.pageId && element.text === originalText)!;
  const duplicate = identity.elements.find(element => element.elementId !== target.elementId && element.text === originalText)!;
  expect(target).toBeDefined(); expect(duplicate).toBeDefined();
  await headStore.save({ documentLineageId: identity.documentLineageId, headWorkId: source.work.id, fileId: source.file.id,
    sourceExecutionId: source.work.sourceExecutionId, checksumSha256: source.file.checksumSha256!, runtimeRevision: 1, identityIndexVersion: 1 });
  let conversation: Conversation = createProjectConversation({ id: toConversationId('conversation-production-update'), projectId,
    title: '生产文本更新闭环', createdAt: now });
  await conversations.create(conversation);
  const save = async (next: Conversation) => { await conversations.save(next, conversation.revision); conversation = next; };
  await save(addUserMessage(conversation, { id: toMessageId('source-update-message'), content: '生成一个测试 PPT。', createdAt: now }));
  const assistantId = toMessageId('source-update-result');
  await save(addCompletedAssistantMessage(conversation, { id: assistantId, content: '测试 PPT 已生成。', createdAt: now }));
  await save(attachDocumentResultToMessage(conversation, assistantId, { kind: 'ppt', workId: source.work.id,
    fileName: sourceRead.fileName, sizeBytes: sourceRead.buffer.length, validatedContent: 'STALE-CACHED-OUTLINE-DO-NOT-USE' }, now));
  const provider = await providerFixture(userDataDirectory);
  const requests: WireRequest[] = [];
  const errors: unknown[] = [];
  const readSpy = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
  const mutateSpy = vi.spyOn(DocumentMutationCoordinator.prototype, 'updateText');
  const genericMutateSpy = vi.spyOn(DocumentMutationCoordinator.prototype, 'mutate');
  const beginSpy = vi.spyOn(DocumentTaskRuntimeService.prototype, 'beginToolCall');
  const failureSpy = vi.spyOn(ConversationResponseExecutionLifecycle.prototype, 'failDeferredPublish');
  const calls: WireCall[] = [];
  let releaseLateCall!: () => void;
  const lateCall = new Promise<void>(resolve => { releaseLateCall = resolve; });
  let signalPrepared!: () => void;
  const updatePrepared = new Promise<void>(resolve => { signalPrepared = resolve; });
  if (failureMode === 'version_conflict') {
    mutateSpy.mockResolvedValueOnce({
      status: 'revision_conflict',
      record: { state: 'revision_conflict', diagnostic: 'revision_conflict' }
    } as never);
  }
  if (failureMode === 'tool_error') {
    mutateSpy.mockResolvedValueOnce({
      status: 'failed',
      record: { state: 'failed', diagnostic: 'tool_failed' }
    } as never);
  }
  const call = (id: string, name: string, args: Record<string, unknown>): WireCall => {
    const value = { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    calls.push(value); return value;
  };
  const resultFor = (payload: WireRequest, id: string): ToolResult => JSON.parse(payload.messages.find(message => message.role === 'tool' && message.tool_call_id === id)!.content) as ToolResult;
  const pageElement = (result: ToolResult): ElementObservation => {
    expect(result.status).toBe('success');
    return result.observation!.page!.elements.find(element => element.elementId === target.elementId)!;
  };
  const pageElements = (result: ToolResult): readonly ElementObservation[] => {
    expect(result.status).toBe('success');
    return result.observation!.page!.elements;
  };
  let addedElementId: string | undefined;
  const transport = { send: async (request: { readonly body?: Uint8Array }): Promise<NewApiHttpTransportResponse> => {
    const payload = JSON.parse(Buffer.from(request.body!).toString('utf8')) as WireRequest;
    requests.push(payload);
    let next: WireCall;
    if (failureMode === 'invalid_args' && requests.length === 1) {
      next = call('invalid-update-1', updating.toolId, { text: firstText });
    } else if (failureMode === 'invalid_args' && requests.length === 2) {
      expect(resultFor(payload, 'invalid-update-1')).toMatchObject({ status: 'failed', diagnostics: [{ code: 'invalid_tool_arguments' }] });
      next = call('read-after-invalid-2', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (failureMode === 'invalid_args' && requests.length === 3) {
      expect(pageElement(resultFor(payload, 'read-after-invalid-2')).text).toBe(originalText);
      return stream(provider.modelKey, { content: '参数错误已作为 Observation 返回，文件未修改。' }, 'stop');
    } else if (failureMode === 'version_conflict' && requests.length === 1) {
      next = call('read-target-1', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (failureMode === 'version_conflict' && requests.length === 2) {
      const observed = pageElement(resultFor(payload, 'read-target-1'));
      next = call('update-conflict-2', updating.toolId, { elementId: observed.elementId, text: firstText });
    } else if (failureMode === 'version_conflict' && requests.length === 3) {
      expect(resultFor(payload, 'update-conflict-2')).toMatchObject({ status: 'failed', diagnostics: [{ code: 'revision_conflict' }] });
      next = call('read-after-conflict-3', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (failureMode === 'version_conflict' && requests.length === 4) {
      expect(pageElement(resultFor(payload, 'read-after-conflict-3')).text).toBe(originalText);
      return stream(provider.modelKey, { content: '版本冲突已作为 Observation 返回，重新读取后确认文件未修改。' }, 'stop');
    } else if (failureMode === 'tool_error' && requests.length === 1) {
      next = call('read-target-1', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (failureMode === 'tool_error' && requests.length === 2) {
      const observed = pageElement(resultFor(payload, 'read-target-1'));
      next = call('runtime-error-2', updating.toolId, { elementId: observed.elementId, text: firstText });
    } else if (failureMode === 'tool_error' && requests.length === 3) {
      expect(resultFor(payload, 'runtime-error-2')).toMatchObject({ status: 'failed', diagnostics: [{ code: 'tool_failed' }] });
      next = call('read-after-runtime-error-3', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (failureMode === 'tool_error' && requests.length === 4) {
      expect(pageElement(resultFor(payload, 'read-after-runtime-error-3')).text).toBe(originalText);
      return stream(provider.modelKey, { content: '工具失败已作为 Observation 返回，重新读取后确认文件未修改。' }, 'stop');
    } else if (requests.length === 1) {
      next = call('read-target-1', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (mutationMode === 'add-delete' && requests.length === 2) {
      const observed = pageElement(resultFor(payload, 'read-target-1'));
      expect(observed.text).toBe(originalText);
      const pageId = resultFor(payload, 'read-target-1').observation?.page?.pageId;
      expect(pageId).toBe(target.pageId);
      next = call('add-target-2', adding.toolId, { pageId, type: 'text', text: originalText, placement: 'default' });
    } else if (mutationMode === 'add-delete' && requests.length === 3) {
      const added = resultFor(payload, 'add-target-2');
      expect(added).toMatchObject({ status: 'success', observation: { pageId: target.pageId, operation: 'added' } });
      addedElementId = added.observation?.elementId;
      expect(addedElementId).toMatch(/^element-[a-f0-9]{48}$/u);
      next = call('read-after-add-3', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (mutationMode === 'add-delete' && requests.length === 4) {
      const elements = pageElements(resultFor(payload, 'read-after-add-3'));
      expect(elements.filter(element => element.text === originalText)).toHaveLength(2);
      expect(new Set(elements.filter(element => element.text === originalText).map(element => element.elementId)).size).toBe(2);
      expect(addedElementId).toBeDefined();
      next = call('delete-added-4', deleting.toolId, { elementId: addedElementId });
    } else if (mutationMode === 'add-delete' && requests.length === 5) {
      expect(resultFor(payload, 'delete-added-4')).toMatchObject({ status: 'success', observation: { elementId: addedElementId, operation: 'deleted' } });
      next = call('read-after-delete-5', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (mutationMode === 'add-delete' && requests.length === 6) {
      const elements = pageElements(resultFor(payload, 'read-after-delete-5'));
      expect(elements.filter(element => element.text === originalText)).toHaveLength(1);
      expect(elements.some(element => element.elementId === addedElementId)).toBe(false);
      return stream(provider.modelKey, { content: '已从真实文件核验：新增后删除成功，其他元素身份保持稳定。' }, 'stop');
    } else if (requests.length === 2) {
      const observed = pageElement(resultFor(payload, 'read-target-1'));
      expect(observed.text).toBe(originalText);
      expect(observed.elementId).toBe(target.elementId);
      if (revokeBeforeWrite) {
        const liveFile = (await files.get(source.file.id))!;
        await files.save({ ...liveFile, state: 'missing', updatedAt: toIsoTimestamp('2026-09-28T12:00:01.000Z') });
      }
      next = call('update-target-2', updating.toolId, { elementId: observed.elementId, text: firstText });
    } else if (revokeBeforeWrite) {
      return stream(provider.modelKey, { content: '权限已撤销，没有修改。' }, 'stop');
    } else if (requests.length === 3) {
      expect(resultFor(payload, 'update-target-2')).toMatchObject({ status: 'success', observation: { elementId: target.elementId, changed: true, field: 'text' } });
      next = call('read-updated-3', reading.toolId, { scope: 'page', ordinal: 2 });
    } else if (requests.length === 4) {
      expect(pageElement(resultFor(payload, 'read-updated-3')).text).toBe(firstText);
      next = call('update-again-4', updating.toolId, { elementId: target.elementId, text: secondText });
    } else if (requests.length === 5) {
      expect(resultFor(payload, 'update-again-4')).toMatchObject({ status: 'success', observation: { elementId: target.elementId, changed: true } });
      next = call('read-final-5', reading.toolId, { scope: 'page', ordinal: 2 });
    } else {
      if (requests.length !== 6) throw new Error('Unexpected extra synthetic request');
      const final = pageElement(resultFor(payload, 'read-final-5'));
      expect(final.text).toBe(secondText);
      return stream(provider.modelKey, { content: '已从真实文件核验：' + final.text }, 'stop');
    }
    if (cancelBeforeWrite && requests.length === 2) {
      signalPrepared();
      // Deliberately ignore AbortSignal here to model a late server response.
      await lateCall;
    }
    return stream(provider.modelKey, { tool_calls: [{ index: 0, ...next }] }, 'tool_calls');
  } };
  const newApiRuntime = new NewApiSharedRuntime({ transport });
  const deepSeekRuntime = new DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected provider'); } } });
  const runtime = createChatContextRuntime({ userDataDirectory, providerRegistry: provider.registry, runtimeAuthorization: provider.authorization,
    getSession: () => ({ projectId, projectName: 'Synthetic production update', rootDirectory }),
    textSubmission: { credentialVault: provider.vault, deepSeekRuntime, newApiRuntime }, now: () => now, onError: error => errors.push(error) });
  cleanups.push(async () => { releaseLateCall(); await runtime.interruptActiveResponses(); await runtime.waitForMutations(); deepSeekRuntime.dispose(); newApiRuntime.dispose(); });
  let activeExecutionId: string | undefined;
  async function run(agentNative = false) {
    const candidates = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
    if (!candidates.ok) throw new Error('Candidates failed: ' + candidates.error.code);
    const candidate = candidates.value.find(item => item.available);
    if (!candidate) throw new Error('No candidate');
    const request = { clientCommandId: agentNative ? 'start-agent-production-update' : mutationMode === 'update' ? 'start-production-update' : 'start-production-add-delete',
      conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null }, title: conversation.title,
      content: mutationMode === 'update'
        ? '把当前 PPT 第二页的“年度销售目标”改成“2027 年全球销售目标”，读取核验后，再改成“2028 年全球销售目标”并再次读取第二页核验，最后简短告诉我结果。'
        : '在当前 PPT 第二页新增一句“年度销售目标”，读取真实文件核验后，再删除刚才新增的那一句并再次读取第二页核验，最后简短告诉我结果。',
      productFeature: 'text_chat' as const, candidateId: candidate.candidateId, contextSelections: [], parameterValues: {} };
    const started = agentNative
      ? await runtime.responses.startAgent(request)
      : await runtime.responses.start({ ...request, confirmed: true });
    if (!started.ok) throw new Error('Start failed: ' + started.error.code);
    if (!('execution' in started.value)) throw new Error('Expected an executable document update response');
    const executionId = started.value.execution.responseExecutionId;
    activeExecutionId = executionId;
    await vi.waitFor(async () => {
      const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
      if (!current.ok) throw new Error('Missing execution: ' + current.error.code);
      expect(['completed', 'failed', 'cancelled']).toContain(current.value.state);
    }, { timeout: 20_000, interval: 30 });
    await runtime.waitForMutations();
    const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
    if (!current.ok) throw new Error('Missing execution');
    return current.value;
  }
  return { run, rootDirectory, storage, works, files, identityStore, headStore, identity, source, sourceRead, target, duplicate,
    requests, errors, calls, render, readSpy, mutateSpy, genericMutateSpy, beginSpy, failureSpy, updatePrepared, releaseLateCall,
    addedElementId: () => addedElementId,
    cancel: async () => {
      if (!activeExecutionId) throw new Error('Execution not started');
      return runtime.responses.cancelExecution({ responseExecutionId: activeExecutionId });
    } };
}

describe('production NewAPI update_element continuation', () => {
  it('does not invent a new lineage when the identity of a twice-mutated registered PPT is missing', async () => {
    const data = await fixture();
    expect((await data.run()).state).toBe('completed');
    const head = (await data.headStore.get(data.identity.documentLineageId))!;
    expect(head.runtimeRevision).toBe(3);
    const old = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(data.source.work.id);
    const current = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(toWorkId(head.headWorkId));
    const primary = path.join(data.rootDirectory, 'entities', 'presentation-identity-index',
      `work-${createHash('sha256').update(head.headWorkId).digest('hex')}.json`);
    await rm(primary);
    const before = (await readdir(path.dirname(primary))).sort();
    const conversations = new JsonProjectConversationRepository(data.storage, projectId);
    const stored = (await conversations.get(toConversationId('conversation-production-update')))!;
    const publishedAt = toIsoTimestamp(new Date().toISOString());
    const resultId = toMessageId('latest-controlled-version-result');
    const published = addCompletedAssistantMessage(stored, { id: resultId, content: '已登记并核验最新修改版本。', createdAt: publishedAt });
    await conversations.save(published, stored.revision);
    const prior = attachDocumentResultToMessage(published, resultId, { kind: 'ppt', workId: current.work.id,
      fileName: current.fileName, sizeBytes: current.buffer.length }, publishedAt);
    await conversations.save(prior, published.revision);
    const userMessageId = toMessageId('missing-identity-followup');
    const conversation = addUserMessage(prior, { id: userMessageId, content: '修改当前 PPT 第二页的文字', createdAt: toIsoTimestamp(new Date().toISOString()) });
    await conversations.save(conversation, prior.revision);
    const message = conversation.messages.at(-1)!;
    const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('missing-identity-draft'), projectId,
      conversationId: conversation.id, conversationRevision: conversation.revision,
      userMessageId: message.id, userMessageRevision: message.revision, productFeature: 'text_chat', createdAt: message.createdAt });
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId, conversations,
      mutation: { renderPreview: data.render } });
    cleanups.push(() => service.dispose());
    await expect(service.prepare({ conversation, draft })).rejects.toMatchObject({ code: 'identity_unresolved' });
    expect(await data.identityStore.getForWork(head.headWorkId)).toBeUndefined();
    expect(await data.headStore.get(data.identity.documentLineageId)).toEqual(head);
    expect((await readdir(path.dirname(primary))).sort()).toEqual(before);
    expect(await data.works.list(projectId)).toHaveLength(3);
    const reader = new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId });
    expect((await reader.read(data.source.work.id)).buffer).toEqual(old.buffer);
    expect((await reader.read(toWorkId(head.headWorkId))).buffer).toEqual(current.buffer);
    expect(data.mutateSpy).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('reads, updates the same element twice and reads each actual revision without changing duplicate text', async () => {
    const data = await fixture();
    const execution = await data.run();
    expect(execution.state).toBe('completed');
    expect(execution.content).toBe('已从真实文件核验：' + secondText);
    expect(data.errors).toEqual([]);
    expect(data.requests).toHaveLength(6);
    expect(data.mutateSpy).toHaveBeenCalledTimes(2);
    const head = (await data.headStore.get(data.identity.documentLineageId))!;
    expect(head.runtimeRevision).toBe(3);
    expect(head.headWorkId).not.toBe(data.source.work.id);
    expect(head.checksumSha256).not.toBe(data.source.file.checksumSha256);
    expect(await data.works.list(projectId)).toHaveLength(3);
    const currentIdentity = (await data.identityStore.getForWork(head.headWorkId))!;
    expect(currentIdentity.identityIndexVersion).toBe(1);
    expect(currentIdentity.elements.map(element => element.elementId)).toEqual(data.identity.elements.map(element => element.elementId));
    expect(currentIdentity.pages.map(page => page.pageId)).toEqual(data.identity.pages.map(page => page.pageId));
    const actual = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(toWorkId(head.headWorkId));
    expect(actual.file.checksumSha256).toBe(head.checksumSha256);
    expect(createHash('sha256').update(actual.buffer).digest('hex')).toBe(head.checksumSha256);
    expect(await readIdentityElementText(actual.buffer, currentIdentity, data.target.elementId)).toBe(secondText);
    expect(await readIdentityElementText(actual.buffer, currentIdentity, data.duplicate.elementId)).toBe(originalText);
    const old = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(data.source.work.id);
    expect(await readIdentityElementText(old.buffer, data.identity, data.target.elementId)).toBe(originalText);
    for (const request of data.requests) {
      expect(request.tools?.map(tool => tool.function.name).sort()).toEqual([reading.toolId, updating.toolId, 'add_element', 'add_slide', 'delete_element'].sort());
      for (const tool of request.tools!) expect(tool.function.parameters).toEqual(canonicalToolInputSchema(registry.get(tool.function.name as 'update_element')!));
    }
    const final = data.requests.at(-1)!;
    expect(final.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(data.calls.map(call => call.id));
    expect(final.messages.filter(message => message.role === 'assistant' && message.tool_calls).flatMap(message => message.tool_calls!)).toEqual(data.calls);
    expect(final.messages.slice(-10).map(message => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
    const contexts = data.beginSpy.mock.calls.filter(([, call]) => call.toolId === updating.toolId).map(([, , context]) => context!);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].taskContext.taskId).toBe(contexts[1].taskContext.taskId);
    expect(contexts[0].revision).toBe(1); expect(contexts[1].revision).toBe(2);
    expect(contexts[0].currentDocumentId).toBe(data.source.work.id);
    expect(contexts[1].currentDocumentId).not.toBe(data.source.work.id);
    const runtimes = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(runtimes.some(runtime => runtime.toolCalls.filter(call => call.toolId === updating.toolId && call.status === 'completed').length === 2)).toBe(true);
    const allWorks = await data.works.list(projectId);
    const outgoing = JSON.stringify(data.requests) + data.requests.flatMap(request => request.messages.filter(message => message.role === 'tool').map(message => message.content)).join('\n');
    for (const hidden of [data.rootDirectory, data.identity.documentLineageId, head.checksumSha256,
      ...allWorks.flatMap(work => [work.id, work.fileId, work.sourceExecutionId]),
      '"rootDirectory"', '"relativePath"', '"slidePart"', '"shapeId"', '"identityIndexVersion"', '"manifest"',
      '"currentDocumentIR"', '"authorization"', '"abortSignal"', '"projectContext"', '"taskContext"', '"irPatch"']) expect(outgoing).not.toContain(hidden);
    expect(data.render.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('lets the Agent-native path choose the same read/mutation continuation against the real file', async () => {
    const data = await fixture();
    const execution = await data.run(true);
    expect(execution.state).toBe('completed');
    expect(execution.content).toBe('已从真实文件核验：' + secondText);
    expect(data.requests).toHaveLength(6);
    expect(data.calls.map(call => call.function.name)).toEqual([
      reading.toolId, updating.toolId, reading.toolId, updating.toolId, reading.toolId
    ]);
    expect(data.mutateSpy).toHaveBeenCalledTimes(2);
    expect((await data.headStore.get(data.identity.documentLineageId))?.runtimeRevision).toBe(3);
    const head = (await data.headStore.get(data.identity.documentLineageId))!;
    const current = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(toWorkId(head.headWorkId));
    const currentIdentity = (await data.identityStore.getForWork(head.headWorkId))!;
    expect(await readIdentityElementText(current.buffer, currentIdentity, data.target.elementId)).toBe(secondText);
  }, 20_000);

  it('returns invalid tool arguments as an Observation and continues the Agent-native turn', async () => {
    const data = await fixture(false, false, 'update', 'invalid_args');
    const execution = await data.run(true);
    expect(execution.state).toBe('completed');
    expect(data.requests).toHaveLength(3);
    expect(data.calls.map(call => call.function.name)).toEqual([updating.toolId, reading.toolId]);
    expect(execution.content).toContain('参数错误已作为 Observation');
    expect(await data.works.list(projectId)).toHaveLength(1);
  }, 20_000);

  it('returns a revision conflict as an Observation and continues with a fresh read', async () => {
    const data = await fixture(false, false, 'update', 'version_conflict');
    const execution = await data.run(true);
    expect(execution.state).toBe('completed');
    expect(data.requests).toHaveLength(4);
    expect(data.calls.map(call => call.function.name)).toEqual([reading.toolId, updating.toolId, reading.toolId]);
    expect(execution.content).toContain('版本冲突已作为 Observation');
    expect(data.mutateSpy).toHaveBeenCalledOnce();
    expect(await data.works.list(projectId)).toHaveLength(1);
  }, 20_000);

  it('returns a Runtime tool failure as an Observation and continues the Agent-native turn', async () => {
    const data = await fixture(false, false, 'update', 'tool_error');
    const execution = await data.run(true);
    expect(execution.state).toBe('completed');
    expect(data.requests).toHaveLength(4);
    expect(data.calls.map(call => call.function.name)).toEqual([reading.toolId, updating.toolId, reading.toolId]);
    expect(execution.content).toContain('工具失败已作为 Observation');
    expect(data.mutateSpy).toHaveBeenCalledOnce();
    expect(await data.works.list(projectId)).toHaveLength(1);
  }, 20_000);

  it('does not start mutation after current-file access is revoked while the model responds', async () => {
    const data = await fixture(true);
    const execution = await data.run();
    expect(execution.state).toBe('failed');
    expect(data.failureSpy).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,127}$/u));
    expect(data.requests).toHaveLength(2);
    expect(data.requests[1].tools?.some(tool => tool.function.name === updating.toolId)).toBe(true);
    expect(data.mutateSpy).not.toHaveBeenCalled();
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect((await data.headStore.get(data.identity.documentLineageId))?.headWorkId).toBe(data.source.work.id);
  }, 20_000);

  it('adds a third duplicate text, reads the real file, then deletes only the returned identity', async () => {
    const data = await fixture(false, false, 'add-delete');
    const execution = await data.run();
    expect(execution.state).toBe('completed');
    expect(execution.content).toBe('已从真实文件核验：新增后删除成功，其他元素身份保持稳定。');
    expect(data.errors).toEqual([]);
    expect(data.requests).toHaveLength(6);
    expect(data.genericMutateSpy).toHaveBeenCalledTimes(2);
    const addedElementId = data.addedElementId();
    expect(addedElementId).toMatch(/^element-[a-f0-9]{48}$/u);
    const addedMutation = await data.genericMutateSpy.mock.results[0]!.value as {
      readonly candidate?: { readonly pin: { readonly headWorkId: string } }
    };
    expect(addedMutation.candidate).toBeDefined();
    const addedRead = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(toWorkId(addedMutation.candidate!.pin.headWorkId));
    const addedIdentity = (await data.identityStore.getForWork(addedMutation.candidate!.pin.headWorkId))!;
    expect(addedIdentity.elements.filter(element => element.text === originalText)).toHaveLength(3);
    expect(await readIdentityElementText(addedRead.buffer, addedIdentity, addedElementId!)).toBe(originalText);
    const head = (await data.headStore.get(data.identity.documentLineageId))!;
    expect(head.runtimeRevision).toBe(3);
    expect(await data.works.list(projectId)).toHaveLength(3);
    const currentIdentity = (await data.identityStore.getForWork(head.headWorkId))!;
    expect(currentIdentity.elements.map(element => element.elementId)).toEqual(data.identity.elements.map(element => element.elementId));
    expect(currentIdentity.tombstones).toContainEqual({ elementId: addedElementId, pageId: data.target.pageId, revision: 3 });
    const actual = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(toWorkId(head.headWorkId));
    expect(await readIdentityElementText(actual.buffer, currentIdentity, data.target.elementId)).toBe(originalText);
    expect(await readIdentityElementText(actual.buffer, currentIdentity, data.duplicate.elementId)).toBe(originalText);
    await expect(readIdentityElementText(actual.buffer, currentIdentity, addedElementId!)).rejects.toMatchObject({ code: 'identity_unresolved' });

    for (const request of data.requests) {
      expect(request.model).toBe('synthetic-newapi-text');
      expect(request.tools?.map(tool => tool.function.name).sort()).toEqual([reading.toolId, updating.toolId, adding.toolId, 'add_slide', deleting.toolId].sort());
      for (const tool of request.tools!) expect(tool.function.parameters).toEqual(canonicalToolInputSchema(registry.get(tool.function.name as 'update_element')!));
    }
    expect(data.calls.map(call => call.function.name)).toEqual([
      reading.toolId, adding.toolId, reading.toolId, deleting.toolId, reading.toolId
    ]);
    const addCall = data.calls.find(call => call.function.name === adding.toolId)!;
    const deleteCall = data.calls.find(call => call.function.name === deleting.toolId)!;
    expect(JSON.parse(addCall.function.arguments)).toEqual({ pageId: data.target.pageId, type: 'text', text: originalText, placement: 'default' });
    expect(JSON.parse(deleteCall.function.arguments)).toEqual({ elementId: addedElementId });
    const final = data.requests.at(-1)!;
    const outgoing = JSON.stringify(data.requests) + data.requests.flatMap(request => request.messages.filter(message => message.role === 'tool').map(message => message.content)).join('\n');
    for (const hidden of [data.rootDirectory, data.identity.documentLineageId, head.checksumSha256,
      ...((await data.works.list(projectId)).flatMap(work => [work.id, work.fileId, work.sourceExecutionId])),
      '"rootDirectory"', '"relativePath"', '"slidePart"', '"shapeId"', '"identityIndexVersion"', '"manifest"',
      '"currentDocumentIR"', '"authorization"', '"abortSignal"', '"projectContext"', '"taskContext"', '"irPatch"']) expect(outgoing).not.toContain(hidden);
    expect(final.messages.filter(message => message.role === 'assistant' && message.tool_calls).flatMap(message => message.tool_calls!)).toEqual(data.calls);
    const runtimes = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(runtimes.some(runtime => runtime.toolCalls.some(call => call.toolId === adding.toolId && call.status === 'completed'))).toBe(true);
    expect(runtimes.some(runtime => runtime.toolCalls.some(call => call.toolId === deleting.toolId && call.status === 'completed'))).toBe(true);
    expect(data.render.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('cancels through Runtime before adapter start and ignores the late provider update call', async () => {
    const data = await fixture(false, true);
    const running = data.run();
    await data.updatePrepared;
    expect(data.calls.at(-1)?.function.name).toBe(updating.toolId);
    const cancelled = await data.cancel();
    expect(cancelled.ok).toBe(true);
    data.releaseLateCall();
    const execution = await running;
    expect(execution.state).toBe('cancelled');
    expect(data.mutateSpy).not.toHaveBeenCalled();
    expect(data.requests).toHaveLength(2);
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect((await data.headStore.get(data.identity.documentLineageId))?.headWorkId).toBe(data.source.work.id);
    const old = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(data.source.work.id);
    expect(await readIdentityElementText(old.buffer, data.identity, data.target.elementId)).toBe(originalText);
  }, 20_000);
});

function stream(model: string, delta: Record<string, unknown>, finishReason: 'stop' | 'tool_calls'): NewApiHttpTransportResponse {
  const body = 'data: ' + JSON.stringify({ id: 'synthetic-production-update', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n';
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: (async function* () { yield Buffer.from(body); })() };
}
async function providerFixture(directory: string) {
  const providerId = toProviderId('provider-generation-loop');
  const connectionId = toConnectionId('connection-generation-loop');
  const bindingId = toProtocolBindingId('binding-generation-loop');
  const modelId = toModelId('model-generation-loop');
  const modelKey = 'synthetic-newapi-text';
  const definition = createOpenAiCompatibleDefaultTextDefinition({ packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, providerModelKey: modelKey, features: ['text_chat'] });
  const template = definition.profileTemplates[0]!;
  const providerRegistry = new JsonProviderRegistryStore(path.join(directory, 'provider-registry.json'));
  await providerRegistry.mutate(snapshot => ({ result: undefined, snapshot: { ...snapshot,
    providers: [createProvider({ id: providerId, name: 'Synthetic NewAPI', packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, accessCategory: 'online', identityState: 'verified', createdAt: now, updatedAt: now })],
    connections: [createProviderConnection({ id: connectionId, providerId, name: 'Synthetic connection', endpoint: 'https://gateway.example.test/v1',
      packageId: NEWAPI_PROVIDER_PACKAGE_ID, packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
      templateKind: 'compatible_custom', credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
      credentialVersionId: 'credential-version-generation-loop', credentialReference: 'synthetic-generation-reference',
      connectionPolicyId: 'connection.newapi.compatible', connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.newapi.models', discoveryPolicyRevision: 1,
      endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
      connectionConfigVersionId: 'connection-config-generation-loop', connectionRevision: 1,
      adapterBindings: [{ adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION,
        protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: now, updatedAt: now })],
    protocolBindings: [createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION, adapterKind: NEWAPI_CHAT_ADAPTER_ID,
      mediaKind: 'unknown', authScheme: 'bearer', executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: now, updatedAt: now })],
    models: [createProviderModel({ id: modelId, providerId, connectionId, protocolBindingId: bindingId,
      providerModelKey: modelKey, mediaKind: 'unknown', revision: 1, displayName: 'Synthetic model',
      activeProfileId: 'profile-generation-loop', catalogState: 'present', enabled: true, createdAt: now, updatedAt: now })],
    modelDefinitions: [definition], modelProfiles: [{ schemaVersion: 1, profileId: 'profile-generation-loop', revision: 1,
      packageId: definition.packageId, sourceTemplateId: template.templateId, adapterKey: template.adapterKey,
      modelId, modelRevision: 1, protocolBindingId: bindingId, status: 'verified', features: template.features, evidenceIds: [], recordedAt: now }]
  } }));
  const authorization = new RuntimeAuthorizationLedger(new JsonRuntimeAuthorizationLedgerStore(path.join(directory, 'authorization.json')), () => now);
  await authorization.upsertPolicy({ policyId: 'policy-generation-loop', providerPackageId: NEWAPI_PROVIDER_PACKAGE_ID,
    connectionId, adapterKey: NEWAPI_CHAT_ADAPTER_ID, state: 'interactive_allowed', revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
  const vault = new SecureCredentialVault(path.join(directory, 'synthetic-credentials.json'), {
    isAvailable: () => true, protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8')
  });

  await vault.saveRecord('synthetic-generation-reference', { schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
    values: { api_key: 'synthetic-offline-unit-test-key' } });
  return { registry: providerRegistry, authorization, vault, modelKey };
}
