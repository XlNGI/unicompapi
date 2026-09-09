import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationIntentOrchestrator, ConversationWorkflowService, DocumentGenerationApplicationService, ConversationStreamingService } from '../../src/application';
import { runLocalDocumentRevisionAgent } from '../../src/application/document-revision-agent';
import { mappedPresentationTarget } from '../../src/application/presentation-revision-map';
import { addUserMessage, createConversation, toConversationId, toMessageId, toProjectId, toIsoTimestamp, type DocumentOutline } from '../../src/domain';
import { NodeProjectStorage } from '../../src/platform/storage';
import { JsonProjectConversationRepository, JsonConversationWorkflowRepository, JsonConversationResponseExecutionRepository } from '../../src/platform/repositories';
import { JsonWorkRepository, JsonExecutionRepository, JsonTaskRepository } from '../../src/platform/repositories/json-repositories';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { readPptxDocument, readPptxPage } from '../../src/platform/documents/pptx-page-reader';
import { RegisteredPresentationReader, buildPresentationRevisionMap, createPresentationWorkflowScope } from '../../src/platform/documents/registered-presentation-reader';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import { createDocumentWorkflowSettlement } from '../../src/platform/documents/conversation-document-workflow';
import { ConversationDocumentInputStore } from '../../src/platform/documents/conversation-document-inputs';
import { applyStructuredDocumentPatch, readStructuredDocument } from '../../src/platform/documents/structured-document-tools';
import { toWorkflowDto } from '../../src/platform/ipc/conversation-workflow-controller';
import { documentGenerationRequestParsers } from '../../src/shared/document-generation-ipc';
import { createChatContextRuntime } from '../../src/platform/ipc/chat-context-runtime';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const now = () => '2026-09-09T12:00:00.000Z';
const baseOutline: DocumentOutline = { kind: 'ppt', title: '十三页章节验收', sections: Array.from({ length: 8 }, (_, index) => ({
  heading: `第${index + 1}章标题`, level: 1, blocks: [{ type: 'paragraph', text: `第${index + 1}章正文` }]
})) };

async function fixture(reorder = false) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-revision-map-')); roots.push(rootDirectory);
  const projectId = toProjectId('project-revision-map');
  const storage = new NodeProjectStorage(rootDirectory);
  const presentation = new PptxGenJS();
  const sections = [-1, 0, 1, 1, 2, 2, 3, 4, 5, 6, 6, 7, -2];
  sections.forEach((section, index) => {
    const slide = presentation.addSlide();
    const heading = section === -1 ? baseOutline.title : section === -2 ? '谢谢' : baseOutline.sections[section].heading;
    slide.addText(index === 10 ? `${heading}（续2）` : heading, { x: 1, y: 0.4, w: 8, h: 0.5 });
    if (section >= 0) slide.addText(`实际第${index + 1}页独有正文`, { x: 1, y: 2, w: 8, h: 1 });
    if (index === 10) slide.addText('11', { x: 1, y: 4, w: 1, h: 0.5 });
  });
  let bytes = await presentation.write({ outputType: 'nodebuffer' }) as Buffer;
  if (reorder) {
    const zip = await JSZip.loadAsync(bytes);
    const name = 'ppt/_rels/presentation.xml.rels';
    const xml = await zip.file(name)!.async('string');
    zip.file(name, xml.replace('slides/slide7.xml', 'slides/swap.xml').replace('slides/slide8.xml', 'slides/slide7.xml').replace('slides/swap.xml', 'slides/slide8.xml'));
    bytes = await zip.generateAsync({ type: 'nodebuffer' });
  }
  const generator = vi.fn(async (input: Parameters<typeof generateTemporaryDocumentFile>[0]) => {
    const result = await generateTemporaryDocumentFile(input);
    if (!input.revisionSourceBuffer) {
      await writeFile(result.temporaryPath, bytes);
      return { ...result, sizeBytes: bytes.length };
    }
    return result;
  });
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId, now, generateTemporaryFile: generator });
  const base = await runner.run({ kind: 'ppt', title: baseOutline.title, outline: baseOutline,
    contentFingerprint: hash(bytes), draftRevision: 1, sourceDraftId: 'base-presentation' });
  const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
  return { rootDirectory, projectId, storage, runner, base, reader, generator, bytes };
}

