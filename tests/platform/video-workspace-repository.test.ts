import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyVideoWorkspaceDraft,
  toDraftId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  JsonVideoWorkspaceRepository,
  NodeProjectStorage,
  projectStoragePaths,
  RepositoryDataError
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-23T10:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-repository-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const projectId = toProjectId('project-video-repository');
  return {
    projectId,
    repository: new JsonVideoWorkspaceRepository(storage, projectId),
    storage
  };
}

describe('JsonVideoWorkspaceRepository', () => {
  it('round-trips versioned video drafts and enforces project scope', async () => {
    const fixture = await createFixture();
    const draft = createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-video-repository'),
      projectId: fixture.projectId,
      mode: 'text_to_video',
      createdAt: timestamp
    });
    const otherProject = createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-video-other'),
      projectId: toProjectId('project-video-other'),
      mode: 'quick_video',
      createdAt: timestamp
    });

    await fixture.repository.save(draft);

    await expect(fixture.repository.get(draft.id)).resolves.toEqual(draft);
    await expect(fixture.repository.list(fixture.projectId)).resolves.toEqual([
      draft
    ]);
    await expect(fixture.repository.save(otherProject)).rejects.toThrow(
      'outside repository scope'
    );
  });

  it('rejects unknown modes and malformed mode-specific state at read time', async () => {
    const fixture = await createFixture();
    const draft = createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-invalid-video-repository'),
      projectId: fixture.projectId,
      mode: 'text_to_video',
      createdAt: timestamp
    });

    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.videoWorkspaceDrafts,
      {
        schemaVersion: 1,
        entities: [{ ...draft, mode: 'batch_video' }]
      }
    );
    await expect(fixture.repository.list(fixture.projectId)).rejects.toBeInstanceOf(
      RepositoryDataError
    );

    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.videoWorkspaceDrafts,
      {
        schemaVersion: 1,
        entities: [
          {
            ...draft,
            textToVideo: {
              ...draft.textToVideo,
              storyboard: {
                state: 'current',
                staleReasons: [],
                frameAssetIds: []
              }
            }
          }
        ]
      }
    );
    await expect(fixture.repository.list(fixture.projectId)).rejects.toThrow(
      'contains an invalid project-scoped entity'
    );
  });
});
