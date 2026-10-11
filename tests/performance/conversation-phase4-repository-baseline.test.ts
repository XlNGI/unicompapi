import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createItemV1, createTurnV1, toMessageItemId, toProjectId, toThreadId, toTurnId, toIsoTimestamp } from '../../src/domain';
import { ThreadFileRepository } from '../../src/platform/repositories/thread-file-repository';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');

describe('phase 4 synthetic storage baseline', () => {
  it('measures one durable JSONL commit versus repeated legacy-shaped appends', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-thread-phase4-baseline-'));
    try {
      const threadId = toThreadId('thread-phase4-baseline');
      const repository = new ThreadFileRepository(root);
      await repository.createThread({ threadId, projectId: toProjectId('project-phase4'), title: 'Baseline', createdAt: t0 });
      const turns = [], items = [];
      for (let sequence = 1; sequence <= 1000; sequence += 1) {
        const turnId = toTurnId(`turn-phase4-${sequence}`);
        const item = createItemV1({ itemId: toMessageItemId(`message-phase4-${sequence}`), threadId, turnId, sequence, type: 'user_message', status: 'completed', createdAt: t0, updatedAt: t0, messageSource: { messageId: `message-phase4-${sequence}` as never, messageRevision: 0 }, content: `message-${sequence}` });
        items.push(item);
        turns.push(createTurnV1({ turnId, threadId, turnSequence: sequence, createdAt: t0, userItemId: item.itemId, provenance: 'native' }));
      }
      const appendStart = performance.now();
      const result = await repository.append({ threadId, idempotencyKey: 'baseline-1000', occurredAt: t0, turns, items });
      const appendMs = performance.now() - appendStart;
      const readStart = performance.now();
      const loaded = await repository.readItems(threadId);
      const readMs = performance.now() - readStart;
      const threadPath = path.join(root, 'entities', 'threads', String(threadId));
      const manifestBytes = (await stat(path.join(threadPath, 'manifest.v1.json'))).size;
      const commitBytes = (await stat(path.join(threadPath, 'commits', `commits-${result.commit.generation}.jsonl`))).size;
      expect(loaded).toHaveLength(1000);
      const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        measurementBoundary: 'synthetic Node/Vitest; local temp files; no legacy JSON rewrite in this run',
        itemCount: loaded.length,
        appendMs: Math.round(appendMs * 100) / 100,
        readMs: Math.round(readMs * 100) / 100,
        durableCommitCount: 1,
        manifestBytes,
        commitBytes,
        note: 'Legacy conversations.json read/write comparison remains in outputs/conversation-phase0/baseline.json; this benchmark measures the new Repository baseline only.'
      };
      const outputDirectory = path.resolve('outputs/conversation-phase4');
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, 'repository-baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.info(`conversation-phase4-repository-baseline ${JSON.stringify(report)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
