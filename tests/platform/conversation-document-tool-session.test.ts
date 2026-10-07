import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCompletedAssistantMessage, addUserMessage, archiveConversation, attachDocumentResultToMessage,
  createConversationResponseDraft, createProjectConversation,
  toConversationId, toConversationResponseDraftId, toExecutionId, toFileReferenceId,
  toIsoTimestamp, toMessageId, toProjectId, toTaskId, toWorkId,
  type Conversation, type ConversationResponseDraftV1, type FileReference, type ProjectId, type Work
} from '../../src/domain';
import { canonicalToolInputSchema, createCanonicalToolRegistry } from '../../src/domain/entities/canonical-tool-contract';
import { NodeProjectStorage } from '../../src/platform/storage';
import { JsonFileReferenceRepository, JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { JsonDocumentTaskRuntimeRepository } from '../../src/platform/repositories/json-document-task-runtime-repository';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';
import {
  buildDocumentReadToolInstruction, ConversationDocumentToolSessionService,
  type ConversationDocumentToolSession, type ConversationDocumentMutationToolSelection
} from '../../src/platform/documents/conversation-document-tool-session';
import { sanitizeControlledToolResult } from '../../src/platform/providers/provider-tool-calling';
import { getProductionTraceStore, withProductionTrace } from '../../src/platform/conversation-production-trace';
import * as productionTrace from '../../src/platform/conversation-production-trace';
import { DocumentIdentityIndexStore } from '../../src/platform/documents/document-identity-index-store';
import { DocumentMutationHeadStore } from '../../src/platform/documents/document-mutation-head-store';

const roots: string[] = [];
const services: ConversationDocumentToolSessionService[] = [];
const sessions: ConversationDocumentToolSession[] = [];
const projectId = toProjectId('project-read-production');
const now = toIsoTimestamp('2026-09-27T12:00:00.000Z');
const contract = createCanonicalToolRegistry().get('read_document_structure')!;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  await Promise.allSettled(services.splice(0).map(service => service.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(texts = ['封面：验收演示文稿', '第二页独有事实：预算为二百万元', '第三页独有事实：计划为三百万元']) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-document-read-session-'));
  roots.push(rootDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const works = new JsonWorkRepository(storage, projectId);
  let currentProjectId: ProjectId | undefined = projectId;
  const service = new ConversationDocumentToolSessionService({ rootDirectory, projectId, conversations,
    getCurrentProjectId: () => currentProjectId });
  services.push(service);
  let conversation: Conversation = createProjectConversation({ id: toConversationId('read-session-conversation'),
    projectId, title: '真实 PPT 查询', createdAt: now });
  let version = 0;
  async function save(next: Conversation) {
    await conversations.save(next, conversation.revision);
    conversation = next;
  }
  await conversations.create(conversation);
  await save(addUserMessage(conversation, { id: toMessageId('original-request'), content: '生成 PPT', createdAt: now }));
  async function register(title = '验证文档', pageTexts = texts, attach = true) {
    const index = ++version;
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst>${pageTexts.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
    zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pageTexts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
    for (const [i, text] of pageTexts.entries()) {
      zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${i === 1 ? ' show="0"' : ''}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="${i + 1}" name="Text ${i + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const fileName = `${title}-${index}.pptx`;
    const absolutePath = path.join(rootDirectory, 'files', 'documents', fileName);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer);
    const file: FileReference = { schemaVersion: 1, id: toFileReferenceId(`file-${index}`), projectId,
      sourceExecutionId: toExecutionId(`generation-${index}`), state: 'available',
      locator: { kind: 'project', relativePath: `files/documents/${fileName}` }, sizeBytes: buffer.length,
      checksumSha256: createHash('sha256').update(buffer).digest('hex'), createdAt: now, updatedAt: now };
    const work: Work = { schemaVersion: 1, id: toWorkId(attach ? `work:${index}` : `work-generated-${index}`), projectId, fileId: file.id,
      sourceTaskId: toTaskId(`task-${index}`), sourceExecutionId: file.sourceExecutionId!, mediaKind: 'document', name: title, createdAt: now };
    await files.save(file);
    await works.save(work);
    const messageId = toMessageId(`document-result-${index}`);
    if (attach) {
      await save(addCompletedAssistantMessage(conversation, { id: messageId,
        content: '陈旧的大纲伪事实：所有页都为九百万元', createdAt: now }));
      await save(attachDocumentResultToMessage(conversation, messageId, { kind: 'ppt', workId: work.id, fileName, sizeBytes: buffer.length }, now));
    }
    return { work, file, fileName, absolutePath, buffer, messageId };
  }
  const first = await register();
  async function question(query = '请读取当前 PPT 的整篇文档，并总结各页内容。') {
    const currentUserMessageId = toMessageId(`question-${conversation.messages.length}`);
    await save(addUserMessage(conversation, { id: currentUserMessageId, content: query, createdAt: now }));
    return { conversation, currentUserMessageId, query };
  }
  async function session(query?: string) {
    const selection = await service.select(await question(query));
    if (!selection) throw new Error('expected selection');
    const created = await service.createSession({ selection, responseExecutionId: `response-${conversation.messages.length}` });
    sessions.push(created);
    return { selection, session: created };
  }
  return { rootDirectory, storage, conversations, files, works, service, first, register, question, session, save,
    get conversation() { return conversation; }, setCurrentProject(id: ProjectId | undefined) { currentProjectId = id; } };
}

function execute(session: ConversationDocumentToolSession, args: Record<string, unknown>, id = 'read-call') {
  return session.bridge.execute({ call: { id, name: contract.toolId, arguments: args }, signal: new AbortController().signal });
}

describe('production registered document read sessions', () => {
  it('admits a legacy whole-document regeneration with a parent Work as an independent first identity', async () => {
    const data = await fixture();
    await data.works.save({ ...data.first.work, parentWorkId: toWorkId('legacy-prior-version') });
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, mutation: { renderPreview: async () => ({ previewCount: 3, diagnostics: [] }) } });
    services.push(service);
    const first = await service.select(await data.question('修改当前 PPT')) as ConversationDocumentMutationToolSelection;
    expect(first).toMatchObject({ kind: 'mutation', identity: { workId: data.first.work.id, revision: 1 } });
    const second = await service.select(await data.question('修改当前 PPT')) as ConversationDocumentMutationToolSelection;
    expect(second.identity).toEqual(first.identity);
  });

  it('refuses to reseed a lost first-admission identity when the durable head or seed still references the Work', async () => {
    const data = await fixture();
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, mutation: { renderPreview: async () => ({ previewCount: 3, diagnostics: [] }) } });
    services.push(service);
    const first = await service.select(await data.question('修改当前 PPT')) as ConversationDocumentMutationToolSelection;
    const heads = new DocumentMutationHeadStore(data.storage);
    const head = await heads.get(first.documentLineageId);
    const primary = path.join(data.rootDirectory, 'entities', 'presentation-identity-index',
      `work-${createHash('sha256').update(data.first.work.id).digest('hex')}.json`);
    await rm(primary);
    await expect(service.select(await data.question('修改当前 PPT'))).rejects.toMatchObject({ code: 'identity_unresolved' });
    expect(await new DocumentIdentityIndexStore(data.storage).getForWork(data.first.work.id)).toBeUndefined();
    expect(await heads.get(first.documentLineageId)).toEqual(head);
    expect(await readFile(data.first.absolutePath)).toEqual(data.first.buffer);
  });

  it('projects an executed read from durable receipts and verifies its actual file after close', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    expect(await execute(session, {})).toMatchObject({ status: 'success' });
    await session.close();
    const [runtime] = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(runtime.status).toBe('completed');
    expect(runtime.workRef).toBeUndefined();
    const facts = await data.service.collectResponseFacts(runtime.executionId);
    expect(facts).toMatchObject({ pendingToolCallCount: 0, unpersistedObservationCount: 0, unknownResult: false, toolFailed: false,
      documentTasks: [{ active: true, readBackConfirmed: true, deliveryConfirmed: false, runtime: { id: runtime.id, status: 'completed' } }] });
    expect(await data.works.list(projectId)).toHaveLength(1);
    await writeFile(data.first.absolutePath, 'changed actual file');
    expect((await data.service.collectResponseFacts(runtime.executionId)).documentTasks[0].readBackConfirmed).toBe(false);
    expect((await data.service.collectResponseFacts('unrelated-response')).documentTasks).toEqual([]);
  });

  it('keeps an unused prepared task inactive without claiming it was completed', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    await session.close();
    const [runtime] = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    const facts = await data.service.collectResponseFacts(runtime.executionId);
    expect(facts.documentTasks).toMatchObject([{ active: false, readBackConfirmed: false, runtime: { status: 'paused', toolCalls: [] } }]);
    expect(facts.unknownResult).toBe(false);
  });

  it('projects failed Observation persistence as unknown and never replays the read', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    vi.spyOn(DocumentTaskRuntimeService.prototype, 'recordObservation').mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await execute(session, {}, 'uncertain-receipt')).toMatchObject({ status: 'unknown' });
    await session.close();
    const [runtime] = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(await data.service.collectResponseFacts(runtime.executionId)).toMatchObject({ unknownResult: true, unpersistedObservationCount: 1,
      documentTasks: [{ active: true, runtime: { status: 'needs_reconciliation', toolCalls: [{ status: 'unknown' }] } }] });
    expect(await execute(session, {}, 'never-replay')).not.toMatchObject({ status: 'success' });
    expect((await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list())[0].toolCalls).toHaveLength(1);
  });

  it('persists an unknown write-ahead receipt even when no call record can be read back', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    vi.spyOn(DocumentTaskRuntimeService.prototype, 'beginToolCall').mockRejectedValueOnce(new Error('write-ahead receipt unavailable'));
    expect(await execute(session, {}, 'write-ahead-missing')).toMatchObject({ status: 'unknown' });
    await session.close();
    const [runtime] = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(await data.service.collectResponseFacts(runtime.executionId)).toMatchObject({ unknownResult: true,
      documentTasks: [{ runtime: { status: 'needs_reconciliation', toolCalls: [] } }] });
  });

  it('separates registered generation, actual readback, and persisted delivery facts', async () => {
    const diagnostic = vi.spyOn(productionTrace, 'emitProductionDiagnostic');
    const data = await fixture();
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId, conversations: data.conversations,
      generatePptx: { compiler: { compile: () => ({ kind: 'ppt', title: '新的生成事实', sections: [
        { heading: '文档事实', level: 1, blocks: [{ type: 'paragraph', text: '核验新生成文件' }] }
      ] }), recover: () => { throw new Error('unused'); } }, executor: { run: async () => {
        const result = await data.register('新的生成事实', ['新封面', '新事实'], false);
        return { taskId: result.work.sourceTaskId, executionId: result.work.sourceExecutionId, workId: result.work.id,
          fileName: result.fileName, sizeBytes: result.buffer.length };
      } }, revalidateAuthorization: async () => true } });
    services.push(service);
    const selection = await service.select(await data.question('立即生成关于海洋的PPT'));
    const session = await service.createSession({ selection: selection!, responseExecutionId: 'new-artifact-facts' });
    sessions.push(session);
    await session.prepareTools(new AbortController().signal);
    const preparation = diagnostic.mock.calls.filter(([event]) => event.code === 'tool_authorization');
    expect(preparation).toEqual([[{ code: 'tool_authorization', status: 'completed', operationId: 'available_tools_prepared',
      facts: { tool: 'write_document', purpose: 'tool', count: 1 } }]]);
    expect(await session.bridge.execute({ call: { id: 'generate-facts', name: 'generate_pptx', arguments: { title: '新的生成事实', content: '## 文档事实\n核验新生成文件' } },
      signal: new AbortController().signal })).toMatchObject({ status: 'success' });
    expect(session.bridge.finalizationState?.()).toMatchObject({ phase: 'readback', readBackConfirmed: false });
    await session.close();
    expect(session.bridge.finalizationState?.()).toBeUndefined();
    const first = await service.collectResponseFacts('new-artifact-facts');
    expect(first.documentTasks).toMatchObject([{ active: true, readBackConfirmed: true, deliveryConfirmed: false,
      runtime: { status: 'completed', workRef: { kind: 'registered', ref: 'work-generated-2' } },
      registeredWork: { id: 'work-generated-2', projectId, sourceTaskRuntimeId: first.documentTasks[0].runtime.id } }]);
    const work = (await data.works.get(toWorkId('work-generated-2')))!;
    const file = (await data.files.get(work.fileId))!;
    const messageId = toMessageId('new-artifact-delivery');
    await data.save(addCompletedAssistantMessage(data.conversation, { id: messageId, content: '文档已生成', createdAt: now }));
    await data.save(attachDocumentResultToMessage(data.conversation, messageId, { kind: 'ppt', workId: work.id,
      fileName: path.basename(file.locator.kind === 'project' ? file.locator.relativePath : ''), sizeBytes: file.sizeBytes! }, now));
    expect((await service.collectResponseFacts('new-artifact-facts')).documentTasks[0].deliveryConfirmed).toBe(true);
    await data.files.save({ ...file, state: 'missing' });
    const lostFile = (await service.collectResponseFacts('new-artifact-facts')).documentTasks[0];
    expect(lostFile.registeredWork?.id).toBe(work.id);
    expect(lostFile.readBackConfirmed).toBe(false);
  });

  it('adds a late registered Work to the frozen task after cancellation without replaying generation', async () => {
    const data = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = vi.fn(async () => {
      await gate;
      const result = await data.register('迟到作品', ['迟到封面', '已登记事实'], false);
      return { taskId: result.work.sourceTaskId, executionId: result.work.sourceExecutionId, workId: result.work.id,
        fileName: result.fileName, sizeBytes: result.buffer.length };
    });
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId, conversations: data.conversations,
      generatePptx: { compiler: { compile: () => ({ kind: 'ppt', title: '迟到作品', sections: [
        { heading: '迟到事实', level: 1, blocks: [{ type: 'paragraph', text: '已登记事实' }] }
      ] }), recover: () => { throw new Error('unused'); } }, executor: { run }, revalidateAuthorization: async () => true } });
    services.push(service);
    const selection = await service.select(await data.question('立即生成关于海洋的PPT'));
    const session = await service.createSession({ selection: selection!, responseExecutionId: 'late-artifact-facts' });
    sessions.push(session);
    await session.prepareTools(new AbortController().signal);
    const pending = session.bridge.execute({ call: { id: 'generate-late', name: 'generate_pptx', arguments: { title: '迟到作品', content: '## 迟到事实\n已登记事实' } },
      signal: new AbortController().signal });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await session.cancel?.();
    expect(await pending).toMatchObject({ status: 'unknown' });
    expect(session.bridge.finalizationState?.()).toBeUndefined();
    await session.close();
    release();
    await vi.waitFor(async () => {
      const facts = await service.collectResponseFacts('late-artifact-facts');
      expect(facts).toMatchObject({ unknownResult: true, documentTasks: [{ readBackConfirmed: true, deliveryConfirmed: false,
        registeredWork: { id: 'work-generated-2' }, runtime: { status: 'needs_reconciliation', toolCalls: [{ status: 'unknown' }] } }] });
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pins the read parent deadline to the durable runtime and never renews it on preparation', async () => {
    const data = await fixture();
    const { session } = await data.session();
    const budget = session.executionBudget!;
    const [runtime] = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(budget.policy).toEqual({ startedAt: Date.parse(runtime.createdAt),
      deadlineAt: Date.parse(runtime.createdAt) + 180_000, maxToolCalls: 8, budgetUnits: 8 });
    await session.prepareTools(new AbortController().signal);
    const deadline = budget.policy.deadlineAt;
    const wallClock = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(wallClock + 1000);
    await session.prepareTools(new AbortController().signal);
    expect(budget.policy.deadlineAt).toBe(deadline);
    expect(budget.remainingMs()).toBeLessThanOrEqual(deadline - wallClock - 1000);
    await session.close();
    expect(budget.stopReason).toBeUndefined();
  });

  it('links cancellation from execution lookup to its existing parent owner', async () => {
    const data = await fixture();
    const selection = await data.service.select(await data.question());
    const responseExecutionId = 'read-lookup-cancellation';
    await data.service.registerExecution({ selection: selection!, responseExecutionId });
    const controller = new AbortController();
    const session = (await data.service.forExecution({ responseExecutionId, signal: controller.signal }))!;
    sessions.push(session);
    controller.abort();
    expect(session.executionBudget?.signal.aborted).toBe(true);
    expect(session.executionBudget?.stopReason).toBe('cancelled');
    expect(await execute(session, {}, 'after-lookup-cancel')).toMatchObject({ status: 'cancelled' });
  });

  it('inherits the original root deadline and remaining counters before creating a document session', async () => {
    const data = await fixture();
    const startedAt = Date.now() - 60_000;
    const policy = { startedAt, deadlineAt: startedAt + 180_000, maxToolCalls: 2, budgetUnits: 2 };
    const getInheritedExecutionContext = vi.fn(async () => ({ policy }));
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, getInheritedExecutionContext });
    services.push(service);
    const selection = (await service.select(await data.question()))!;
    await service.registerExecution({ selection, responseExecutionId: 'inherited-read-session' });
    const session = (await service.forExecution({ responseExecutionId: 'inherited-read-session' }))!;
    expect(getInheritedExecutionContext).toHaveBeenCalledWith('inherited-read-session');
    expect(session.executionBudget?.policy).toEqual(policy);
    const runtime = (await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list())[0];
    expect(runtime.budget).toMatchObject({ maxSteps: 2, budgetUnits: 2, deadlineAt: policy.deadlineAt });
    expect(session.executionBudget!.remainingMs()).toBeLessThanOrEqual(120_000);
    await session.prepareTools(new AbortController().signal);
    expect(await execute(session, {}, 'inherited-first')).toMatchObject({ status: 'success' });
    expect(await execute(session, {}, 'inherited-second')).toMatchObject({ status: 'success' });
    expect(await execute(session, {}, 'inherited-third')).toMatchObject({ status: 'failed', diagnostics: [{ code: 'tool_call_limit' }] });
    expect(session.executionBudget!.snapshot('tool_call_limit')).toMatchObject({ toolCallsUsed: 2, costUnitsUsed: 2 });
    expect((await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list())[0].toolCalls).toHaveLength(2);
  });

  it.each(['startup', 'lease'] as const)('stops an inherited document budget when the %s signal is revoked', async source => {
    const data = await fixture();
    const startup = new AbortController();
    const lease = new AbortController();
    const startedAt = Date.now() - 1000;
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, getInheritedExecutionContext: async () => ({
        policy: { startedAt, deadlineAt: startedAt + 180000, maxToolCalls: 2, budgetUnits: 2 }, signal: lease.signal
      }) });
    services.push(service);
    const selection = (await service.select(await data.question()))!;
    await service.registerExecution({ selection, responseExecutionId: `inherited-signal-${source}`, signal: startup.signal });
    const session = (await service.forExecution({ responseExecutionId: `inherited-signal-${source}` }))!;
    await session.prepareTools(new AbortController().signal);
    (source === 'startup' ? startup : lease).abort();
    expect(session.executionBudget?.stopReason).toBe('cancelled');
    expect(await execute(session, {}, `after-inherited-${source}`)).toMatchObject({ status: 'cancelled' });
    expect((await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list())[0].toolCalls).toHaveLength(0);
  });

  it.each(['deadline', 'units', 'calls'] as const)('rejects an inherited %s policy exceeding the local document capability', async field => {
    const data = await fixture();
    const startedAt = Date.now() - 1000;
    const policy = { startedAt, deadlineAt: startedAt + 180000, maxToolCalls: 8, budgetUnits: 8 };
    if (field === 'deadline') policy.deadlineAt += 1;
    if (field === 'units') policy.budgetUnits += 1;
    if (field === 'calls') policy.maxToolCalls += 1;
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, getInheritedExecutionContext: async () => ({ policy }) });
    services.push(service);
    const create = vi.spyOn(service, 'createSession');
    const selection = (await service.select(await data.question()))!;
    await expect(service.registerExecution({ selection, responseExecutionId: `excess-inherited-${field}` }))
      .rejects.toThrow('invalid_inherited_execution_budget');
    expect(create).not.toHaveBeenCalled();
    expect(await service.forExecution({ responseExecutionId: `excess-inherited-${field}` })).toBeUndefined();
    expect(await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list()).toHaveLength(0);
  });

  it('cancels a stalled root-context lookup on shutdown before a document task can be created', async () => {
    const data = await fixture();
    let resolve!: (value: undefined) => void;
    const context = new Promise<undefined>(accept => { resolve = accept; });
    const getInheritedExecutionContext = vi.fn(async () => context);
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, getInheritedExecutionContext });
    services.push(service);
    const create = vi.spyOn(service, 'createSession');
    const selection = (await service.select(await data.question()))!;
    const pending = service.registerExecution({ selection, responseExecutionId: 'stalled-inherited-context' });
    const stopped = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(getInheritedExecutionContext).toHaveBeenCalledOnce());
    await service.dispose();
    await stopped;
    resolve(undefined);
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list()).toHaveLength(0);
  });

  it('does not renew an inherited deadline that already expired before session registration', async () => {
    const data = await fixture();
    const startedAt = Date.now() - 180000;
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, getInheritedExecutionContext: async () => ({
        policy: { startedAt, deadlineAt: startedAt + 100000, maxToolCalls: 2, budgetUnits: 2 }
      }) });
    services.push(service);
    const create = vi.spyOn(service, 'createSession');
    const selection = (await service.select(await data.question()))!;
    await expect(service.registerExecution({ selection, responseExecutionId: 'expired-root-deadline' }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(create).not.toHaveBeenCalled();
    expect(await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list()).toHaveLength(0);
  });

  it('cleans a refused root-context admission without leaking an execution registration', async () => {
    const data = await fixture();
    const startedAt = Date.now() - 1000;
    const getInheritedExecutionContext = vi.fn(async () => ({
      policy: { startedAt, deadlineAt: startedAt + 180000, maxToolCalls: 2, budgetUnits: 2 }
    })).mockRejectedValueOnce(new Error('Root lease refused'));
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations, getInheritedExecutionContext });
    services.push(service);
    const selection = (await service.select(await data.question()))!;
    await expect(service.registerExecution({ selection, responseExecutionId: 'root-admission-retry' })).rejects.toThrow('Root lease refused');
    expect(await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list()).toHaveLength(0);
    await service.registerExecution({ selection, responseExecutionId: 'root-admission-retry' });
    expect(await service.forExecution({ responseExecutionId: 'root-admission-retry' })).toBeDefined();
    expect(getInheritedExecutionContext).toHaveBeenCalledTimes(2);
  });

  it('records parent Stop diagnostics when cancellation arrives outside the initial trace context', async () => {
    const data = await fixture();
    const request = await data.question();
    const selection = await data.service.select(request);
    const scope = { rootDirectory: data.rootDirectory, projectId, conversationId: request.conversation.id,
      sourceMessageId: request.currentUserMessageId, traceId: 'parent-budget-audit' };
    const session = await withProductionTrace(scope, () => data.service.createSession({ selection: selection!, responseExecutionId: 'budget-audit-execution' }));
    sessions.push(session);
    session.executionBudget!.cancel('cancelled');
    await vi.waitFor(async () => {
      const events = await getProductionTraceStore(scope).list({ conversationId: request.conversation.id });
      expect(events).toContainEqual(expect.objectContaining({ operationId: 'execution_budget', status: 'cancelled',
        facts: expect.objectContaining({ stopReason: 'cancelled', timeoutScope: 'execution', toolCallsUsed: 0, costUnitsUsed: 0 }) }));
      expect(JSON.stringify(events)).not.toContain(data.rootDirectory);
      expect(JSON.stringify(events)).not.toContain('二百万元');
    });
  });

  it('uses one bounded parent policy for combined Agent generation and mutation branches', async () => {
    const data = await fixture();
    const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
      conversations: data.conversations,
      generatePptx: { compiler: { compile: () => ({ kind: 'ppt', title: '预算合成', sections: [
        { heading: '预算内容', level: 1, blocks: [{ type: 'paragraph', text: '测试内容' }] }
      ] }), recover: () => { throw new Error('not invoked'); } }, executor: { run: async () => { throw new Error('not invoked'); } }, revalidateAuthorization: async () => true },
      mutation: { renderPreview: async () => ({ previewCount: 3, diagnostics: [] }) } });
    services.push(service);
    const request = await data.question('继续处理当前 PPT');
    const message = request.conversation.messages.at(-1)!;
    const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('combined-parent-budget'), projectId,
      conversationId: request.conversation.id, conversationRevision: request.conversation.revision,
      userMessageId: message.id, userMessageRevision: message.revision, agentNative: true, productFeature: 'text_chat', createdAt: now });
    const selection = await service.prepare({ conversation: request.conversation, draft });
    expect(selection).toMatchObject({ kind: 'agent', mutation: { kind: 'mutation' } });
    const session = await service.createSession({ selection: selection!, responseExecutionId: 'combined-budget-execution' });
    expect(session.bridge.finalizationState).toBeUndefined();
    sessions.push(session);
    const budget = session.executionBudget!;
    expect(budget.policy).toMatchObject({ maxToolCalls: 12, budgetUnits: 32 });
    expect(budget.policy.deadlineAt - budget.policy.startedAt).toBe(540_000);
    const runtimes = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(runtimes).toHaveLength(2);
    expect(budget.policy.startedAt).toBe(Math.min(...runtimes.map(item => Date.parse(item.createdAt))));
    expect(runtimes.every(item => item.budget.timeoutMs === 540_000)).toBe(true);
    const tools = await session.prepareTools(new AbortController().signal);
    expect(tools?.some(tool => tool.function.name === 'generate_pptx')).toBe(true);
    expect(tools?.some(tool => tool.function.name === 'update_element')).toBe(true);
    await session.cancel?.();
    expect(budget.stopReason).toBe('cancelled');
    await expect(session.prepareTools(new AbortController().signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('pins host-only metadata without reading bytes or including document content in the first prompt', async () => {
    const data = await fixture();
    const reader = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
    const selection = await data.service.select(await data.question());
    expect(selection).toMatchObject({ workId: data.first.work.id, fileId: data.first.file.id,
      checksumSha256: data.first.file.checksumSha256, scope: 'document', bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(reader).not.toHaveBeenCalled();
    expect(JSON.stringify(selection)).not.toMatch(/absolutePath|relativePath|rootDirectory|陈旧|九百|二百|三百/);
    const instruction = buildDocumentReadToolInstruction(selection!);
    expect(instruction).not.toContain(data.rootDirectory);
    expect(instruction).not.toContain(data.first.work.id);
    expect(instruction).not.toContain(selection!.checksumSha256);
    expect(instruction).not.toContain('二百');
  });

  it('reads the whole real presentation through the canonical schema and persisted observation/trace', async () => {
    const data = await fixture();
    const { session } = await data.session();
    const signal = new AbortController().signal;
    const tools = await session.prepareTools(signal);
    expect(tools?.map(tool => tool.function.name)).toEqual([contract.toolId]);
    expect(tools![0].function.parameters).toEqual(canonicalToolInputSchema(contract));
    const scope = { rootDirectory: data.rootDirectory, projectId, conversationId: data.conversation.id,
      sourceMessageId: 'read-source', traceId: 'read-source' };
    const result = await withProductionTrace(scope, () => execute(session, {}));
    expect(result).toMatchObject({ status: 'success', observation: { scope: 'document', pageCount: 3,
      totalSections: 3, totalPages: 3, structureUnit: 'physical_page',
      sections: [{ sectionId: 'page-1' }, { sectionId: 'page-2' }, { sectionId: 'page-3' }] } });
    expect(JSON.stringify(result)).toContain('预算为二百万元');
    expect(JSON.stringify(result)).toContain('计划为三百万元');
    expect(JSON.stringify(result)).not.toContain('陈旧');
    expect(JSON.stringify(result)).not.toContain(data.rootDirectory);
    const runtimes = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({ checkpoint: { step: 1, costUnits: contract.execution.budgetUnits },
      toolCalls: [{ id: 'read-call', toolId: contract.toolId, status: 'completed' }],
      observations: [{ ok: true, data: { totalPages: 3 } }] });
    expect(JSON.stringify(runtimes)).not.toContain('二百万元');
    const traces = await getProductionTraceStore(scope).list({ conversationId: data.conversation.id });
    expect(traces.some(trace => trace.code === 'tool_authorization' && trace.status === 'completed')).toBe(true);
    expect(traces.some(trace => trace.code === 'tool_call' && trace.status === 'started')).toBe(true);
    expect(traces.some(trace => trace.code === 'tool_result' && trace.status === 'completed')).toBe(true);
  });

  it('authorizes only the requested physical page and never treats it as an outline section', async () => {
    const data = await fixture();
    const { session, selection } = await data.session('请读取当前 PPT 的第 2 页内容。');
    expect(selection).toMatchObject({ scope: 'page', ordinal: 2 });
    await session.prepareTools(new AbortController().signal);
    for (const [index, args] of [{}, { scope: 'document' }, { scope: 'page', ordinal: 3 }, { scope: 'section', ordinal: 2 }].entries()) {
      const denied = await execute(session, args, `denied-${index}`);
      expect(denied).toMatchObject({ status: 'failed', diagnostics: [{ code: 'authorization_or_revision_invalid' }] });
      expect(JSON.stringify(denied)).not.toContain('万元');
    }
    const result = await execute(session, { scope: 'page', ordinal: 2 });
    expect(result).toMatchObject({ status: 'success', observation: { scope: 'page', ordinal: 2,
      page: { pageNumber: 2, totalPages: 3, hidden: true, text: '第二页独有事实：预算为二百万元' } } });
    expect(JSON.stringify(result)).not.toContain('三百万元');
    expect(JSON.stringify(result)).not.toContain('九百万元');
    expect(JSON.stringify(result)).not.toContain('partName');
  });

  it.each(['documentRef', 'documentId', 'currentDocumentId', 'revision', 'rootDirectory', 'relativePath', 'filePath', 'authorization'])(
    'rejects model-supplied runtime parameter %s before opening the adapter', async key => {
      const data = await fixture();
      const { session } = await data.session();
      await session.prepareTools(new AbortController().signal);
      const read = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
      const result = await execute(session, { [key]: 'forbidden' });
      expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'invalid_tool_arguments' }] });
      expect(read).not.toHaveBeenCalled();
    });

  it('refreshes available tools before requests and prevents execution after project revocation', async () => {
    const data = await fixture();
    const { session } = await data.session();
    expect(await session.prepareTools(new AbortController().signal)).toHaveLength(1);
    data.setCurrentProject(undefined);
    const read = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
    expect(await session.prepareTools(new AbortController().signal)).toBeUndefined();
    expect(await execute(session, {})).toMatchObject({ status: 'failed', diagnostics: [{ code: 'TOOL_PRECONDITION_FAILED' }] });
    expect(read).not.toHaveBeenCalled();
  });

  it('rechecks the file hash immediately before execution when bytes change after tools were advertised', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    await writeFile(data.first.absolutePath, 'tampered file');
    const result = await execute(session, {});
    expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'authorization_or_revision_invalid' }] });
    expect(JSON.stringify(result)).not.toContain('万元');
    expect(await session.prepareTools(new AbortController().signal)).toBeUndefined();
  });

  it('does not expose tools after the source message, file registration or conversation state changes', async () => {
    const data = await fixture();
    const firstSession = await data.session();
    await firstSession.session.prepareTools(new AbortController().signal);
    await data.files.save({ ...data.first.file, updatedAt: toIsoTimestamp('2026-09-27T12:00:01.000Z') });
    expect(await firstSession.session.prepareTools(new AbortController().signal)).toBeUndefined();
    await data.files.save(data.first.file);
    await data.save(archiveConversation(data.conversation, now));
    expect(await firstSession.session.prepareTools(new AbortController().signal)).toBeUndefined();
  });

  it('uses only a previously registered work in the same conversation and honors a known filename', async () => {
    const data = await fixture();
    const question = await data.question();
    const future = await data.register('另一个版本', ['不能读取的未来作品']);
    const selection = await data.service.select({ ...question, conversation: data.conversation });
    expect(selection!.workId).toBe(data.first.work.id);
    const latest = await data.service.select(await data.question());
    expect(latest!.workId).toBe(future.work.id);
    const explicit = await data.service.select(await data.question(`请读取 ${data.first.fileName} 的整篇内容。`));
    expect(explicit!.workId).toBe(data.first.work.id);
    const page = await data.service.select(await data.question(`请读取 ${data.first.fileName} 的第2页。`));
    expect(page!.bindingHash).not.toBe(explicit!.bindingHash);
  });

  it.each(['读取上一份PPT', '读取未知文件.pptx的内容', '读取 C:\\private\\source.pptx 第2页',
    'PPT 第2页和第3页是什么', 'PPT 第2到3页是什么', 'PPT 最后一页是什么', '读取附件第2页'])(
    'rejects an ambiguous, path-based or overbroad selection: %s', async query => {
      const data = await fixture();
      await expect(data.service.select(await data.question(query))).rejects.toMatchObject({ code: 'document_page_ambiguous' });
    });

  it.each(['你好', '删除当前 PPT 的第2页', '修改当前 PPT 的第2页标题'])(
    'keeps unrelated and mutation requests on their existing path: %s', async query => {
      const data = await fixture();
      expect(await data.service.select(await data.question(query))).toBeUndefined();
    });

  it.each(['新增一页 PPT', 'add a slide to the PPT', '在第二页后面加一页，标题叫市场机会'])(
    'routes controlled add-slide intent into the mutation path: %s', async query => {
      const data = await fixture();
      const service = new ConversationDocumentToolSessionService({ rootDirectory: data.rootDirectory, projectId,
        conversations: data.conversations, mutation: { renderPreview: async temporary => ({ previewCount: (await readFile(temporary)).length ? 1 : 0, diagnostics: [] }) } });
      services.push(service);
      const selection = await service.select(await data.question(query));
      expect(selection).toMatchObject({ kind: 'mutation', writeAuthorized: true });
    });

  it('creates an awaiting-user generation selection for a new PPT request', async () => {
    const data = await fixture();
    const selection = await data.service.select(await data.question('制作一份新的PPT'));
    expect(selection).toMatchObject({ kind: 'generation', authorizationStatus: 'awaiting_user' });
  });

  it('binds the Agent-native path to the latest registered PPT mutation tools', async () => {
    const data = await fixture();
    const service = new ConversationDocumentToolSessionService({
      rootDirectory: data.rootDirectory,
      projectId,
      conversations: data.conversations,
      mutation: { renderPreview: async temporary => ({ previewCount: (await readFile(temporary)).length ? 1 : 0, diagnostics: [] }) }
    });
    services.push(service);
    const request = await data.question('可以，继续处理刚才的 PPT');
    const message = request.conversation.messages.at(-1)!;
    const draft = createConversationResponseDraft({
      id: toConversationResponseDraftId('agent-native-mutation'),
      projectId,
      conversationId: request.conversation.id,
      conversationRevision: request.conversation.revision,
      userMessageId: message.id,
      userMessageRevision: message.revision,
      agentNative: true,
      productFeature: 'text_chat',
      createdAt: now
    });
    const selection = await service.prepare({ conversation: request.conversation, draft });
    expect(selection).toMatchObject({ kind: 'agent', mutation: { kind: 'mutation', writeAuthorized: true, workId: data.first.work.id } });
  });

  it('does not attach tools to an internal generation prompt or a different project', async () => {
    const data = await fixture();
    const request = await data.question();
    const message = request.conversation.messages.at(-1)!;
    const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('draft-read'), projectId,
      conversationId: request.conversation.id, conversationRevision: request.conversation.revision,
      userMessageId: message.id, userMessageRevision: message.revision, createdAt: now, productFeature: 'text_chat' });
    expect(await data.service.prepare({ conversation: request.conversation, draft })).toBeDefined();
    expect(await data.service.prepare({ conversation: request.conversation,
      draft: { ...draft, promptContent: 'Only return an Outline JSON document' } })).toBeUndefined();
    await expect(data.service.select({ ...request, conversation: { ...request.conversation, projectId: toProjectId('other-project') } }))
      .rejects.toMatchObject({ code: 'document_page_unavailable' });
  });

  it('accepts composed chat requirements only through an exact host-pinned draft', async () => {
    const data = await fixture();
    const request = await data.question();
    const selection = (await data.service.select(request))!;
    const message = request.conversation.messages.at(-1)!;
    const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('composed-chat-draft'), projectId,
      conversationId: request.conversation.id, conversationRevision: request.conversation.revision,
      userMessageId: message.id, userMessageRevision: message.revision, createdAt: now, productFeature: 'text_chat',
      attachmentQuery: request.query, promptContent: `${request.query}\n\n已确认参数：\n受众：管理层` });
    expect(await data.service.prepare({ conversation: data.conversation, draft })).toBeUndefined();
    await data.service.pinDraft({ draft, selection });
    expect(await data.service.prepare({ conversation: data.conversation, draft })).toBe(selection);
    await data.service.registerExecution({ selection, responseExecutionId: 'composed-chat-response' });
    // Orchestration may reread the subject after artifact creation.
    expect(await data.service.prepare({ conversation: data.conversation, draft })).toBe(selection);
    await (await data.service.forExecution({ responseExecutionId: 'composed-chat-response' }))!.close();
    expect(await data.service.prepare({ conversation: data.conversation, draft })).toBeUndefined();
  });

  it.each([
    { promptContent: 'Only return an Outline JSON document' },
    { attachmentQuery: '读取另一个PPT' },
    { documentPageQuery: '第3页' },
    { imageQuery: '读取附件图片' },
    { revision: 1 },
    { userMessageRevision: 1 },
    { parameterValues: { temperature: 0.5 } }
  ] satisfies Partial<ConversationResponseDraftV1>[])(
    'rejects a changed host-pinned draft without falling back to ordinary routing: %j', async changed => {
      const data = await fixture();
      const request = await data.question();
      const selection = (await data.service.select(request))!;
      const message = data.conversation.messages.at(-1)!;
      const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('pinned-draft'), projectId,
        conversationId: request.conversation.id, conversationRevision: request.conversation.revision,
        userMessageId: message.id, userMessageRevision: message.revision, createdAt: now, productFeature: 'text_chat',
        attachmentQuery: request.query, promptContent: `${request.query}\n\n已确认参数：\n受众：管理层` });
      await data.service.pinDraft({ draft, selection });
      await expect(data.service.prepare({ conversation: data.conversation, draft: { ...draft, ...changed } }))
        .rejects.toMatchObject({ code: 'document_page_unavailable' });
    });

  it('rejects a host-pinned draft after its document source changes', async () => {
    const data = await fixture();
    const request = await data.question();
    const selection = (await data.service.select(request))!;
    const message = data.conversation.messages.at(-1)!;
    const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('source-bound-draft'), projectId,
      conversationId: request.conversation.id, conversationRevision: request.conversation.revision,
      userMessageId: message.id, userMessageRevision: message.revision, createdAt: now, productFeature: 'text_chat',
      promptContent: `${request.query}\n\n已确认参数：\n受众：管理层` });
    await data.service.pinDraft({ draft, selection });
    const source = data.conversation.messages.find(item => item.id === data.first.messageId)!;
    await data.save(attachDocumentResultToMessage(data.conversation, source.id, source.documentResult!, now));
    await expect(data.service.prepare({ conversation: data.conversation, draft })).rejects.toMatchObject({ code: 'document_page_unavailable' });
  });

  it('requires a host-issued selection and isolates sessions and execution lookup', async () => {
    const data = await fixture();
    const selection = (await data.service.select(await data.question()))!;
    await expect(data.service.createSession({ selection: { ...selection }, responseExecutionId: 'forged' })).rejects.toMatchObject({ code: 'document_page_unavailable' });
    await data.service.registerExecution({ selection, responseExecutionId: 'response-bound' });
    expect(await data.service.forExecution({ responseExecutionId: 'missing' })).toBeUndefined();
    const first = (await data.service.forExecution({ responseExecutionId: 'response-bound' }))!;
    await expect(data.service.registerExecution({ selection, responseExecutionId: 'response-bound' })).rejects.toMatchObject({ code: 'document_page_unavailable' });
    await first.prepareTools(new AbortController().signal);
    const selectedPage = (await data.service.select(await data.question('读取当前PPT的第2页')))!;
    const second = await data.service.createSession({ selection: selectedPage, responseExecutionId: 'response-other' });
    sessions.push(second);
    await second.prepareTools(new AbortController().signal);
    expect(await execute(first, {})).toMatchObject({ status: 'success', observation: { scope: 'document' } });
    expect(await execute(second, {})).toMatchObject({ status: 'failed' });
    await first.close();
    expect(await data.service.forExecution({ responseExecutionId: 'response-bound' })).toBeUndefined();
    await expect(first.prepareTools(new AbortController().signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('aborts a pending session factory on shutdown without waiting for the task deadline', async () => {
    const data = await fixture();
    const selection = (await data.service.select(await data.question()))!;
    const create = vi.spyOn(data.service, 'createSession').mockImplementation(() => new Promise(() => undefined));
    const registration = data.service.registerExecution({ selection, responseExecutionId: 'shutdown-pending-factory' });
    const stopped = expect(registration).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await data.service.dispose();
    await stopped;
    expect(await data.service.forExecution({ responseExecutionId: 'shutdown-pending-factory' })).toBeUndefined();
  });

  it('supports cancellation and never starts a read after a cancelled request', async () => {
    const data = await fixture();
    const { session } = await data.session();
    const controller = new AbortController();
    controller.abort();
    const reader = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
    expect(await session.prepareTools(controller.signal)).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
    expect(await session.bridge.execute({ call: { id: 'cancelled', name: contract.toolId, arguments: {} }, signal: controller.signal }))
      .toMatchObject({ status: 'cancelled' });
  });

  it('redacts paths and credential-like text from real document observations without leaking runtime fields', async () => {
    const data = await fixture(['封面', '资料位置 C:\\private\\sensitive.pptx api_key=do-not-send', '正常计划']);
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    const safe = sanitizeControlledToolResult(await execute(session, {}));
    expect(safe).toMatchObject({ status: 'success' });
    const encoded = JSON.stringify(safe);
    expect(encoded).toContain('[redacted]');
    expect(encoded).not.toMatch(/private|sensitive\.pptx|do-not-send|currentDocumentIR|currentDocumentId|rootDirectory|relativePath|authorization/);
  });

  it('fails closed for an unrepresentable full document instead of silently truncating, but can read one physical page', async () => {
    const data = await fixture(Array.from({ length: 81 }, (_, i) => `第${i + 1}页真实文字`));
    const full = await data.session();
    expect(await full.session.prepareTools(new AbortController().signal)).toBeUndefined();
    const page = await data.session('请读取当前PPT第81页');
    await page.session.prepareTools(new AbortController().signal);
    expect(await execute(page.session, { scope: 'page', ordinal: 81 })).toMatchObject({ status: 'success',
      observation: { page: { pageNumber: 81, totalPages: 81, text: '第81页真实文字' } } });
  });

  it('does not modify the source PPT or register a new work', async () => {
    const data = await fixture();
    const before = await readFile(data.first.absolutePath);
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    await execute(session, {});
    await session.close();
    expect(await readFile(data.first.absolutePath)).toEqual(before);
    expect(await data.works.list(projectId)).toHaveLength(1);
  });

  it('returns the bounded tool result without an additional unbounded checkpoint read', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    const get = JsonDocumentTaskRuntimeRepository.prototype.get;
    let reads = 0;
    const read = vi.spyOn(JsonDocumentTaskRuntimeRepository.prototype, 'get').mockImplementation(function (this: JsonDocumentTaskRuntimeRepository, id) {
      if (++reads > 2) return new Promise(() => undefined);
      return get.call(this, id);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([execute(session, {}), new Promise(resolve => {
        timeout = setTimeout(() => resolve({ status: 'unbounded_read' }), 1_000);
      })]);
      expect(result).toMatchObject({ status: 'success' });
      expect(read).toHaveBeenCalledTimes(2);
    } finally { clearTimeout(timeout); read.mockRestore(); }
  });

  it.each(['project', 'registration', 'bytes'] as const)(
    'blocks subsequent provider requests carrying a successful observation after %s revocation', async change => {
      const data = await fixture();
      const { session } = await data.session();
      await session.prepareTools(new AbortController().signal);
      expect(await execute(session, {})).toMatchObject({ status: 'success' });
      if (change === 'project') data.setCurrentProject(undefined);
      else if (change === 'registration') await data.files.save({ ...data.first.file, state: 'missing' });
      else await writeFile(data.first.absolutePath, 'bytes no longer match the authorized document');
      const request = vi.fn();
      await expect((async () => {
        await session.prepareTools(new AbortController().signal);
        request();
      })()).rejects.toMatchObject({ code: 'document_page_unavailable' });
      expect(request).not.toHaveBeenCalled();
      expect(await execute(session, {}, 'after-revocation')).toMatchObject({ status: 'cancelled' });
    });

  it('does not upgrade a page binding after one successful read or after the source request is edited', async () => {
    const data = await fixture();
    const { session, selection } = await data.session('请读取当前PPT的第2页');
    await session.prepareTools(new AbortController().signal);
    const first = await execute(session, { scope: 'page', ordinal: 2 });
    expect(first).toMatchObject({ status: 'success' });
    expect(await execute(session, { scope: 'document' }, 'upgrade')).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(first)).not.toContain('三百万元');
    await data.save({ ...data.conversation, revision: data.conversation.revision + 1,
      messages: data.conversation.messages.map(message => message.id === selection.currentUserMessageId && message.state === 'completed' && message.role === 'user'
        ? { ...message, content: '请读取当前PPT整篇文档', revision: message.revision + 1 } : message) });
    await expect(session.prepareTools(new AbortController().signal)).rejects.toMatchObject({ code: 'document_page_unavailable' });
  });

  it('stops safely on cancellation after an observation was returned', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    expect(await execute(session, {})).toMatchObject({ status: 'success' });
    const controller = new AbortController();
    controller.abort();
    await expect(session.prepareTools(controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled' });
  });

  it('cancels a hanging preparation reader and ignores a late successful refresh', async () => {
    const data = await fixture();
    const { session } = await data.session();
    await session.prepareTools(new AbortController().signal);
    expect(await execute(session, {})).toMatchObject({ status: 'success' });
    const verified = await new RegisteredPresentationReader({ rootDirectory: data.rootDirectory, projectId }).read(data.first.work.id);
    let finish: (value: typeof verified) => void = () => undefined;
    const reader = vi.spyOn(RegisteredPresentationReader.prototype, 'read').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = session.prepareTools(controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
    controller.abort();
    await cancelled;
    finish(verified);
    await Promise.resolve();
    await Promise.resolve();
    await expect(session.prepareTools(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await execute(session, {}, 'late-refresh')).toMatchObject({ status: 'cancelled' });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging preparation repository before the reader starts and ignores late completion', async () => {
    const data = await fixture();
    const { session } = await data.session();
    vi.useFakeTimers();
    let finish: (value: Conversation) => void = () => undefined;
    vi.spyOn(data.conversations, 'get').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.spyOn(JsonWorkRepository.prototype, 'get').mockResolvedValue(data.first.work);
    vi.spyOn(JsonFileReferenceRepository.prototype, 'get').mockResolvedValue(data.first.file);
    const reader = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
    const pending = session.prepareTools(new AbortController().signal);
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'timeout', scope: 'prepare' });
    await vi.advanceTimersByTimeAsync(contract.execution.timeoutMs + 1);
    await timedOut;
    finish(data.conversation);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader).not.toHaveBeenCalled();
    expect(await session.prepareTools(new AbortController().signal)).toBeUndefined();
    expect(await execute(session, {}, 'late-repository')).toMatchObject({ status: 'cancelled' });
  });
});
