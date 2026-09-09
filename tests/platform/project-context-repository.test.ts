import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProjectContextDraftFragment,
  createProjectContextDraft,
  deleteProjectContext,
  registerProjectContextDraft,
  replaceProjectContextDraftLabels,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  updateProjectContextContent
} from '../../src/domain';
import {
  JsonProjectContextRepository,
  NodeProjectStorage,
  ProjectContextRepositoryDataError,
  ProjectContextRevisionConflictError,
  migrateProjectContextRegistryDocument,
  projectStoragePaths
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-context-repository');
const conversationId = toConversationId('conversation-context-repository');
const t0 = toIsoTimestamp('2026-07-28T13:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-28T13:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-28T13:02:00.000Z');
const t3 = toIsoTimestamp('2026-07-28T13:03:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-project-context-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  let tick = 0;
  const now = () => `2026-07-28T14:${String(tick++).padStart(2, '0')}:00.000Z`;
  return {
    root,
    storage,
    now,
    repository: new JsonProjectContextRepository(storage, projectId, now)
  };
}

function draft(id = 'project-context-draft') {
  return createProjectContextDraft({
    id: toProjectContextDraftId(id),
    projectId,
    conversationId,
    createdAt: t0
  });
}

function draftWithFragment(id = 'project-context-draft') {
  return addProjectContextDraftFragment(draft(id), {
    id: toProjectContextFragmentId(`${id}-fragment`),
    conversationId,
    messageId: toMessageId(`${id}-message`),
    messageRevision: 0,
    messageRole: 'user',
    selection: { schemaVersion: 1, startUtf16: 0, endUtf16: 6 },
    contentSnapshot: '仓储上下文'
  }, t1);
}

describe('JsonProjectContextRepository', () => {
  it('atomically turns a draft into a registered context and keeps history queryable', async () => {
    const { root, repository } = await fixture();
    const created = draftWithFragment();
    await repository.createDraft(draft());
    await repository.saveDraft(created, 0);
    const context = registerProjectContextDraft(
      created,
      toProjectContextId('project-context-registered'),
      t2
    );
    await repository.registerDraft(created.id, created.revision, context);

    await expect(repository.getDraft(created.id)).resolves.toBeUndefined();
    await expect(repository.get(context.id)).resolves.toEqual(context);
    await expect(repository.getRevision(context.id, 1)).resolves.toEqual(
      context.versions[0]
    );
    await expect(repository.list()).resolves.toEqual([context]);
    const files = await readdir(path.join(root, 'entities'));
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('serializes draft writers and rejects stale revisions', async () => {
    const { storage, now, repository } = await fixture();
    const created = draft('draft-conflict');
    await repository.createDraft(created);
    const other = new JsonProjectContextRepository(storage, projectId, now);
    const first = replaceProjectContextDraftLabels(created, ['一'], t1);
    const second = replaceProjectContextDraftLabels(created, ['二'], t2);
    const results = await Promise.allSettled([
      repository.saveDraft(first, 0),
      other.saveDraft(second, 0)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.any(ProjectContextRevisionConflictError)
    });
  });

  it('rejects overwritten context history and stale context revisions', async () => {
    const { repository } = await fixture();
    const createdDraft = draftWithFragment('draft-history');
    await repository.createDraft(draft('draft-history'));
    await repository.saveDraft(createdDraft, 0);
    const context = registerProjectContextDraft(
      createdDraft,
      toProjectContextId('context-history'),
      t2
    );
    await repository.registerDraft(createdDraft.id, 1, context);
    const updated = updateProjectContextContent(context, '第二版内容', [], t3);
    await repository.save(updated, 1);

    const third = updateProjectContextContent(updated, '第三版内容', ['第三版'],
      toIsoTimestamp('2026-07-28T13:04:00.000Z'));
    const overwritten = {
      ...third,
      versions: [
        { ...third.versions[0], contentSnapshot: '覆盖旧版本' },
        ...third.versions.slice(1)
      ]
    };
    await expect(repository.save(overwritten, 2)).rejects.toThrow(
      'history must be append-only'
    );
    const stale = deleteProjectContext(context, t3);
    await expect(repository.save(stale, 1)).rejects.toBeInstanceOf(
      ProjectContextRevisionConflictError
    );
    await expect(repository.getRevision(context.id, 1)).resolves.toMatchObject({
      contentSnapshot: '仓储上下文'
    });
  });

  it('uses only a verified backup when the primary document is corrupt', async () => {
    const { root, repository } = await fixture();
    const created = draft('draft-backup');
    await repository.createDraft(created);
    const updated = replaceProjectContextDraftLabels(created, ['备份'], t1);
    await repository.saveDraft(updated, 0);

    const primaryPath = path.join(root, 'entities', 'project-contexts.json');
    const backupPath = `${primaryPath}.bak`;
    expect(JSON.parse(await readFile(backupPath, 'utf8'))).toMatchObject({
      revision: 1,
      drafts: [{ revision: 0 }]
    });
    await writeFile(primaryPath, '{corrupted-primary', 'utf8');
    await expect(repository.getDraft(created.id)).resolves.toEqual(created);
    await expect(readFile(primaryPath, 'utf8')).resolves.toBe('{corrupted-primary');
  });

  it('fails closed for invalid primary and backup schemas', async () => {
    const { storage, repository } = await fixture();
    await storage.writeJsonAtomically(projectStoragePaths.entities.projectContexts, {});
    await storage.writeJsonAtomically(
      projectStoragePaths.entities.projectContextsBackup,
      {}
    );
    await expect(repository.list()).rejects.toBeInstanceOf(
      ProjectContextRepositoryDataError
    );
  });

  it('rejects sensitive extra fields in persisted project context data', async () => {
    const { storage, repository } = await fixture();
    await storage.writeJsonAtomically(projectStoragePaths.entities.projectContexts, {
      schemaVersion: 1,
      revision: 0,
      updatedAt: t3,
      drafts: [{ ...draft(), endpoint: 'https://example.invalid' }],
      contexts: []
    });
    await expect(repository.list()).rejects.toBeInstanceOf(
      ProjectContextRepositoryDataError
    );
  });
});

describe('project context registry migrations', () => {
  it('requires explicit sequential migrations and rejects future versions', () => {
    const migrated = migrateProjectContextRegistryDocument(
      { schemaVersion: 0, records: [] },
      [{
        fromVersion: 0,
        toVersion: 1,
        migrate: () => ({
          schemaVersion: 1,
          revision: 0,
          updatedAt: t3,
          drafts: [],
          contexts: []
        })
      }],
      projectId
    );
    expect(migrated).toMatchObject({ schemaVersion: 1, revision: 0 });
    expect(() => migrateProjectContextRegistryDocument({ schemaVersion: 0 }))
      .toThrow('no project context migration exists');
    expect(() => migrateProjectContextRegistryDocument({ schemaVersion: 2 }))
      .toThrow('newer than supported');
  });
});
