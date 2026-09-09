import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  parseSettingsDocument,
  type ProxyMode,
  type SettingsDocumentV1,
  type SettingsValues
} from '../../src/domain';
import type { ProxyTestResultDto } from '../../src/shared/settings-ipc';
import {
  InMemorySettingsRepository,
  NotificationService,
  PrivacyPermissionService,
  ProxyService,
  SecureCredentialVault,
  SettingsController,
  SettingsDataError,
  ShortcutService,
  type CredentialProtector,
  type ProxyPlatformAdapter,
  type SettingsB3Services,
  type SettingsLoadResult,
  type SettingsRepository,
  type ShortcutPlatformAdapter
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('SettingsController B3 operations', () => {
  it('advertises B3 capabilities without making B4 capabilities available', async () => {
    const { controller } = await fixture();
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        capabilities: expect.arrayContaining([
          expect.objectContaining({ id: 'permission_controls', state: 'available' }),
          expect.objectContaining({ id: 'proxy_controls', state: 'available' }),
          expect.objectContaining({ id: 'notification_controls', state: 'available' }),
          expect.objectContaining({ id: 'shortcut_controls', state: 'available' }),
          expect.objectContaining({ id: 'diagnostics', state: 'unavailable' }),
          expect.objectContaining({ id: 'updates', state: 'unavailable' })
        ])
      }
    });
  });

  it('keeps proxy credentials out of plans and snapshots after confirmation', async () => {
    const { controller } = await fixture();
    const value: ProxyMode = {
      kind: 'custom',
      protocol: 'https',
      host: '127.0.0.1',
      port: 8443,
      authenticationConfigured: true
    };
    const staged = await controller.stageProxyCredential({
      username: 'proxy-user',
      value: 'never-echo-fixture'
    });
    if (!staged.ok) throw new Error('proxy credential staging failed');
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'update_proxy',
        value,
        credentialHandle: staged.value.credentialHandle
      }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        blockers: [],
        warnings: ['changes_apply_to_new_requests_only', 'active_requests_are_not_retried']
      }
    });
    expect(JSON.stringify(planned)).not.toContain('never-echo-fixture');
    if (!planned.ok) throw new Error('proxy planning failed');
    const executed = await controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    });
    expect(executed).toMatchObject({
      ok: true,
      value: { revision: 1, values: { network: { proxy: value } } }
    });
    expect(JSON.stringify(executed)).not.toContain('proxy-user');
    expect(JSON.stringify(executed)).not.toContain('never-echo-fixture');
  });

  it('blocks a failed proxy probe and preserves the old setting', async () => {
    const { controller, proxyAdapter } = await fixture();
    proxyAdapter.probeResult = { ok: false, failure: 'certificate' };
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'update_proxy',
        value: {
          kind: 'custom', protocol: 'http', host: 'proxy.invalid', port: 8080,
          authenticationConfigured: false
        }
      }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: { blockers: ['proxy_test_certificate'] }
    });
    if (!planned.ok) throw new Error('proxy planning failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({ ok: false, error: { code: 'operation_blocked' } });
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { revision: 0, values: { network: { proxy: { kind: 'system_default' } } } }
    });
    expect(proxyAdapter.applied).toEqual([]);
  });

  it('rolls proxy runtime back when settings persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-controller-'));
    roots.push(root);
    const proxyAdapter = new ControllerProxyAdapter();
    const document = createDefaultSettings('2026-07-27T00:00:00.000Z');
    const repository = new FailingSettingsRepository(document);
    const b3 = createB3(root, proxyAdapter);
    const controller = new SettingsController(
      repository,
      () => '2026-07-27T00:00:01.000Z',
      () => 'confirm-rollback',
      60_000,
      undefined,
      b3
    );
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'update_proxy', value: { kind: 'direct' } }
    });
    if (!planned.ok) throw new Error('proxy planning failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({ ok: false, error: { code: 'settings_write_failed' } });
    expect(proxyAdapter.applied.map((item) => item.kind)).toEqual([
      'direct',
      'system_default'
    ]);
  });

  it('routes network restore-default through the proxy transaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-controller-'));
    roots.push(root);
    const proxyAdapter = new ControllerProxyAdapter();
    const defaults = createDefaultSettings('2026-07-27T00:00:00.000Z');
    const document = parseSettingsDocument({
      ...defaults,
      network: { ...defaults.network, proxy: { kind: 'direct' } }
    });
    const controller = new SettingsController(
      new InMemorySettingsRepository(document),
      () => '2026-07-27T00:00:00.000Z',
      () => 'confirm-network-default',
      60_000,
      undefined,
      createB3(root, proxyAdapter)
    );
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'restore_category_defaults', category: 'network' }
    });
    if (!planned.ok) throw new Error('network default planning failed');
    await expect(controller.executeOperation({
      confirmationHandle: planned.value.confirmationHandle
    })).resolves.toMatchObject({
      ok: true,
      value: { values: { network: { proxy: { kind: 'system_default' } } } }
    });
    expect(proxyAdapter.applied).toEqual([{ kind: 'system_default' }]);
  });

  it('rejects conflicting shortcuts before save and isolates platform bindings', async () => {
    const { controller } = await fixture();
    const first = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'update_shortcuts',
        platform: 'windows',
        bindings: [
          { actionId: 'show_app', accelerator: 'Control+K' },
          { actionId: 'focus_search', accelerator: 'Control+K' }
        ]
      }
    });
    expect(first).toMatchObject({ ok: true, value: { blockers: ['shortcut_conflict'] } });

    const macPlan = await controller.planOperation({
      expectedRevision: 0,
      operation: {
        kind: 'update_shortcuts',
        platform: 'macos',
        bindings: [{ actionId: 'show_app', accelerator: 'Command+Shift+U' }]
      }
    });
    if (!macPlan.ok) throw new Error('shortcut planning failed');
    const executed = await controller.executeOperation({
      confirmationHandle: macPlan.value.confirmationHandle
    });
    expect(executed).toMatchObject({
      ok: true,
      value: {
        values: {
          shortcuts: {
            bindings: [{
              actionId: 'show_app', windows: 'Control+Alt+U', macos: 'Command+Shift+U'
            }]
          }
        }
      }
    });
  });

  it('requires impact planning for privacy changes and keeps mandatory policies fixed', async () => {
    const { controller } = await fixture();
    const snapshot = await controller.getSnapshot();
    if (!snapshot.ok) throw new Error('snapshot failed');
    const privacy = {
      ...snapshot.value.values.privacy,
      readProjectContext: false
    };
    const values: SettingsValues = { ...snapshot.value.values, privacy };
    await expect(controller.updateValues({ expectedRevision: 0, values })).resolves.toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' }
    });
    const planned = await controller.planOperation({
      expectedRevision: 0,
      operation: { kind: 'update_privacy_permissions', values: privacy }
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        affectedCategories: ['privacy'],
        warnings: ['mandatory_outbound_and_cost_confirmations_remain_enabled']
      }
    });
  });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-controller-'));
  roots.push(root);
  const proxyAdapter = new ControllerProxyAdapter();
  const b3 = createB3(root, proxyAdapter);
  let handle = 0;
  const controller = new SettingsController(
    new InMemorySettingsRepository(
      createDefaultSettings('2026-07-27T00:00:00.000Z'),
      () => '2026-07-27T00:00:01.000Z'
    ),
    () => '2026-07-27T00:00:00.000Z',
    () => `confirm-b3-${++handle}`,
    60_000,
    undefined,
    b3
  );
  return { controller, proxyAdapter };
}

