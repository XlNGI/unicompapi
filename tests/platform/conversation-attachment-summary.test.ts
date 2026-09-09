import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addUserMessage, createProjectConversation, toConversationId, toIsoTimestamp, toMessageId, toProjectId } from '../../src/domain';
import { AttachmentImportService, ConversationAttachmentContextService, JsonFileReferenceRepository, NodeProjectStorage } from '../../src/platform';
import { ConversationControlledTextError, type ConversationSemanticClassifier } from '../../src/platform/providers/conversation-semantic-classifier';
import { conversationSummaryCachePath, type AttachmentSummaryCacheRecord } from '../../src/platform/documents/conversation-attachment-summary-store';

const roots: string[] = [];
const projectId = toProjectId('summary-project');
const selection = { candidateId: 'selected-summary-route', productFeature: 'text_chat' as const };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
type Summarizer = Pick<ConversationSemanticClassifier, 'summarizeSource'>;

async function fixture(text = `${'全文重要内容'.repeat(3000)}最后事实：应收账款为三万元。`) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-source-summary-'));
  roots.push(root);
  const source = path.join(root, 'long.txt');
  await writeFile(source, text);
  const imported = await new AttachmentImportService({ rootDirectory: root, projectId }).importAttachment({ sourcePath: source });
  const summarizeSource = vi.fn<Summarizer['summarizeSource']>().mockImplementation(async ({ text: part }) => `事实摘要：${part.slice(-80)}`);
  const createService = (summarizer: Summarizer = { summarizeSource }) => new ConversationAttachmentContextService({ rootDirectory: root, projectId, summarizer });
  const service = createService();
  const createdAt = toIsoTimestamp('2026-09-09T06:00:00.000Z');
  const conversation = addUserMessage(createProjectConversation({ id: toConversationId('summary-conversation'), projectId, title: '总结', createdAt }),
    { id: toMessageId('summary-message'), content: '总结全文', createdAt, attachments: await service.pin([imported.fileId]) });
  const input = { conversation, query: '总结全文的主要观点', selection, signal: new AbortController().signal };
  const resolveInput = { conversation, query: input.query, currentUserMessageId: toMessageId('summary-message') };
  const records = async () => JSON.parse(await readFile(path.join(root, conversationSummaryCachePath), 'utf8')) as { schemaVersion: 1; records: AttachmentSummaryCacheRecord[] };
  return { root, text, imported, summarizeSource, service, createService, input, resolveInput, records };
}

