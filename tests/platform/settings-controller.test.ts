import { describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  exportPortableSettings,
  parseSettingsValues,
  toSettingsValues
} from '../../src/domain';
import {
  InMemorySettingsRepository,
  SettingsController
} from '../../src/platform';

function fixture() {
  let now = '2026-07-27T00:00:00.000Z';
  let handle = 0;
  const repository = new InMemorySettingsRepository(
    createDefaultSettings(now),
    () => now
  );
  const controller = new SettingsController(
    repository,
    () => now,
    () => `confirm-${++handle}`,
    60_000
  );
  return {
    controller,
    repository,
    setNow(value: string) { now = value; }
  };
}

describe('SettingsController', () => {
  it('returns honest B1 capabilities and persists ordinary preferences', async () => {
    const { controller } = fixture();
    const initial = await controller.getSnapshot();
    expect(initial).toMatchObject({
      ok: true,
      value: {
        revision: 0,
        statuses: { repository: 'primary', schemaVersion: 1 }
      }
    });
    if (!initial.ok) throw new Error('snapshot failed');
    expect(initial.value.capabilities).toContainEqual({
      id: 'settings_persistence',
      state: 'available'
    });
    expect(initial.value.capabilities).toContainEqual({
      id: 'platform_capability_detection',
      state: 'unavailable',
      reason: 'phase8_platform_adapter_pending'
    });
    const values = parseSettingsValues({
      ...initial.value.values,
      general: { ...initial.value.values.general, theme: 'dark' }
    });
    const updated = await controller.updateValues({ expectedRevision: 0, values });
    expect(updated).toMatchObject({
      ok: true,
      value: { revision: 1, values: { general: { theme: 'dark' } } }
    });
  });

  it('blocks high-risk changes from the ordinary update surface', async () => {
    const { controller } = fixture();
    const initial = await controller.getSnapshot();
    if (!initial.ok) throw new Error('snapshot failed');
    const values = parseSettingsValues({
      ...initial.value.values,
      performance: {
        ...initial.value.values.performance,
        mode: 'high_performance'
      }
    });
    await expect(
      controller.updateValues({ expectedRevision: 0, values })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' }
    });
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { revision: 0 }
    });
  });

  it('plans and executes a category reset through a one-time handle', async () => {
    const { controller } = fixture();
    const initial = await controller.getSnapshot();
    if (!initial.ok) throw new Error('snapshot failed');
    const changed = parseSettingsValues({
      ...initial.value.values,
      general: { ...initial.value.values.general, theme: 'dark' }
    });
    const updated = await controller.updateValues({ expectedRevision: 0, values: changed });
    if (!updated.ok) throw new Error('update failed');

    const planned = await controller.planOperation({
      expectedRevision: 1,
      operation: { kind: 'restore_category_defaults', category: 'general' }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        kind: 'restore_category_defaults',
        affectedCategories: ['general'],
        reversible: true,
        blockers: []
      }
    });
    if (!planned.ok) throw new Error('plan failed');
    const executed = await controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    });
    expect(executed).toMatchObject({
      ok: true,
      value: { revision: 2, values: { general: { theme: 'system' } } }
    });
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_not_found' }
    });
  });

  it('invalidates expired and stale plans before writing', async () => {
    const expired = fixture();
    const expiredPlan = await expired.controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'restore_all_defaults' }
    });
    if (!expiredPlan.ok) throw new Error('plan failed');
    expired.setNow('2026-07-27T00:02:00.000Z');
    await expect(expired.controller.executeOperation({
      confirmationHandle: expiredPlan.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_expired' }
    });

    const stale = fixture();
    const stalePlan = await stale.controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'restore_all_defaults' }
    });
    if (!stalePlan.ok) throw new Error('plan failed');
    const snapshot = await stale.controller.getSnapshot();
    if (!snapshot.ok) throw new Error('snapshot failed');
    const ordinary = parseSettingsValues({
      ...snapshot.value.values,
      general: { ...snapshot.value.values.general, theme: 'dark' }
    });
    await stale.controller.updateValues({ expectedRevision: 0, values: ordinary });
    await expect(stale.controller.executeOperation({
      confirmationHandle: stalePlan.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', actualRevision: 1 }
    });
  });

  it('prepares portable imports without exposing device-bound settings', async () => {
    const { controller, repository } = fixture();
    const current = await repository.load();
    const portable = exportPortableSettings(toSettingsValues(current.document));
    const changedPortable = {
      ...portable,
      general: { ...portable.general, theme: 'light' as const }
    };
    const planned = await controller.prepareImport({
      expectedRevision: 0,
      document: changedPortable
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        kind: 'import_portable_settings',
        affectedCategories: ['general']
      }
    });
    await expect(controller.exportPortable()).resolves.toMatchObject({
      ok: true,
      value: { schemaVersion: 1 }
    });
  });

  it('rejects malformed requests without returning internal errors', async () => {
    const { controller } = fixture();
    await expect(controller.updateValues({ expectedRevision: 0, values: {}, extra: true }))
      .resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Settings values are invalid' }
      });
    await expect(controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'clear_everything_without_confirmation' }
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_unsupported' }
    });
  });
});
