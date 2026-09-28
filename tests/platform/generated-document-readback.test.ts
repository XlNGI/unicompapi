import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addUserMessage, archiveConversation, createProjectConversation, toConversationId, toIsoTimestamp,
  toMessageId, toProjectId, type Conversation, type ProjectId } from '../../src/domain';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';
import { createCanonicalToolRegistry } from '../../src/domain/entities/canonical-tool-contract';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import { ConversationDocumentToolSessionService, type ConversationDocumentToolSession } from '../../src/platform/documents/conversation-document-tool-session';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { JsonFileReferenceRepository, JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];
const sessions: ConversationDocumentToolSession[] = [];
const services: ConversationDocumentToolSessionService[] = [];
const projectId = toProjectId('generated-file-session');
const now = toIsoTimestamp('2026-09-28T12:00:00.000Z');
const args = { title: '真实读回测试', content: '# 真实读回测试\n\n## 第一事实\n\nPHYSICAL-PAGE-ONE\n\n## 第二事实\n\nPHYSICAL-PAGE-TWO',
  presentationTemplate: 'business_minimal' };
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  await Promise.allSettled(services.splice(0).map(service => service.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
});

async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-generated-readback-'));
  roots.push(rootDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const works = new JsonWorkRepository(storage, projectId);
  let conversation: Conversation = createProjectConversation({ id: toConversationId('generated-readback-conversation'),
    projectId, title: '真实文件读回', createdAt: now });
  await conversations.create(conversation);
  conversation = addUserMessage(conversation, { id: toMessageId('approved-generation'),
    content: '直接生成一个简单 PPT，然后读取刚生成的真实文档。', createdAt: now });
  await conversations.save(conversation, 0);
  let activeProject: ProjectId | undefined = projectId;
  const executor = new PlatformDocumentGenerationExecutor(new DocumentGenerationRunner({ rootDirectory, projectId,
    requireRenderForPpt: true, renderPreview: async target => ({ previewCount: (await readPptxDocument(await readFile(target))).length, diagnostics: [] }) }));
  const run = vi.spyOn(executor, 'run');
  const begin = vi.spyOn(DocumentTaskRuntimeService.prototype, 'beginToolCall');
  const reader = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
  const service = new ConversationDocumentToolSessionService({ rootDirectory, projectId, conversations,
    getCurrentProjectId: () => activeProject, generatePptx: { compiler: new PlatformDocumentDraftCompiler(), executor,
      revalidateAuthorization: async () => activeProject === projectId } });
  services.push(service);
  const selection = await service.select({ conversation, currentUserMessageId: conversation.messages[0].id, query: conversation.messages[0].content });
  if (!selection) throw new Error('Missing generation selection');
  const session = await service.createSession({ selection, responseExecutionId: 'generated-file-read-response' });
  sessions.push(session);
  const signal = new AbortController().signal;
  async function generate() {
    expect((await session.prepareTools(signal))?.map(tool => tool.function.name)).toEqual(['generate_pptx']);
    const result = await session.bridge.execute({ call: { id: 'generate-one', name: 'generate_pptx', arguments: args }, signal });
    expect(result).toMatchObject({ status: 'success', observation: { generated: true } });
    const [work] = await works.list(projectId);
    expect(work).toBeDefined();
    const file = (await files.get(work.fileId))!;
    if (file.locator.kind !== 'project') throw new Error('Expected local file');
    return { result, work, file, absolutePath: path.join(rootDirectory, file.locator.relativePath) };
  }
  async function read(arguments_: Record<string, unknown> = { scope: 'document' }, id = 'read-one') {
    return session.bridge.execute({ call: { id, name: 'read_document_structure', arguments: arguments_ }, signal });
  }
  async function revokeConversation() {
    const next = archiveConversation(conversation, now);
    await conversations.save(next, conversation.revision);
    conversation = next;
  }
  return { rootDirectory, session, signal, generate, read, works, files, reader, run, begin, revokeConversation,
    setCurrentProject(value: ProjectId | undefined) { activeProject = value; } };
}

