import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  toDraftId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  JsonImageWorkspaceRepository,
  NodeProjectStorage,
  projectStoragePaths,
  RepositoryDataError
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-23T01:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-repository-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  const projectId = toProjectId('project-image-repository');
  return {
    projectId,
    repository: new JsonImageWorkspaceRepository(storage, projectId),
    storage
  };
}

describe('JsonImageWorkspaceRepository', () => {
  it('round-trips versioned image drafts and enforces project scope', async () => {
    const fixture = await createFixture();
    const draft = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-image-repository'),
      projectId: fixture.projectId,
      mode: 'image_understanding',
      createdAt: timestamp
    });
    const otherProject = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-other-project'),
      projectId: toProjectId('project-other'),
      mode: 'quick_image',
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
    const draft = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-invalid-image-repository'),
      projectId: fixture.projectId,
      mode: 'image_to_prompt',
      createdAt: timestamp
    });

    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.imageWorkspaceDrafts,
      {
        schemaVersion: 1,
        entities: [{ ...draft, mode: 'batch_image' }]
      }
    );

    await expect(fixture.repository.list(fixture.projectId)).rejects.toBeInstanceOf(
      RepositoryDataError
    );

    await fixture.storage.writeJsonAtomically(
      projectStoragePaths.entities.imageWorkspaceDrafts,
      {
        schemaVersion: 1,
        entities: [
          {
            ...draft,
            imageToPrompt: {
              ...draft.imageToPrompt,
              analysisState: 'current'
            }
          }
        ]
      }
    );

    await expect(fixture.repository.list(fixture.projectId)).rejects.toThrow(
      'contains an invalid project-scoped entity'
    );
  });

  it('removes ephemeral drafts after programmatic generation', async () => {
    const fixture = await createFixture();
    const draft = createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-ephemeral'),
      projectId: fixture.projectId,
      mode: 'quick_image',
      createdAt: timestamp
    });
    await fixture.repository.save(draft);
    await fixture.repository.remove(draft.id);
    await expect(fixture.repository.get(draft.id)).resolves.toBeUndefined();
    await expect(fixture.repository.list(fixture.projectId)).resolves.toEqual([]);
  });
});
