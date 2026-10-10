import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderOperationRecord } from '../../src/domain';
import { StoredImmediateImageResultPort } from '../../src/platform/images/stored-immediate-image-result-port';
import { JsonProviderOperationRepository } from '../../src/platform/repositories/json-provider-operation-repository';
import { NodeProjectStorage, type AtomicJsonWriteEvent } from '../../src/platform/storage/node-project-storage';
import { ProjectMetadataUnitOfWork } from '../../src/platform/storage/project-metadata-unit-of-work';
import { projectStoragePaths, toProjectRelativePath } from '../../src/platform/storage/project-paths';
import { ProjectSubmissionAcceptanceStore } from '../../src/platform/storage/project-submission-acceptance';
import {
  acceptanceMetadataKey,
  createAcceptance,
  createProviderResultHistoryFixture,
  historyImageBase64
} from '../fixtures/provider-result-history';

const roots: string[] = [];
const operationPath = projectStoragePaths.entities.providerOperations;
const metadataPath = projectStoragePaths.entities.metadataUnit;
const largeBase64 = Buffer.alloc(256 * 1024, 73).toString('base64');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-history-compaction-'));
  roots.push(root);
  const events: AtomicJsonWriteEvent[] = [];
  const storage = new NodeProjectStorage(root, { onAtomicWriteStage: (event) => { events.push(event); } });
  const metadata = new ProjectMetadataUnitOfWork(storage);
  return {
    root, events, storage, metadata,
    operations: new JsonProviderOperationRepository(storage),
    acceptances: new ProjectSubmissionAcceptanceStore(metadata)
  };
}

function storedResult(record: ProviderOperationRecord) {
  if (record.outcome.kind !== 'completed_sync') throw new Error('Expected synchronous receipt');
  const result = record.outcome.results[0];
  if (result.kind !== 'stored_base64') throw new Error('Expected stored result reference');
  expect(result.value).toMatch(/^[a-f0-9]{64}$/);
  expect(result.mimeType).toBe('image/png');
  return result;
}

async function seedHistory(target: Awaited<ReturnType<typeof fixture>>) {
  const history = createProviderResultHistoryFixture({
    operationCount: 2, acceptanceCount: 3, base64: largeBase64
  });
  await target.storage.writeJsonAtomically(operationPath, history.operationDocument);
  await target.storage.writeJsonAtomically(metadataPath, history.metadataDocument);
  target.events.length = 0;
  return history;
}

