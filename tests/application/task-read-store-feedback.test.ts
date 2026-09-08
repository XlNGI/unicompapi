import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('keeps a failed read visible until a retry actually succeeds', async () => {
  vi.resetModules();
  const listTasks = vi.fn().mockResolvedValue({ ok: false });
  vi.stubGlobal('window', { unicomp: { storage: {
    listTasks,
    getProjectSession: async () => ({ ok: true, value: { projectId: 'project-test' } })
  } } });
  const { refreshTaskReadStore, getTaskReadSnapshot } = await import('../../src/ui/task-read-store');
  await refreshTaskReadStore();
  expect(getTaskReadSnapshot().error).toBe(true);
  let resolveRead!: (value: unknown) => void;
  listTasks.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
  const retry = refreshTaskReadStore();
  expect(getTaskReadSnapshot().error).toBe(true);
  resolveRead({ ok: true, value: { items: [], issues: [] } });
  await retry;
  expect(getTaskReadSnapshot()).toMatchObject({ error: false, loading: false, currentProjectId: 'project-test' });
});
