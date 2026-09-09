import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationApplicationService, ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { toMessageId, toProjectId, toConversationId } from '../../src/domain';
import { AttachmentImportService, ConversationAttachmentContextService, ConversationResponseController, ConversationWorkflowController,
  JsonConversationWorkflowRepository, JsonProjectConversationRepository, NodeProjectStorage,
  type ConversationResponseControllerRuntime } from '../../src/platform';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-attachment-workflow-'));
  roots.push(root);
  const projectId = toProjectId('attachment-workflow-project');
  const storage = new NodeProjectStorage(root);
  const conversations = new JsonProjectConversationRepository(storage, projectId);
  const workflows = new JsonConversationWorkflowRepository(storage, projectId);
  let id = 0;
  const conversationService = new ConversationApplicationService(conversations, {
    nextConversationId: () => toConversationId(`attachment-conversation-${++id}`),
    nextMessageId: () => toMessageId(`attachment-message-${++id}`)
  });
  const workflowService = new ConversationWorkflowService(workflows, new ConversationIntentOrchestrator());
  const summarizeSource = vi.fn(async () => '事实摘要：应收账款为三万元。');
  const attachments = new ConversationAttachmentContextService({ rootDirectory: root, projectId, summarizer: { summarizeSource } });
  const prepareSummary = vi.spyOn(attachments, 'prepareSummary');
  const source = path.join(root, 'report.txt');
  await writeFile(source, `${'报告全文重要内容'.repeat(2500)}最后事实：应收账款为三万元。`);
  const file = await new AttachmentImportService({ rootDirectory: root, projectId }).importAttachment({ sourcePath: source });
  const session = { rootDirectory: root, projectId, projectName: 'Attachment workflow' };
  const controller = new ConversationWorkflowController({
    getSession: () => session,
    getRuntime: () => ({ conversationService, workflowService, attachments })
  });
  const candidatePreparation = vi.fn(async () => { throw new Error('Unexpected candidate preparation'); });
  const providerStart = vi.fn(async () => { throw new Error('Unexpected provider dispatch'); });
  const createDraft = vi.fn(async () => undefined);
  const responseController = new ConversationResponseController({
    getSession: () => session,
    getRuntime: () => ({
      conversationService, workflowService, conversations, attachments, ready: Promise.resolve(),
      executions: { listActive: async () => [] }, drafts: { create: createDraft },
      candidates: { prepareSubmission: candidatePreparation }, start: providerStart
    } as unknown as ConversationResponseControllerRuntime),
    nextResponseDraftId: () => 'attachment-response-draft'
  });
  return { controller, responseController, file, conversations, attachments, prepareSummary, summarizeSource,
    candidatePreparation, providerStart, createDraft };
}
const selection = { candidateId: 'selected-summary-route', productFeature: 'text_chat' };

describe('attachment requirements across workflow turns', () => {
  it.each([
    ['帮我做个总结', 'PPT'],
    ['帮我做一份报告', 'PPT，总结附件全文']
  ])('prepares a complete summary for the effective request: %s → %s', async (initial, answer) => {
    const f = await fixture();
    const started = await f.controller.start({ clientCommandId: 'initial', conversation: null, title: '报告',
      content: initial, attachmentFileIds: [f.file.fileId], semanticCandidate: selection });
    if (!started.ok) throw new Error(started.error.message);
    const answered = await f.controller.answer({ clientCommandId: 'answer', workflowId: started.value.workflow.workflowId,
      expectedWorkflowRevision: started.value.workflow.revision, expectedConversationRevision: started.value.conversation.revision,
      content: answer, semanticCandidate: selection });
    expect(answered).toMatchObject({ ok: true, value: { workflow: { status: 'ready' } } });
    if (!answered.ok) throw new Error(answered.error.message);
    const query = f.prepareSummary.mock.calls.at(-1)![0].query;
    expect(query).toContain(initial);
    expect(query).toContain(answer);
    expect(f.summarizeSource).toHaveBeenCalledTimes(3);
    const conversation = await f.conversations.get(toConversationId(answered.value.conversation.conversationId));
    if (!conversation) throw new Error('Missing conversation');
    const references = await f.attachments.resolve({ conversation,
      currentUserMessageId: toMessageId(answered.value.workflow.sourceMessageId), query });
    expect(references[0].excerpt).toContain('已逐段处理全文');
    expect(references[0].excerpt).toContain('应收账款为三万元');
  });

  it('rejects clarified whole-table statistics before candidate authorization or provider dispatch', async () => {
    const f = await fixture();
    const started = await f.controller.start({ clientCommandId: 'initial', conversation: null, title: '报告',
      content: '帮我做个总结', attachmentFileIds: [f.file.fileId], semanticCandidate: selection });
    if (!started.ok) throw new Error(started.error.message);
    const answered = await f.controller.answer({ clientCommandId: 'answer', workflowId: started.value.workflow.workflowId,
      expectedWorkflowRevision: started.value.workflow.revision, expectedConversationRevision: started.value.conversation.revision,
      content: 'Excel，统计全表总计金额', semanticCandidate: selection });
    expect(answered).toMatchObject({ ok: true, value: { workflow: { status: 'ready' } } });
    if (!answered.ok) throw new Error(answered.error.message);
    const result = await f.responseController.start({ clientCommandId: 'response',
      conversation: { conversationId: answered.value.conversation.conversationId,
        expectedRevision: answered.value.conversation.revision, editedMessageId: null },
      workflow: { workflowId: answered.value.workflow.workflowId, expectedRevision: answered.value.workflow.revision },
      title: '全表统计', content: '内部文档提示：整理摘要并生成 Excel',
      productFeature: 'text_chat', candidateId: selection.candidateId, contextSelections: [], parameterValues: {}, confirmed: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'attachment_scope_exceeded' } });
    expect(f.summarizeSource).not.toHaveBeenCalled();
    expect(f.createDraft).not.toHaveBeenCalled();
    expect(f.candidatePreparation).not.toHaveBeenCalled();
    expect(f.providerStart).not.toHaveBeenCalled();
  });
});
