import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MessageDto, ThreadItemDto } from '../../src/shared/chat-context-ipc';
import { MarkdownMessage } from '../../src/components/MarkdownMessage';
import {
  createThreadItemStore,
  threadItemKey
} from '../../src/pages/chat/threadItemStore';

interface Scenario { readonly itemCount: number; }
const scenarios: readonly Scenario[] = [{ itemCount: 100 }, { itemCount: 1_000 }];

function makeItems(count: number): readonly ThreadItemDto[] {
  return Array.from({ length: count }, (_, index) => {
    const message: MessageDto = {
      messageId: `phase2-message-${index}`,
      conversationId: 'phase2-thread',
      revision: 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      state: 'completed',
      content: `历史消息 ${index}`,
      attachments: [],
      createdAt: `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      updatedAt: `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`
    };
    return {
      itemId: { namespace: 'message', value: message.messageId },
      threadId: message.conversationId,
      sequence: index + 1,
      itemType: message.role === 'user' ? 'user_message' : 'assistant_message',
      status: message.state,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      messageId: message.messageId,
      message
    };
  });
}

function round(value: number): number { return Math.round(value * 100) / 100; }

describe('conversation phase 2 renderer synthetic baseline', () => {
  it('compares whole-array projection work with normalized Item updates', async () => {
    const metrics = scenarios.map(({ itemCount }) => {
      const items = makeItems(itemCount);
      const target = items[itemCount - 1]!;
      let legacy = items;
      const legacyStart = performance.now();
      for (let index = 0; index < 300; index += 1) {
        legacy = legacy.map((item) => item.itemId.value === target.itemId.value
          ? { ...item, message: { ...item.message!, content: `${item.message?.content} delta-${index}` } }
          : item);
      }
      const legacyMs = performance.now() - legacyStart;

      let normalized = createThreadItemStore(items, {
        readAtSequence: itemCount,
        hasOlder: false,
        complete: false
      });
      const normalizedStart = performance.now();
      let streamingItem = normalized.itemById.get(threadItemKey(target))!;
      for (let index = 0; index < 300; index += 1) {
        // The live response overlay updates one Item object. The historical
        // normalized Map and ordered IDs are not rebuilt for each Delta.
        streamingItem = {
          ...streamingItem,
          updatedAt: `2026-10-01T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
          message: { ...streamingItem.message!, content: `${streamingItem.message?.content} delta-${index}` }
        };
      }
      const normalizedMs = performance.now() - normalizedStart;
      expect(normalized.itemById.size).toBe(itemCount);
      return {
        itemCount,
        deltaBatches: 300,
        legacyWholeArrayWorkUnits: itemCount * 300,
        normalizedItemWorkUnits: 300,
        legacyUpdateMs: round(legacyMs),
        normalizedUpdateMs: round(normalizedMs),
        normalizedOrderedIdsStable: normalized.orderedItemIds.length === itemCount
      };
    });

    const markdown = Array.from({ length: 400 }, (_, index) =>
      `## Section ${index}\n\nA long paragraph with **bold text** and a stable historical body.\n\n` +
      '| Name | Value |\n| --- | ---: |\n| Metric | ' + index + ' |\n\n```ts\nconst value' + index + ' = ' + index + ';\n```'
    ).join('\n\n');
    const beforeMemory = process.memoryUsage();
    const markdownStart = performance.now();
    const html = renderToStaticMarkup(createElement(MarkdownMessage, { content: markdown }));
    const markdownMs = performance.now() - markdownStart;
    const afterMemory = process.memoryUsage();
    expect(html.length).toBeGreaterThan(markdown.length);

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      measurementBoundary: 'synthetic Node/Vitest; normalized reconciliation work proxy, not Chromium React Commit instrumentation',
      scenarios: metrics,
      markdown: {
        characters: markdown.length,
        ssrHtmlBytes: Buffer.byteLength(html),
        markdownSsrMs: round(markdownMs)
      },
      memory: {
        rssBeforeBytes: beforeMemory.rss,
        rssAfterBytes: afterMemory.rss,
        heapUsedBeforeBytes: beforeMemory.heapUsed,
        heapUsedAfterBytes: afterMemory.heapUsed
      },
      notMeasured: [
        'Chromium React Commit count/duration in the full Electron ChatPage',
        'real IPC structured-clone payload',
        'browser layout/scroll anchoring cost',
        'virtual-list comparison'
      ]
    };
    const outputDirectory = path.resolve('outputs/conversation-phase2');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'render-baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.info(`conversation-phase2-render-baseline ${JSON.stringify(report)}`);
  }, 120_000);
});
