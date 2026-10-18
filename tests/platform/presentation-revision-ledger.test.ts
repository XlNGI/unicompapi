import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeProjectStorage } from '../../src/platform/storage';
import { PresentationRevisionLedger } from '../../src/platform/documents/presentation-revision-ledger';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const pin = { documentLineageId: 'test-lineage', headWorkId: 'work-source', fileId: 'file-source', sourceExecutionId: 'execution-source',
  checksumSha256: 'a'.repeat(64), runtimeRevision: 1, identityIndexVersion: 1 };
describe('visual revision shares the durable document mutation fence', () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-visual-ledger-')); roots.push(root);
    const storage = new NodeProjectStorage(root);
    return (key: string) => new PresentationRevisionLedger(storage, { basePin: pin, idempotencyKey: key.repeat(64), requestFingerprint: 'f'.repeat(64) });
  }
  it('blocks a new operation while a previous document mutation is unresolved', async () => {
    const ledger = await fixture();
    const first = ledger('a'); await first.claim();
    await first.beginPublication(); await first.finish('reconciliation_required');
    await expect(ledger('b').claim()).rejects.toThrow('reconciliation_required');
  });
  it('releases only known terminal operations and fences the head-commit boundary', async () => {
    const ledger = await fixture();
    const first = ledger('a'); await first.claim(); await first.finish('failed');
    const next = ledger('b'); await next.claim(); await next.beginPublication();
    const candidate = { ...pin, headWorkId: 'work-next', fileId: 'file-next', runtimeRevision: 2 };
    await next.finish('commit_prepared', candidate);
    await expect(ledger('c').claim()).rejects.toThrow('reconciliation_required');
    await next.finish('committed', candidate);
    await expect(ledger('c').claim()).resolves.toBeUndefined();
  });
  it('rejects raw text in private audit identity fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-visual-ledger-input-')); roots.push(root);
    expect(() => new PresentationRevisionLedger(new NodeProjectStorage(root), { basePin: pin, idempotencyKey: 'raw request',
      requestFingerprint: 'f'.repeat(64) })).toThrow('invalid_visual_ledger');
  });
});
