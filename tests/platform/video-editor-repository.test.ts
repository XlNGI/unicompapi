import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyVideoEditCommand,
  createEmptyVideoEditDraft,
  toIsoTimestamp,
  toProjectId,
  toVideoEditDraftId
} from '../../src/domain';
import {
  JsonVideoEditDraftRepository,
  NodeProjectStorage,
  projectStoragePaths,
  RepositoryDataError
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-24T13:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-24T13:01:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-editor-repository-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const projectId = toProjectId('project-editor-repository');
  return {
    projectId,
    repository: new JsonVideoEditDraftRepository(storage, projectId),
    storage
  };
}

describe('JsonVideoEditDraftRepository', () => {
  it('round-trips the draft and persisted command history atomically', async () => {
    const fixture = await createFixture();
    const created = createEmptyVideoEditDraft({
      id: toVideoEditDraftId('editor-repository-draft'),
      projectId: fixture.projectId,
      createdAt: t0
    });
    const updated = applyVideoEditCommand(
      created,
      {
        schemaVersion: 1,
        kind: 'set_title',
        before: created.title,
        after: '已自动保存的剪辑'
      },
      t1
    );

    await fixture.repository.save(updated);

    await expect(fixture.repository.get(updated.id)).resolves.toEqual(updated);
    await expect(fixture.repository.list(fixture.projectId)).resolves.toEqual([
      updated
    ]);
  });

  it('enforces project scope and rejects invalid stored schemas', async () => {
    const fixture = await createFixture();
    const outside = createEmptyVideoEditDraft({
      id: toVideoEditDraftId('outside-editor-draft'),
      projectId: toProjectId('another-project'),
      createdAt: t0
    });

    await expect(fixture.repository.save(outside)).rejects.toThrow(
      'outside repository scope'
    );

    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.videoEditDrafts,
      {
        schemaVersion: 1,
        entities: [
          {
            ...createEmptyVideoEditDraft({
              id: toVideoEditDraftId('malformed-editor-draft'),
              projectId: fixture.projectId,
              createdAt: t0
            }),
            mediaEngineCommand: '--overwrite-source'
          }
        ]
      }
    );

    await expect(
      fixture.repository.list(fixture.projectId)
    ).rejects.toBeInstanceOf(RepositoryDataError);
  });
});
