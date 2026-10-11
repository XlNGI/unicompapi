import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addUserMessage, createProjectConversation, toConversationId, toIsoTimestamp, toMessageId, toProjectId } from '../../src/domain';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { NodeProjectStorage } from '../../src/platform/storage/node-project-storage';
import { LegacyThreadMigration } from '../../src/platform/repositories/thread-migration';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';
import { ThreadFileReadAdapter } from '../../src/platform/ipc/thread-file-read-adapter';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');

function makeConversations(count: number, messagesPerConversation: number) {
  return Array.from({ length: count }, (_, conversationIndex) => {
    let conversation = createProjectConversation({ id: toConversationId(`phase5-thread-${conversationIndex}`), projectId: toProjectId('phase5-project'), title: `Thread ${conversationIndex}`, createdAt: t0 });
    for (let messageIndex = 0; messageIndex < messagesPerConversation; messageIndex += 1) {
      conversation = addUserMessage(conversation, { id: toMessageId(`phase5-message-${conversationIndex}-${messageIndex}`), content: `message ${conversationIndex}-${messageIndex}`, createdAt: t0 });
    }
    return conversation;
  });
}

function percentile(values: readonly number[], fraction: number): number { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0; }

describe('phase 5 isolated legacy versus Thread read baseline', () => {
  it('records p50/p95 list/open/page timings and payload boundaries', async () => {
    const root = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-phase5-read-')));
    const conversations = makeConversations(10, 100);
    try {
      const projectRoot = path.join(root, 'legacy-project');
      await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
      await writeFile(path.join(projectRoot, 'entities', 'conversations.json'), `${JSON.stringify({ schemaVersion: 1, revision: conversations.length, updatedAt: t0, conversations })}\n`, 'utf8');
      const oldRepository = new JsonProjectConversationRepository(new NodeProjectStorage(projectRoot), toProjectId('phase5-project'));
      const targetRoot = path.join(root, 'thread-target');
      const targetRepository = new ThreadFileRepository(targetRoot);
      const migration = new LegacyThreadMigration(targetRoot, targetRepository, { migrationId: 'phase5-read-baseline' });
      await migration.migrate(conversations.map(conversation => ({ conversation })));
      const adapter = new ThreadFileReadAdapter({ getRepository: () => targetRepository, projectId: () => 'phase5-project' });
      const oldListTimes: number[] = [], newListTimes: number[] = [], oldOpenTimes: number[] = [], newPageTimes: number[] = [];
      for (let iteration = 0; iteration < 5; iteration += 1) {
        let start = performance.now();
        const oldList = await oldRepository.list({ statuses: ['active'] });
        oldListTimes.push(performance.now() - start);
        start = performance.now();
        const newList = await adapter.listThreadSummaries({ includeArchived: true, includeDeleted: false, limit: 200 });
        newListTimes.push(performance.now() - start);
        start = performance.now();
        await oldRepository.get(conversations[0]!.id);
        oldOpenTimes.push(performance.now() - start);
        start = performance.now();
        const page = await adapter.getThreadItemsPage({ threadId: String(conversations[0]!.id), direction: 'older', limit: 20 });
        newPageTimes.push(performance.now() - start);
        expect(oldList).toHaveLength(10);
        expect(newList.ok && newList.value.items).toHaveLength(10);
        expect(page.ok && page.value.items).toHaveLength(20);
      }
      const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        measurementBoundary: 'isolated Node/Vitest files; not Electron IPC structured clone, Chromium Renderer or main event-loop instrumentation',
        scenario: { conversationCount: 10, messagesPerConversation: 100, iterations: 5 },
        legacy: { listP50Ms: percentile(oldListTimes, 0.5), listP95Ms: percentile(oldListTimes, 0.95), openP50Ms: percentile(oldOpenTimes, 0.5), openP95Ms: percentile(oldOpenTimes, 0.95) },
        threadFile: { summaryP50Ms: percentile(newListTimes, 0.5), summaryP95Ms: percentile(newListTimes, 0.95), firstPageP50Ms: percentile(newPageTimes, 0.5), firstPageP95Ms: percentile(newPageTimes, 0.95), pageLimit: 20 },
        notMeasured: ['real Electron IPC payload bytes', 'main-process event-loop delay', 'Renderer first interactive time', 'Chromium React Commit duration']
      };
      const outputDirectory = path.resolve('outputs/conversation-phase5');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, 'read-baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.info(`conversation-phase5-read-baseline ${JSON.stringify(report)}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
