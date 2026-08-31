import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, parseSettingsDocument } from '../../src/domain';
import {
  CleanupService,
  DirectoryMigrationService,
  InMemorySettingsRepository,
  JsonDirectoryRegistry,
  MediaSettingsStatusService,
  PerformancePolicyService,
  SettingsController
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-settings-b2-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const userData = path.join(root, 'user-data');
  await mkdir(source);
  await mkdir(target);
  await mkdir(userData);
  await writeFile(path.join(source, 'project.json'), '{"name":"project"}');
  let id = 0;
  const registry = new JsonDirectoryRegistry(
    path.join(userData, 'settings', 'directories.json'),
    () => '2026-07-27T00:00:00.000Z',
    () => `1000000${++id}`
  );
  const sourceEntry = await registry.register('projects', source);
  const targetEntry = await registry.register('projects', target);
  const defaults = createDefaultSettings('2026-07-27T00:00:00.000Z');
  const document = parseSettingsDocument({
    ...defaults,
    storage: {
      ...defaults.storage,
      directories: { ...defaults.storage.directories, projects: sourceEntry.id }
    }
  });
  let handle = 0;
  const controller = new SettingsController(
    new InMemorySettingsRepository(document, () => '2026-07-27T00:00:01.000Z'),
    () => '2026-07-27T00:00:00.000Z',
    () => `confirm-b2-${++handle}`,
    60_000,
    {
      userDataPath: userData,
      directoryRegistry: registry,
      directoryMigration: new DirectoryMigrationService(registry, {
        createPlanId: () => 'controller-migration'
      }),
      cleanup: new CleanupService(userData, registry),
      performance: new PerformancePolicyService(() => ({
        logicalCpuCount: 4,
        totalMemoryBytes: 8 * 1024 ** 3,
        freeMemoryBytes: 4 * 1024 ** 3,
        loadAverageOneMinute: null
      })),
      media: new MediaSettingsStatusService(() => undefined)
    }
  );
  return { controller, root, source, target, targetEntry, userData };
}

describe('SettingsController B2 operations', () => {
  it('returns path-free system facts and B2 capability availability', async () => {
    const { controller, root } = await fixture();
    const snapshot = await controller.getSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        capabilities: expect.arrayContaining([
          { id: 'directory_operations', state: 'available' },
          { id: 'task_policy', state: 'available' },
          { id: 'media_components', state: 'available' }
        ])
      }
    });
    const status = await controller.getSystemStatus();
    expect(status).toMatchObject({
      ok: true,
      value: {
        storage: { directories: expect.any(Array) },
        performance: { changesApplyTo: 'new_tasks_and_attempts' },
        media: { engine: { state: 'unavailable' } }
      }
    });
    expect(JSON.stringify(status)).not.toContain(root);
  });

  it('migrates verified data and switches the opaque setting only after confirmation', async () => {
    const { controller, source, target, targetEntry } = await fixture();
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'migrate_directory',
        purpose: 'projects',
        targetDirectoryId: targetEntry.id
      }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        kind: 'migrate_directory',
        affectedCategories: ['storage'],
        blockers: [],
        impact: { fileCount: 1, oldLocationRetained: true }
      }
    });
    if (!planned.ok) throw new Error('migration plan failed');
    const executed = await controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    });
    expect(executed).toMatchObject({
      ok: true,
      value: {
        revision: 1,
        values: { storage: { directories: { projects: targetEntry.id } } }
      }
    });
    await expect(readFile(path.join(target, 'project.json'), 'utf8'))
      .resolves.toContain('project');
    await expect(readFile(path.join(source, 'project.json'), 'utf8'))
      .resolves.toContain('project');
  });

  it('reports migration conflicts as non-executable blockers', async () => {
    const { controller, target, targetEntry } = await fixture();
    await writeFile(path.join(target, 'existing.bin'), 'conflict');
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'migrate_directory',
        purpose: 'projects',
        targetDirectoryId: targetEntry.id
      }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: { blockers: ['target_conflict'] }
    });
    if (!planned.ok) throw new Error('blocked plan failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_blocked' }
    });
  });

  it('confirms performance changes without mutating an active task', async () => {
    const { controller } = await fixture();
    const snapshot = await controller.getSnapshot();
    if (!snapshot.ok) throw new Error('snapshot failed');
    const performance = {
      ...snapshot.value.values.performance,
      mode: 'high_performance' as const,
      concurrency: {
        ...snapshot.value.values.performance.concurrency,
        localVideo: 2
      }
    };
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'update_performance', values: performance }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        affectedCategories: ['performance'],
        warnings: ['changes_apply_only_to_new_tasks_and_attempts'],
        impact: { activeTasksUnaffected: true }
      }
    });
    if (!planned.ok) throw new Error('performance plan failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, values: { performance: { mode: 'high_performance' } } }
    });
  });

  it('keeps unapproved hardware blocked while software fallback remains true', async () => {
    const { controller } = await fixture();
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'update_hardware_acceleration',
        value: 'prefer_hardware'
      }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        blockers: ['hardware_acceleration_not_approved'],
        warnings: ['software_export_remains_available']
      }
    });
    if (!planned.ok) throw new Error('hardware plan failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({ ok: false, error: { code: 'operation_blocked' } });
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { values: { media: { automaticSoftwareFallback: true } } }
    });
  });

  it('plans cleanup before deleting only eligible app data', async () => {
    const { controller, userData } = await fixture();
    const cache = path.join(userData, 'cache', 'rebuildable.bin');
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, 'cache');
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'cleanup_storage', scopes: ['caches'] }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        reversible: false,
        impact: { fileCount: 1, bytes: 5 }
      }
    });
    if (!planned.ok) throw new Error('cleanup plan failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({ ok: true, value: { revision: 0 } });
    await expect(readFile(cache)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
