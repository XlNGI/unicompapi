import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAsset,
  createDraft,
  createExecution,
  createFileReference,
  createProject,
  toAssetId,
  toDraftId,
  toFileReferenceId,
  toExecutionId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  toWorkId,
  type Work
} from '../../src/domain';
import {
  JsonAssetRepository,
  JsonDraftRepository,
  JsonExecutionRepository,
  JsonFileReferenceRepository,
  JsonProjectRepository,
  JsonTaskRepository,
  JsonWorkRepository,
  NodeProjectStorage,
  projectStoragePaths,
  RepositoryDataError
} from '../../src/platform';
import { createDraftFixture, createLinkedExecutionFixture } from '../domain/fixtures';

const temporaryRoots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createStorage() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-repositories-'));
  temporaryRoots.push(root);
  return new NodeProjectStorage(root);
}

describe('JSON repositories', () => {
  it('round-trips the project manifest', async () => {
    const storage = await createStorage();
    const repository = new JsonProjectRepository(
      storage,
      toProjectId('project-manifest')
    );
    const project = createProject({
      id: toProjectId('project-manifest'),
      name: 'Local project',
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await repository.save(project);

    await expect(repository.load()).resolves.toEqual(project);
  });

  it('upserts drafts and lists only the requested project', async () => {
    const storage = await createStorage();
    const first = createDraftFixture();
    const repository = new JsonDraftRepository(storage, first.projectId);
    const updated = createDraft({
      ...first,
      state: 'saved'
    });
    const otherProject = createDraft({
      ...first,
      id: toDraftId('draft-other-project'),
      projectId: toProjectId('project-other')
    });

    await repository.save(first);
    await repository.save(updated);
    await expect(repository.save(otherProject)).rejects.toThrow(
      'outside repository scope'
    );

    await expect(repository.get(first.id)).resolves.toEqual(updated);
    await expect(repository.list(first.projectId)).resolves.toEqual([updated]);
  });

  it('persists assets, files, tasks, executions and works through their ports', async () => {
    const storage = await createStorage();
    const { execution, task } = createLinkedExecutionFixture();
    const assetRepository = new JsonAssetRepository(storage, task.projectId);
    const fileRepository = new JsonFileReferenceRepository(
      storage,
      task.projectId
    );
    const taskRepository = new JsonTaskRepository(storage, task.projectId);
    const executionRepository = new JsonExecutionRepository(storage);
    const workRepository = new JsonWorkRepository(storage, task.projectId);
    const asset = createAsset({
      id: toAssetId('asset-repository'),
      projectId: task.projectId,
      fileId: toFileReferenceId('file-asset'),
      name: 'Input image',
      mediaKind: 'image',
      origin: 'imported',
      createdAt: timestamp
    });
    const work: Work = {
      schemaVersion: 1,
      id: toWorkId('work-repository'),
      projectId: task.projectId,
      sourceTaskId: task.id,
      sourceExecutionId: execution.id,
      fileId: toFileReferenceId('file-work'),
      mediaKind: 'image',
      name: 'Output image',
      createdAt: timestamp
    };
    const file = createFileReference({
      id: toFileReferenceId('file-repository'),
      projectId: task.projectId,
      sourceExecutionId: execution.id,
      locator: { kind: 'project', relativePath: 'files/output.png' },
      createdAt: timestamp
    });

    await assetRepository.save(asset);
    await fileRepository.save(file);
    await taskRepository.save(task);
    await executionRepository.save(execution);
    await workRepository.save(work);

    await expect(assetRepository.get(asset.id)).resolves.toEqual(asset);
    await expect(fileRepository.get(file.id)).resolves.toEqual(file);
    await expect(taskRepository.get(task.id)).resolves.toEqual(task);
    await expect(executionRepository.get(execution.id)).resolves.toEqual(
      execution
    );
    await expect(workRepository.get(work.id)).resolves.toEqual(work);
  });

  it('serializes executions from different tasks in one project file', async () => {
    const storage = await createStorage();
    const repository = new JsonExecutionRepository(storage);
    const first = createExecution({
      id: toExecutionId('execution-task-a'),
      taskId: toTaskId('task-a'),
      createdAt: timestamp
    });
    const second = createExecution({
      id: toExecutionId('execution-task-b'),
      taskId: toTaskId('task-b'),
      createdAt: timestamp
    });

    await Promise.all([repository.save(first), repository.save(second)]);

    await expect(repository.list(first.taskId)).resolves.toEqual([first]);
    await expect(repository.list(second.taskId)).resolves.toEqual([second]);
  });

  it('serializes concurrent saves without dropping entities', async () => {
    const storage = await createStorage();
    const base = createDraftFixture();
    const repository = new JsonDraftRepository(storage, base.projectId);
    const drafts = Array.from({ length: 20 }, (_, index) =>
      createDraft({
        ...base,
        id: toDraftId(`draft-concurrent-${index}`)
      })
    );

    await Promise.all(drafts.map((draft) => repository.save(draft)));

    await expect(repository.list(base.projectId)).resolves.toHaveLength(20);
  });

  it('rejects unknown collection versions and duplicate IDs', async () => {
    const storage = await createStorage();
    const draft = createDraftFixture();
    const repository = new JsonDraftRepository(storage, draft.projectId);

    await storage.writeJsonAtomically(projectStoragePaths.entities.drafts, {
      schemaVersion: 2,
      entities: []
    });
    await expect(repository.list(draft.projectId)).rejects.toBeInstanceOf(
      RepositoryDataError
    );

    await storage.writeJsonAtomically(projectStoragePaths.entities.drafts, {
      schemaVersion: 1,
      entities: [draft, draft]
    });
    await expect(repository.list(draft.projectId)).rejects.toThrow(
      'contains duplicate entity id'
    );

    await storage.writeJsonAtomically(projectStoragePaths.entities.drafts, {
      schemaVersion: 1,
      entities: [{ ...draft, state: 'invented_state' }]
    });
    await expect(repository.list(draft.projectId)).rejects.toThrow(
      'contains an invalid project-scoped entity'
    );
  });

  it('rejects a project manifest from another project root', async () => {
    const storage = await createStorage();
    const repository = new JsonProjectRepository(
      storage,
      toProjectId('expected-project')
    );
    const otherProject = createProject({
      id: toProjectId('other-project'),
      name: 'Other project',
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await storage.writeJsonAtomically(projectStoragePaths.manifest, otherProject);

    await expect(repository.load()).rejects.toBeInstanceOf(RepositoryDataError);
  });
});
