import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveConversation,
  createConversation,
  deleteConversation,
  renameConversation,
  toConversationId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  ConversationRepositoryDataError,
  ConversationRevisionConflictError,
  JsonConversationRepository,
  migrateConversationDocument
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-28T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-28T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-28T10:02:00.000Z');
const t3 = toIsoTimestamp('2026-07-28T10:03:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-conversations-'));
  roots.push(root);
  const repositoryPath = path.join(root, 'chat', 'conversations.json');
  let tick = 0;
  const now = () => `2026-07-28T11:${String(tick++).padStart(2, '0')}:00.000Z`;
  return {
    root,
    repositoryPath,
    repository: new JsonConversationRepository(repositoryPath, now),
    now
  };
}

function create(id = 'conversation-repository') {
  return createConversation({
    id: toConversationId(id),
    title: '仓储对话',
    projectId: toProjectId('project-repository'),
    createdAt: t0
  });
}

describe('JsonConversationRepository', () => {
  it('persists versioned conversations atomically and applies explicit list semantics', async () => {
    const { root, repositoryPath, repository } = await fixture();
    const first = create('conversation-active');
    const second = create('conversation-archived');
    await repository.create(first);
    await repository.create(second);
    const archived = archiveConversation(second, t1);
    await repository.save(archived, second.revision);

    await expect(repository.get(first.id)).resolves.toEqual(first);
    await expect(repository.list()).resolves.toEqual([first]);
    await expect(repository.list({ statuses: ['archived'] })).resolves.toEqual([
      archived
    ]);
    await expect(repository.list({
      statuses: ['active', 'archived'],
      projectId: toProjectId('another-project')
    })).resolves.toEqual([]);

    const document = JSON.parse(await readFile(repositoryPath, 'utf8'));
    expect(document).toMatchObject({
      schemaVersion: 1,
      revision: 3,
      conversations: expect.arrayContaining([
        expect.objectContaining({ id: first.id, revision: 0 }),
        expect.objectContaining({ id: second.id, revision: 1 })
      ])
    });
    expect((await readdir(path.join(root, 'chat'))).some((name) => name.endsWith('.tmp')))
      .toBe(false);
    const persistedText = await readFile(repositoryPath, 'utf8');
    expect(persistedText).not.toMatch(
      /absolutePath|sha256|apiKey|endpoint|https?:\/\//i
    );
  });

  it('keeps deleted conversations as tombstones while ordinary lists hide them', async () => {
    const { repository } = await fixture();
    const created = create('conversation-deleted');
    await repository.create(created);
    const deleted = deleteConversation(created, t1);
    await repository.save(deleted, created.revision);

    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.list({ statuses: ['deleted'] })).resolves.toEqual([
      deleted
    ]);
    await expect(repository.get(created.id)).resolves.toEqual(deleted);
  });

  it('serializes writers across repository instances and rejects stale revisions', async () => {
    const { repositoryPath, repository, now } = await fixture();
    const created = create('conversation-conflict');
    await repository.create(created);
    const otherInstance = new JsonConversationRepository(repositoryPath, now);
    const first = renameConversation(created, '第一个写入', t1);
    const second = renameConversation(created, '第二个写入', t2);

    const results = await Promise.allSettled([
      repository.save(first, 0),
      otherInstance.save(second, 0)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConversationRevisionConflictError)
    });
    expect((await repository.get(created.id))?.revision).toBe(1);
  });

  it('maintains a last verified backup and does not overwrite corrupt evidence on load', async () => {
    const { repositoryPath, repository } = await fixture();
    const created = create('conversation-backup');
    await repository.create(created);
    const renamed = renameConversation(created, '备份前版本', t1);
    await repository.save(renamed, 0);
    const archived = archiveConversation(renamed, t2);
    await repository.save(archived, 1);

    const backup = JSON.parse(await readFile(`${repositoryPath}.bak`, 'utf8'));
    expect(backup).toMatchObject({
      revision: 2,
      conversations: [{ title: '备份前版本', status: 'active', revision: 1 }]
    });

    await writeFile(repositoryPath, '{corrupted-primary', 'utf8');
    await expect(repository.get(created.id)).resolves.toMatchObject({
      title: '备份前版本',
      revision: 1
    });
    await expect(readFile(repositoryPath, 'utf8')).resolves.toBe('{corrupted-primary');
  });

  it('fails closed for invalid primary and backup documents', async () => {
    const { repositoryPath, repository } = await fixture();
    await mkdir(path.dirname(repositoryPath), { recursive: true });
    await writeFile(repositoryPath, '{}', 'utf8');
    await writeFile(`${repositoryPath}.bak`, '{}', 'utf8');
    await expect(repository.list()).rejects.toBeInstanceOf(
      ConversationRepositoryDataError
    );
  });

  it('rejects duplicate creation, skipped revisions and unknown persisted fields', async () => {
    const { repositoryPath, repository } = await fixture();
    const created = create('conversation-strict-repository');
    await repository.create(created);
    await expect(repository.create(created)).rejects.toBeInstanceOf(
      ConversationRevisionConflictError
    );
    await expect(repository.save({ ...created, revision: 2 }, 0)).rejects.toThrow(
      'revision must increment exactly once'
    );

    const raw = JSON.parse(await readFile(repositoryPath, 'utf8'));
    raw.conversations[0].absolutePath = 'C:\\private\\conversation.json';
    await writeFile(repositoryPath, JSON.stringify(raw), 'utf8');
    await expect(repository.list()).rejects.toBeInstanceOf(
      ConversationRepositoryDataError
    );
  });
});

describe('conversation document migrations', () => {
  it('requires explicit sequential migrations and rejects future schemas', () => {
    const migrated = migrateConversationDocument(
      { schemaVersion: 0, items: [] },
      [{
        fromVersion: 0,
        toVersion: 1,
        migrate: () => ({
          schemaVersion: 1,
          revision: 0,
          updatedAt: t3,
          conversations: []
        })
      }]
    );
    expect(migrated).toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: t3,
      conversations: []
    });
    expect(() => migrateConversationDocument({ schemaVersion: 0 }))
      .toThrow('No conversation migration exists');
    expect(() => migrateConversationDocument({ schemaVersion: 2 }))
      .toThrow('newer than supported');
  });
});