describe('bounded full attachment summaries', () => {
  it('processes every source character once and reuses verified summaries after a reload', async () => {
    const f = await fixture();
    await f.service.prepareSummary(f.input);
    expect(f.summarizeSource).toHaveBeenCalledTimes(3);
    const calls = f.summarizeSource.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.text).join('')).toBe(f.text);
    expect(calls.every((input, index) => input.text.length <= 8000 && input.part === index + 1 && input.parts === 3 && input.selection === selection)).toBe(true);
    const service = f.createService();
    await service.prepareSummary(f.input);
    const references = await service.resolve(f.resolveInput);
    expect(f.summarizeSource).toHaveBeenCalledTimes(3);
    expect(references[0].excerpt).toContain(`已逐段处理全文 ${f.text.length} 字符`);
    expect(references[0].excerpt).toContain('应收账款为三万元');
    expect(references[0].excerpt).toContain('不是原文');
    expect((await f.records()).records[0].status).toBe('completed');
    const targeted = await service.resolve({ ...f.resolveInput, query: '最后一节的账款多少？' });
    expect(targeted[0].excerpt).toContain('应收账款为三万元');
    expect(targeted[0].excerpt).toContain('问题相关片段');
  });

  it('refuses more than four parts and whole-table statistics before making summary requests', async () => {
    const f = await fixture('长'.repeat(32001));
    await expect(f.service.prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_scope_exceeded' });
    await f.service.prepareSummary({ ...f.input, query: '总结并统计全表的总计金额' });
    await expect(f.service.resolve({ ...f.resolveInput, query: '总结并统计全表的总计金额' })).rejects.toMatchObject({ code: 'attachment_scope_exceeded' });
    expect(f.summarizeSource).not.toHaveBeenCalled();
  });

  it('retains completed parts but never resends an unknown request after restart', async () => {
    const f = await fixture();
    f.summarizeSource.mockImplementationOnce(async () => '第一段事实').mockRejectedValueOnce(new ConversationControlledTextError('unknown', new Error('transport lost')));
    await expect(f.service.prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_unavailable' });
    const record = (await f.records()).records[0];
    expect(record).toMatchObject({ status: 'failed', failureOutcome: 'unknown' });
    expect(record.parts[0].summary).toBe('第一段事实');
    await expect(f.createService().prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_unavailable' });
    expect(f.summarizeSource).toHaveBeenCalledTimes(2);
    await expect(f.service.resolve(f.resolveInput)).rejects.toMatchObject({ code: 'attachment_scope_exceeded' });
  });

  it('resumes only unfinished parts on a new request after a known pre-request failure', async () => {
    const f = await fixture();
    f.summarizeSource.mockImplementationOnce(async () => '第一段事实').mockRejectedValueOnce(new ConversationControlledTextError('not_sent', new Error('authorization unavailable')));
    await expect(f.service.prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_unavailable' });
    expect(f.summarizeSource).toHaveBeenCalledTimes(2);
    await f.createService().prepareSummary(f.input);
    expect(f.summarizeSource.mock.calls.map(([input]) => input.part)).toEqual([1, 2, 2, 3]);
    expect((await f.records()).records[0].status).toBe('completed');
  });

  it('stops remaining parts promptly even if a summarizer ignores cancellation and blocks an unknown restart', async () => {
    const f = await fixture();
    f.summarizeSource.mockImplementationOnce(async () => '第一段事实').mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const operation = f.service.prepareSummary({ ...f.input, signal: controller.signal });
    const assertion = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(f.summarizeSource).toHaveBeenCalledTimes(2));
    controller.abort();
    await assertion;
    expect(f.summarizeSource.mock.calls[1][0].signal.aborted).toBe(true);
    expect((await f.records()).records[0]).toMatchObject({ status: 'failed', failureOutcome: 'unknown' });
    await expect(f.createService().prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_unavailable' });
    expect(f.summarizeSource).toHaveBeenCalledTimes(2);
  });

  it('does not reuse the cache across conversations or after the pinned file changes', async () => {
    const f = await fixture();
    await f.service.prepareSummary(f.input);
    const another = { ...f.input.conversation, id: toConversationId('another-summary-conversation') };
    await expect(f.service.resolve({ ...f.resolveInput, conversation: another })).rejects.toMatchObject({ code: 'attachment_scope_exceeded' });
    const file = await new JsonFileReferenceRepository(new NodeProjectStorage(f.root), projectId).get(f.imported.fileId as never);
    if (!file || file.locator.kind !== 'project') throw new Error('Expected imported file');
    await writeFile(path.join(f.root, file.locator.relativePath), '改变原文件');
    await expect(f.service.prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_changed' });
    await expect(f.service.resolve(f.resolveInput)).rejects.toMatchObject({ code: 'attachment_changed' });
    expect(f.summarizeSource).toHaveBeenCalledTimes(3);
  });

  it('rejects cache records with missing source coverage before claiming a full summary', async () => {
    const f = await fixture();
    await f.service.prepareSummary(f.input);
    const cache = await f.records();
    const record = cache.records[0];
    await writeFile(path.join(f.root, conversationSummaryCachePath), JSON.stringify({ ...cache, records: [{ ...record, parts: record.parts.slice(1) }] }));
    await expect(f.service.resolve(f.resolveInput)).rejects.toMatchObject({ code: 'attachment_unavailable' });
    await expect(f.service.prepareSummary(f.input)).rejects.toMatchObject({ code: 'attachment_unavailable' });
    expect(f.summarizeSource).toHaveBeenCalledTimes(3);
  });
});
