import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversationResponseDraft, parseConversationResponseDraft, toConversationId,
  toConversationResponseDraftId, toIsoTimestamp, toMessageId, toProjectId
} from '../../src/domain';
import {
  ConversationResponseDraftRepositoryDataError, JsonConversationResponseDraftRepository,
  parseConversationResponseDraftDocument
} from '../../src/platform/repositories/json-conversation-response-draft-repository';
import { NodeProjectStorage, projectStoragePaths } from '../../src/platform/storage';
import { chatContextFailure } from '../../src/platform/ipc/chat-context-errors';

const roots: string[] = [];
const projectId = toProjectId('compatibility-project');
const now = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const draft = (index: number) => createConversationResponseDraft({
  id: toConversationResponseDraftId(`draft-${index}`), projectId,
  conversationId: toConversationId(`conversation-${index}`), conversationRevision: 1,
  userMessageId: toMessageId(`user-${index}`), userMessageRevision: 0,
  productFeature: 'text_chat', promptContent: `Synthetic history ${index}`, createdAt: now
});
const history = () => ({ schemaVersion: 1, revision: 97, updatedAt: now,
  drafts: Array.from({ length: 97 }, (_, index) => ({ ...draft(index),
    promptMode: index % 2 ? 'document_revision' : 'conversation' })) });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-draft-compatibility-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const repository = new JsonConversationResponseDraftRepository(storage, projectId, () => now);
  await storage.writeJsonAtomically(projectStoragePaths.entities.conversationResponseDrafts, history());
  return { root, storage, repository, file: path.join(root, projectStoragePaths.entities.conversationResponseDrafts) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('stored response draft compatibility', () => {
  it('reads all 97 known legacy drafts without writing, then preserves history and backs up on a normal create', async () => {
    const { repository, file } = await setup();
    const original = await readFile(file, 'utf8');
    expect(await repository.list()).toHaveLength(97);
    expect(await readFile(file, 'utf8')).toBe(original);
    await repository.create(draft(97));
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.revision).toBe(98);
    expect(saved.drafts).toEqual(Array.from({ length: 98 }, (_, index) => draft(index)));
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual(history());
  });

  it.each([
    ['unknown mode', { promptMode: 'unknown' }],
    ['array mode', { promptMode: ['conversation'] }],
    ['null mode', { promptMode: null }],
    ['unknown key', { extraField: true }],
    ['invalid revision', { revision: -1 }],
    ['other project', { projectId: 'another-project' }],
    ['invalid version', { schemaVersion: 2 }]
  ])('rejects %s without writing and reports local data, not a bad user request', async (_name, override) => {
    const { storage, repository, file } = await setup();
    const document = history();
    const drafts = [{ ...document.drafts[0], ...override }, ...document.drafts.slice(1)];
    await storage.writeJsonAtomically(projectStoragePaths.entities.conversationResponseDrafts, { ...document, drafts });
    const original = await readFile(file, 'utf8');
    const error = await repository.create(draft(97)).catch(error => error);
    expect(error).toBeInstanceOf(ConversationResponseDraftRepositoryDataError);
    expect(chatContextFailure(error)).toMatchObject({ ok: false, error: { code: 'local_chat_data_invalid' } });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('rejects duplicate IDs and retains strict validation for newly supplied domain objects', () => {
    const document = history();
    document.drafts[1] = document.drafts[0];
    expect(() => parseConversationResponseDraftDocument(document, projectId)).toThrow();
    expect(() => parseConversationResponseDraft({ ...draft(0), promptMode: 'conversation' })).toThrow();
  });

  it('reports damaged JSON as local data and preserves the damaged source', async () => {
    const { repository, file } = await setup();
    await writeFile(file, '{broken', 'utf8');
    const error = await repository.create(draft(97)).catch(error => error);
    expect(chatContextFailure(error)).toMatchObject({ ok: false, error: { code: 'local_chat_data_invalid' } });
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('saves an existing legacy draft with revision locking and reads the resulting current format', async () => {
    const { repository, file } = await setup();
    const updated = { ...draft(0), revision: 1 };
    await repository.save(updated, 0);
    expect(await repository.get(updated.id)).toEqual(updated);
    expect(await repository.list()).toHaveLength(97);
    const saved = await readFile(file, 'utf8');
    await expect(repository.save(updated, 0)).rejects.toThrow('revision conflict');
    expect(await readFile(file, 'utf8')).toBe(saved);
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual(history());
  });

  it('preserves all original bytes if the required backup cannot be written', async () => {
    const { repository, file } = await setup();
    const original = await readFile(file, 'utf8');
    await mkdir(`${file}.bak`);
    await expect(repository.create(draft(97))).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await repository.list()).toHaveLength(97);
  });

  it('preserves source and backup when replacement fails after syncing the new document', async () => {
    const { root, file } = await setup();
    const original = await readFile(file, 'utf8');
    const storage = new NodeProjectStorage(root, { onAtomicWriteStage: ({ stage, targetPath }) => {
      if (stage === 'before_replace' && targetPath === file) throw new Error('Injected replacement failure');
    } });
    const repository = new JsonConversationResponseDraftRepository(storage, projectId, () => now);
    await expect(repository.save({ ...draft(0), revision: 1 }, 0)).rejects.toThrow('Injected replacement failure');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(original);
  });
});
