import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { StructuredCredentialRecord } from '../../domain';

export interface CredentialProtector {
  isAvailable(): boolean;
  protect(value: string): Uint8Array;
  unprotect(value: Uint8Array): string;
}

interface EncryptedCredentialEntry {
  readonly reference: string;
  readonly encryptedValue: string;
  readonly payloadKind?: 'text' | 'structured_record';
  readonly updatedAt: string;
}

interface EncryptedCredentialSnapshot {
  readonly schemaVersion: 1;
  readonly entries: readonly EncryptedCredentialEntry[];
}

export type CredentialVaultStatus =
  | 'saved'
  | 'not_configured'
  | 'encryption_unavailable'
  | 'unreadable';

export type CredentialVerificationResult =
  | 'valid'
  | 'invalid'
  | 'verification_unavailable';

export class SecureCredentialVault {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly backupPath: string;

  constructor(
    private readonly vaultPath: string,
    private readonly protector: CredentialProtector
  ) {
    this.backupPath = `${vaultPath}.bak`;
  }

  async save(reference: string, value: string): Promise<void> {
    requireCredentialValue(value);
    await this.savePayload(reference, value, 'text');
  }

  async saveRecord(
    reference: string,
    record: StructuredCredentialRecord
  ): Promise<void> {
    const normalized = parseStructuredCredentialRecord(record);
    await this.savePayload(
      reference,
      JSON.stringify(normalized),
      'structured_record'
    );
  }

