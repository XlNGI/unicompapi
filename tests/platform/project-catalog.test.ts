import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryProjectCatalogStore,
  ProjectCatalogService,
  ProjectSessionController,
  StorageProjectSessionRegistry
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-catalog-'));
  roots.push(root);
  return root;
}

describe('ProjectCatalogService', () => {
  it('stores recent projects without exposing their paths in DTOs', async () => {
    const root = await createRoot();
    const catalog = new ProjectCatalogService(
      new InMemoryProjectCatalogStore(),
      () => '2020-01-01T00:00:00.000Z'
    );

    await catalog.remember({
      projectId: 'project-catalog' as never,
      projectName: 'Catalog project',
      rootDirectory: root
    });

    const result = await catalog.list();
    expect(result).toEqual([
      {
        projectId: 'project-catalog',
        projectName: 'Catalog project',
        availability: 'available',
        lastOpenedAt: '2020-01-01T00:00:00.000Z'
      }
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});

describe('ProjectSessionController.createProject', () => {
  it('creates an empty project, initializes directories, and opens its session', async () => {
    const root = await createRoot();
    const catalog = new ProjectCatalogService(new InMemoryProjectCatalogStore());
    const registry = new StorageProjectSessionRegistry();
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root,
      catalog
    });

    const result = await controller.createProject({ name: 'Created project' });

    expect(result).toMatchObject({
      ok: true,
      value: {
        cancelled: false,
        session: { projectName: 'Created project' }
      }
    });
    expect(registry.get()?.rootDirectory).toBe(path.resolve(root));
    await expect(readFile(path.join(root, 'project.json'), 'utf8')).resolves.toContain(
      'Created project'
    );
    await expect(stat(path.join(root, 'entities'))).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
    await expect(stat(path.join(root, 'index'))).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
    expect((await catalog.list())[0]?.projectName).toBe('Created project');
  });

  it('rejects a non-empty directory without replacing the current session', async () => {
    const root = await createRoot();
    await writeFile(path.join(root, 'existing.txt'), 'existing', 'utf8');
    const registry = new StorageProjectSessionRegistry();
    const controller = new ProjectSessionController({
      registry,
      chooseProjectDirectory: async () => root
    });

    await expect(controller.createProject({ name: 'Conflict project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'project_create_failed' }
    });
    expect(registry.get()).toBeUndefined();
  });
});
