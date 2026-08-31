import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  exportPortableSettings,
  parseSettingsValues,
  toSettingsValues
} from '../../src/domain';
import {
  ApplicationDataService,
  DiagnosticsService,
  InMemorySettingsRepository,
  SettingsController,
  UpdatesService,
  type SettingsB4Services
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SettingsController B4 operations', () => {
  it('advertises local diagnostics while keeping production updates unavailable', async () => {
    const { controller } = await fixture();
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        capabilities: expect.arrayContaining([
          { id: 'diagnostics', state: 'available', reason: 'local_only_no_upload' },
          { id: 'updates', state: 'unavailable', reason: 'production_update_source_not_configured' }
        ])
      }
    });
    await expect(controller.getMaintenanceStatus()).resolves.toMatchObject({
      ok: true,
      value: {
        diagnostics: { logging: { localOnly: true, automaticUpload: false } },
        updates: { capability: { state: 'unavailable' } }
      }
    });
    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      ok: true,
      value: { updates: { items: expect.arrayContaining([
        expect.objectContaining({ kind: 'application', canInstall: false })
      ]) } }
    });
  });

  it('executes a portable import only after the one-time confirmation', async () => {
    const { controller, repository } = await fixture();
    const current = await repository.load();
    const document = exportPortableSettings(toSettingsValues(current.document));
    const changed = { ...document, general: { ...document.general, theme: 'dark' as const } };
    const planned = await controller.prepareImport({ expectedRevision: 0, document: changed });
    if (!planned.ok) throw new Error('import plan failed');
    expect(planned.value).toMatchObject({
      kind: 'import_portable_settings',
      affectedCategories: ['general'],
      reversible: true
    });
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { revision: 0, values: { general: { theme: 'system' } } }
    });
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, values: { general: { theme: 'dark' } } }
    });
  });

  it('keeps reset settings distinct from clearing local application data', async () => {
    const { controller, root } = await fixture();
    const credential = path.join(root, 'secure-credentials.json');
    await writeFile(credential, 'encrypted-fixture');
    const initial = await controller.getSnapshot();
    if (!initial.ok) throw new Error('snapshot failed');
    const changed = parseSettingsValues({
      ...initial.value.values,
      general: { ...initial.value.values.general, theme: 'dark' }
    });
    await controller.updateValues({ expectedRevision: 0, values: changed });

    const reset = await controller.planOperation({
      expectedRevision: 1,
      operation: { kind: 'restore_all_defaults' }
    });
    if (!reset.ok) throw new Error('reset plan failed');
    expect(reset.value.reversible).toBe(true);
    await controller.executeOperation({ confirmationHandle: reset.value.confirmationHandle });
    await expect(readFile(credential, 'utf8')).resolves.toBe('encrypted-fixture');

    const clear = await controller.planOperation({
      expectedRevision: 2,
      operation: {
        kind: 'clear_local_application_data',
        scopes: ['local_credentials']
      }
    });
    if (!clear.ok) throw new Error('clear plan failed');
    expect(clear.value).toMatchObject({
      reversible: false,
      impact: {
        credentialsDeleted: true,
        projectsExcluded: true,
        externalFilesExcluded: true
      }
    });
    await controller.executeOperation({ confirmationHandle: clear.value.confirmationHandle });
    await expect(stat(credential)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects duplicate or unknown clear-data scopes', async () => {
    const { controller } = await fixture();
    await expect(controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'clear_local_application_data', scopes: ['logs', 'logs'] }
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'clear_local_application_data', scopes: ['projects'] }
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b4-controller-'));
  roots.push(root);
  await mkdir(path.join(root, 'logs'), { recursive: true });
  const repository = new InMemorySettingsRepository(
    createDefaultSettings('2026-07-27T00:00:00.000Z'),
    () => '2026-07-27T00:00:01.000Z'
  );
  const b4: SettingsB4Services = {
    diagnostics: new DiagnosticsService(root, () => '2026-07-27T00:00:00.000Z'),
    updates: new UpdatesService('0.1.0', () => '2026-07-27T00:00:00.000Z'),
    applicationData: new ApplicationDataService(root)
  };
  let handle = 0;
  const controller = new SettingsController(
    repository,
    () => '2026-07-27T00:00:00.000Z',
    () => `confirm-b4-${++handle}`,
    60_000,
    undefined,
    undefined,
    b4
  );
  return { controller, repository, root };
}
