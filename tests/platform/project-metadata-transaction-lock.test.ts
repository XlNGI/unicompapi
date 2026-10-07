import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { NodeProjectStorage, projectStoragePaths, toProjectRelativePath } from '../../src/platform/storage';
import { withProjectMetadataTransactionLock } from '../../src/platform/storage/project-metadata-transaction-lock';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { createConversationAgentSession, toConversationAgentRunId, toConversationId, toMessageId, toProjectId, toIsoTimestamp, updateConversationAgentSession, toWorkId } from '../../src/domain';

const roots: string[] = [], workers: { child: ChildProcessWithoutNullStreams; exited: Promise<void> }[] = [];
let bundleRoot: string, workerFile: string;
function safeRoot(root: string) {
  if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-metadata-lock-')) throw new Error('Unsafe metadata lock test cleanup');
}
beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-metadata-lock-bundle-')); workerFile = path.join(bundleRoot, 'worker.cjs');
  const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild') as { build(options: Readonly<Record<string, unknown>>): Promise<unknown> };
  await esbuild.build({ entryPoints: [path.resolve('tests/fixtures/project-metadata-lock-worker.ts')], outfile: workerFile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map(async ({ child, exited }) => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }));
  await Promise.all(roots.splice(0).map(async root => { safeRoot(root); await rm(root, { recursive: true, force: true }); }));
});
afterAll(async () => { if (bundleRoot) { safeRoot(bundleRoot); await rm(bundleRoot, { recursive: true, force: true }); } });
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-metadata-lock-test-')); roots.push(root); return { root, target: path.join(root, 'entities/project-metadata.json'), storage: new NodeProjectStorage(root) }; }
function start(root: string, mode = 'claim') {
  const child = spawn(process.execPath, [workerFile, root, mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); }); workers.push({ child, exited });
  const messages: Record<string, unknown>[] = [], subscribers: (() => void)[] = []; let buffered = '';
  child.stdout.on('data', chunk => {
    buffered += String(chunk); let boundary: number;
    while ((boundary = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 1); if (line) messages.push(JSON.parse(line) as Record<string, unknown>); }
    for (const subscriber of [...subscribers]) subscriber();
  });
  function wait(kind: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error(`metadata worker did not emit ${kind}`)); }, 4000);
      const check = () => { const index = messages.findIndex(message => message.kind === kind); if (index >= 0) { const [message] = messages.splice(index, 1); clearTimeout(timer); unsubscribe(); resolve(message); } };
      const unsubscribe = () => { const index = subscribers.indexOf(check); if (index >= 0) subscribers.splice(index, 1); };
      subscribers.push(check); check();
    });
  }
  return { child, exited, wait, go: () => child.stdin.write('go\n') };
}
function initial(createdAt = toIsoTimestamp(new Date().toISOString())) {
  const digest = 'a'.repeat(64);
  return createConversationAgentSession({ id: toConversationAgentRunId('session-os-lock'), projectId: toProjectId('project-os-lock'), conversationId: toConversationId('conversation-os-lock'), sourceMessageId: toMessageId('source-os-lock'),
    budget: { startedAt: Date.parse(createdAt), deadlineAt: Date.parse(createdAt) + 360_000, maxToolCalls: 8, budgetUnits: 24 }, createdAt,
    inputReferences: [{ kind: 'message', id: 'source-os-lock', version: 0, contentHash: digest }], initialSegment: { runId: toConversationAgentRunId('session-os-lock'), sourceMessageId: toMessageId('source-os-lock'), inputReferenceHash: digest, status: 'active', toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 } });
}
async function ownerFile(target: string, text: string) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(`${target}.transaction.lock`, text, 'utf8'); }
describe('OS metadata transaction lock', () => {
  it('serializes two independent Node processes acquiring one actual session lease', async () => {
    const { root, storage, target } = await setup(), repository = new JsonConversationAgentSessionRepository(storage, toProjectId('project-os-lock')), session = initial(); await repository.create(session);
    const first = start(root), second = start(root); await Promise.all([first.wait('ready'), second.wait('ready')]); first.go(); second.go();
    const results = await Promise.all([first.wait('result'), second.wait('result')]); await Promise.all([first.exited, second.exited]);
    expect(results.filter(result => result.status === 'acquired')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')?.code).toBe('conversation_agent_session_lease_busy');
    expect((await repository.get(session.id))?.leaseEpoch).toBe(1); await expect(access(`${target}.transaction.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reclaims a real crashed writer only after its process is proven absent', async () => {
    const { root, target, storage } = await setup(), holder = start(root, 'hold'); await holder.wait('ready'); holder.go(); await holder.wait('held');
    const owner = JSON.parse(await readFile(`${target}.transaction.lock`, 'utf8')) as { pid: number }; expect(owner.pid).toBe(holder.child.pid);
    holder.child.kill('SIGKILL'); await holder.exited;
    await storage.writeJsonAtomically(projectStoragePaths.entities.metadataUnit, { schemaVersion: 1, fact: 'replacement-after-crash' });
    expect(await storage.readJson(projectStoragePaths.entities.metadataUnit)).toEqual({ schemaVersion: 1, fact: 'replacement-after-crash' });
    await expect(access(`${target}.transaction.lock.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('checks the expired session fence after another OS process releases the queued metadata lock', async () => {
    const { root, storage } = await setup(), session = initial(); let clock = session.budget.startedAt + 100;
    const repository = new JsonConversationAgentSessionRepository(storage, session.projectId, () => new Date(clock).toISOString()); await repository.create(session);
    const claim = await repository.acquireLease({ sessionId: session.id, ownerId: 'owner-original', ttlMs: 1000 });
    const holder = start(root, 'hold'); await holder.wait('ready'); holder.go(); await holder.wait('held');
    const next = updateConversationAgentSession(claim.session, { registeredWorkIds: [toWorkId('work-late')] }, claim.session.updatedAt);
    const queued = repository.commit({ sessionId: session.id, expectedRevision: claim.session.revision, session: next, fence: { ownerId: claim.lease.ownerId, epoch: claim.lease.epoch } });
    await new Promise<void>(resolve => setTimeout(resolve, 40)); clock = claim.lease.expiresAt + 1; holder.go();
    await expect(queued).rejects.toThrow('conversation_agent_session_lease_lost'); await holder.exited;
    expect((await repository.get(session.id))?.revision).toBe(claim.session.revision);
  });
  it('does not reclaim an aged live PID and protects primary plus backup writes', async () => {
    const { root, target } = await setup(); const original = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID(), createdAt: '2000-01-01T00:00:00.000Z' })}\n`; await ownerFile(target, original);
    const storage = new NodeProjectStorage(root, { metadataTransactionLock: { waitTimeoutMs: 25, pollIntervalMs: 5 } });
    await expect(storage.writeJsonAtomically(projectStoragePaths.entities.metadataUnit, { unsafe: true })).rejects.toThrow('project_metadata_transaction_lock_timeout');
    await expect(storage.writeJsonAtomically(toProjectRelativePath('entities/project-metadata.json.bak'), { unsafe: true })).rejects.toThrow('project_metadata_transaction_lock_timeout');
    expect(await readFile(`${target}.transaction.lock`, 'utf8')).toBe(original);
    await storage.writeJsonAtomically(projectStoragePaths.manifest, { unrelated: true });
  });
  it('keeps corrupt owner or recovery evidence fail-closed without touching metadata', async () => {
    const { root, target } = await setup(); await ownerFile(target, '{broken');
    await expect(withProjectMetadataTransactionLock(root, target, async () => 'unsafe', { waitTimeoutMs: 20, pollIntervalMs: 5 })).rejects.toThrow(/lock_timeout/);
    expect(await readFile(`${target}.transaction.lock`, 'utf8')).toBe('{broken');
    await rm(`${target}.transaction.lock`); await writeFile(`${target}.transaction.lock.recovery`, 'unknown recovery owner', 'utf8');
    await expect(withProjectMetadataTransactionLock(root, target, async () => 'unsafe', { waitTimeoutMs: 20, pollIntervalMs: 5 })).rejects.toThrow(/lock_timeout/);
  });
  it('still allows readonly backup inspection while an active writer owns the mutex', async () => {
    const { root, target, storage } = await setup(); await storage.writeJsonAtomically(projectStoragePaths.entities.metadataUnit, { count: 1 }); await storage.writeJsonAtomically(projectStoragePaths.entities.metadataUnit, { count: 2 }, { backup: true });
    await ownerFile(target, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() })}\n`);
    await writeFile(target, '{broken', 'utf8');
    expect(await storage.readJsonWithBackup(projectStoragePaths.entities.metadataUnit, value => value)).toEqual({ value: { count: 1 }, source: 'backup' });
    await expect(withProjectMetadataTransactionLock(root, target, async () => 'unsafe', { waitTimeoutMs: 20, pollIntervalMs: 5 })).rejects.toThrow(/lock_timeout/);
  });
  it('rejects a transaction lock junction that escapes the controlled project root', async () => {
    const { root, target } = await setup(), outside = await mkdtemp(path.join(os.tmpdir(), 'unicomp-metadata-lock-outside-')); roots.push(outside);
    await mkdir(path.dirname(target), { recursive: true }); await symlink(outside, `${target}.transaction.lock`, 'junction');
    await expect(withProjectMetadataTransactionLock(root, target, async () => 'unsafe')).rejects.toMatchObject({ code: 'symbolic_link_rejected' });
  });
});
