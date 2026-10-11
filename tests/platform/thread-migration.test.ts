import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addCompletedAssistantMessage,
  addUserMessage,
  createProjectConversation,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toThreadId
} from '../../src/domain';
import { LegacyFileMigrationRunner, LegacyThreadMigration } from '../../src/platform/repositories/thread-migration';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-08T00:00:01.000Z');

function legacyConversation() {
  let conversation = createProjectConversation({ id: toConversationId('legacy-migration-conversation'), projectId: toProjectId('project-migration'), title: 'Legacy copy', createdAt: t0 });
  conversation = addUserMessage(conversation, { id: toMessageId('legacy-user-1'), content: 'create a report', createdAt: t0 });
  conversation = addCompletedAssistantMessage(conversation, { id: toMessageId('legacy-assistant-1'), content: 'report complete', createdAt: t1 });
  conversation = addUserMessage(conversation, { id: toMessageId('legacy-user-2'), content: 'continue', createdAt: t1 });
  return conversation;
}

describe('Legacy Thread migration and Shadow Read', () => {
  it('migrates an isolated legacy copy with stable IDs and a resumable ledger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-migration-'));
    try {
      const conversation = legacyConversation();
      const sourceBefore = JSON.stringify(conversation);
      const repository = new ThreadFileRepository(root);
      const migration = new LegacyThreadMigration(root, repository, { migrationId: 'migration-test', sourceLabel: 'fixture-copy' });
      const snapshot = { conversation } as const;
      const first = await migration.migrate([snapshot]);
      expect(first.status).toBe('completed');
      expect(first.migrated).toBe(1);
      const second = await migration.migrate([snapshot]);
      expect(second.skipped).toBe(1);
      expect((await repository.readItems(toThreadId(conversation.id))).map(item => item.messageSource?.messageId)).toEqual([
        toMessageId('legacy-user-1'), toMessageId('legacy-assistant-1'), toMessageId('legacy-user-2')
      ]);
      expect(JSON.stringify(conversation)).toBe(sourceBefore);
      const ledger = JSON.parse(await readFile(path.join(root, 'migration', 'migration-ledger.v1.json'), 'utf8')) as { readonly entries: readonly { status: string; sourceChecksum: string }[] };
      expect(ledger.entries).toHaveLength(1);
      expect(ledger.entries[0]!.status).toBe('migrated');
      expect(ledger.entries[0]!.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads a real legacy conversations.json primary or backup without modifying either file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-real-file-migration-'));
    try {
      const legacyPath = path.join(root, 'entities', 'conversations.json');
      const targetRoot = path.join(root, 'thread-target');
      const conversation = legacyConversation();
      const document = { schemaVersion: 1, revision: 1, updatedAt: conversation.updatedAt, conversations: [conversation] };
      await (await import('node:fs/promises')).mkdir(path.dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, `${JSON.stringify(document)}\n`, 'utf8');
      const before = await readFile(legacyPath, 'utf8');
      const repository = new ThreadFileRepository(targetRoot);
      const migration = new LegacyThreadMigration(targetRoot, repository, { migrationId: 'real-file-test' });
      const report = await new LegacyFileMigrationRunner(legacyPath, migration).run();
      expect(report.sourceKind).toBe('primary');
      expect(report.sourceFileChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(legacyPath, 'utf8')).toBe(before);
      await writeFile(legacyPath, '{invalid');
      await writeFile(`${legacyPath}.bak`, before);
      const backupReport = await new LegacyFileMigrationRunner(legacyPath, migration).run();
      expect(backupReport.sourceKind).toBe('backup');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('shadow compares summaries, item content and duplicate Thread identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-shadow-'));
    try {
      const conversation = legacyConversation();
      const repository = new ThreadFileRepository(root);
      const migration = new LegacyThreadMigration(root, repository, { migrationId: 'shadow-test' });
      await migration.migrate([{ conversation }]);
      const report = await migration.shadowCompare([{ conversation }]);
      expect(report.differences).toEqual([]);
      expect(report.modelContextCompared).toBe(true);
      expect(report.sourceSummaryHash).toBeTruthy();
      expect(report.targetSummaryHash).toBeTruthy();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks readiness for active executions, missing backup or shadow differences', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-fence-'));
    try {
      const repository = new ThreadFileRepository(root);
      const migration = new LegacyThreadMigration(root, repository, { migrationId: 'fence-test' });
      const conversation = legacyConversation();
      const run = await migration.migrate([{ conversation }]);
      const shadow = await migration.shadowCompare([{ conversation }]);
      const blocked = await migration.prepareCutover({ legacyGeneration: 1, targetGeneration: 1, activeExecutionCount: 1, backupVerified: false, shadow, ledger: run.ledger });
      expect(blocked.status).toBe('blocked');
      expect(blocked.onlineDualWriteSupported).toBe(false);
      expect(blocked.oldAuthorityPreserved).toBe(true);
      const rollback = await migration.rollbackReadiness({ cutoverStarted: true, oldStoreCaughtUp: false, newWritesAfterCutover: 1 });
      expect(rollback.status).toBe('blocked');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
