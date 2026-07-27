import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import {
  access,
  copyFile as nodeCopyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DirectoryPurpose } from '../../shared/settings-ipc';
import type { DirectoryRegistry, DirectoryRegistryEntry } from './directory-registry';

interface MigrationFile {
  readonly relativePath: string;
  readonly bytes: number;
  readonly modifiedMs: number;
  readonly sha256: string;
}

export interface DirectoryMigrationPlan {
  readonly planId: string;
  readonly purpose: DirectoryPurpose;
  readonly sourceDirectoryId: string | null;
  readonly targetDirectoryId: string;
  readonly fileCount: number;
  readonly bytes: number;
  readonly oldLocationRetained: true;
  /** Main-process-only immutable manifest and paths. */
  readonly sourcePath: string | null;
  readonly targetPath: string;
  readonly files: readonly MigrationFile[];
}

export class StorageOperationError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StorageOperationError';
  }
}

export interface DirectoryMigrationOptions {
  readonly maximumFileCount?: number;
  readonly freeBytes?: (target: string) => Promise<number | null>;
  readonly createPlanId?: () => string;
  readonly copyFile?: (source: string, target: string) => Promise<void>;
}

export class DirectoryMigrationService {
  private readonly maximumFileCount: number;
  private readonly freeBytes: (target: string) => Promise<number | null>;
  private readonly createPlanId: () => string;
  private readonly copy: (source: string, target: string) => Promise<void>;

  constructor(
    private readonly registry: DirectoryRegistry,
    options: DirectoryMigrationOptions = {}
  ) {
    this.maximumFileCount = options.maximumFileCount ?? 100_000;
    this.freeBytes = options.freeBytes ?? availableBytes;
    this.createPlanId = options.createPlanId ?? (() => randomUUID());
    this.copy = options.copyFile ?? (async (source, target) => {
      await nodeCopyFile(source, target, 1);
    });
  }

  async plan(input: {
    readonly purpose: DirectoryPurpose;
    readonly sourceDirectoryId: string | null;
    readonly targetDirectoryId: string;
  }): Promise<DirectoryMigrationPlan> {
    const target = await this.requireDirectory(input.targetDirectoryId, input.purpose);
    const source = input.sourceDirectoryId
      ? await this.requireDirectory(input.sourceDirectoryId, input.purpose)
      : undefined;
    assertSafeManagedRoot(target.directoryPath);
    await assertAccess(target.directoryPath, constants.R_OK | constants.W_OK);
    if (source) {
      assertSafeManagedRoot(source.directoryPath);
      await assertAccess(source.directoryPath, constants.R_OK);
    }
    if (source && overlaps(source.directoryPath, target.directoryPath)) {
      throw new StorageOperationError(
        'directory_overlap',
        'Source and target directories must not overlap'
      );
    }
    await assertEmptyDirectory(target.directoryPath);
    const files = source
      ? await scanFiles(source.directoryPath, this.maximumFileCount, true)
      : [];
    const bytes = files.reduce((total, file) => total + file.bytes, 0);
    const freeBytes = await this.freeBytes(target.directoryPath);
    if (freeBytes !== null && freeBytes < bytes) {
      throw new StorageOperationError(
        'insufficient_space',
        'The target directory does not have enough free space'
      );
    }
    return Object.freeze({
      planId: this.createPlanId(),
      purpose: input.purpose,
      sourceDirectoryId: source?.id ?? null,
      targetDirectoryId: target.id,
      fileCount: files.length,
      bytes,
      oldLocationRetained: true,
      sourcePath: source?.directoryPath ?? null,
      targetPath: target.directoryPath,
      files: Object.freeze(files.map((file) => Object.freeze(file)))
    });
  }

