import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDraft,
  toDraftId,
  toIsoTimestamp
} from '../../src/domain';
import {
  JsonDocumentDataError,
  JsonDraftRepository,
  JsonRevisionConflictError,
  createJsonDocumentEnvelope,
  createLegacyJsonReadModel,
  migrateJsonDocument,
  NodeProjectStorage,
  parseProjectMetadataDocument,
  ProjectMetadataDraft,
  ProjectMetadataUnitOfWork,
  projectStoragePaths,
  SubmissionIntentJournal,
  type SubmissionIntentJournalEventV1
} from '../../src/platform';
import { createDraftFixture } from '../domain/fixtures';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-31T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-31T00:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-31T00:02:00.000Z');
const t3 = toIsoTimestamp('2026-07-31T00:03:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function rootFixture(prefix = 'unicomp-json-foundation-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('local JSON persistence foundation', () => {
  it('serializes writers by normalized absolute path across storage instances', async () => {
    const root = await rootFixture();
    const firstStorage = new NodeProjectStorage(root);
    const secondStorage = new NodeProjectStorage(path.join(root, '.'));
    const base = createDraftFixture();
    const firstRepository = new JsonDraftRepository(firstStorage, base.projectId);
    const secondRepository = new JsonDraftRepository(secondStorage, base.projectId);
    const drafts = Array.from({ length: 30 }, (_, index) =>
      createDraft({ ...base, id: toDraftId(`draft-shared-writer-${index}`) })
    );

    await Promise.all(
      drafts.map((draft, index) =>
        (index % 2 === 0 ? firstRepository : secondRepository).save(draft)
      )
    );

    await expect(firstRepository.list(base.projectId)).resolves.toHaveLength(30);
    const document = await firstStorage.readJson<Record<string, unknown>>(
      projectStoragePaths.entities.drafts
    );
    expect(document).toMatchObject({ schemaVersion: 2, revision: 30 });
  });

  it('enforces metadata CAS across independent controllers and keeps a valid backup', async () => {
    const root = await rootFixture();
    const first = new ProjectMetadataUnitOfWork(
      new NodeProjectStorage(root),
      () => t0
    );
    const second = new ProjectMetadataUnitOfWork(
      new NodeProjectStorage(root),
      () => t1
    );
    const results = await Promise.allSettled([
      first.transact(0, (draft) => draft.set('route.snapshot', { id: 'route-a' })),
      second.transact(0, (draft) => draft.set('route.snapshot', { id: 'route-b' }))
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(JsonRevisionConflictError)
    });
    const current = await first.load();
    expect(current.document.revision).toBe(1);

    await first.transact(1, (draft) => draft.set('task.snapshot', { id: 'task-a' }));
    const primaryPath = path.join(root, 'entities', 'project-metadata.json');
    await writeFile(primaryPath, '{corrupted-primary', 'utf8');
    const recovered = await second.load();
    expect(recovered.source).toBe('backup');
    expect(recovered.document.revision).toBe(1);
    await expect(readFile(primaryPath, 'utf8')).resolves.toBe('{corrupted-primary');
  });

  it('rejects sensitive metadata before it reaches disk', async () => {
    const root = await rootFixture();
    const unit = new ProjectMetadataUnitOfWork(new NodeProjectStorage(root), () => t0);

    await expect(
      unit.transact(0, (draft) =>
        draft.set('connection.snapshot', {
          connectionId: 'connection-a',
          token: 'must-not-persist'
        } as never)
      )
    ).rejects.toBeInstanceOf(JsonDocumentDataError);
    await expect(
      readFile(path.join(root, 'entities', 'project-metadata.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates public metadata parsing, draft inputs and every exposed snapshot', () => {
    const source = {
      schemaVersion: 1, revision: 0, updatedAt: t0,
      entries: [{ key: 'route.snapshot', value: { nested: { status: 'before' } } }]
    };
    const parsed = parseProjectMetadataDocument(source);
    source.entries[0].value.nested.status = 'source-changed';
    expect(parsed.entries[0].value).toEqual({ nested: { status: 'before' } });

    const draft = new ProjectMetadataDraft(parsed.entries);
    (parsed.entries[0].value as { nested: { status: string } }).nested.status = 'parsed-changed';
    const input = { nested: { status: 'accepted' } };
    draft.set('agent.snapshot', input);
    input.nested.status = 'input-changed';
    const read = draft.get('agent.snapshot') as typeof input;
    read.nested.status = 'get-changed';
    const exported = draft.entries();
    (exported[0].value as typeof input).nested.status = 'entries-changed';
    expect(draft.entries()).toEqual([
      { key: 'agent.snapshot', value: { nested: { status: 'accepted' } } },
      { key: 'route.snapshot', value: { nested: { status: 'before' } } }
    ]);
  });

  it('freezes the commit snapshot before asynchronous disk writes and preserves the previous backup', async () => {
    const root = await rootFixture();
    const baseline = new ProjectMetadataUnitOfWork(new NodeProjectStorage(root), () => t0);
    await baseline.transact(0, draft => draft.set('provider.acceptance', { result: { content: 'preserved' } }));
    let retained: ProjectMetadataDraft | undefined;
    const storage = new NodeProjectStorage(root, {
      onAtomicWriteStage: ({ stage, targetPath }) => {
        if (stage === 'before_replace' && targetPath.endsWith('project-metadata.json')) {
          // A retained callback draft may still be used while the writer awaits I/O.
          retained!.set('agent.snapshot', { status: 'late-change' });
          retained!.delete('provider.acceptance');
        }
      }
    });
    const unit = new ProjectMetadataUnitOfWork(storage, () => t1);
    const committed = await unit.transact(1, draft => {
      retained = draft;
      draft.set('agent.snapshot', { status: 'accepted' });
      const external = draft.get('provider.acceptance') as { result: { content: string } };
      external.result.content = 'must-not-change-backup';
    });
    expect(committed.entries).toEqual([
      { key: 'agent.snapshot', value: { status: 'accepted' } },
      { key: 'provider.acceptance', value: { result: { content: 'preserved' } } }
    ]);
    const persisted = await unit.load();
    expect(persisted.document).toEqual(committed);
    expect(JSON.parse(await readFile(path.join(root, 'entities/project-metadata.json.bak'), 'utf8')))
      .toEqual({ schemaVersion: 1, revision: 1, updatedAt: t0,
        entries: [{ key: 'provider.acceptance', value: { result: { content: 'preserved' } } }] });
    (committed.entries[0].value as { status: string }).status = 'return-changed';
    (persisted.document.entries[0].value as { status: string }).status = 'load-changed';
    expect((await unit.load()).document.entries[0].value).toEqual({ status: 'accepted' });
    expect(retained!.get('agent.snapshot')).toEqual({ status: 'late-change' });
  });

  it('leaves primary and backup byte-for-byte intact when mutation fails after editing the draft', async () => {
    const root = await rootFixture();
    const unit = new ProjectMetadataUnitOfWork(new NodeProjectStorage(root), () => t0);
    await unit.transact(0, draft => draft.set('provider.acceptance', { result: { content: 'preserved' } }));
    await unit.transact(1, draft => draft.set('agent.snapshot', { status: 'before' }));
    const primaryPath = path.join(root, 'entities/project-metadata.json');
    const backupPath = `${primaryPath}.bak`;
    const previous = await Promise.all([readFile(primaryPath, 'utf8'), readFile(backupPath, 'utf8')]);
    await expect(unit.transact(2, draft => {
      draft.delete('provider.acceptance');
      draft.set('agent.snapshot', { status: 'after' });
      throw new Error('mutation rejected');
    })).rejects.toThrow('mutation rejected');
    expect(await Promise.all([readFile(primaryPath, 'utf8'), readFile(backupPath, 'utf8')])).toEqual(previous);
  });

  it.each([
    { label: 'sensitive unrelated value', entries: [{ key: 'provider.acceptance', value: { token: 'synthetic-forbidden' } }] },
    { label: 'duplicate unrelated key', entries: [{ key: 'provider.acceptance', value: {} }, { key: 'provider.acceptance', value: {} }] },
    { label: 'unexpected unrelated field', entries: [{ key: 'provider.acceptance', value: {}, unexpected: true }] }
  ])('rejects $label before calling the transaction callback', async ({ entries }) => {
    const root = await rootFixture();
    const storage = new NodeProjectStorage(root);
    await storage.writeJsonAtomically(projectStoragePaths.entities.metadataUnit,
      { schemaVersion: 1, revision: 1, updatedAt: t0, entries });
    const primaryPath = path.join(root, 'entities/project-metadata.json');
    const previous = await readFile(primaryPath, 'utf8');
    let invoked = false;
    await expect(new ProjectMetadataUnitOfWork(storage, () => t1).transact(1, draft => {
      invoked = true;
      draft.delete('provider.acceptance');
    })).rejects.toBeInstanceOf(JsonDocumentDataError);
    expect(invoked).toBe(false);
    expect(await readFile(primaryPath, 'utf8')).toBe(previous);
    await expect(readFile(`${primaryPath}.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the previous file when atomic replacement is interrupted', async () => {
    const root = await rootFixture();
    const baseline = new NodeProjectStorage(root);
    await baseline.writeJsonAtomically(projectStoragePaths.manifest, {
      schemaVersion: 1,
      name: 'before'
    });
    let injected = false;
    const interrupted = new NodeProjectStorage(root, {
      onAtomicWriteStage: ({ stage, targetPath }) => {
        if (!injected && stage === 'before_replace' && targetPath.endsWith('project.json')) {
          injected = true;
          throw new Error('simulated power loss before replace');
        }
      }
    });

    await expect(
      interrupted.writeJsonAtomically(projectStoragePaths.manifest, {
        schemaVersion: 1,
        name: 'after'
      })
    ).rejects.toThrow('simulated power loss');
    await expect(baseline.readJson(projectStoragePaths.manifest)).resolves.toEqual({
      schemaVersion: 1,
      name: 'before'
    });
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('runs explicit sequential migrations and rejects gaps or future schemas', () => {
    const parser = (value: unknown) => value as { schemaVersion: 2; value: string };
    const migrations = [
      {
        fromVersion: 0,
        toVersion: 1,
        migrate: () => ({ schemaVersion: 1, text: 'legacy' })
      },
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: (value: Readonly<Record<string, unknown>>) => ({
          schemaVersion: 2,
          value: value.text
        })
      }
    ];
    expect(migrateJsonDocument({ schemaVersion: 0 }, 2, migrations, parser)).toEqual({
      schemaVersion: 2,
      value: 'legacy'
    });
    expect(() => migrateJsonDocument({ schemaVersion: 0 }, 2, migrations.slice(1), parser))
      .toThrow('No JSON migration exists for version 0');
    expect(() => migrateJsonDocument({ schemaVersion: 3 }, 2, migrations, parser))
      .toThrow('newer than supported');

    const legacy = createLegacyJsonReadModel(
      { schemaVersion: 0 },
      2,
      migrations,
      parser
    );
    expect(legacy).toMatchObject({
      sourceSchemaVersion: 0,
      migrated: true,
      readOnly: true,
      document: { schemaVersion: 2, value: 'legacy' }
    });
    expect(createJsonDocumentEnvelope(
      { kind: 'project_metadata' },
      '2026-07-31T00:00:00.000Z'
    )).toMatchObject({ schemaVersion: 1, revision: 0 });
  });
});

describe('submission intent recovery journal', () => {
  it('appends idempotently across instances and derives every non-terminal recovery action', async () => {
    const root = await rootFixture('unicomp-submission-journal-');
    const first = new SubmissionIntentJournal(new NodeProjectStorage(root), () => t3);
    const second = new SubmissionIntentJournal(new NodeProjectStorage(root), () => t3);
    const intentOnly = event('intent-a', 'event-a-1', 'intent_recorded', t0);
    await Promise.all([first.append(intentOnly), second.append(intentOnly)]);

    await appendSequence(first, [
      event('intent-b', 'event-b-1', 'intent_recorded', t0),
      event('intent-b', 'event-b-2', 'authorization_claimed', t1, {
        claimId: 'claim-b'
      })
    ]);
    await appendSequence(first, [
      event('intent-c', 'event-c-1', 'intent_recorded', t0),
      event('intent-c', 'event-c-2', 'authorization_claimed', t1, {
        claimId: 'claim-c'
      }),
      event('intent-c', 'event-c-3', 'request_started', t2, {
        claimId: 'claim-c',
        routeSnapshotId: 'route-c'
      })
    ]);
    await appendSequence(first, [
      event('intent-d', 'event-d-1', 'intent_recorded', t0),
      event('intent-d', 'event-d-2', 'authorization_claimed', t1, {
        claimId: 'claim-d'
      }),
      event('intent-d', 'event-d-3', 'request_started', t2, {
        claimId: 'claim-d',
        routeSnapshotId: 'route-d'
      }),
      event('intent-d', 'event-d-4', 'provider_accepted', t3, {
        claimId: 'claim-d',
        routeSnapshotId: 'route-d',
        providerOperationId: 'operation-d'
      })
    ]);

    const journal = await first.load();
    expect(journal.events.filter((item) => item.intentId === 'intent-a')).toHaveLength(1);
    expect(journal.revision).toBe(10);
    await expect(first.scanRecovery()).resolves.toEqual([
      {
        action: 'discard_unsubmitted_intent',
        idempotencyKey: 'idempotency-intent-a',
        intentId: 'intent-a'
      },
      {
        action: 'release_authorization_claim',
        claimId: 'claim-b',
        idempotencyKey: 'idempotency-intent-b',
        intentId: 'intent-b'
      },
      {
        action: 'mark_unknown_outcome',
        idempotencyKey: 'idempotency-intent-c',
        intentId: 'intent-c',
        retryAllowed: false
      },
      {
        action: 'resume_provider_operation',
        allowedActions: ['query', 'cancel', 'receive_result'],
        claimId: 'claim-d',
        idempotencyKey: 'idempotency-intent-d',
        intentId: 'intent-d',
        providerOperationId: 'operation-d',
        routeSnapshotId: 'route-d'
      }
    ]);
  });

  it('fails closed on skipped stages, changed idempotency keys and unknown fields', async () => {
    const root = await rootFixture('unicomp-submission-invalid-');
    const journal = new SubmissionIntentJournal(new NodeProjectStorage(root), () => t0);
    await expect(
      journal.append(event('intent-invalid', 'event-invalid', 'request_started', t0, {
        claimId: 'claim-invalid',
        routeSnapshotId: 'route-invalid'
      }))
    ).rejects.toThrow('must start with intent_recorded');

    await journal.append(event('intent-valid', 'event-valid-1', 'intent_recorded', t0));
    await expect(
      journal.append({
        ...event('intent-valid', 'event-valid-2', 'authorization_claimed', t1, {
          claimId: 'claim-valid'
        }),
        idempotencyKey: 'different-key'
      })
    ).rejects.toThrow('changed its idempotency key');
  });
});

function event(
  intentId: string,
  eventId: string,
  stage: SubmissionIntentJournalEventV1['stage'],
  recordedAt: SubmissionIntentJournalEventV1['recordedAt'],
  fields: Pick<
    SubmissionIntentJournalEventV1,
    'claimId' | 'routeSnapshotId' | 'providerOperationId'
  > = {}
): SubmissionIntentJournalEventV1 {
  return {
    schemaVersion: 1,
    eventId,
    intentId,
    idempotencyKey: `idempotency-${intentId}`,
    stage,
    recordedAt,
    ...fields
  };
}

async function appendSequence(
  journal: SubmissionIntentJournal,
  events: readonly SubmissionIntentJournalEventV1[]
): Promise<void> {
  for (const item of events) await journal.append(item);
}