describe('provider result history compaction', () => {
  it('externalizes new receipts in both ledgers through save, accept and advance', async () => {
    const target = await fixture();
    const accepted = createAcceptance(0, {
      results: [{ kind: 'base64', value: largeBase64, mimeType: 'image/png' }]
    });
    await target.operations.save(accepted.providerOperationRecord!);
    await target.acceptances.accept(accepted);
    await target.acceptances.accept(createAcceptance(1, { includeResult: false }));
    const advanced = createAcceptance(1, {
      results: [{ kind: 'base64', value: largeBase64, mimeType: 'image/png' }]
    });
    await target.acceptances.advance({
      intent: advanced.intent,
      invocationEvent: advanced.invocationEvents[1],
      providerOperationRecord: advanced.providerOperationRecord
    });
    const records = await target.operations.list();
    const acceptances = await target.acceptances.list();
    const reference = storedResult(records[0]);
    expect(acceptances.map((acceptance) => storedResult(acceptance.providerOperationRecord!)))
      .toEqual([reference, reference]);
    for (const relativePath of [operationPath, metadataPath]) {
      const text = await readFile(path.join(target.root, relativePath), 'utf8');
      expect(text).not.toContain(largeBase64);
      expect(text.length).toBeLessThan(20_000);
    }
    expect(await readdir(path.join(target.root, 'results/provider-payloads')))
      .toEqual([`${reference.value}.json`]);
    await expect(target.operations.resolveResult(reference)).resolves.toEqual({
      kind: 'base64', value: largeBase64, mimeType: 'image/png'
    });
    expect(accepted.providerOperationRecord!.outcome).toMatchObject({
      results: [{ kind: 'base64', value: largeBase64 }]
    });
  });

  it('keeps list/get read-only and explicitly migrates history without changing business facts', async () => {
    const target = await fixture();
    const history = await seedHistory(target);
    await expect(target.operations.list()).resolves.toEqual(history.operations);
    await expect(target.operations.get(history.operations[0].id)).resolves.toEqual(history.operations[0]);
    await expect(target.acceptances.list()).resolves.toEqual(history.acceptances);
    await expect(target.acceptances.get(history.acceptances[0].intent.id)).resolves.toEqual(history.acceptances[0]);
    expect(target.events).toEqual([]);
    expect(await target.storage.readJson(operationPath)).toEqual(history.operationDocument);
    expect((await target.metadata.load()).document).toEqual(history.metadataDocument);

    await target.operations.compactResultHistory();
    await target.acceptances.compactResultHistory();
    const records = await target.operations.list();
    const acceptances = await target.acceptances.list();
    for (const [index, record] of records.entries()) {
      const original = history.operations[index];
      expect(record).toEqual({ ...original, outcome: {
        ...original.outcome, results: [storedResult(record)]
      } });
      expect(acceptances[index]).toEqual({
        ...history.acceptances[index], providerOperationRecord: record
      });
    }
    expect(acceptances[2]).toEqual(history.acceptances[2]);
    const migrated = (await target.metadata.load()).document;
    expect(migrated.revision).toBe(history.metadataDocument.revision + 1);
    expect(migrated.entries.filter((entry) => entry.key !== acceptanceMetadataKey))
      .toEqual(history.metadataDocument.entries.filter((entry) => entry.key !== acceptanceMetadataKey));
    expect(await target.storage.readJson(operationPath)).toEqual({
      ...history.operationDocument, revision: history.operationDocument.revision + 1, records
    });
    for (const relativePath of [operationPath, metadataPath]) {
      expect(await readFile(path.join(target.root, relativePath), 'utf8')).not.toContain(largeBase64);
      expect(target.events.filter((event) => event.stage === 'after_replace' &&
        event.targetPath === path.join(target.root, relativePath))).toHaveLength(1);
    }
    expect(await target.storage.readJson(toProjectRelativePath(`${operationPath}.bak`)))
      .toEqual(history.operationDocument);
    expect(await target.storage.readJson(toProjectRelativePath(`${metadataPath}.bak`)))
      .toEqual(history.metadataDocument);
  });

  it('does not rewrite either ledger or payload on repeated reads and compaction after restart', async () => {
    const target = await fixture();
    await seedHistory(target);
    await target.operations.compactResultHistory();
    await target.acceptances.compactResultHistory();
    const before = await Promise.all([operationPath, metadataPath].map((relativePath) =>
      readFile(path.join(target.root, relativePath), 'utf8')));
    const storage = new NodeProjectStorage(target.root, {
      onAtomicWriteStage: (event) => { target.events.push(event); }
    });
    const operations = new JsonProviderOperationRepository(storage);
    const acceptances = new ProjectSubmissionAcceptanceStore(new ProjectMetadataUnitOfWork(storage));
    target.events.length = 0;
    for (let count = 0; count < 2; count += 1) {
      await operations.list();
      await acceptances.list();
      await operations.compactResultHistory();
      await acceptances.compactResultHistory();
    }
    expect(target.events).toEqual([]);
    expect(await Promise.all([operationPath, metadataPath].map((relativePath) =>
      readFile(path.join(target.root, relativePath), 'utf8')))).toEqual(before);
  });

  it('resolves a migrated image after restart and safely rejects a missing payload', async () => {
    const target = await fixture();
    const history = createProviderResultHistoryFixture({ operationCount: 1, acceptanceCount: 1 });
    await target.storage.writeJsonAtomically(operationPath, history.operationDocument);
    await target.operations.compactResultHistory();
    const operations = new JsonProviderOperationRepository(new NodeProjectStorage(target.root));
    const downloader = { download: vi.fn(async () => { throw new Error('Unexpected network request'); }) };
    const port = new StoredImmediateImageResultPort({ operations, downloader });
    const reference = { kind: 'provider_operation_record' as const, id: history.operations[0].id };
    await expect(port.getCompletedResult(reference)).resolves.toEqual({
      name: 'image-result.png', declaredMimeType: 'image/png',
      expectedSizeBytes: Buffer.from(historyImageBase64, 'base64').length
    });
    const destination = path.join(target.root, 'recovered.png');
    await port.download(reference, destination);
    expect(await readFile(destination)).toEqual(Buffer.from(historyImageBase64, 'base64'));
    const result = storedResult((await operations.get(reference.id))!);
    await target.storage.remove(toProjectRelativePath(`results/provider-payloads/${result.value}.json`));
    await expect(port.getCompletedResult(reference)).rejects.toMatchObject({
      retryability: 'not_retryable', message: 'The stored image result is missing or damaged'
    });
    const missingDestination = path.join(target.root, 'missing.png');
    await expect(port.download(reference, missingDestination)).rejects.toMatchObject({
      retryability: 'not_retryable', message: 'The stored image result is missing or damaged'
    });
    await expect(readFile(missingDestination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(downloader.download).not.toHaveBeenCalled();
  });

  it.each([operationPath, metadataPath])('skips compaction of %s when only the backup has a valid schema', async (relativePath) => {
    const target = await fixture();
    const history = createProviderResultHistoryFixture({ operationCount: 1, acceptanceCount: 2 });
    await target.storage.writeJsonAtomically(operationPath, history.operationDocument);
    await target.storage.writeJsonAtomically(metadataPath, history.metadataDocument);
    target.events.length = 0;
    const primaryPath = path.join(target.root, relativePath);
    const backupPath = `${primaryPath}.bak`;
    const backupBytes = await readFile(primaryPath);
    await writeFile(backupPath, backupBytes);
    const invalidDocument = {
      ...JSON.parse(backupBytes.toString('utf8')),
      schemaVersion: 999
    };
    const invalidBytes = Buffer.from(JSON.stringify(invalidDocument));
    await writeFile(primaryPath, invalidBytes);
    const beforeReplace = vi.fn(() => { throw new Error('Unexpected before_replace during backup recovery'); });
    const storage = new NodeProjectStorage(target.root, {
      onAtomicWriteStage: (event) => {
        target.events.push(event);
        if (event.stage === 'before_replace') beforeReplace();
      }
    });
    const repository = relativePath === operationPath
      ? new JsonProviderOperationRepository(storage)
      : new ProjectSubmissionAcceptanceStore(new ProjectMetadataUnitOfWork(storage));
    const expected = relativePath === operationPath ? history.operations : history.acceptances;
    await expect(storage.readJson(relativePath)).resolves.toEqual(invalidDocument);
    await expect(repository.list()).resolves.toEqual(expected);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(repository.compactResultHistory()).resolves.toBeUndefined();
      expect(await readFile(backupPath)).toEqual(backupBytes);
      expect(await readFile(primaryPath)).toEqual(invalidBytes);
      await expect(repository.list()).resolves.toEqual(expected);
    }
    expect(beforeReplace).not.toHaveBeenCalled();
    expect(target.events).toEqual([]);
    const restartedStorage = new NodeProjectStorage(target.root);
    const restarted = relativePath === operationPath
      ? new JsonProviderOperationRepository(restartedStorage)
      : new ProjectSubmissionAcceptanceStore(new ProjectMetadataUnitOfWork(restartedStorage));
    await expect(restarted.list()).resolves.toEqual(expected);
    expect(await readFile(backupPath)).toEqual(backupBytes);
  });

  it.each([operationPath, metadataPath])('preserves the original and recoverable backup when migration of %s fails', async (relativePath) => {
    const target = await fixture();
    const history = await seedHistory(target);
    const original = await readFile(path.join(target.root, relativePath), 'utf8');
    const failure = new Error('Injected before_replace failure');
    let injected = false;
    const storage = new NodeProjectStorage(target.root, {
      onAtomicWriteStage: (event) => {
        if (event.stage === 'before_replace' && event.targetPath === path.join(target.root, relativePath)) {
          injected = true;
          throw failure;
        }
      }
    });
    const compact = () => relativePath === operationPath
      ? new JsonProviderOperationRepository(storage).compactResultHistory()
      : new ProjectSubmissionAcceptanceStore(new ProjectMetadataUnitOfWork(storage)).compactResultHistory();
    await expect(compact()).rejects.toThrow('Injected before_replace failure');
    expect(injected).toBe(true);
    expect(await readFile(path.join(target.root, relativePath), 'utf8')).toBe(original);
    expect(await readFile(path.join(target.root, `${relativePath}.bak`), 'utf8')).toBe(original);
    expect((await readdir(path.join(target.root, 'entities'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await writeFile(path.join(target.root, relativePath), '{broken');
    if (relativePath === operationPath) {
      await expect(new JsonProviderOperationRepository(new NodeProjectStorage(target.root)).list())
        .resolves.toEqual(history.operations);
    } else {
      const metadata = new ProjectMetadataUnitOfWork(new NodeProjectStorage(target.root));
      expect((await metadata.load()).source).toBe('backup');
      await expect(new ProjectSubmissionAcceptanceStore(metadata).list()).resolves.toEqual(history.acceptances);
    }
    await writeFile(path.join(target.root, relativePath), original);
    if (relativePath === operationPath) {
      await target.operations.compactResultHistory();
      expect((await target.operations.list()).map(storedResult)).toHaveLength(2);
    } else {
      await target.acceptances.compactResultHistory();
      expect((await target.acceptances.list()).slice(0, 2)
        .map((acceptance) => storedResult(acceptance.providerOperationRecord!))).toHaveLength(2);
    }
  });
});