  async execute(plan: DirectoryMigrationPlan): Promise<void> {
    const target = await this.requireDirectory(plan.targetDirectoryId, plan.purpose);
    if (!samePath(target.directoryPath, plan.targetPath)) {
      throw new StorageOperationError('directory_changed', 'Target directory changed');
    }
    await assertEmptyDirectory(plan.targetPath);
    if (plan.sourcePath === null) return;
    const source = await this.requireDirectory(plan.sourceDirectoryId ?? '', plan.purpose);
    if (!samePath(source.directoryPath, plan.sourcePath)) {
      throw new StorageOperationError('directory_changed', 'Source directory changed');
    }
    const current = await scanFiles(plan.sourcePath, this.maximumFileCount, true);
    if (!sameManifest(plan.files, current)) {
      throw new StorageOperationError('source_changed', 'Source directory changed after planning');
    }
    const staging = path.join(
      path.dirname(plan.targetPath),
      `.${path.basename(plan.targetPath)}.unicomp-migration-${plan.planId}`
    );
    await rm(staging, { recursive: true, force: true });
    try {
      await mkdir(staging, { recursive: false });
      for (const file of plan.files) {
        const sourceFile = path.join(plan.sourcePath, file.relativePath);
        const targetFile = path.join(staging, file.relativePath);
        await mkdir(path.dirname(targetFile), { recursive: true });
        await this.copy(sourceFile, targetFile);
        const copied = await describeFile(targetFile, file.relativePath, true);
        if (!sameFile(file, copied)) {
          throw new StorageOperationError(
            'verification_failed',
            'A copied file failed verification'
          );
        }
      }
      await assertEmptyDirectory(plan.targetPath);
      await rm(plan.targetPath, { recursive: true });
      try {
        await rename(staging, plan.targetPath);
      } catch (error) {
        await mkdir(plan.targetPath, { recursive: true });
        throw new StorageOperationError(
          'publish_failed',
          'Verified migration data could not be published',
          error
        );
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (error instanceof StorageOperationError) throw error;
      throw new StorageOperationError('copy_failed', 'Directory migration failed', error);
    }
  }

  private async requireDirectory(
    id: string,
    purpose: DirectoryPurpose
  ): Promise<DirectoryRegistryEntry> {
    const entry = await this.registry.resolve(id, purpose);
    if (!entry) {
      throw new StorageOperationError(
        'directory_not_registered',
        'Controlled directory is not registered for this purpose'
      );
    }
    try {
      if (!(await stat(entry.directoryPath)).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new StorageOperationError(
        'directory_disconnected',
        'Controlled directory is unavailable',
        error
      );
    }
    return entry;
  }
}

export async function scanDirectoryUsage(
  root: string,
  maximumFileCount = 100_000
): Promise<{ readonly totalBytes: number; readonly fileCount: number; readonly truncated: boolean }> {
  try {
    assertSafeManagedRoot(root);
    const files = await scanFiles(root, maximumFileCount, false);
    return {
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      fileCount: files.length,
      truncated: false
    };
  } catch (error) {
    if (error instanceof StorageOperationError && error.code === 'scan_limit_exceeded') {
      return { totalBytes: errorBytes(error), fileCount: maximumFileCount, truncated: true };
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { totalBytes: 0, fileCount: 0, truncated: false };
    }
    throw error;
  }
}

async function scanFiles(
  root: string,
  maximumFileCount: number,
  includeHashes: boolean
): Promise<readonly MigrationFile[]> {
  const result: MigrationFile[] = [];
  const pending = [''];
  let bytes = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop() ?? '';
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        if (includeHashes) {
          throw new StorageOperationError('symbolic_link_rejected', 'Symbolic links cannot be migrated');
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new StorageOperationError('unsupported_file_type', 'Unsupported file type found');
      }
      if (result.length >= maximumFileCount) {
        const error = new StorageOperationError('scan_limit_exceeded', 'Directory scan limit exceeded');
        Object.assign(error, { scannedBytes: bytes });
        throw error;
      }
      const file = await describeFile(
        path.join(root, relativePath),
        relativePath,
        includeHashes
      );
      bytes += file.bytes;
      result.push(file);
    }
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function describeFile(
  target: string,
  relativePath: string,
  includeHash: boolean
): Promise<MigrationFile> {
  const metadata = await stat(target);
  if (!metadata.isFile()) {
    throw new StorageOperationError('unsupported_file_type', 'Migration entry is not a file');
  }
  return {
    relativePath,
    bytes: metadata.size,
    modifiedMs: metadata.mtimeMs,
    sha256: includeHash ? await hashFile(target) : ''
  };
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertEmptyDirectory(target: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(target);
  } catch (error) {
    throw new StorageOperationError('directory_disconnected', 'Target directory is unavailable', error);
  }
  if (entries.length > 0) {
    throw new StorageOperationError('target_conflict', 'Target directory is not empty');
  }
}

function sameManifest(
  planned: readonly MigrationFile[],
  current: readonly MigrationFile[]
): boolean {
  return planned.length === current.length && planned.every((file, index) =>
    sameFile(file, current[index])
  );
}

function sameFile(left: MigrationFile, right: MigrationFile): boolean {
  return left.relativePath === right.relativePath &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256;
}

async function availableBytes(target: string): Promise<number | null> {
  try {
    const facts = await statfs(target, { bigint: true });
    const bytes = facts.bavail * facts.bsize;
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  } catch {
    return null;
  }
}

async function assertAccess(target: string, mode: number): Promise<void> {
  try {
    await access(target, mode);
  } catch (error) {
    throw new StorageOperationError(
      'directory_permission_denied',
      'Directory permissions do not allow migration',
      error
    );
  }
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ||
    (!reverse.startsWith('..') && !path.isAbsolute(reverse));
}

function assertSafeManagedRoot(target: string): void {
  const resolved = path.resolve(target);
  if (samePath(resolved, path.parse(resolved).root) || samePath(resolved, os.homedir())) {
    throw new StorageOperationError(
      'unsafe_scan_root',
      'Disk roots and the user home directory cannot be scanned'
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function errorBytes(error: StorageOperationError): number {
  const value = (error as StorageOperationError & { scannedBytes?: unknown }).scannedBytes;
  return typeof value === 'number' ? value : 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
