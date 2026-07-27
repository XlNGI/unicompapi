import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  parseSettingsValues,
  toSettingsValues
} from '../../src/domain';
import {
  JsonSettingsRepository,
  SettingsDataError,
  SettingsRevisionConflictError,
  migrateSettingsDocument
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-settings-'));
  roots.push(root);
  let tick = 0;
  const repository = new JsonSettingsRepository(
    path.join(root, 'settings.json'),
    () => `2026-07-27T00:00:0${tick++}.000Z`
  );
  return { root, repository };
}

describe('JsonSettingsRepository', () => {
  it('creates defaults and atomically persists validated revisions', async () => {
    const { root, repository } = await fixture();
    const initial = await repository.load();
    expect(initial.source).toBe('default');
    expect(initial.document.revision).toBe(0);

    const values = parseSettingsValues({
      ...toSettingsValues(initial.document),
      general: { ...initial.document.general, theme: 'dark' }
    });
    const saved = await repository.replace(0, values);
    expect(saved.document).toMatchObject({ revision: 1, general: { theme: 'dark' } });
    expect(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      revision: 1
    });
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('serializes competing writers and rejects the stale revision', async () => {
    const { repository } = await fixture();
    const initial = await repository.load();
    const first = parseSettingsValues({
      ...toSettingsValues(initial.document),
      general: { ...initial.document.general, theme: 'dark' }
    });
    const second = parseSettingsValues({
      ...toSettingsValues(initial.document),
      general: { ...initial.document.general, theme: 'light' }
    });

    const results = await Promise.allSettled([
      repository.replace(0, first),
      repository.replace(0, second)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(SettingsRevisionConflictError)
    });
    expect((await repository.load()).document.revision).toBe(1);
  });

  it('uses the last verified backup without overwriting corrupted evidence', async () => {
    const { root, repository } = await fixture();
    const initial = await repository.load();
    const dark = parseSettingsValues({
      ...toSettingsValues(initial.document),
      general: { ...initial.document.general, theme: 'dark' }
    });
    await repository.replace(0, dark);
    const light = parseSettingsValues({
      ...dark,
      general: { ...dark.general, theme: 'light' }
    });
    await repository.replace(1, light);

    const settingsPath = path.join(root, 'settings.json');
    await writeFile(settingsPath, '{corrupted', 'utf8');
    const recovered = await repository.load();
    expect(recovered.source).toBe('backup');
    expect(recovered.document).toMatchObject({ revision: 1, general: { theme: 'dark' } });
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{corrupted');
  });

  it('fails closed when primary and backup are both invalid', async () => {
    const { root, repository } = await fixture();
    await writeFile(path.join(root, 'settings.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'settings.json.bak'), '{}', 'utf8');
    await expect(repository.load()).rejects.toBeInstanceOf(SettingsDataError);
  });
});

describe('settings migrations', () => {
  it('requires explicit sequential migrations and rejects future versions', () => {
    const defaults = createDefaultSettings('2026-07-27T00:00:00.000Z');
    const migrated = migrateSettingsDocument(
      { schemaVersion: 0, theme: 'dark' },
      [{
        fromVersion: 0,
        toVersion: 1,
        migrate: () => ({
          ...defaults,
          general: { ...defaults.general, theme: 'dark' }
        })
      }]
    );
    expect(migrated.general.theme).toBe('dark');
    expect(() => migrateSettingsDocument({ schemaVersion: 0 })).toThrow(
      'No settings migration exists'
    );
    expect(() => migrateSettingsDocument({ schemaVersion: 2 })).toThrow(
      'newer than supported'
    );
  });
});
