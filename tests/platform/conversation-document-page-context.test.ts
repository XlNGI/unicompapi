import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addUserMessage, addCompletedAssistantMessage, attachDocumentResultToMessage,
  createProjectConversation,
  toConversationId, toExecutionId, toFileReferenceId, toIsoTimestamp, toMessageId,
  toProjectId, toTaskId, toWorkId,
  type Conversation, type DocumentOutline, type FileReference, type Work
} from '../../src/domain';
import { ConversationDocumentPageContextService } from '../../src/platform/documents/conversation-document-page-context';
import { generateDocumentFile } from '../../src/platform/documents/office-document-generator';
import { JsonFileReferenceRepository, JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];
const projectId = toProjectId('document-page-project');
const now = toIsoTimestamp('2026-09-09T07:00:00.000Z');
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function outline(title = '页面定位', continuation = false): DocumentOutline {
  return {
    kind: 'ppt', title,
    sections: Array.from({ length: 6 }, (_, index) => ({
      heading: `第${index + 1}逻辑节`, level: 1 as const,
      blocks: [{ type: 'paragraph' as const, text: index === 0 && continuation
        ? '首节跨页长正文仅属于第一逻辑节。'.repeat(90)
        : `逻辑节${index + 1}独有事实：${title}` }]
    }))
  };
}

async function fixture(continuation = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-document-page-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const works = new JsonWorkRepository(storage, projectId);
  const service = new ConversationDocumentPageContextService({ rootDirectory: root, projectId });
  let conversation: Conversation = createProjectConversation({ id: toConversationId('page-conversation'), projectId, title: 'PPT 问答', createdAt: now });
  conversation = addUserMessage(conversation, { id: toMessageId('request-create'), content: '生成 PPT', createdAt: now });
  let version = 0;
  async function register(title: string, longFirstSection = false) {
    version += 1;
    const content = outline(title, longFirstSection);
    const generated = await generateDocumentFile({ kind: 'ppt', outline: content,
      outputDirectory: path.join(root, 'files', 'documents'), now });
    const buffer = await readFile(generated.absolutePath);
    const file: FileReference = { schemaVersion: 1, id: toFileReferenceId(`file-${version}`), projectId,
      sourceExecutionId: toExecutionId(`execution-${version}`), state: 'available',
      locator: { kind: 'project', relativePath: `files/documents/${generated.fileName}` },
      sizeBytes: buffer.length, checksumSha256: createHash('sha256').update(buffer).digest('hex'), createdAt: now, updatedAt: now };
    const work: Work = { schemaVersion: 1, id: toWorkId(`work-${version}`), projectId,
      sourceTaskId: toTaskId(`task-${version}`), sourceExecutionId: file.sourceExecutionId!, fileId: file.id,
      mediaKind: 'document', name: generated.fileName, createdAt: now };
    await files.save(file);
    await works.save(work);
    const messageId = toMessageId(`generated-${version}`);
    conversation = addCompletedAssistantMessage(conversation, { id: messageId, content: JSON.stringify(content), createdAt: now });
    conversation = attachDocumentResultToMessage(conversation, messageId,
      { workId: work.id, fileName: generated.fileName, kind: 'ppt', sizeBytes: buffer.length, validatedContent: JSON.stringify(content) }, now);
    return { generated, file, work, buffer, messageId };
  }
  const first = await register('第一版', continuation);
  function question(query = '第5页说了什么？') {
    const id = toMessageId(`question-${conversation.messages.length}`);
    conversation = addUserMessage(conversation, { id, content: query, createdAt: now });
    return { conversation, currentUserMessageId: id, query };
  }
  return { root, files, works, service, first, register, question, get conversation() { return conversation; } };
}

