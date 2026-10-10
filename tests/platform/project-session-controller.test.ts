import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProject,
  createProjectConversation,
  toConversationId,
  toIsoTimestamp,
  toProjectId
} from '../../src/domain';
import {
  InMemoryProjectCatalogStore,
  JsonProjectConversationRepository,
  JsonProjectRepository,
  NodeProjectStorage,
  ProjectCatalogService,
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
  it('finishes history maintenance before exposing the opened project to submissions', async () => {
    const { root } = await createValidProjectRoot();
    const registry = new StorageProjectSessionRegistry();
    const order: string[] = [];
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root,
      beforeSessionChange: async () => { order.push('drained'); },
      prepareProjectStorage: async (directory) => {
        expect(directory).toBe(root);
        expect(registry.get()).toBeUndefined();
        order.push('prepared');
      },
      afterSessionChange: async () => { order.push('opened'); }
    });
    expect((await controller.openProject()).ok).toBe(true);
    expect(order).toEqual(['prepared', 'drained', 'opened']);
  });

  it('keeps legacy projects accessible when optional history maintenance fails', async () => {
    const { root } = await createValidProjectRoot();
    const registry = new StorageProjectSessionRegistry();
    const failures: unknown[] = [];
    const failure = new Error('disk full');
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root,
      prepareProjectStorage: async () => { throw failure; },
      onError: (error) => { failures.push(error); }
    });
    expect((await controller.openProject()).ok).toBe(true);
    expect(registry.get()?.rootDirectory).toBe(root);
    expect(failures).toEqual([failure]);
  });

  it('drains operations started on the old project during maintenance and serializes a later close', async () => {
    const { root, projectId } = await createValidProjectRoot();
    const registry = new StorageProjectSessionRegistry();
    const oldSession = { projectId: toProjectId('old-project'), projectName: 'Old project', rootDirectory: await createRoot() };
    registry.set(oldSession);
    const order: string[] = [];
    let finishOldOperation!: () => void;
    let markDraining!: () => void;
    let oldOperation: Promise<void> | undefined;
    const draining = new Promise<void>((resolve) => { markDraining = resolve; });
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root,
      prepareProjectStorage: async () => {
        expect(registry.get()).toBe(oldSession);
        oldOperation = new Promise<void>((resolve) => { finishOldOperation = resolve; });
        order.push('old-operation-started');
      },
      beforeSessionChange: async () => {
        markDraining();
        await oldOperation;
        order.push('drained');
      },
      afterSessionChange: async () => {
        expect(registry.get()?.projectId).toBe(projectId);
        order.push('opened');
      }
    });
    const opening = controller.openProject();
    const closing = controller.closeProject();
    await draining;
    expect(registry.get()).toBe(oldSession);
    expect(order).toEqual(['old-operation-started']);
    finishOldOperation();
    expect((await opening).ok).toBe(true);
    await closing;
    expect(order).toEqual(['old-operation-started', 'drained', 'opened', 'drained']);
    expect(registry.get()).toBeUndefined();
  });
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

  it('opens a recent project by controlled id without invoking the directory picker', async () => {
    const { projectId, root } = await createValidProjectRoot();
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    await catalog.remember({
      projectId,
      projectName: 'Session project',
      rootDirectory: root
    });
    const registry = new StorageProjectSessionRegistry();
    let pickerCalls = 0;
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => {
        pickerCalls += 1;
        return undefined;
      },
      catalog
    });

    const opened = await controller.openRecentProject({ projectId });

    expect(opened).toEqual({
      ok: true,
      value: {
        cancelled: false,
        session: { projectId, projectName: 'Session project' }
      }
    });
    expect(pickerCalls).toBe(0);
    expect(JSON.stringify(opened)).not.toContain(root);
    expect(registry.get()?.rootDirectory).toBe(path.resolve(root));
  });

  it('rejects a recent project when its catalog id no longer matches the manifest', async () => {
    const { root } = await createValidProjectRoot();
    const catalogProjectId = toProjectId('project-stale-catalog');
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    await catalog.remember({
      projectId: catalogProjectId,
      projectName: 'Stale catalog project',
      rootDirectory: root
    });
    const registry = new StorageProjectSessionRegistry();
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => undefined,
      catalog
    });

    await expect(controller.openRecentProject({
      projectId: catalogProjectId
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_open_failed' }
    });
    expect(registry.get()).toBeUndefined();
  });

  it('lists another project conversation titles without opening it or moving the catalog', async () => {
    const { projectId, root } = await createValidProjectRoot();
    const keptRoot = await createRoot();
    const keptProjectId = toProjectId('project-kept');
    const keptStorage = new NodeProjectStorage(keptRoot);
    await new JsonProjectRepository(keptStorage, keptProjectId).save(
      createProject({
        id: keptProjectId,
        name: 'Kept project',
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    await catalog.remember({
      projectId: keptProjectId,
      projectName: 'Kept project',
      rootDirectory: keptRoot
    });
    await catalog.remember({
      projectId,
      projectName: 'Session project',
      rootDirectory: root
    });
    await new JsonProjectConversationRepository(new NodeProjectStorage(root), projectId).create(
      createProjectConversation({
        id: toConversationId('conversation-sidebar'),
        projectId,
        title: 'Sidebar chat',
        createdAt: timestamp
      })
    );
    const registry = new StorageProjectSessionRegistry();
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => undefined,
      catalog
    });

    const listed = await controller.listProjectConversationSummaries({ projectId });

    expect(listed).toEqual({
      ok: true,
      value: [{
        conversationId: 'conversation-sidebar',
        projectId,
        title: 'Sidebar chat',
        status: 'active',
        updatedAt: timestamp
      }]
    });
    expect(JSON.stringify(listed)).not.toContain(root);
    expect(registry.get()).toBeUndefined();
    expect((await catalog.list()).map((item) => item.projectId)).toEqual([projectId, keptProjectId]);
    await expect(controller.listProjectConversationSummaries({
      projectId: 'project-missing'
    })).resolves.toMatchObject({ ok: false, error: { code: 'project_open_failed' } });
    expect(registry.get()).toBeUndefined();
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
      chooseRelinkFile: async () => undefined,
      chooseBackupFile: async () => undefined
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
