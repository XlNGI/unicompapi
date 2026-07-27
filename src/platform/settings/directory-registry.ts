import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type {
  ControlledDirectoryDto,
  DirectoryPurpose
} from '../../shared/settings-ipc';

interface DirectoryRegistryDocument {
  readonly schemaVersion: 1;
  readonly entries: readonly DirectoryRegistryEntry[];
}

export interface DirectoryRegistryEntry {
  readonly id: string;
  readonly purpose: DirectoryPurpose;
  /** Main-process-only absolute path. */
  readonly directoryPath: string;
  readonly displayName: string;
  readonly registeredAt: string;
}

export interface DirectoryRegistry {
  register(purpose: DirectoryPurpose, directoryPath: string): Promise<DirectoryRegistryEntry>;
  resolve(id: string, purpose?: DirectoryPurpose): Promise<DirectoryRegistryEntry | undefined>;
  list(): Promise<readonly DirectoryRegistryEntry[]>;
}

export class JsonDirectoryRegistry implements DirectoryRegistry {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly registryPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => randomUUID()
  ) {}

  async register(
    purpose: DirectoryPurpose,
    directoryPath: string
  ): Promise<DirectoryRegistryEntry> {
    const normalized = requireAbsoluteDirectory(directoryPath);
    let result: DirectoryRegistryEntry | undefined;
    const operation = this.queue.then(async () => {
      await assertDirectory(normalized);
      const document = await this.readDocument();
      const existing = document.entries.find(
        (entry) => entry.purpose === purpose && samePath(entry.directoryPath, normalized)
      );
      if (existing) {
        result = existing;
        return;
      }
      if (document.entries.some((entry) => samePath(entry.directoryPath, normalized))) {
        throw new TypeError('A controlled directory cannot be shared by different purposes');
      }
      const entry: DirectoryRegistryEntry = {
        id: `dir-${this.createId()}`,
        purpose,
        directoryPath: normalized,
        displayName: path.basename(normalized) || path.parse(normalized).root,
        registeredAt: this.now()
      };
      await writeRegistry(this.registryPath, {
        schemaVersion: 1,
        entries: [...document.entries, entry]
      });
      result = entry;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    if (!result) throw new Error('Directory registration did not produce a result');
    return result;
  }

  async resolve(
    id: string,
    purpose?: DirectoryPurpose
  ): Promise<DirectoryRegistryEntry | undefined> {
    await this.queue;
    const entry = (await this.readDocument()).entries.find((item) => item.id === id);
    if (!entry || (purpose !== undefined && entry.purpose !== purpose)) return undefined;
    return entry;
  }

  async list(): Promise<readonly DirectoryRegistryEntry[]> {
    await this.queue;
    return (await this.readDocument()).entries;
  }

  private async readDocument(): Promise<DirectoryRegistryDocument> {
    try {
      return parseRegistry(JSON.parse(await readFile(this.registryPath, 'utf8')));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { schemaVersion: 1, entries: [] };
      }
      const failure = new Error('Controlled directory registry is invalid');
      Object.assign(failure, { cause: error });
      throw failure;
    }
  }
}

export async function describeControlledDirectory(
  entry: DirectoryRegistryEntry
): Promise<ControlledDirectoryDto> {
  try {
    const metadata = await stat(entry.directoryPath);
    if (!metadata.isDirectory()) {
      return unavailableDirectory(entry, 'not_a_directory');
    }
    const [readable, writable, space] = await Promise.all([
      canAccess(entry.directoryPath, constants.R_OK),
      canAccess(entry.directoryPath, constants.W_OK),
      getFreeBytes(entry.directoryPath)
    ]);
    return {
      id: entry.id,
      purpose: entry.purpose,
      displayName: entry.displayName,
      state: readable ? (writable ? 'available' : 'permission_required') : 'permission_required',
      readable,
      writable,
      freeBytes: space,
      reason: readable && writable ? undefined : 'directory_permission_denied'
    };
  } catch (error) {
    return unavailableDirectory(
      entry,
      isNodeError(error) && ['ENOENT', 'ENODEV'].includes(error.code ?? '')
        ? 'directory_disconnected'
        : 'directory_probe_failed'
    );
  }
}

async function writeRegistry(
  target: string,
  document: DirectoryRegistryDocument
): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseRegistry(value: unknown): DirectoryRegistryDocument {
  const item = record(value);
  if (item.schemaVersion !== 1 || !Array.isArray(item.entries)) {
    throw new TypeError('Directory registry version is invalid');
  }
  return {
    schemaVersion: 1,
    entries: item.entries.map((entry) => {
      const candidate = record(entry);
      if (
        typeof candidate.id !== 'string' ||
        !/^dir-[A-Za-z0-9-]{8,128}$/.test(candidate.id) ||
        !isDirectoryPurpose(candidate.purpose) ||
        typeof candidate.directoryPath !== 'string' ||
        !path.isAbsolute(candidate.directoryPath) ||
        typeof candidate.displayName !== 'string' ||
        candidate.displayName.length === 0 ||
        typeof candidate.registeredAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.registeredAt))
      ) {
        throw new TypeError('Directory registry entry is invalid');
      }
      return {
        id: candidate.id,
        purpose: candidate.purpose,
        directoryPath: path.resolve(candidate.directoryPath),
        displayName: candidate.displayName,
        registeredAt: candidate.registeredAt
      };
    })
  };
}

function unavailableDirectory(
  entry: DirectoryRegistryEntry,
  reason: string
): ControlledDirectoryDto {
  return {
    id: entry.id,
    purpose: entry.purpose,
    displayName: entry.displayName,
    state: 'unavailable',
    readable: false,
    writable: false,
    freeBytes: null,
    reason
  };
}

async function assertDirectory(target: string): Promise<void> {
  if (!(await stat(target)).isDirectory()) {
    throw new TypeError('Selected path is not a directory');
  }
}

async function canAccess(target: string, mode: number): Promise<boolean> {
  try {
    await access(target, mode);
    return true;
  } catch {
    return false;
  }
}

async function getFreeBytes(target: string): Promise<number | null> {
  try {
    const facts = await statfs(target, { bigint: true });
    const bytes = facts.bavail * facts.bsize;
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  } catch {
    return null;
  }
}

function requireAbsoluteDirectory(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new TypeError('Controlled directory path must be absolute');
  }
  return path.resolve(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function isDirectoryPurpose(value: unknown): value is DirectoryPurpose {
  return [
    'projects',
    'works',
    'imageOutput',
    'videoOutput',
    'videoEditorOutput',
    'downloads',
    'cache',
    'proxy'
  ].includes(String(value));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Directory registry value must be an object');
  }
  return value as Record<string, unknown>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
