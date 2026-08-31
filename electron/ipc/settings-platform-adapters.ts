import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  globalShortcut,
  net,
  Notification,
  session,
  shell,
  type AuthInfo,
  type Event,
  type ProxyConfig,
  type WebContents
} from 'electron';
import type { ProxyMode } from '../../src/domain';
import type {
  NativeSystemSettingsTarget,
  ProxyTestFailureKind,
  SettingsCapabilityDto
} from '../../src/shared/settings-ipc';
import type {
  DirectoryAuthorizationPort,
  NativePermissionAdapter,
  NotificationPlatformAdapter,
  ProxyPlatformAdapter,
  ShortcutPlatformAdapter,
  DiagnosticLocationAdapter
} from '../../src/platform';

export class ElectronDirectoryAuthorizationAdapter implements DirectoryAuthorizationPort {
  private readonly releases = new Map<string, () => void>();

  async ensureAccess(input: Parameters<DirectoryAuthorizationPort['ensureAccess']>[0]) {
    if (input.authorization.kind === 'native_picker') {
      return { state: 'granted' as const };
    }
    if (process.platform !== 'darwin') {
      return {
        state: 'revoked' as const,
        reason: 'security_scoped_bookmark_platform_mismatch'
      };
    }
    if (this.releases.has(input.directoryId)) {
      return { state: 'granted' as const };
    }
    try {
      const release = app.startAccessingSecurityScopedResource(
        input.authorization.bookmark
      );
      this.releases.set(input.directoryId, () => release());
      return { state: 'granted' as const };
    } catch {
      return {
        state: 'revoked' as const,
        reason: 'directory_authorization_revoked'
      };
    }
  }

  dispose(): void {
    for (const release of this.releases.values()) release();
    this.releases.clear();
  }
}

const proxyProbeUrl = 'https://example.com/';

interface RuntimeProxyCredential {
  readonly username: string;
  readonly secret: string;
}

export class ElectronProxyAdapter implements ProxyPlatformAdapter {
  private activeMode: ProxyMode = { kind: 'system_default' };
  private activeCredential: RuntimeProxyCredential | undefined;

  constructor() {
    app.on('login', this.handleLogin);
  }

  async probe(input: {
    readonly mode: ProxyMode;
    readonly credential?: RuntimeProxyCredential;
    readonly timeoutMs: number;
  }) {
    const probeSession = session.fromPartition(`unicomp-proxy-probe-${randomUUID()}`, {
      cache: false
    });
    try {
      await probeSession.setProxy(toElectronProxyConfig(input.mode));
      return await new Promise<
        | { readonly ok: true; readonly reachedAt: string }
        | { readonly ok: false; readonly failure: ProxyTestFailureKind }
      >((resolve) => {
        const request = net.request({
          method: 'GET',
          url: proxyProbeUrl,
          session: probeSession,
          redirect: 'error'
        });
        let settled = false;
        const finish = (result:
          | { readonly ok: true; readonly reachedAt: string }
          | { readonly ok: false; readonly failure: ProxyTestFailureKind }
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          request.abort();
          finish({ ok: false, failure: 'timeout' });
        }, input.timeoutMs);
        request.on('login', (authInfo, callback) => {
          if (input.credential && matchesProxy(input.mode, authInfo)) {
            callback(input.credential.username, input.credential.secret);
            return;
          }
          callback();
        });
        request.on('response', (response) => {
          finish(response.statusCode === 407
            ? { ok: false, failure: 'authentication' }
            : { ok: true, reachedAt: new Date().toISOString() });
        });
        request.on('error', (error) => {
          finish({ ok: false, failure: classifyProxyFailure(error) });
        });
        request.end();
      });
    } catch (error) {
      return { ok: false as const, failure: classifyProxyFailure(error) };
    } finally {
      await probeSession.closeAllConnections().catch(() => undefined);
      await probeSession.clearStorageData().catch(() => undefined);
    }
  }

  async apply(input: {
    readonly mode: ProxyMode;
    readonly credential?: RuntimeProxyCredential;
  }): Promise<void> {
    await session.defaultSession.setProxy(toElectronProxyConfig(input.mode));
    this.activeMode = input.mode;
    this.activeCredential = input.credential;
  }

  dispose(): void {
    app.off('login', this.handleLogin);
    this.activeCredential = undefined;
  }

  private readonly handleLogin = (
    event: Event,
    _webContents: WebContents,
    _details: Electron.AuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void
  ): void => {
    if (!authInfo.isProxy || !matchesProxy(this.activeMode, authInfo) || !this.activeCredential) {
      return;
    }
    event.preventDefault();
    callback(this.activeCredential.username, this.activeCredential.secret);
  };
}

