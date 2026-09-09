import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationDocumentInputStore } from '../../src/platform/documents/conversation-document-inputs';
import { NodeProjectStorage } from '../../src/platform/storage';
import { toConversationId, toMessageId, toProjectId, toWorkId } from '../../src/domain';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('persisted Office render input', () => {
  it('recovers original parent, theme and paid illustration references after restart with the current revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-office-retry-'));
    roots.push(root);
    const projectId = toProjectId('project-retry');
    const input = { conversationId: toConversationId('conversation-retry'), messageId: toMessageId('message-retry'), expectedRevision: 4,
      kind: 'word' as const, theme: 'forest' as const, parentWorkId: toWorkId('parent-retry'),
      images: [{ workId: 'illustration-retry', caption: '已完成配图' }] };
    await new ConversationDocumentInputStore(new NodeProjectStorage(root), projectId).resolve(input, false);
    const reloaded = new ConversationDocumentInputStore(new NodeProjectStorage(root), projectId);
    await expect(reloaded.resolve({ ...input, messageId: toMessageId('missing-message') }, true)).rejects.toThrow('原文档生成参数已缺失');
    const recovered = await reloaded.resolve({ conversationId: input.conversationId, messageId: input.messageId, expectedRevision: 12,
      kind: 'word', theme: 'ink', images: [] }, true);
    expect(recovered).toEqual({ ...input, expectedRevision: 12 });
    await expect(reloaded.resolve({ ...input, kind: 'excel' }, true)).rejects.toThrow('does not match');
    await expect(new ConversationDocumentInputStore(new NodeProjectStorage(root), toProjectId('another-project')).resolve(input, true))
      .rejects.toThrow('another project');
  });
});
