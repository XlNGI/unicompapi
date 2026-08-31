import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createDefaultSettings,
  parseSettingsDocument,
  parseSettingsValues,
  replaceSettingsValues,
  type SettingsDocumentV1,
  type SettingsValues
} from '../../domain';
import { sharedFileWriteCoordinator } from '../storage';

export type SettingsLoadSource = 'primary' | 'backup' | 'default';

export interface SettingsLoadResult {
  readonly document: SettingsDocumentV1;
  readonly source: SettingsLoadSource;
}

export interface SettingsMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(value: Readonly<Record<string, unknown>>): unknown;
}

export interface SettingsRepository {
  load(): Promise<SettingsLoadResult>;
  replace(expectedRevision: number, values: SettingsValues): Promise<SettingsLoadResult>;
}

export class SettingsRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Settings revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'SettingsRevisionConflictError';
  }
}

export class SettingsDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SettingsDataError';
  }
}

export class JsonSettingsRepository implements SettingsRepository {
  private readonly settingsPath: string;
  private readonly backupPath: string;

  constructor(
    settingsPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly migrations: readonly SettingsMigration[] = []
  ) {
    this.settingsPath = path.resolve(settingsPath);
    this.backupPath = `${this.settingsPath}.bak`;
  }

  async load(): Promise<SettingsLoadResult> {
    return sharedFileWriteCoordinator.runExclusive(
      this.settingsPath,
      () => this.readCurrent()
    );
  }

  async replace(
    expectedRevision: number,
    values: SettingsValues
  ): Promise<SettingsLoadResult> {
    const validatedValues = parseSettingsValues(values);
    let result: SettingsLoadResult | undefined;
    await sharedFileWriteCoordinator.runExclusiveMany(
      [this.settingsPath, this.backupPath],
      async () => {
      const current = await this.readCurrent();
      if (current.document.revision !== expectedRevision) {
        throw new SettingsRevisionConflictError(
          expectedRevision,
          current.document.revision
        );
      }
      const document = replaceSettingsValues(
        current.document,
        validatedValues,
        this.now()
      );
      await this.writeDocument(document, current.source);
      result = { document, source: 'primary' };
      }
    );
    if (!result) throw new SettingsDataError('Settings write did not produce a result');
    return result;
  }

  private async readCurrent(): Promise<SettingsLoadResult> {
    try {
      return {
        document: migrateSettingsDocument(
          JSON.parse(await readFile(this.settingsPath, 'utf8')),
          this.migrations
        ),
        source: 'primary'
      };
    } catch (primaryError) {
      if (isNodeError(primaryError) && primaryError.code === 'ENOENT') {
        return this.readBackupOrDefault();
      }
      try {
        return {
          document: migrateSettingsDocument(
            JSON.parse(await readFile(this.backupPath, 'utf8')),
            this.migrations
          ),
          source: 'backup'
        };
      } catch (backupError) {
        throw new SettingsDataError(
          'Settings file is invalid and no valid backup is available',
          { primaryError, backupError }
        );
      }
    }
  }

  private async readBackupOrDefault(): Promise<SettingsLoadResult> {
    try {
      return {
        document: migrateSettingsDocument(
          JSON.parse(await readFile(this.backupPath, 'utf8')),
          this.migrations
        ),
        source: 'backup'
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw new SettingsDataError('Settings backup is invalid', error);
      }
      return {
        document: createDefaultSettings(this.now()),
        source: 'default'
      };
    }
  }

  private async writeDocument(
    document: SettingsDocumentV1,
    currentSource: SettingsLoadSource
  ): Promise<void> {
    const parent = path.dirname(this.settingsPath);
    await mkdir(parent, { recursive: true });

    if (currentSource === 'primary') {
      const currentText = await readFile(this.settingsPath, 'utf8');
      migrateSettingsDocument(JSON.parse(currentText), this.migrations);
      await writeAtomically(this.backupPath, currentText);
    }

    await writeAtomically(
      this.settingsPath,
      `${JSON.stringify(parseSettingsDocument(document), null, 2)}\n`
    );
    await syncDirectoryBestEffort(parent);
  }
}

export class InMemorySettingsRepository implements SettingsRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private document: SettingsDocumentV1,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async load(): Promise<SettingsLoadResult> {
    await this.queue;
    return { document: parseSettingsDocument(this.document), source: 'primary' };
  }

  async replace(
    expectedRevision: number,
    values: SettingsValues
  ): Promise<SettingsLoadResult> {
    let result: SettingsLoadResult | undefined;
    const operation = this.queue.then(() => {
      if (this.document.revision !== expectedRevision) {
        throw new SettingsRevisionConflictError(
          expectedRevision,
          this.document.revision
        );
      }
      this.document = replaceSettingsValues(
        this.document,
        parseSettingsValues(values),
        this.now()
      );
      result = { document: this.document, source: 'primary' };
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    if (!result) throw new SettingsDataError('Settings write did not produce a result');
    return result;
  }
}

export function migrateSettingsDocument(
  value: unknown,
  migrations: readonly SettingsMigration[] = []
): SettingsDocumentV1 {
  let current = requireRecord(value, 'Settings document');
  let version = requireSchemaVersion(current.schemaVersion);
  const byVersion = new Map<number, SettingsMigration>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      migration.fromVersion < 0 ||
      migration.toVersion !== migration.fromVersion + 1 ||
      byVersion.has(migration.fromVersion)
    ) {
      throw new SettingsDataError('Settings migration registry is invalid');
    }
    byVersion.set(migration.fromVersion, migration);
  }
  if (version > 1) {
    throw new SettingsDataError(`Settings schema version ${version} is newer than supported`);
  }
  while (version < 1) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new SettingsDataError(`No settings migration exists for version ${version}`);
    }
    current = requireRecord(migration.migrate(current), 'Migrated settings document');
    const nextVersion = requireSchemaVersion(current.schemaVersion);
    if (nextVersion !== migration.toVersion) {
      throw new SettingsDataError('Settings migration returned an unexpected version');
    }
    version = nextVersion;
  }
  return parseSettingsDocument(current);
}

async function writeAtomically(target: string, content: string): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
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

function requireSchemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SettingsDataError('Settings schema version is invalid');
  }
  return Number(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsDataError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
