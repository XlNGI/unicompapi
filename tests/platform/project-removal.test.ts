import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject, createProviderInvocationAttempt, createProviderInvocationEvent, toExecutionId,
  toIsoTimestamp, toProjectId, toProviderExecutionRouteSnapshotId, toProviderInvocationAttemptId,
  toProviderInvocationEventId, toTaskId } from '../../src/domain';
import type { ExecutionState } from '../../src/domain';
import { InMemoryProjectCatalogStore, ProjectCatalogService } from '../../src/platform/ipc/project-catalog';
import { ProjectSessionController, StorageProjectSessionRegistry } from '../../src/platform/ipc/project-session-controller';
import { GlobalReadModelController } from '../../src/platform/ipc/global-read-model-controller';
import { JsonExecutionRepository, JsonProjectRepository, JsonProviderInvocationRepository } from '../../src/platform/repositories';
import { NodeProjectStorage, projectStoragePaths } from '../../src/platform/storage';

const roots: string[] = [];
const now = toIsoTimestamp('2026-10-19T00:00:00.000Z');
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^unicomp-project-removal-/);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'unicomp-project-removal-'));
  roots.push(sandbox);
  const root = path.join(sandbox, 'project');
  await mkdir(root);
  const projectId = toProjectId('project-removal');
  const store = new InMemoryProjectCatalogStore();
  const catalog = new ProjectCatalogService(store);
  const entry = { projectId, projectName: '待移除项目', rootDirectory: root };
  await catalog.remember(entry);
  const storage = new NodeProjectStorage(root);
  await new JsonProjectRepository(storage, projectId).save(createProject({ id: projectId, name: entry.projectName, createdAt: now, updatedAt: now }));
  const marker = path.join(root, 'retained.txt');
  await writeFile(marker, 'local project content');
  const registry = new StorageProjectSessionRegistry();
  const before = vi.fn(async () => {});
  const after = vi.fn(async () => {});
  const trash = vi.fn(async (target: string) => { await rename(target, path.join(sandbox, 'isolated-trash')); });
  const controller = new ProjectSessionController({ registry, chooseProjectDirectory: async () => undefined,
    catalog, beforeSessionChange: before, afterSessionChange: after, trashProjectDirectory: trash });
  return { sandbox, root, projectId, store, catalog, registry, before, after, trash, controller, entry, storage, marker };
}

