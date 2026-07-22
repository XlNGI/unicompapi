import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProject,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  JsonProjectRepository,
  NodeProjectStorage,
  ProjectSessionController,
  StorageIpcController,
  StorageProjectSessionRegistry
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2020-01-01T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-session-'));
  roots.push(root);
  return root;
}

async function createValidProjectRoot() {
  const root = await createRoot();
  const projectId = toProjectId('project-session');
  const storage = new NodeProjectStorage(root);
  const repository = new JsonProjectRepository(storage, projectId);
  await repository.save(
    createProject({
      id: projectId,
      name: 'Session project',
      createdAt: timestamp,
      updatedAt: timestamp
    })
  );
  return { projectId, root };
}

describe('ProjectSessionController', () => {
  it('keeps the session empty when native directory selection is cancelled', async () => {
    const registry = new StorageProjectSessionRegistry();
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => undefined
    });

    await expect(controller.openProject()).resolves.toEqual({
      ok: true,
      value: { cancelled: true }
    });
    expect(registry.get()).toBeUndefined();
  });

  it('opens a validated manifest without exposing the project root', async () => {
    const { projectId, root } = await createValidProjectRoot();
    const registry = new StorageProjectSessionRegistry();
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root
    });

    const opened = await controller.openProject();
    const current = await controller.getProjectSession();

    expect(opened).toEqual({
      ok: true,
      value: {
        cancelled: false,
        session: { projectId, projectName: 'Session project' }
      }
    });
    expect(current).toEqual({
      ok: true,
      value: { projectId, projectName: 'Session project' }
    });
    expect(JSON.stringify(opened)).not.toContain(root);
    expect(registry.get()?.rootDirectory).toBe(path.resolve(root));
  });

  it('preserves the current session when another directory is invalid', async () => {
    const { root } = await createValidProjectRoot();
    const invalidRoot = await createRoot();
    const registry = new StorageProjectSessionRegistry();
    let selectedRoot = root;
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => selectedRoot
    });
    await controller.openProject();
    const previous = registry.get();
    selectedRoot = invalidRoot;

    await expect(controller.openProject()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_project' }
    });
    expect(registry.get()).toEqual(previous);
  });

  it('shares the validated session with storage operations and clears it', async () => {
    const { root } = await createValidProjectRoot();
    const registry = new StorageProjectSessionRegistry();
    const projectController = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root
    });
    const storageController = new StorageIpcController({
      getSession: () => registry.get(),
      chooseRelinkFile: async () => undefined
    });
    await projectController.openProject();

    await expect(storageController.rebuildIndex()).resolves.toMatchObject({
      ok: true,
      value: { sourceFileCount: 0, indexedFileCount: 0 }
    });
    await expect(projectController.closeProject()).resolves.toEqual({
      ok: true,
      value: { closed: true }
    });
    await expect(storageController.rebuildIndex()).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_not_open' }
    });
  });

  it('waits for storage mutations before clearing the active session', async () => {
    const registry = new StorageProjectSessionRegistry();
    registry.set({
      projectId: toProjectId('project-waiting'),
      projectName: 'Waiting project',
      rootDirectory: 'C:\\project-waiting'
    });
    let release: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => undefined,
      beforeSessionChange: () => mutationGate
    });

    const closing = controller.closeProject();
    expect(registry.get()).toBeDefined();
    release?.();
    await closing;
    expect(registry.get()).toBeUndefined();
  });
});