describe('generated registered PPT physical-file readback', () => {
  it('rebinds one real Work and stable file revision, reads cover/closing and then the physical second page', async () => {
    const data = await fixture();
    const { work, file, absolutePath } = await data.generate();
    const pages = await readPptxDocument(await readFile(absolutePath));
    const revision = Number.parseInt(createHash('sha256').update(JSON.stringify([work.id, file.id, work.sourceExecutionId,
      file.checksumSha256, file.updatedAt])).digest('hex').slice(0, 12), 16);
    expect((await data.session.prepareTools(data.signal))?.map(tool => tool.function.name)).toEqual(['read_document_structure']);
    expect(pages.length).toBeGreaterThan(data.run.mock.calls[0][0].outline.sections.length);
    const result = await data.read();
    expect(result).toMatchObject({ status: 'success', observation: { revision, pageCount: pages.length, totalSections: pages.length, structureUnit: 'physical_page' } });
    const observation = result.observation as { sections: { blocks: { text: string }[] }[] };
    expect(observation.sections.map(section => section.blocks.map(block => block.text).join(''))).toEqual(pages.map(page => page.contentText.trim()));
    expect(JSON.stringify(result)).toContain('谢谢观看');
    const context = data.begin.mock.calls.find(call => call[1].toolId === 'read_document_structure')![2]!;
    expect(context).toMatchObject({ currentDocumentId: work.id, revision, operation: 'create',
      projectContext: { projectId, workId: work.id }, currentDocumentIR: { documentRef: work.id,
        revision: { baseWorkId: work.id, expectedRevision: revision }, content: { pageCount: pages.length } } });
    expect(context.taskContext.taskId).toBe(data.begin.mock.calls[0][2]!.taskContext.taskId);
    expect(revision).not.toBe(data.run.mock.calls[0][0].draftRevision);
    expect(data.reader.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(data.reader.mock.calls.every(call => call[0] === work.id)).toBe(true);
    await expect(data.read({ scope: 'page', ordinal: 2 }, 'page-two')).resolves.toMatchObject({ status: 'success', observation: { revision,
      page: { pageNumber: 2, totalPages: pages.length, text: pages[1].contentText } } });
    await expect(data.read({ scope: 'section', ordinal: 1 }, 'unsupported-section')).resolves.toMatchObject({ status: 'failed' });
    expect(JSON.stringify(result)).not.toContain(data.rootDirectory);
  });

  it.each(['metadata', 'bytes', 'project', 'conversation'] as const)('removes read access when %s changes without allowing regeneration', async kind => {
    const data = await fixture();
    const { file, absolutePath } = await data.generate();
    await data.session.prepareTools(data.signal);
    if (kind === 'metadata') await data.files.save({ ...file, state: 'missing' });
    if (kind === 'bytes') await writeFile(absolutePath, Buffer.from('tampered registered file'));
    if (kind === 'project') data.setCurrentProject(toProjectId('another-project'));
    if (kind === 'conversation') await data.revokeConversation();
    expect(await data.session.prepareTools(data.signal)).toBeUndefined();
    await expect(data.read()).resolves.toMatchObject({ status: 'failed' });
    await expect(data.session.bridge.execute({ call: { id: 'generate-two', name: 'generate_pptx', arguments: args }, signal: data.signal }))
      .resolves.toMatchObject({ status: 'failed' });
    expect(data.run).toHaveBeenCalledTimes(1);
    expect(await data.works.list(projectId)).toHaveLength(1);
  });

  it('checks a revocation between advertisement and read before starting the read adapter', async () => {
    const data = await fixture();
    const { file } = await data.generate();
    await data.session.prepareTools(data.signal);
    await data.files.save({ ...file, state: 'missing' });
    const result = await data.read();
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.observation).toBeUndefined();
    expect(await data.session.prepareTools(data.signal)).toBeUndefined();
    expect(data.run).toHaveBeenCalledTimes(1);
  });

  it('stops continuation after a delivered read observation is no longer authorized', async () => {
    const data = await fixture();
    const { file } = await data.generate();
    await data.session.prepareTools(data.signal);
    await expect(data.read()).resolves.toMatchObject({ status: 'success' });
    await data.files.save({ ...file, state: 'missing' });
    await expect(data.session.prepareTools(data.signal)).rejects.toThrow();
    expect(data.run).toHaveBeenCalledTimes(1);
    expect(await data.works.list(projectId)).toHaveLength(1);
  });

  it('does not restore tools when a delayed physical read returns after cancellation', async () => {
    const data = await fixture();
    await data.generate();
    const actual = data.reader.getMockImplementation();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    data.reader.mockImplementationOnce(async function (this: RegisteredPresentationReader, ...input) {
      await gate;
      return actual!.apply(this, input);
    });
    const preparation = data.session.prepareTools(data.signal);
    const rejected = expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(data.reader).toHaveBeenCalled());
    await data.session.cancel!();
    await rejected;
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await data.session.prepareTools(data.signal)).toBeUndefined();
    await expect(data.read()).resolves.toMatchObject({ status: 'cancelled' });
    expect(data.run).toHaveBeenCalledTimes(1);
    expect(await data.works.list(projectId)).toHaveLength(1);
  });

  it('bounds an unresolved Reader promise and prevents a late read from re-advertising tools', async () => {
    const data = await fixture();
    await data.generate();
    vi.useFakeTimers();
    data.reader.mockImplementationOnce(() => new Promise(() => undefined));
    const preparation = data.session.prepareTools(data.signal);
    const rejected = expect(preparation).rejects.toThrow();
    await vi.waitFor(() => expect(data.reader).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(createCanonicalToolRegistry().get('read_document_structure')!.execution.timeoutMs + 1);
    await rejected;
    expect(await data.session.prepareTools(data.signal)).toBeUndefined();
    vi.useRealTimers();
    expect(data.run).toHaveBeenCalledTimes(1);
  });
});
