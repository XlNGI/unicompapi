import { randomUUID } from 'node:crypto';
import type { ProxyMode } from '../../domain';
import type {
  ProxyTestFailureKind,
  ProxyTestResultDto,
  SettingsCapabilityDto
} from '../../shared/settings-ipc';
import {
  CredentialNotFoundError,
  type SecureCredentialVault
} from '../providers';

export const proxyCredentialReference = 'settings.proxy.v1';

interface ProxyCredential {
  readonly username: string;
  readonly secret: string;
}

export interface ProxyPlatformAdapter {
  probe(input: {
    readonly mode: ProxyMode;
    readonly credential?: ProxyCredential;
    readonly timeoutMs: number;
  }): Promise<ProxyTestResultDto>;
  apply(input: {
    readonly mode: ProxyMode;
    readonly credential?: ProxyCredential;
  }): Promise<void>;
}

export interface ProxyChangePlan {
  readonly previousMode: ProxyMode;
  readonly nextMode: ProxyMode;
  readonly previousCredential?: ProxyCredential;
  readonly nextCredential?: ProxyCredential;
  readonly test: ProxyTestResultDto;
}

export class ProxyOperationError extends Error {
  constructor(readonly code: ProxyTestFailureKind | 'credential_storage') {
    super(`Proxy operation failed: ${code}`);
    this.name = 'ProxyOperationError';
  }
}

export class ProxyService {
  private lastTest: ProxyTestResultDto | null = null;
  private activeMode: ProxyMode = { kind: 'system_default' };
  private queue: Promise<void> = Promise.resolve();
  private readonly stagedCredentials = new Map<string, {
    readonly credential: ProxyCredential;
    readonly expiresAtMs: number;
  }>();

  constructor(
    private readonly adapter: ProxyPlatformAdapter,
    private readonly vault: SecureCredentialVault,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createHandle: () => string = () => randomUUID(),
    private readonly stageLifetimeMs = 5 * 60 * 1000
  ) {}

  async stageCredential(username: string, secret: string): Promise<string> {
    const credential = requireCredential({ username, secret });
    const vaultStatus = await this.vault.status(proxyCredentialReference);
    if (vaultStatus === 'encryption_unavailable' || vaultStatus === 'unreadable') {
      throw new ProxyOperationError('credential_storage');
    }
    const nowMs = Date.parse(this.now());
    this.purgeStaged(nowMs);
    const handle = this.createHandle();
    this.stagedCredentials.set(handle, {
      credential,
      expiresAtMs: nowMs + this.stageLifetimeMs
    });
    return handle;
  }

  async getStatus(_selectedMode: ProxyMode) {
    const vaultStatus = await this.vault.status(proxyCredentialReference);
    const credentialStorage: SettingsCapabilityDto =
      vaultStatus === 'encryption_unavailable'
        ? { id: 'proxy_credential_storage', state: 'unavailable', reason: vaultStatus }
        : vaultStatus === 'unreadable'
          ? { id: 'proxy_credential_storage', state: 'failed', reason: vaultStatus }
          : {
              id: 'proxy_credential_storage',
              state: 'available',
              reason: vaultStatus
            };
    return {
      activeMode: this.activeMode.kind,
      appliesTo: 'new_requests_only' as const,
      activeRequestsRetried: false as const,
      credentialStorage,
      lastTest: this.lastTest
    };
  }

  async plan(
    previousMode: ProxyMode,
    nextMode: ProxyMode,
    credentialHandle: string | undefined,
    timeoutMs: number
  ): Promise<ProxyChangePlan> {
    const needsPreviousCredential =
      (previousMode.kind === 'custom' && previousMode.authenticationConfigured) ||
      (nextMode.kind === 'custom' && nextMode.authenticationConfigured && !credentialHandle);
    const previousCredential = needsPreviousCredential
      ? await this.readCredential()
      : undefined;
    const credential = credentialHandle
      ? this.takeStagedCredential(credentialHandle)
      : undefined;
    let nextCredential: ProxyCredential | undefined;
    let test: ProxyTestResultDto;
    try {
      nextCredential = resolveNextCredential(nextMode, credential, previousCredential);
      test = await this.adapter.probe({
        mode: nextMode,
        credential: nextCredential,
        timeoutMs
      });
    } catch (error) {
      if (!(error instanceof ProxyOperationError) || error.code !== 'authentication') {
        throw error;
      }
      test = { ok: false, failure: 'authentication' };
    }
    this.lastTest = test.ok ? { ok: true, reachedAt: this.now() } : test;
    return {
      previousMode,
      nextMode,
      previousCredential,
      nextCredential,
      test: this.lastTest
    };
  }