describe('generated PPT physical page context', () => {
  it('reads actual page 5 after cover and continuation pages rather than logical section 5', async () => {
    const data = await fixture(true);
    const zip = await JSZip.loadAsync(data.first.buffer);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    expect(slides.length).toBeGreaterThan(8);
    const fifth = await zip.file('ppt/slides/slide5.xml')!.async('string');
    expect(fifth).not.toContain('逻辑节5独有事实');
    const refs = await data.service.resolve(data.question());
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ sourceId: data.first.work.id, sourceType: 'project', location: expect.stringContaining('第 5 页') });
    for (const match of fifth.matchAll(/<a:t(?:\s[^>]*)?>([^<]+)<\/a:t>/gu)) expect(refs[0].excerpt).toContain(match[1]);
    expect(refs[0].excerpt).not.toContain('逻辑节5独有事实');
    expect(refs[0].excerpt).toContain('封面为第 1 页');
    expect(refs[0].excerpt).toContain('视觉内容未分析');
    expect(JSON.stringify(refs)).not.toContain(data.root);
  });

  it.each(['第五页内容是什么？', '第 5 页说了什么？', '第5张幻灯片是什么？'])(
    'accepts bounded single-page request %s', async (query) => {
      const data = await fixture();
      expect((await data.service.resolve(data.question(query)))[0].excerpt).toContain('[第 5 页文字开始]');
    });

  it('uses the latest registered version and honors an explicit earlier filename', async () => {
    const data = await fixture();
    const second = await data.register('第二版');
    const latest = await data.service.resolve(data.question());
    expect(latest[0].sourceId).toBe(second.work.id);
    expect(latest[0].excerpt).toContain('第二版');
    const prior = await data.service.resolve(data.question(`解释 ${data.first.generated.fileName} 第5页`));
    expect(prior[0].sourceId).toBe(data.first.work.id);
    expect(prior[0].excerpt).not.toContain('第二版');
    expect(prior[0].contentHash).not.toBe(latest[0].contentHash);
    const uppercase = await data.service.resolve(data.question(`解释 ${data.first.generated.fileName.toUpperCase()} 第5页`));
    expect(uppercase[0].sourceId).toBe(data.first.work.id);
  });

  it('deduplicates repeated result cards by Work and never uses a future message', async () => {
    const data = await fixture();
    const input = data.question();
    const future = await data.register('未来生成版本');
    const refs = await data.service.resolve({ ...input, conversation: data.conversation });
    expect(refs[0].sourceId).toBe(data.first.work.id);
    const duplicate = { ...data.conversation.messages.find((message) => message.id === future.messageId)!,
      id: toMessageId('duplicate-card') };
    const conversation = { ...data.conversation, messages: [...data.conversation.messages, duplicate] };
    const currentUserMessageId = toMessageId('question-duplicate');
    const withQuestion = addUserMessage(conversation, { id: currentUserMessageId, content: `第5页 ${future.generated.fileName}`, createdAt: now });
    expect((await data.service.resolve({ conversation: withQuestion, currentUserMessageId, query: `第5页 ${future.generated.fileName}` }))[0].sourceId).toBe(future.work.id);
  });

  it('keeps ordinary chat, attachment-only, and another conversation out of generated-work context', async () => {
    const data = await fixture();
    expect(await data.service.resolve(data.question('你好'))).toEqual([]);
    const other = addUserMessage(createProjectConversation({ id: toConversationId('other-conversation'), projectId, title: '另一个会话', createdAt: now }),
      { id: toMessageId('other-user'), content: '第5页', createdAt: now });
    expect(await data.service.resolve({ conversation: other, currentUserMessageId: toMessageId('other-user'), query: '第5页' })).toEqual([]);
    await expect(data.service.resolve({ ...data.question(), currentUserMessageId: data.first.messageId })).rejects.toMatchObject({ code: 'document_page_unavailable' });
    const otherProject = new ConversationDocumentPageContextService({ rootDirectory: data.root, projectId: toProjectId('other-project') });
    await expect(otherProject.resolve(data.question())).rejects.toMatchObject({ code: 'document_page_unavailable' });
  });

  it.each(['第5页和第7页', '第5到7页', '第5页至7页', '第5、7页', '倒数第5页', '最后一页',
    '上一份的第5页', '第一份的第5页', '其他文件的第5页', '未知文件.pptx 的第5页', '附件的第5页', 'C:\\private\\secret.pptx 第5页'])(
    'refuses ambiguous target %s instead of silently using the latest work', async (query) => {
      const data = await fixture();
      await expect(data.service.resolve(data.question(query))).rejects.toMatchObject({ code: 'document_page_ambiguous' });
    });

  it('refuses multiple named documents and preserves safe error text', async () => {
    const data = await fixture();
    const second = await data.register('第二版');
    const promise = data.service.resolve(data.question(`${data.first.generated.fileName} 和 ${second.generated.fileName} 第5页`));
    await expect(promise).rejects.toMatchObject({ code: 'document_page_ambiguous' });
    await expect(promise).rejects.not.toHaveProperty('message', expect.stringContaining(data.root));
  });

  it.each(['第0页', '第9999页', '第999页', '第一百页', '第十百页'])(
    'reports out-of-range or invalid physical ordinal %s', async (query) => {
      const data = await fixture();
      await expect(data.service.resolve(data.question(query))).rejects.toMatchObject({ code: 'document_page_out_of_range' });
    });

  it('refuses changed bytes, missing files, and an unregistered result', async () => {
    const data = await fixture();
    const input = data.question();
    await writeFile(data.first.generated.absolutePath, '更改后的内容');
    await expect(data.service.resolve(input)).rejects.toMatchObject({ code: 'document_page_unavailable' });
    await rm(data.first.generated.absolutePath);
    await expect(data.service.resolve(input)).rejects.toMatchObject({ code: 'document_page_unavailable' });
    const conversation = { ...input.conversation, messages: input.conversation.messages.map((message) => message.documentResult
      ? { ...message, documentResult: { ...message.documentResult, workId: toWorkId('not-registered') } } : message) };
    await expect(data.service.resolve({ ...input, conversation })).rejects.toMatchObject({ code: 'document_page_unavailable' });
  });

  it('refuses non-document works and mismatched file execution, location, checksum or state', async () => {
    const data = await fixture();
    const input = data.question();
    await data.works.save({ ...data.first.work, mediaKind: 'image' });
    await expect(data.service.resolve(input)).rejects.toMatchObject({ code: 'document_page_unavailable' });
    await data.works.save(data.first.work);
    for (const changed of [
      { ...data.first.file, sourceExecutionId: toExecutionId('wrong-execution') },
      { ...data.first.file, state: 'missing' as const },
      { ...data.first.file, checksumSha256: undefined },
      { ...data.first.file, locator: { kind: 'project' as const, relativePath: 'files/attachments/source.pptx' } },
      { ...data.first.file, locator: { kind: 'external' as const, absolutePath: data.first.generated.absolutePath } }
    ]) {
      await data.files.save(changed);
      await expect(data.service.resolve(input)).rejects.toMatchObject({ code: 'document_page_unavailable' });
    }
  });

  it('preserves an empty physical page without substituting another page', async () => {
    const data = await fixture();
    const zip = await JSZip.loadAsync(data.first.buffer);
    const page = await zip.file('ppt/slides/slide5.xml')!.async('string');
    zip.file('ppt/slides/slide5.xml', page.replace(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/gu, '<a:t></a:t>'));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(data.first.generated.absolutePath, buffer);
    await data.files.save({ ...data.first.file, sizeBytes: buffer.length, checksumSha256: createHash('sha256').update(buffer).digest('hex') });
    const input = data.question();
    const conversation = { ...input.conversation, messages: input.conversation.messages.map((message) => message.documentResult
      ? { ...message, documentResult: { ...message.documentResult, sizeBytes: buffer.length } } : message) };
    const refs = await data.service.resolve({ ...input, conversation });
    expect(refs[0].excerpt).toContain('本页没有可提取文字');
    expect(refs[0].excerpt).not.toContain('逻辑节5独有事实');
  });

  it('rejects text beyond the single-page budget without partial reference output', async () => {
    const data = await fixture();
    const zip = await JSZip.loadAsync(data.first.buffer);
    const page = await zip.file('ppt/slides/slide5.xml')!.async('string');
    zip.file('ppt/slides/slide5.xml', page.replace(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/u, `<a:t>${'超限正文'.repeat(3100)}</a:t>`));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(data.first.generated.absolutePath, buffer);
    await data.files.save({ ...data.first.file, sizeBytes: buffer.length, checksumSha256: createHash('sha256').update(buffer).digest('hex') });
    const input = data.question();
    const conversation = { ...input.conversation, messages: input.conversation.messages.map((message) => message.documentResult
      ? { ...message, documentResult: { ...message.documentResult, sizeBytes: buffer.length } } : message) };
    await expect(data.service.resolve({ ...input, conversation })).rejects.toMatchObject({ code: 'document_page_scope_exceeded' });
    expect((await stat(data.first.generated.absolutePath)).size).toBe(buffer.length);
  });
});