function createB3(root: string, proxyAdapter: ControllerProxyAdapter): SettingsB3Services {
  const shortcutAdapter: ShortcutPlatformAdapter = {
    register: () => true,
    unregister: () => undefined
  };
  return {
    privacy: new PrivacyPermissionService({
      async getStatus() {
        return { state: 'unknown', reason: 'not_queryable' };
      },
      async openSystemSettings() {}
    }),
    proxy: new ProxyService(
      proxyAdapter,
      new SecureCredentialVault(
        path.join(root, 'settings', 'proxy-credentials.json'),
        protector()
      ),
      () => '2026-07-27T00:00:00.000Z'
    ),
    notifications: new NotificationService({
      async getSystemCapability() {
        return { id: 'system_notifications', state: 'unknown' };
      },
      async getSoundCapability() {
        return { id: 'notification_sound', state: 'available' };
      },
      async sendTest() {
        return 'accepted';
      },
      async playSound() {
        return 'accepted';
      }
    }),
    shortcuts: new ShortcutService('windows', shortcutAdapter)
  };
}

class ControllerProxyAdapter implements ProxyPlatformAdapter {
  probeResult: ProxyTestResultDto = {
    ok: true,
    reachedAt: '2026-07-27T00:00:00.000Z'
  };
  readonly applied: ProxyMode[] = [];

  async probe() {
    return this.probeResult;
  }

  async apply(input: { readonly mode: ProxyMode }): Promise<void> {
    this.applied.push(input.mode);
  }
}

class FailingSettingsRepository implements SettingsRepository {
  constructor(private readonly document: SettingsDocumentV1) {}

  async load(): Promise<SettingsLoadResult> {
    return { document: this.document, source: 'primary' };
  }

  async replace(_expectedRevision: number, _values: SettingsValues): Promise<SettingsLoadResult> {
    throw new SettingsDataError('injected write failure');
  }
}

function protector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
    unprotect: (value) => Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8')
  };
}
