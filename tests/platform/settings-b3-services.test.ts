import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProxyMode, ShortcutSettings } from '../../src/domain';
import type { ProxyTestResultDto } from '../../src/shared/settings-ipc';
import {
  NotificationService,
  PrivacyPermissionService,
  ProxyService,
  SecureCredentialVault,
  ShortcutOperationError,
  ShortcutService,
  proxyCredentialReference,
  type CredentialProtector,
  type NativePermissionAdapter,
  type NotificationPlatformAdapter,
  type ProxyPlatformAdapter,
  type ShortcutPlatformAdapter
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('phase 8 B3 platform services', () => {
  it('exposes enforced minimum authorization without scan or clipboard APIs', async () => {
    const opened: string[] = [];
    const adapter: NativePermissionAdapter = {
      async getStatus(target) {
        return { state: 'unknown', reason: `${target}_not_queryable` };
      },
      async openSystemSettings(target) {
        opened.push(target);
      }
    };
    const service = new PrivacyPermissionService(adapter);
    await expect(service.getStatus()).resolves.toMatchObject({
      minimumAuthorization: {
        selectedFilesOnly: true,
        authorizedDirectoriesOnly: true,
        homeDirectoryScan: false,
        backgroundClipboardRead: false,
        outboundConfirmationMandatory: true,
        unknownCostConfirmationMandatory: true
      }
    });
    await service.openSystemSettings('notifications');
    expect(opened).toEqual(['notifications']);
    await expect(service.openSystemSettings('disk' as never)).rejects.toBeInstanceOf(TypeError);
  });

  it('keeps proxy secrets encrypted and never applies a failed probe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-proxy-'));
    roots.push(root);
    const adapter = new FakeProxyAdapter();
    adapter.probeResult = { ok: false, failure: 'dns' };
    const vaultPath = path.join(root, 'proxy-credentials.json');
    const vault = new SecureCredentialVault(vaultPath, protector());
    const service = new ProxyService(adapter, vault, () => '2026-07-27T10:00:00.000Z');
    const next: ProxyMode = {
      kind: 'custom', protocol: 'http', host: 'proxy.invalid', port: 8080,
      authenticationConfigured: true
    };
    const credentialHandle = await service.stageCredential('local-user', 'local-secret-fixture');
    const plan = await service.plan(
      { kind: 'system_default' },
      next,
      credentialHandle,
      1_000
    );
    expect(plan.test).toEqual({ ok: false, failure: 'dns' });
    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'dns' });
    expect(adapter.applied).toEqual([]);
    expect(await vault.status(proxyCredentialReference)).toBe('not_configured');
  });

  it('allows credential-free modes while refusing staging without OS encryption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-proxy-'));
    roots.push(root);
    const adapter = new FakeProxyAdapter();
    const vault = new SecureCredentialVault(
      path.join(root, 'proxy-credentials.json'),
      {
        isAvailable: () => false,
        protect: () => new Uint8Array(),
        unprotect: () => ''
      }
    );
    const service = new ProxyService(adapter, vault);
    await expect(service.stageCredential('user', 'value')).rejects.toMatchObject({
      code: 'credential_storage'
    });
    const plan = await service.plan(
      { kind: 'system_default' },
      { kind: 'direct' },
      undefined,
      1_000
    );
    expect(plan.test.ok).toBe(true);
  });

  it('preserves all five proxy failure categories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-proxy-'));
    roots.push(root);
    const adapter = new FakeProxyAdapter();
    const service = new ProxyService(
      adapter,
      new SecureCredentialVault(path.join(root, 'proxy-credentials.json'), protector())
    );
    for (const failure of [
      'dns', 'certificate', 'authentication', 'timeout', 'unknown'
    ] as const) {
      adapter.probeResult = { ok: false, failure };
      const plan = await service.plan(
        { kind: 'system_default' },
        { kind: 'direct' },
        undefined,
        1_000
      );
      expect(plan.test).toEqual({ ok: false, failure });
    }
  });

  it('restores proxy runtime and encrypted credential through the rollback callback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-b3-proxy-'));
    roots.push(root);
    const adapter = new FakeProxyAdapter();
    const vaultPath = path.join(root, 'proxy-credentials.json');
    const vault = new SecureCredentialVault(vaultPath, protector());
    const service = new ProxyService(adapter, vault);
    const next: ProxyMode = {
      kind: 'custom', protocol: 'socks5', host: '127.0.0.1', port: 1080,
      authenticationConfigured: true
    };
    const credentialHandle = await service.stageCredential('dev', 'rollback-secret-fixture');
    const plan = await service.plan(
      { kind: 'direct' },
      next,
      credentialHandle,
      1_000
    );
    const rollback = await service.apply(plan);
    expect(adapter.applied[adapter.applied.length - 1]?.mode).toEqual(next);
    expect(await vault.status(proxyCredentialReference)).toBe('saved');
    expect(await readFile(vaultPath, 'utf8')).not.toContain('rollback-secret-fixture');
    await rollback();
    expect(adapter.applied[adapter.applied.length - 1]?.mode).toEqual({ kind: 'direct' });
    expect(await vault.status(proxyCredentialReference)).toBe('not_configured');
  });

  it('retains in-app delivery when the operating system denies a test notification', async () => {
    const adapter: NotificationPlatformAdapter = {
      async getSystemCapability() {
        return { id: 'system_notifications', state: 'permission_required' };
      },
      async getSoundCapability() {
        return { id: 'notification_sound', state: 'available' };
      },
      async sendTest() {
        return 'denied';
      },
      async playSound() {
        return 'accepted';
      }
    };
    const result = await new NotificationService(adapter).sendTest(true, true);
    expect(result).toEqual({
      inApp: 'retained',
      system: 'denied',
      sound: 'accepted',
      taskStateMutated: false,
      executionStateMutated: false
    });
  });

  it('rejects conflicts and reserved keys while preserving the other platform', () => {
    const adapter = new FakeShortcutAdapter();
    const service = new ShortcutService('windows', adapter);
    const current: ShortcutSettings = {
      bindings: [
        { actionId: 'show_app', windows: 'Control+Alt+U', macos: 'Command+Option+U' },
        { actionId: 'new_project', windows: 'Control+N', macos: 'Command+N' }
      ]
    };
    const conflict = service.plan(current, 'windows', [
      { actionId: 'show_app', accelerator: 'Control+N' }
    ]);
    expect(conflict.issues).toEqual(expect.arrayContaining([
      { actionId: 'show_app', code: 'duplicate' },
      { actionId: 'new_project', code: 'duplicate' }
    ]));
    const reserved = service.plan(current, 'windows', [
      { actionId: 'show_app', accelerator: 'Alt+F4' }
    ]);
    expect(reserved.issues).toContainEqual({ actionId: 'show_app', code: 'system_reserved' });
    const macOnly = service.plan(current, 'macos', [
      { actionId: 'show_app', accelerator: 'Command+Shift+U' }
    ]);
    expect(macOnly.next.bindings.find((item) => item.actionId === 'show_app')).toEqual({
      actionId: 'show_app',
      windows: 'Control+Alt+U',
      macos: 'Command+Shift+U'
    });
  });

  it('restores old global bindings when native registration fails', async () => {
    const adapter = new FakeShortcutAdapter();
    const service = new ShortcutService('windows', adapter);
    const previous: ShortcutSettings = {
      bindings: [{ actionId: 'show_app', windows: 'Control+Alt+U', macos: null }]
    };
    await service.activate(previous);
    adapter.failOn = 'Control+Shift+U';
    const plan = service.plan(previous, 'windows', [
      { actionId: 'show_app', accelerator: 'Control+Shift+U' }
    ]);
    await expect(service.apply(plan)).rejects.toBeInstanceOf(ShortcutOperationError);
    expect(adapter.registered).toEqual(new Map([['Control+Alt+U', 'show_app']]));
    expect(service.getStatus(previous).activeGlobalActionIds).toEqual(['show_app']);
  });
});

class FakeProxyAdapter implements ProxyPlatformAdapter {
  probeResult: ProxyTestResultDto = {
    ok: true,
    reachedAt: '2026-07-27T10:00:00.000Z'
  };
  readonly applied: Array<{ mode: ProxyMode }> = [];

  async probe() {
    return this.probeResult;
  }

  async apply(input: { readonly mode: ProxyMode }): Promise<void> {
    this.applied.push({ mode: input.mode });
  }
}

class FakeShortcutAdapter implements ShortcutPlatformAdapter {
  readonly registered = new Map<string, string>();
  failOn: string | undefined;

  register(accelerator: string, actionId: string): boolean {
    if (accelerator === this.failOn || this.registered.has(accelerator)) return false;
    this.registered.set(accelerator, actionId);
    return true;
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator);
  }
}

function protector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5)),
    unprotect: (value) => Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8')
  };
}