  private async savePayload(
    reference: string,
    value: string,
    payloadKind: 'text' | 'structured_record'
  ): Promise<void> {
    const safeReference = requireReference(reference);
    if (!this.protector.isAvailable()) {
      throw new CredentialVaultUnavailableError();
    }

    const protectedBytes = this.protector.protect(value);
    let roundTrip: string;
    try {
      roundTrip = this.protector.unprotect(protectedBytes);
    } catch (error) {
      throw new CredentialProtectionError('Credential encryption could not be verified', error);
    }
    if (roundTrip !== value) {
      throw new CredentialProtectionError('Credential encryption verification did not match');
    }
    const encryptedValue = Buffer.from(protectedBytes).toString('base64');
    const operation = this.writeQueue.then(async () => {
      const snapshot = await this.loadSnapshot();
      const entry: EncryptedCredentialEntry = {
        reference: safeReference,
        encryptedValue,
        payloadKind,
        updatedAt: new Date().toISOString()
      };
      await this.writeSnapshot({
        schemaVersion: 1,
        entries: [
          ...snapshot.entries.filter((item) => item.reference !== safeReference),
          entry
        ]
      });
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async remove(reference: string): Promise<boolean> {
    const safeReference = requireReference(reference);
    const operation = this.writeQueue.then(async () => {
      const snapshot = await this.loadSnapshot();
      const remaining = snapshot.entries.filter(
        (item) => item.reference !== safeReference
      );
      if (remaining.length === snapshot.entries.length) return false;
      await this.writeSnapshot({ schemaVersion: 1, entries: remaining });
      return true;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async status(reference: string): Promise<CredentialVaultStatus> {
    if (!this.protector.isAvailable()) return 'encryption_unavailable';
    const entry = await this.findEntry(requireReference(reference));
    if (!entry) return 'not_configured';
    try {
      this.protector.unprotect(Buffer.from(entry.encryptedValue, 'base64'));
      return 'saved';
    } catch {
      return 'unreadable';
    }
  }

  async test(
    reference: string,
    verifier: (value: string) => Promise<CredentialVerificationResult>
  ): Promise<CredentialVerificationResult> {
    if (!this.protector.isAvailable()) {
      throw new CredentialVaultUnavailableError();
    }
    return this.useValue(reference, verifier);
  }

  /** Keeps decrypted values inside a main-process callback boundary. */
  async useValue<T>(
    reference: string,
    operation: (value: string) => Promise<T>
  ): Promise<T> {
    if (!this.protector.isAvailable()) {
      throw new CredentialVaultUnavailableError();
    }
    const entry = await this.findEntry(requireReference(reference));
    if (!entry) throw new CredentialNotFoundError();
    if ((entry.payloadKind ?? 'text') !== 'text') {
      throw new CredentialPayloadKindError('text');
    }
    const value = this.decryptEntry(entry);
    return operation(value);
  }

  /** Keeps structured credential fields inside a main-process callback boundary. */
  async useRecord<T>(
    reference: string,
    operation: (record: StructuredCredentialRecord) => Promise<T>
  ): Promise<T> {
    if (!this.protector.isAvailable()) {
      throw new CredentialVaultUnavailableError();
    }
    const entry = await this.findEntry(requireReference(reference));
    if (!entry) throw new CredentialNotFoundError();
    if (entry.payloadKind !== 'structured_record') {
      throw new CredentialPayloadKindError('structured_record');
    }
    let record: StructuredCredentialRecord;
    try {
      record = parseStructuredCredentialRecord(JSON.parse(this.decryptEntry(entry)));
    } catch (error) {
      if (error instanceof CredentialUnreadableError) throw error;
      throw new CredentialUnreadableError(error);
    }
    return operation(record);
  }

  private decryptEntry(entry: EncryptedCredentialEntry): string {
    try {
      return this.protector.unprotect(
        Buffer.from(entry.encryptedValue, 'base64')
      );
    } catch (error) {
      throw new CredentialUnreadableError(error);
    }
  }

  private async findEntry(
    reference: string
  ): Promise<EncryptedCredentialEntry | undefined> {
    await this.writeQueue;
    return (await this.loadSnapshot()).entries.find(
      (item) => item.reference === reference
    );
  }

  private async loadSnapshot(): Promise<EncryptedCredentialSnapshot> {
    try {
      return parseSnapshot(JSON.parse(await readFile(this.vaultPath, 'utf8')));
    } catch (primaryError) {
      try {
        return parseSnapshot(JSON.parse(await readFile(this.backupPath, 'utf8')));
      } catch (backupError) {
        if (
          isNodeError(primaryError) && primaryError.code === 'ENOENT' &&
          isNodeError(backupError) && backupError.code === 'ENOENT'
        ) {
          return { schemaVersion: 1, entries: [] };
        }
        const failure = new Error('Credential vault is invalid and no valid backup is available');
        Object.assign(failure, { cause: { primaryError, backupError } });
        throw failure;
      }
    }
  }

  private async writeSnapshot(
    snapshot: EncryptedCredentialSnapshot
  ): Promise<void> {
    const parent = path.dirname(this.vaultPath);
    const temporary = path.join(
      parent,
      `.${path.basename(this.vaultPath)}.${randomUUID()}.tmp`
    );
    await mkdir(parent, { recursive: true });
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const currentText = await readFile(this.vaultPath, 'utf8');
        parseSnapshot(JSON.parse(currentText));
        await writeTextAtomically(this.backupPath, currentText);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
      await rename(temporary, this.vaultPath);
      await syncDirectoryBestEffort(parent);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class CredentialVaultUnavailableError extends Error {
  constructor() {
    super('Operating-system credential encryption is unavailable');
    this.name = 'CredentialVaultUnavailableError';
  }
}

export class CredentialNotFoundError extends Error {
  constructor() {
    super('Credential is not configured');
    this.name = 'CredentialNotFoundError';
  }
}

export class CredentialProtectionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CredentialProtectionError';
  }
}

export class CredentialUnreadableError extends Error {
  constructor(readonly cause?: unknown) {
    super('Credential cannot be decrypted by the operating-system protector');
    this.name = 'CredentialUnreadableError';
  }
}

export class CredentialPayloadKindError extends Error {
  constructor(readonly expectedKind: 'text' | 'structured_record') {
    super(`Credential payload is not a ${expectedKind} value`);
    this.name = 'CredentialPayloadKindError';
  }
}

async function writeTextAtomically(target: string, content: string): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function parseSnapshot(value: unknown): EncryptedCredentialSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries)
  ) {
    throw new TypeError('Credential vault has an unsupported schema');
  }
  const references = new Set<string>();
  const entries = value.entries.map((candidate) => {
    if (!isRecord(candidate)) throw new TypeError('Credential entry is invalid');
    const reference = requireReference(candidate.reference);
    if (
      references.has(reference) ||
      typeof candidate.encryptedValue !== 'string' ||
      !isBase64(candidate.encryptedValue) ||
      typeof candidate.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.updatedAt))
    ) {
      throw new TypeError('Credential entry is invalid');
    }
    references.add(reference);
    return {
      reference,
      encryptedValue: candidate.encryptedValue,
      payloadKind: parsePayloadKind(candidate.payloadKind),
      updatedAt: candidate.updatedAt
    };
  });
  return { schemaVersion: 1, entries };
}

function parsePayloadKind(
  value: unknown
): EncryptedCredentialEntry['payloadKind'] {
  if (value === undefined) return undefined;
  if (value !== 'text' && value !== 'structured_record') {
    throw new TypeError('Credential entry payload kind is invalid');
  }
  return value;
}

function parseStructuredCredentialRecord(
  value: unknown
): StructuredCredentialRecord {
  if (!isRecord(value) || !isRecord(value.values)) {
    throw new TypeError('Structured credential record is invalid');
  }
  const schemaId = requireReference(value.schemaId);
  if (!Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) {
    throw new TypeError('Structured credential schema version is invalid');
  }
  const values: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value.values)) {
    const safeKey = requireCredentialFieldKey(key);
    requireCredentialValue(fieldValue as string);
    values[safeKey] = fieldValue as string;
  }
  return {
    schemaId,
    schemaVersion: Number(value.schemaVersion),
    values
  };
}

function requireCredentialFieldKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    throw new TypeError('Credential field key is invalid');
  }
  return value;
}

function requireReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new TypeError('Credential reference is invalid');
  }
  return value;
}

function requireCredentialValue(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 65_536) {
    throw new TypeError('Credential value is invalid');
  }
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