export class ElectronPermissionAdapter implements NativePermissionAdapter {
  async getStatus(target: NativeSystemSettingsTarget) {
    if (target === 'notifications' && !Notification.isSupported()) {
      return { state: 'unsupported' as const, reason: 'system_notifications_unsupported' };
    }
    return {
      state: 'unknown' as const,
      reason: 'operating_system_permission_not_queryable'
    };
  }

  async openSystemSettings(target: NativeSystemSettingsTarget): Promise<void> {
    await shell.openExternal(systemSettingsUrl(target));
  }
}

export class ElectronNotificationAdapter implements NotificationPlatformAdapter {
  async getSystemCapability(): Promise<SettingsCapabilityDto> {
    return Notification.isSupported()
      ? { id: 'system_notifications', state: 'available', reason: 'delivery_permission_not_queryable' }
      : { id: 'system_notifications', state: 'unsupported', reason: 'platform_unsupported' };
  }

  async getSoundCapability(): Promise<SettingsCapabilityDto> {
    return Notification.isSupported()
      ? { id: 'notification_sound', state: 'available', reason: 'uses_system_default_sound' }
      : { id: 'notification_sound', state: 'unsupported', reason: 'platform_unsupported' };
  }

  async sendTest(input: {
    readonly title: string;
    readonly body: string;
  }) {
    if (!Notification.isSupported()) return 'unsupported' as const;
    try {
      new Notification({
        title: input.title,
        body: input.body,
        silent: true
      }).show();
      return 'accepted' as const;
    } catch {
      return 'failed' as const;
    }
  }

  async playSound() {
    try {
      shell.beep();
      return 'accepted' as const;
    } catch {
      return 'failed' as const;
    }
  }
}

export class ElectronShortcutAdapter implements ShortcutPlatformAdapter {
  register(accelerator: string, actionId: string): boolean {
    return globalShortcut.register(accelerator, () => {
      if (actionId === 'show_app') {
        const window = BrowserWindow.getAllWindows()[0];
        window?.show();
        window?.focus();
      }
    });
  }

  unregister(accelerator: string): void {
    globalShortcut.unregister(accelerator);
  }
}

export class ElectronDiagnosticLocationAdapter implements DiagnosticLocationAdapter {
  constructor(private readonly userDataPath: string) {}

  async open(target: 'logs' | 'last_bundle', lastBundlePath: string | undefined): Promise<void> {
    if (target === 'last_bundle') {
      if (!lastBundlePath) throw new Error('No diagnostic bundle has been generated');
      shell.showItemInFolder(lastBundlePath);
      return;
    }
    const error = await shell.openPath(path.join(this.userDataPath, 'logs'));
    if (error) throw new Error(error);
  }
}

export function enforceMinimumRendererPermissions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
}

function toElectronProxyConfig(mode: ProxyMode): ProxyConfig {
  if (mode.kind === 'direct') return { mode: 'direct' };
  if (mode.kind === 'system_default' || mode.kind === 'system_proxy') {
    return { mode: 'system' };
  }
  return {
    mode: 'fixed_servers',
    proxyRules: `${mode.protocol}://${mode.host}:${mode.port}`
  };
}

function matchesProxy(mode: ProxyMode, authInfo: AuthInfo): boolean {
  return mode.kind === 'custom' &&
    authInfo.host.toLowerCase() === mode.host.toLowerCase() &&
    authInfo.port === mode.port;
}

function classifyProxyFailure(error: unknown): ProxyTestFailureKind {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(
        'cause' in error ? (error as Error & { cause?: unknown }).cause ?? '' : ''
      )}`.toLowerCase()
    : String(error).toLowerCase();
  if (/abort|timed?\s*out|err_timed_out/.test(text)) return 'timeout';
  if (/cert|certificate|ssl|tls/.test(text)) return 'certificate';
  if (/auth|407/.test(text)) return 'authentication';
  if (/name_not_resolved|dns|enotfound|eai_again/.test(text)) return 'dns';
  return 'unknown';
}

function systemSettingsUrl(target: NativeSystemSettingsTarget): string {
  if (process.platform === 'darwin') {
    return target === 'notifications'
      ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
  }
  return target === 'notifications'
    ? 'ms-settings:notifications'
    : 'ms-settings:privacy-documents';
}
