import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloneProviderSubmitOutcome,
  createProviderOperationRecord,
  toExecutionId,
  toIsoTimestamp,
  toProviderOperationRecordId,
  toTaskId,
  type ProviderImmediateResultReference,
  type ProviderOperationRecord
} from '../../src/domain';
import { NodeProjectStorage } from '../../src/platform/storage/node-project-storage';
import { toProjectRelativePath } from '../../src/platform/storage/project-paths';
import { ProviderResultPayloadStore } from '../../src/platform/storage/provider-result-payload-store';

type Base64Result = Extract<ProviderImmediateResultReference, { kind: 'base64' }>;
type StoredBase64Result = Extract<ProviderImmediateResultReference, { kind: 'stored_base64' }>;

const roots: string[] = [];
const payload: Base64Result = { kind: 'base64', value: 'aGVsbG8=', mimeType: 'image/png' };
const timestamp = toIsoTimestamp('2026-10-10T00:00:00.000Z');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProviderResultPayloadStore', () => {
  it('writes and verifies a payload before returning its reference without changing the input', async () => {
    const { root, storage, store } = await fixture();
    const read = vi.spyOn(storage, 'readJson');
    const write = vi.spyOn(storage, 'writeJsonAtomically');
    const remote: ProviderImmediateResultReference = { kind: 'remote_url', value: 'https://example.com/image.png' };
    const input = record([payload, remote]);
    const output = await store.externalize(input);
    const reference = firstStored(output);

    expect(reference).toEqual(referenceFor(payload));
    expect(input.outcome).toMatchObject({ results: [payload, remote] });
    expect(output).toEqual({ ...input, outcome: { ...input.outcome, results: [reference, remote] } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    expect(read.mock.invocationCallOrder[1]).toBeGreaterThan(write.mock.invocationCallOrder[0]);
    expect(JSON.parse(await readFile(payloadFile(root, reference), 'utf8'))).toEqual(payload);
    await expect(store.resolve(reference)).resolves.toEqual(payload);
  });

  it('shares one immutable file between two concurrent ledger records and store instances', async () => {
    const { root, storage, store } = await fixture();
    const secondStorage = new NodeProjectStorage(root);
    const secondStore = new ProviderResultPayloadStore(secondStorage);
    const firstWrite = vi.spyOn(storage, 'writeJsonAtomically');
    const secondWrite = vi.spyOn(secondStorage, 'writeJsonAtomically');
    const [first, second] = await Promise.all([
      store.externalize(record([payload], 'first-ledger')),
      secondStore.externalize(record([payload], 'second-ledger'))
    ]);

    expect(firstStored(first)).toEqual(firstStored(second));
    expect(firstWrite.mock.calls.length + secondWrite.mock.calls.length).toBe(1);
    const before = await readFile(payloadFile(root, firstStored(first)), 'utf8');
    await store.externalize(record([payload]));
    expect(firstWrite.mock.calls.length + secondWrite.mock.calls.length).toBe(1);
    expect(await readFile(payloadFile(root, firstStored(first)), 'utf8')).toBe(before);
    expect(await readdir(path.join(root, 'results', 'provider-payloads'))).toEqual([`${firstStored(first).value}.json`]);
  });

  it('includes both MIME type and value in the digest', async () => {
    const { store } = await fixture();
    const outputs = await Promise.all([
      store.externalize(record([payload])),
      store.externalize(record([{ ...payload, mimeType: 'image/jpeg' }])),
      store.externalize(record([{ ...payload, value: 'd29ybGQ=' }]))
    ]);
    expect(new Set(outputs.map((output) => firstStored(output).value)).size).toBe(3);
  });

  it('returns the original object without storage access when no base64 needs migration', async () => {
    const { storage, store } = await fixture();
    const read = vi.spyOn(storage, 'readJson');
    const write = vi.spyOn(storage, 'writeJsonAtomically');
    const lock = vi.spyOn(storage, 'withExclusiveAccess');
    const records: ProviderOperationRecord[] = [
      record([referenceFor(payload)]),
      record([{ kind: 'remote_url', value: 'https://example.com/result' }, { kind: 'file_uri', value: 'file:///result.png' }]),
      { ...record([payload]), outcome: { kind: 'submission_outcome_unknown', message: 'unknown' } },
      { ...record([payload]), outcome: { kind: 'accepted_async', providerOperationId: 'async', state: 'queued' } }
    ];
    for (const input of records) expect(await store.externalize(input)).toBe(input);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it.each(['not base64!', 'abc', '', 'aGVsbG8=\n'])('preserves legacy encoding %j for validation by the consumer', async (value) => {
    const { store } = await fixture();
    const original = { ...payload, value };
    const input: ProviderOperationRecord = {
      ...record([payload]),
      outcome: { kind: 'completed_sync', providerOperationId: 'provider-result', results: [original] }
    };
    await expect(store.resolve(firstStored(await store.externalize(input)))).resolves.toEqual(original);
  });

  it.each([20, 21])('preserves a %i MiB result without imposing the receiver limit during storage', async (sizeMiB) => {
    const { store } = await fixture();
    const large = { ...payload, value: Buffer.alloc(sizeMiB * 1024 * 1024).toString('base64') };
    const reference = firstStored(await store.externalize(record([large])));
    expect((await store.resolve(reference)).value).toBe(large.value);
  });

  it('rejects payloads exceeding the encoded 128 MiB provider bound', async () => {
    const { store, storage } = await fixture();
    const oversized = { ...payload, value: 'A'.repeat(Math.ceil(128 * 1024 * 1024 / 3) * 4 + 4) };
    const input: ProviderOperationRecord = {
      ...record([payload]),
      outcome: { kind: 'completed_sync', providerOperationId: 'provider-result', results: [oversized] }
    };
    const write = vi.spyOn(storage, 'writeJsonAtomically');
    await expect(store.externalize(input)).rejects.toThrow('too large');
    expect(write).not.toHaveBeenCalled();
    vi.spyOn(storage, 'readJson').mockResolvedValue(oversized);
    await expect(store.resolve(referenceFor(payload))).rejects.toThrow('too large');
  });

  it.each([
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['wrong kind', JSON.stringify({ ...payload, kind: 'remote_url' })],
    ['changed value', JSON.stringify({ ...payload, value: 'd29ybGQ=' })],
    ['changed MIME', JSON.stringify({ ...payload, mimeType: 'image/jpeg' })],
    ['missing value', JSON.stringify({ kind: 'base64', mimeType: 'image/png' })]
  ])('fails on %s without overwriting or falling back', async (_name, contents) => {
    const { root, storage, store } = await fixture();
    const reference = firstStored(await store.externalize(record([payload])));
    await writeFile(payloadFile(root, reference), contents);
    const write = vi.spyOn(storage, 'writeJsonAtomically');
    await expect(store.resolve(reference)).rejects.toThrow();
    await expect(store.externalize(record([payload]))).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(payloadFile(root, reference), 'utf8')).toBe(contents);
  });

  it('fails for missing payloads and mismatched reference MIME types', async () => {
    const { store } = await fixture();
    await expect(store.resolve(referenceFor(payload))).rejects.toThrow('missing or invalid');
    const reference = firstStored(await store.externalize(record([payload])));
    await expect(store.resolve({ ...reference, mimeType: 'image/jpeg' })).rejects.toThrow('integrity');
  });

  it.each(['../secret', '..\\secret', '/absolute', 'C:\\secret', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), `${'a'.repeat(64)}\n`, ` ${'a'.repeat(64)}`])(
    'rejects illegal hash %j before touching storage and during domain cloning',
    async (value) => {
      const { storage, store } = await fixture();
      const read = vi.spyOn(storage, 'readJson');
      const reference: StoredBase64Result = { kind: 'stored_base64', value, mimeType: 'image/png' };
      await expect(store.resolve(reference)).rejects.toThrow('hash');
      expect(read).not.toHaveBeenCalled();
      expect(() => cloneProviderSubmitOutcome({ kind: 'completed_sync', providerOperationId: 'provider', results: [reference] })).toThrow('SHA-256');
    }
  );

  it('clones valid stored references with their MIME intact', () => {
    const reference = referenceFor(payload);
    const outcome = { kind: 'completed_sync' as const, providerOperationId: 'provider', results: [reference] };
    const cloned = cloneProviderSubmitOutcome(outcome);
    expect(cloned).toEqual(outcome);
    if (cloned.kind !== 'completed_sync') throw new Error('Expected synchronous outcome');
    expect(cloned.results[0]).not.toBe(reference);
  });

  it('rejects symlink or junction traversal through the storage adapter', async () => {
    const { root, store } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'unicomp-payload-outside-'));
    roots.push(outside);
    await mkdir(path.join(root, 'results'));
    await symlink(outside, path.join(root, 'results', 'provider-payloads'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.externalize(record([payload]))).rejects.toThrow();
    await expect(store.resolve(referenceFor(payload))).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not publish a reference when the atomic write fails before replacement', async () => {
    const root = await temporaryRoot();
    const storage = new NodeProjectStorage(root, {
      onAtomicWriteStage: ({ stage }) => {
        if (stage === 'before_replace') throw new Error('injected write failure');
      }
    });
    const store = new ProviderResultPayloadStore(storage);
    const input = record([payload]);
    await expect(store.externalize(input)).rejects.toThrow('injected write failure');
    expect(input.outcome).toMatchObject({ results: [payload] });
    expect(await readdir(path.join(root, 'results', 'provider-payloads'))).toEqual([]);
    await expect(store.resolve(referenceFor(payload))).rejects.toThrow();
  });

  it('does not return a reference when read-back fails integrity verification', async () => {
    const { storage, store } = await fixture();
    const write = storage.writeJsonAtomically.bind(storage);
    vi.spyOn(storage, 'writeJsonAtomically').mockImplementation(async (target) => {
      await write(target, { ...payload, value: 'dGFtcGVyZWQ=' });
    });
    await expect(store.externalize(record([payload]))).rejects.toThrow('integrity');
  });

  it('can verify and reuse the payload after a post-replacement write failure', async () => {
    const root = await temporaryRoot();
    const storage = new NodeProjectStorage(root, {
      onAtomicWriteStage: ({ stage }) => {
        if (stage === 'after_replace') throw new Error('injected post-replace failure');
      }
    });
    const store = new ProviderResultPayloadStore(storage);
    await expect(store.externalize(record([payload]))).rejects.toThrow('post-replace');
    const write = vi.spyOn(storage, 'writeJsonAtomically');
    const reference = firstStored(await store.externalize(record([payload])));
    expect(write).not.toHaveBeenCalled();
    await expect(store.resolve(reference)).resolves.toEqual(payload);
    await expect(storage.readJson(toProjectRelativePath(`results/provider-payloads/${reference.value}.json`))).resolves.toEqual(payload);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-payload-'));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = await temporaryRoot();
  const storage = new NodeProjectStorage(root);
  return { root, storage, store: new ProviderResultPayloadStore(storage) };
}

function record(results: readonly ProviderImmediateResultReference[], id = 'operation'): ProviderOperationRecord {
  return createProviderOperationRecord({
    id: toProviderOperationRecordId(id),
    taskId: toTaskId('task'),
    executionId: toExecutionId('execution'),
    mediaKind: 'image',
    executionLifecycle: 'synchronous_completed',
    outcome: { kind: 'completed_sync', providerOperationId: 'provider-result', results },
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function firstStored(input: ProviderOperationRecord): StoredBase64Result {
  if (input.outcome.kind !== 'completed_sync' || input.outcome.results[0].kind !== 'stored_base64') {
    throw new Error('Expected a stored base64 reference');
  }
  return input.outcome.results[0];
}

function referenceFor(input: Base64Result): StoredBase64Result {
  return {
    kind: 'stored_base64',
    value: createHash('sha256').update(JSON.stringify([input.mimeType, input.value])).digest('hex'),
    mimeType: input.mimeType
  };
}

function payloadFile(root: string, reference: StoredBase64Result): string {
  return path.join(root, 'results', 'provider-payloads', `${reference.value}.json`);
}
