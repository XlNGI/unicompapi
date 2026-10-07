import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { assertNoSymbolicLinkTraversal } from './path-security';

export interface ProjectMetadataTransactionLockOptions {
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}
interface LockOwnerV1 { readonly schemaVersion: 1; readonly pid: number; readonly nonce: string; readonly createdAt: string }
interface LockEvidence { readonly owner: LockOwnerV1; readonly dev: number; readonly ino: number; readonly text: string }
export class ProjectMetadataTransactionLockError extends Error {
  constructor(readonly code: 'lock_timeout' | 'ownership_lost') { super(`project_metadata_transaction_${code}`); this.name = 'ProjectMetadataTransactionLockError'; }
}

/** Cross-process metadata write mutex. Elapsed time never proves that a live writer may be displaced. */
export async function withProjectMetadataTransactionLock<T>(rootDirectory: string, primaryTarget: string, operation: () => Promise<T>, options: ProjectMetadataTransactionLockOptions = {}): Promise<T> {
  const timeout = bounded(options.waitTimeoutMs ?? 5000, 1, 30_000), poll = bounded(options.pollIntervalMs ?? 20, 1, 1000);
  const lockPath = `${primaryTarget}.transaction.lock`, recoveryPath = `${lockPath}.recovery`;
  await assertNoSymbolicLinkTraversal(rootDirectory, lockPath);
  await mkdir(path.dirname(primaryTarget), { recursive: true });
  const owner: LockOwnerV1 = { schemaVersion: 1, pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  const started = performance.now();
  let handle: FileHandle | undefined;
  while (!handle) {
    await assertNoSymbolicLinkTraversal(rootDirectory, lockPath);
    await assertNoSymbolicLinkTraversal(rootDirectory, recoveryPath);
    // A crashed recovery guard cannot be reclaimed merely by age; uncertain recovery ownership is fail-closed.
    if (!await exists(recoveryPath)) {
      try { handle = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (!nodeError(error) || error.code !== 'EEXIST') throw error;
        await reclaimProvenDeadOwner(rootDirectory, lockPath, recoveryPath, owner);
      }
    }
    if (!handle) {
      if (performance.now() - started >= timeout) throw new ProjectMetadataTransactionLockError('lock_timeout');
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(poll, Math.max(1, timeout - (performance.now() - started)))));
    }
  }
  let initialized = false;
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync(); initialized = true;
    return await operation();
  } finally {
    await handle.close();
    if (initialized) {
      const current = await evidence(lockPath);
      if (!current || current.owner.pid !== owner.pid || current.owner.nonce !== owner.nonce) throw new ProjectMetadataTransactionLockError('ownership_lost');
      await assertNoSymbolicLinkTraversal(rootDirectory, lockPath);
      await rm(lockPath);
    }
    // An incomplete owner record is deliberately left as uncertain evidence instead of clearing another writer's lock.
  }
}

async function reclaimProvenDeadOwner(root: string, lockPath: string, recoveryPath: string, claimant: LockOwnerV1): Promise<void> {
  const original = await evidence(lockPath);
  if (!original || !processIsProvenAbsent(original.owner.pid)) return;
  let guard: FileHandle;
  try { guard = await open(recoveryPath, 'wx', 0o600); }
  catch (error) { if (nodeError(error) && error.code === 'EEXIST') return; throw error; }
  let initialized = false;
  try {
    await guard.writeFile(`${JSON.stringify(claimant)}\n`, 'utf8'); await guard.sync(); initialized = true;
    await assertNoSymbolicLinkTraversal(root, lockPath);
    const current = await evidence(lockPath);
    if (current && sameEvidence(original, current) && processIsProvenAbsent(current.owner.pid)) await rm(lockPath);
  } finally {
    await guard.close();
    if (initialized) {
      const current = await evidence(recoveryPath);
      if (!current || current.owner.pid !== claimant.pid || current.owner.nonce !== claimant.nonce) throw new ProjectMetadataTransactionLockError('ownership_lost');
      await assertNoSymbolicLinkTraversal(root, recoveryPath); await rm(recoveryPath);
    }
  }
}
async function evidence(target: string): Promise<LockEvidence | undefined> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || stat.nlink !== 1) return undefined;
    const text = await readFile(target, 'utf8'), value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 4 || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(value.nonce) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    const after = await lstat(target);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return undefined;
    return { owner: value as unknown as LockOwnerV1, dev: stat.dev, ino: stat.ino, text };
  } catch (error) { if (error instanceof SyntaxError || nodeError(error) && error.code === 'ENOENT') return undefined; throw error; }
}
function sameEvidence(left: LockEvidence, right: LockEvidence): boolean { return left.dev === right.dev && left.ino === right.ino && left.text === right.text; }
function processIsProvenAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return nodeError(error) && error.code === 'ESRCH'; }
}
async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) { if (nodeError(error) && error.code === 'ENOENT') return false; throw error; }
}
function bounded(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('Invalid metadata lock wait policy'); return value; }
function nodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error; }