  async apply(plan: ProxyChangePlan): Promise<() => Promise<void>> {
    if (!plan.test.ok) throw new ProxyOperationError(plan.test.failure);
    const operation = this.queue.then(async () => {
      await this.writeCredential(plan.nextCredential);
      try {
        await this.adapter.apply({
          mode: plan.nextMode,
          credential: plan.nextCredential
        });
        this.activeMode = plan.nextMode;
      } catch (error) {
        try {
          await this.adapter.apply({
            mode: plan.previousMode,
            credential: plan.previousCredential
          });
        } catch {
          // The original failure remains authoritative; the adapter reports runtime facts.
        }
        try {
          await this.writeCredential(plan.previousCredential);
        } catch {
          // The original failure remains authoritative; status reports vault failures.
        }
        throw error;
      }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return async () => {
      let failure: unknown;
      try {
        await this.adapter.apply({
          mode: plan.previousMode,
          credential: plan.previousCredential
        });
        this.activeMode = plan.previousMode;
      } catch (error) {
        failure = error;
      }
      try {
        await this.writeCredential(plan.previousCredential);
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    };
  }

  async activate(mode: ProxyMode): Promise<void> {
    const credential = mode.kind === 'custom' && mode.authenticationConfigured
      ? await this.readCredential()
      : undefined;
    if (mode.kind === 'custom' && mode.authenticationConfigured && !credential) {
      throw new ProxyOperationError('authentication');
    }
    await this.adapter.apply({ mode, credential });
    this.activeMode = mode;
  }

  dispose(): void {
    this.stagedCredentials.clear();
  }

  private async readCredential(): Promise<ProxyCredential | undefined> {
    try {
      return await this.vault.useValue(proxyCredentialReference, async (value) =>
        parseCredential(value)
      );
    } catch (error) {
      if (error instanceof CredentialNotFoundError) return undefined;
      throw error;
    }
  }

  private async writeCredential(value: ProxyCredential | undefined): Promise<void> {
    if (!value) {
      await this.vault.remove(proxyCredentialReference);
      return;
    }
    await this.vault.save(proxyCredentialReference, JSON.stringify(value));
  }

  private takeStagedCredential(handle: string): ProxyCredential {
    if (!/^[A-Za-z0-9-]{8,128}$/.test(handle)) {
      throw new TypeError('Proxy credential handle is invalid');
    }
    const nowMs = Date.parse(this.now());
    this.purgeStaged(nowMs);
    const staged = this.stagedCredentials.get(handle);
    this.stagedCredentials.delete(handle);
    if (!staged) throw new TypeError('Proxy credential handle is invalid or expired');
    return staged.credential;
  }

  private purgeStaged(nowMs: number): void {
    for (const [handle, staged] of this.stagedCredentials) {
      if (nowMs > staged.expiresAtMs) this.stagedCredentials.delete(handle);
    }
  }
}

function resolveNextCredential(
  mode: ProxyMode,
  supplied: ProxyCredential | undefined,
  existing: ProxyCredential | undefined
): ProxyCredential | undefined {
  if (mode.kind !== 'custom') {
    if (supplied) throw new TypeError('Credentials require a custom proxy');
    return undefined;
  }
  if (!mode.authenticationConfigured) {
    if (supplied) throw new TypeError('Unexpected proxy credential');
    return undefined;
  }
  const credential = supplied ?? existing;
  if (!credential) throw new ProxyOperationError('authentication');
  requireCredential(credential);
  return credential;
}

function parseCredential(value: string): ProxyCredential {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new TypeError('Proxy credential is invalid');
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('username') || !keys.includes('secret')) {
    throw new TypeError('Proxy credential is invalid');
  }
  return requireCredential({
    username: parsed.username as string,
    secret: parsed.secret as string
  });
}

function requireCredential(value: ProxyCredential): ProxyCredential {
  if (
    typeof value.username !== 'string' || value.username.length > 512 ||
    typeof value.secret !== 'string' || value.secret.length < 1 || value.secret.length > 65_536
  ) {
    throw new TypeError('Proxy credential is invalid');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