async function clear(f: Awaited<ReturnType<typeof fixture>>, unit: 'page' | 'section', ordinal: number, work = f.base.work, outline = baseOutline) {
  const source = await f.reader.read(work.id, outline);
  const target = mappedPresentationTarget(source.map!, { unit, ordinal });
  const next = { ...outline, sections: outline.sections.map((section, index) => index === target.sectionIndex ? { ...section, blocks: [] } : section) };
  return f.runner.run({ kind: 'ppt', title: next.title, outline: next,
    contentFingerprint: hash(`${work.id}:${unit}:${ordinal}`), draftRevision: 1, sourceDraftId: `${work.id}-${unit}-${ordinal}`,
    parentWorkId: work.id, sourceChecksumSha256: source.map!.checksumSha256,
    revisionPatch: { operation: 'clear_section', target } });
}

async function assertOnlySlidesChanged(before: Uint8Array, after: Uint8Array, allowed: readonly string[]) {
  const a = await JSZip.loadAsync(before); const b = await JSZip.loadAsync(after);
  expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
  for (const name of Object.keys(a.files)) {
    if (a.files[name].dir) continue;
    const same = (await a.file(name)!.async('nodebuffer')).equals(await b.file(name)!.async('nodebuffer'));
    expect(same, name).toBe(!allowed.includes(name));
  }
}

async function conversationFixture(request = '将第7章内容清空') {
  const f = await fixture();
  const conversationId = toConversationId('conversation-revision-map');
  const conversations = new JsonProjectConversationRepository(f.storage, f.projectId, now);
  await conversations.create(createConversation({ id: conversationId, projectId: f.projectId, title: '保存回归', createdAt: toIsoTimestamp(now()) }));
  let messageSequence = 0;
  const streaming = new ConversationStreamingService(conversations, {
    nextConversationId: () => conversationId, nextMessageId: () => toMessageId(`revision-message-${++messageSequence}`)
  }, now);
  const appendAssistant = async (content: string) => streaming.createCompletedLocalAssistantMessage({
    conversationId, expectedRevision: (await conversations.get(conversationId))!.revision, content
  });
  const parent = await appendAssistant(JSON.stringify(baseOutline));
  await streaming.attachDocumentResult({ conversationId, messageId: parent.messageId,
    expectedRevision: (await conversations.get(conversationId))!.revision,
    documentResult: { kind: 'ppt', workId: f.base.work.id, fileName: '十三页章节验收.pptx', sizeBytes: f.base.file.sizeBytes!, validatedContent: JSON.stringify(baseOutline) }
  });
  const appendUser = async (content: string) => {
    const conversation = (await conversations.get(conversationId))!;
    const id = toMessageId(`revision-message-${++messageSequence}`);
    await conversations.save(addUserMessage(conversation, { id, content, createdAt: toIsoTimestamp(now()) }), conversation.revision);
    return id;
  };
  await appendUser('第7页是什么内容？');
  await appendAssistant('第7页是第4章标题。');
  const sourceMessageId = await appendUser(request);
  const scope = createPresentationWorkflowScope(f);
  const workflows = new ConversationWorkflowService(new JsonConversationWorkflowRepository(f.storage, f.projectId, now),
    new ConversationIntentOrchestrator(), now, undefined, undefined, scope);
  const workflow = await workflows.create({ projectId: f.projectId, conversationId, sourceMessageId, rawText: request,
    context: { documents: [{ messageId: parent.messageId, kind: 'ppt', fileName: '十三页章节验收.pptx' }] } });
  const attachResult = vi.fn(async (input: Parameters<typeof streaming.attachDocumentResult>[0]) => { await streaming.attachDocumentResult(input); });
  const makeApplication = () => new DocumentGenerationApplicationService({
    projectId: f.projectId,
    conversations: { load: (id) => conversations.get(id), createCompletedLocalAssistantMessage: (input) => streaming.createCompletedLocalAssistantMessage(input),
      attachDocumentResult: attachResult, updateDocumentGenerationStatus: async (input) => { await streaming.updateDocumentGenerationStatus(input); } },
    workflows: { load: (id) => workflows.get(id), beginExecution: async (input) => { await workflows.beginExecution(input); },
      bindDocumentMessage: (executionId, messageId) => workflows.bindDocumentMessage(executionId, messageId),
      finishExecution: async (id, status) => { await workflows.finishExecution(id, status); },
      settleDocumentResult: createDocumentWorkflowSettlement({ workflows, conversations, executions: new JsonConversationResponseExecutionRepository(f.storage, f.projectId) }) },
    compiler: new PlatformDocumentDraftCompiler(), generator: new PlatformDocumentGenerationExecutor(f.runner),
    resolvePresentationMap: async (workId, outline) => (await f.reader.read(workId, outline)).map!,
    validatePresentationSelection: scope.validatePresentationSelection, canRetryMessage: scope.canRetryMessage,
    generationInputs: new ConversationDocumentInputStore(f.storage, f.projectId), fingerprint: hash,
    revisionAgent: (input) => runLocalDocumentRevisionAgent(input, { readStructure: readStructuredDocument,
      applyPatch: (outline, patch) => { const result = applyStructuredDocumentPatch(outline, patch); return {
        document: result.document, changed: result.change.changed, affectedSections: result.change.affectedSections
      }; } })
  });
  const prepare = async () => {
    const confirmed = await workflows.confirm({ workflowId: workflow.id, expectedRevision: workflow.revision });
    const app = makeApplication();
    const prepared = await app.prepareDeterministicRevision({ conversationId, expectedRevision: (await conversations.get(conversationId))!.revision,
      workflowId: confirmed.id, expectedWorkflowRevision: confirmed.revision, kind: 'ppt', parentWorkId: f.base.work.id });
    return { app, input: { ...prepared, kind: 'ppt' as const, parentWorkId: f.base.work.id, images: [] } };
  };
  return { ...f, conversations, conversationId, workflows, workflow, scope, prepare, makeApplication, attachResult };
}