describe('controlled project removal', () => {
  it('forgets a valid project without changing its files, and allows reopening it', async () => {
    const f = await fixture();
    expect(await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).toEqual({ ok: true,
      value: { projectId: f.projectId, filesTrashed: false, sessionClosed: false } });
    expect(await f.catalog.list()).toEqual([]);
    expect(await readFile(f.marker, 'utf8')).toBe('local project content');
    expect(f.trash).not.toHaveBeenCalled();
    const opener = new ProjectSessionController({ registry: f.registry, chooseProjectDirectory: async () => f.root, catalog: f.catalog });
    expect((await opener.openProject()).ok).toBe(true);
    expect((await f.catalog.list()).length).toBe(1);
  });

  it.each(['missing', 'invalid', 'file'] as const)('removes a %s project and clears its global issue without reading a valid manifest', async kind => {
    const f = await fixture();
    await rm(f.root, { recursive: true });
    if (kind === 'invalid') {
      await mkdir(f.root);
      await writeFile(path.join(f.root, 'project.json'), '{}');
      await f.storage.writeJsonAtomically(projectStoragePaths.entities.works, { schemaVersion: 1, entities: [{}] });
    }
    if (kind === 'file') await writeFile(f.root, 'not a directory');
    const reads = new GlobalReadModelController(f.catalog);
    expect((await reads.listWorks())).toMatchObject({ ok: true, value: { issues: [{ projectId: f.projectId }] } });
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(true);
    expect((await reads.listWorks())).toEqual({ ok: true, value: { items: [], issues: [] } });
    expect(f.trash).not.toHaveBeenCalled();
  });

  it('drains before closing the current session and leaves other entries intact', async () => {
    const f = await fixture();
    await f.catalog.remember({ ...f.entry, projectId: toProjectId('other-project'), rootDirectory: path.join(f.sandbox, 'other') });
    f.registry.set(f.entry);
    let finish!: () => void;
    const drained = new Promise<void>(resolve => { finish = resolve; });
    f.before.mockImplementation(async () => { await drained; });
    const result = f.controller.removeProject({ projectId: f.projectId, mode: 'forget' });
    await vi.waitFor(() => expect(f.before).toHaveBeenCalledOnce());
    expect(f.registry.get()).toBe(f.entry);
    expect((await f.catalog.getEntries()).length).toBe(2);
    finish();
    expect(await result).toMatchObject({ ok: true, value: { sessionClosed: true } });
    expect(f.registry.get()).toBeUndefined();
    expect((await f.catalog.getEntries()).map(entry => entry.projectId)).toEqual(['other-project']);
    expect(f.after).toHaveBeenCalledOnce();
  });

  it('keeps the session and files if catalog persistence fails', async () => {
    const f = await fixture();
    f.registry.set(f.entry);
    vi.spyOn(f.store, 'save').mockRejectedValue(new Error('catalog read only'));
    expect(await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).toMatchObject({ ok: false, error: { code: 'project_remove_failed' } });
    expect(f.registry.get()).toBe(f.entry);
    expect((await f.catalog.getEntries()).length).toBe(1);
    expect(await readFile(f.marker, 'utf8')).toBe('local project content');
  });

  it('keeps the current project if its drain guard fails', async () => {
    const f = await fixture();
    f.registry.set(f.entry);
    f.before.mockRejectedValue(new Error('busy'));
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(false);
    expect(f.registry.get()).toBe(f.entry);
    expect((await f.catalog.getEntries()).length).toBe(1);
  });

  it('does not confuse post-removal maintenance failure with removal failure', async () => {
    const f = await fixture();
    f.registry.set(f.entry);
    f.after.mockRejectedValue(new Error('watcher disconnected'));
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(true);
    expect(f.registry.get()).toBeUndefined();
    expect(await f.catalog.getEntries()).toEqual([]);
  });

  it.each([null, {}, { projectId: '', mode: 'forget' }, { projectId: 'project-removal', mode: 'delete' },
    { projectId: 'project-removal', mode: 'trash', rootDirectory: 'C:\\' }])('rejects invalid or path-bearing requests: %j', async request => {
    const f = await fixture();
    expect(await f.controller.removeProject(request)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(f.trash).not.toHaveBeenCalled();
    expect((await f.catalog.getEntries()).length).toBe(1);
  });

  it('makes removal retries idempotent without repeating native trash', async () => {
    const f = await fixture();
    const request = { projectId: f.projectId, mode: 'trash' };
    expect(await f.controller.removeProject(request)).toMatchObject({ ok: true, value: { filesTrashed: true } });
    expect(await f.controller.removeProject(request)).toMatchObject({ ok: true, value: { filesTrashed: false } });
    expect(f.trash).toHaveBeenCalledTimes(1);
    expect(f.trash).toHaveBeenCalledWith(f.root);
    expect(await readFile(path.join(f.sandbox, 'isolated-trash', 'retained.txt'), 'utf8')).toBe('local project content');
  });

  it('retains a record when native trash fails so the user can retry with forget', async () => {
    const f = await fixture();
    f.trash.mockRejectedValue(new Error('volume does not support trash'));
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect((await f.catalog.getEntries()).length).toBe(1);
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(true);
    expect(await readFile(f.marker, 'utf8')).toBe('local project content');
  });

  it('lets stale catalog records be removed if native trash succeeded but catalog saving failed', async () => {
    const f = await fixture();
    const save = vi.spyOn(f.store, 'save').mockRejectedValueOnce(new Error('disk full'));
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect((await f.catalog.getEntries()).length).toBe(1);
    save.mockRestore();
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(true);
    expect(f.trash).toHaveBeenCalledTimes(1);
  });

  it('rejects trashing the currently open project', async () => {
    const f = await fixture();
    f.registry.set(f.entry);
    expect(await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).toMatchObject({ ok: false, error: { code: 'project_in_use' } });
    expect(f.registry.get()).toBe(f.entry);
    expect(f.trash).not.toHaveBeenCalled();
  });

  it.each(['missing', 'mismatch', 'corrupt', 'nested', 'alias'] as const)('rejects unsafe trash target: %s', async kind => {
    const f = await fixture();
    if (kind === 'missing') await rm(f.root, { recursive: true });
    if (kind === 'mismatch') await writeFile(path.join(f.root, 'project.json'), JSON.stringify(createProject({ id: toProjectId('other-id'), name: 'other', createdAt: now, updatedAt: now })));
    if (kind === 'corrupt') await writeFile(path.join(f.root, 'project.json'), '{}');
    if (kind === 'nested') await f.catalog.remember({ ...f.entry, projectId: toProjectId('nested-id'), rootDirectory: path.join(f.root, 'nested') });
    if (kind === 'alias') {
      const alias = path.join(f.sandbox, 'alias');
      await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await f.catalog.remember({ ...f.entry, rootDirectory: alias });
    }
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect(f.trash).not.toHaveBeenCalled();
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(true);
  });

  it.each<ExecutionState>(['submitting', 'processing', 'encoding', 'writing_file', 'submission_outcome_unknown', 'recovery_required'])('blocks trash for unresolved operation: %s', async state => {
    const f = await fixture();
    await new JsonExecutionRepository(f.storage).save({ schemaVersion: 1, id: toExecutionId('unfinished'),
      taskId: toTaskId('unfinished-task'), attempt: 1, state, createdAt: now, updatedAt: now });
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect(f.trash).not.toHaveBeenCalled();
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'forget' })).ok).toBe(true);
  });

  it('fails closed if operation history cannot be validated', async () => {
    const f = await fixture();
    await f.storage.writeJsonAtomically(projectStoragePaths.entities.executions, { schemaVersion: 1, entities: [{}] });
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect(f.trash).not.toHaveBeenCalled();
  });

  it('protects application data directories even if they contain a valid project manifest', async () => {
    const f = await fixture();
    const controller = new ProjectSessionController({ registry: f.registry, catalog: f.catalog,
      chooseProjectDirectory: async () => undefined, trashProjectDirectory: f.trash,
      protectedDirectories: [path.join(f.root, 'application-data')] });
    expect((await controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect(f.trash).not.toHaveBeenCalled();
  });

  it('protects a current project nested inside the selected directory', async () => {
    const f = await fixture();
    f.registry.set({ ...f.entry, projectId: toProjectId('nested-current'), rootDirectory: path.join(f.root, 'nested-current') });
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect(f.trash).not.toHaveBeenCalled();
    expect(f.registry.get()?.projectId).toBe('nested-current');
  });

  it('protects provider operations even without a generic execution record', async () => {
    const f = await fixture();
    const attempt = createProviderInvocationAttempt({ id: toProviderInvocationAttemptId('unfinished-provider'),
      projectId: f.projectId, subject: { kind: 'media', taskId: toTaskId('task'), executionId: toExecutionId('execution') },
      routeSnapshotId: toProviderExecutionRouteSnapshotId('route'), createdAt: now });
    await new JsonProviderInvocationRepository(f.storage, f.projectId).create(attempt,
      createProviderInvocationEvent({ id: toProviderInvocationEventId('started'), invocationAttemptId: attempt.id,
        sequence: 1, type: 'submission_started', occurredAt: now }));
    expect((await f.controller.removeProject({ projectId: f.projectId, mode: 'trash' })).ok).toBe(false);
    expect(f.trash).not.toHaveBeenCalled();
    expect((await f.catalog.getEntries()).length).toBe(1);
  });

  it('serializes open and remove so the removed project cannot remain the active session', async () => {
    const f = await fixture();
    const opened = f.controller.openRecentProject({ projectId: f.projectId });
    const removed = f.controller.removeProject({ projectId: f.projectId, mode: 'forget' });
    expect((await opened).ok).toBe(true);
    expect((await removed).ok).toBe(true);
    expect(f.registry.get()).toBeUndefined();
    expect(await f.catalog.getEntries()).toEqual([]);
  });
});