describe('registered PPT revision and save recovery', () => {
  it('confirms chapter seven as pages ten to eleven after page-seven QA and saves through the real application', async () => {
    const f = await conversationFixture();
    expect(f.workflow).toMatchObject({ status: 'needs_confirmation', resolvedTarget: { presentation: {
      unit: 'section', ordinal: 7, pages: [10, 11], heading: '第7章标题', checksumSha256: hash(f.bytes)
    } } });
    expect(JSON.stringify(toWorkflowDto(f.workflow))).not.toContain('checksumSha256');
    expect(() => documentGenerationRequestParsers.generateFromMessage({ conversationId: f.conversationId, expectedRevision: 0,
      messageId: 'fake', kind: 'ppt', sourceChecksumSha256: hash(f.bytes) })).toThrow();
    const { app, input } = await f.prepare();
    const result = await app.generateFromMessage(input);
    expect((await f.workflows.get(f.workflow.id))?.status).toBe('completed');
    const reopened = await new JsonProjectConversationRepository(f.storage, f.projectId).get(f.conversationId);
    expect(reopened?.messages.find((message) => message.id === input.messageId)?.documentResult?.workId).toBe(result.workId);
    const child = await f.reader.read(result.workId);
    await assertOnlySlidesChanged(f.bytes, child.buffer, ['ppt/slides/slide10.xml', 'ppt/slides/slide11.xml']);
  });

  it('rejects a changed version between confirmation and generation before creating another file', async () => {
    const f = await conversationFixture(); const { app, input } = await f.prepare();
    const changedMap = { ...(await f.reader.read(f.base.work.id, baseOutline)).map!, checksumSha256: '0'.repeat(64) };
    await expect(f.scope.validatePresentationSelection(input, changedMap, { unit: 'section', ordinal: 7 })).rejects.toMatchObject({ code: 'revision_scope_violation' });
    const originalRead = f.reader.read.bind(f.reader);
    vi.spyOn(f.reader, 'read').mockImplementation(async (workId, outline) => ({ ...await originalRead(workId, outline), map: changedMap }));
    await expect(app.generateFromMessage(input)).rejects.toMatchObject({ code: 'revision_scope_violation' });
    expect(f.generator).toHaveBeenCalledTimes(1);
    const failed = (await f.workflows.get(f.workflow.id))!;
    expect(failed.deliveries?.[0].failureReason).toBe('input_required');
    await expect(f.workflows.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision })).rejects.toMatchObject({ code: 'workflow_not_ready' });
    await expect(f.makeApplication().generateFromMessage(input)).rejects.toMatchObject({ code: 'revision_scope_violation' });
    expect(f.generator).toHaveBeenCalledTimes(1);
  });

  it('recovers result synchronization after reopening without a duplicate document or paid generation', async () => {
    const f = await conversationFixture(); const { app, input } = await f.prepare();
    f.attachResult.mockRejectedValueOnce(new Error('conversation storage temporarily unavailable'));
    await expect(app.generateFromMessage(input)).rejects.toMatchObject({ code: 'result_sync_pending' });
    const failed = (await f.workflows.get(f.workflow.id))!;
    const status = (await new JsonProjectConversationRepository(f.storage, f.projectId).get(f.conversationId))!.messages.find((message) => message.id === input.messageId)?.documentGenerationStatus;
    expect(status).toMatchObject({ state: 'failed', errorCode: 'result_sync_pending' });
    const before = await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId);
    expect(before).toHaveLength(2);
    await f.workflows.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision });
    const result = await f.makeApplication().generateFromMessage(input);
    expect(before.map((work) => work.id)).toContain(result.workId);
    expect(f.generator).toHaveBeenCalledTimes(2);
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(2);
    expect((await f.workflows.get(f.workflow.id))?.status).toBe('completed');
  });

  it('restores the saved-result retry after both conversation attachment and workflow settlement were interrupted', async () => {
    const f = await conversationFixture(); const { app, input } = await f.prepare();
    f.attachResult.mockRejectedValueOnce(new Error('conversation temporarily unavailable'));
    const finish = vi.spyOn(f.workflows, 'finishDocumentExecution').mockRejectedValueOnce(new Error('workflow temporarily unavailable'));
    await expect(app.generateFromMessage(input)).rejects.toMatchObject({ code: 'result_sync_pending' });
    expect((await f.workflows.get(f.workflow.id))?.status).toBe('executing');
    finish.mockRestore();
    const runtime = createChatContextRuntime({
      getSession: () => ({ projectId: f.projectId, projectName: '保存回归', rootDirectory: f.rootDirectory }),
      userDataDirectory: path.join(f.rootDirectory, 'user-data'), now
    });
    const pending = await runtime.workflows.getPending({ conversationId: f.conversationId });
    expect(pending).toMatchObject({ ok: true, value: { status: 'failed', deliveries: [{ failureReason: 'execution_failed' }] } });
    const failed = (await f.workflows.get(f.workflow.id))!;
    await f.workflows.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision });
    await f.makeApplication().generateFromMessage(input);
    expect(f.generator).toHaveBeenCalledTimes(2);
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(2);
  });

  it('rejects a changed file at the confirmation boundary', async () => {
    const f = await conversationFixture();
    const filePath = path.join(f.rootDirectory, f.base.file.locator.kind === 'project' ? f.base.file.locator.relativePath : '');
    await writeFile(filePath, Buffer.concat([f.bytes, Buffer.from('changed')]));
    await expect(f.workflows.confirm({ workflowId: f.workflow.id, expectedRevision: f.workflow.revision })).rejects.toMatchObject({ code: 'document_page_ambiguous' });
    expect(f.generator).toHaveBeenCalledTimes(1);
  });

  it('clears numeric body content equal to the page number instead of mistaking it for a footer', async () => {
    const f = await fixture(); const result = await clear(f, 'page', 11);
    const child = await f.reader.read(result.work.id);
    expect(child.pages[10].contentText.trim()).toBe('第7章标题（续2）');
    expect(result.validatedOutline?.sections[6].blocks).toEqual([{ type: 'paragraph', text: '实际第10页独有正文' }]);
  });

  it('maps chapter seven to slides ten and eleven and changes only those XML parts', async () => {
    const f = await fixture(); const source = await f.reader.read(f.base.work.id, baseOutline);
    expect(source.map?.totalPages).toBe(13);
    expect(mappedPresentationTarget(source.map!, { unit: 'section', ordinal: 7 }).pages).toEqual([10, 11]);
    expect((await readPptxPage(source.buffer, 7)).text).toContain('第4章标题');
    const result = await clear(f, 'section', 7);
    const child = await f.reader.read(result.work.id, result.validatedOutline);
    expect(child.pages[9].contentText.trim()).toBe('第7章标题');
    expect(child.pages[10].contentText.trim()).toBe('第7章标题（续2）');
    expect(result.validatedOutline?.sections[6].blocks).toEqual([]);
    expect(result.work.parentWorkId).toBe(f.base.work.id);
    await assertOnlySlidesChanged(source.buffer, child.buffer, ['ppt/slides/slide10.xml', 'ppt/slides/slide11.xml']);
    expect(hash((await f.reader.read(f.base.work.id)).buffer)).toBe(hash(source.buffer));
  });

  it('changes the actual seventh page after reordering without changing slide7.xml', async () => {
    const f = await fixture(true); const source = await f.reader.read(f.base.work.id, baseOutline);
    expect(source.pages[6]).toMatchObject({ partName: 'ppt/slides/slide8.xml', heading: '第5章标题' });
    const result = await clear(f, 'page', 7); const child = await f.reader.read(result.work.id);
    await assertOnlySlidesChanged(source.buffer, child.buffer, ['ppt/slides/slide8.xml']);
  });

  it('retains the unedited continuation and numeric body text in the next revision metadata', async () => {
    const f = await fixture(); const first = await clear(f, 'page', 10);
    expect(first.validatedOutline?.sections[6].blocks).toEqual([
      { type: 'paragraph', text: '实际第11页独有正文' }, { type: 'paragraph', text: '11' }
    ]);
    const second = await clear(f, 'section', 7, first.work, first.validatedOutline!);
    expect(second.validatedOutline?.sections[6].blocks).toEqual([]);
    expect(second.work.parentWorkId).toBe(first.work.id);
  });

  it('rejects ambiguous chapter headings and noncontiguous chapter pages', async () => {
    const f = await fixture(); const pages = await readPptxDocument(f.bytes);
    expect(() => buildPresentationRevisionMap(pages, { ...baseOutline, sections: [baseOutline.sections[0], baseOutline.sections[0]] }, hash(f.bytes))).toThrow();
    const changed = pages.map((page) => page.pageNumber === 8 ? { ...page, heading: baseOutline.sections[0].heading } : page);
    expect(() => buildPresentationRevisionMap(changed, baseOutline, hash(f.bytes))).toThrow();
  });

  it('refuses a changed registered file before generating a child Work', async () => {
    const f = await fixture();
    const filePath = path.join(f.rootDirectory, f.base.file.locator.kind === 'project' ? f.base.file.locator.relativePath : '');
    await writeFile(filePath, Buffer.concat([f.bytes, Buffer.from('changed')]));
    await expect(clear(f, 'section', 7)).rejects.toMatchObject({ code: 'revision_scope_violation' });
    expect(f.generator).toHaveBeenCalledTimes(1);
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });

  it.each(['write', 'registration'] as const)('records a recoverable %s failure and preserves the original Work', async (stage) => {
    const f = await fixture();
    const input = { kind: 'ppt' as const, title: baseOutline.title, outline: baseOutline, contentFingerprint: hash(stage), draftRevision: 1, sourceDraftId: `failure-${stage}` };
    const options = { rootDirectory: f.rootDirectory, projectId: f.projectId, now,
      ...(stage === 'write' ? { publishFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } : {}) };
    const saved = JsonWorkRepository.prototype.save;
    if (stage === 'registration') vi.spyOn(JsonWorkRepository.prototype, 'save').mockImplementationOnce(async () => { throw new Error('registration failure'); });
    await expect(new DocumentGenerationRunner(options).run(input)).rejects.toMatchObject({ code: stage === 'write' ? 'write_failed' : 'registration_failed' });
    vi.restoreAllMocks();
    expect(JsonWorkRepository.prototype.save).toBe(saved);
    const tasks = await new JsonTaskRepository(f.storage, f.projectId).list(f.projectId);
    const task = tasks.find((item) => item.sourceDraftId === input.sourceDraftId)!;
    expect((await new JsonExecutionRepository(f.storage).list(task.id))[0].failure?.retryability).toBe('retryable');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
    expect((await new DocumentGenerationRunner({ rootDirectory: f.rootDirectory, projectId: f.projectId, now }).run(input)).execution.state).toBe('completed');
  });
});
