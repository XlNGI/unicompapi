import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  type Conversation,
  type Message
} from '../../src/domain';
import { JsonConversationRepository, toConversationDto } from '../../src/platform';
import { ConversationStreamDeltaBatcher } from '../../src/platform/providers/conversation-stream-delta-batcher';
import type { ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';
import { projectProductionMessages } from '../../src/pages/chat/productionTimeline';
import { MarkdownMessage } from '../../src/components/MarkdownMessage';

const roots: string[] = [];
const createdAt = toIsoTimestamp('2026-10-01T12:00:00.000Z');
const updatedAt = toIsoTimestamp('2026-10-01T12:01:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface Scenario {
  readonly conversationCount: number;
  readonly messagesPerConversation: number;
}

const scenarios: readonly Scenario[] = [
  { conversationCount: 10, messagesPerConversation: 100 },
  { conversationCount: 100, messagesPerConversation: 100 },
  { conversationCount: 1_000, messagesPerConversation: 100 },
  { conversationCount: 10, messagesPerConversation: 1_000 }
];

describe('conversation phase 0 synthetic performance baseline', () => {
  it('measures legacy JSON read, DTO payload, projection, Markdown SSR, and stream batching in isolated temp storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-conversation-phase0-'));
    roots.push(root);
    const scenarioMetrics = [];

    for (const scenario of scenarios) {
      const repositoryPath = path.join(root,
        `conversations-${scenario.conversationCount}-${scenario.messagesPerConversation}.json`);
      const document = makeConversationDocument(scenario);
      await writeFile(repositoryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      const repositoryBytes = (await stat(repositoryPath)).size;
      const repository = new JsonConversationRepository(repositoryPath);

      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      const listStart = performance.now();
      const conversations = await repository.list({ statuses: ['active'] });
      const listMs = performance.now() - listStart;
      await new Promise<void>(resolve => setImmediate(resolve));
      delay.disable();

      const dtoStart = performance.now();
      const dtos = conversations.map(conversation => toConversationDto(conversation));
      const dtoMapMs = performance.now() - dtoStart;
      const dtoSerializeStart = performance.now();
      const dtoJson = JSON.stringify(dtos);
      const dtoSerializeMs = performance.now() - dtoSerializeStart;
      const ipcPayloadBytes = Buffer.byteLength(dtoJson);
      const summaryStart = performance.now();
      const summaries = conversations.map(conversation => ({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        title: conversation.title,
        status: conversation.status,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length
      }));
      const summaryMapMs = performance.now() - summaryStart;
      const summarySerializeStart = performance.now();
      const summaryJson = JSON.stringify(summaries);
      const summarySerializeMs = performance.now() - summarySerializeStart;
      const summaryPayloadBytes = Buffer.byteLength(summaryJson);
      let jsonParseOnlyMs: number | undefined;
      let jsonParseProbeBytes = 0;
      if (scenario.conversationCount === 10) {
        const raw = await readFile(repositoryPath, 'utf8');
        const parseStart = performance.now();
        const parsed = JSON.parse(raw) as { readonly conversations: readonly unknown[] };
        jsonParseOnlyMs = performance.now() - parseStart;
        jsonParseProbeBytes = Buffer.byteLength(raw);
        expect(parsed.conversations).toHaveLength(scenario.conversationCount);
      }

      const openStart = performance.now();
      const opened = await repository.get(conversations[0]!.id);
      const openMs = performance.now() - openStart;
      expect(opened?.messages).toHaveLength(scenario.messagesPerConversation);

      const write = scenario.conversationCount === 10 && scenario.messagesPerConversation === 100
        ? await measureFullDocumentSave(repository, repositoryPath, conversations[0]!)
        : undefined;
      scenarioMetrics.push({
        ...scenario,
        repositoryBytes,
        listMs: round(listMs),
        openMs: round(openMs),
        dtoMapMs: round(dtoMapMs),
        dtoJsonSerializeMs: round(dtoSerializeMs),
        ipcPayloadBytes,
        summaryMapMs: round(summaryMapMs),
        summaryJsonSerializeMs: round(summarySerializeMs),
        summaryPayloadBytes,
        ...(jsonParseOnlyMs !== undefined ? {
          jsonParseOnlyMs: round(jsonParseOnlyMs),
          jsonParseProbeBytes,
          instrumentationReadCalls: 1
        } : {}),
        nodeRunnerEventLoopDelayMaxMs: round(delay.max / 1e6),
        rssBytesAfterRead: process.memoryUsage().rss,
        heapUsedBytesAfterRead: process.memoryUsage().heapUsed,
        sourceDerivedRepositoryReadCalls: 2,
        sourceDerivedRepositoryReadBytes: repositoryBytes * 2,
        ...(jsonParseOnlyMs !== undefined ? { totalMeasuredReadCallsIncludingProbe: 3 } : {}),
        ...(write ? { saveRewrite: write } : {})
      });
    }

    const markdown = Array.from({ length: 800 }, (_, index) =>
      `## Section ${index}\n\nA long Markdown paragraph with **bold text**, a table row, and a stable historical message body.\n\n| Name | Value |\n| --- | ---: |\n| Metric ${index} | ${index * 7} |\n\n` +
      '```ts\n' + `export const section${index} = ${index};\n` + '```'
    ).join('\n\n');
    const markdownStart = performance.now();
    const markdownHtml = renderToStaticMarkup(createElement(MarkdownMessage, { content: markdown }));
    const markdownSsrMs = performance.now() - markdownStart;
    expect(markdownHtml.length).toBeGreaterThan(0);

    const projectionConversation = makeConversationDocument({
      conversationCount: 1,
      messagesPerConversation: 100
    }).conversations[0]!;
    const projectionDto = toConversationDto(projectionConversation);
    const sourceMessageId = projectionDto.messages[0]!.messageId;
    const assistantMessageId = projectionDto.messages[1]!.messageId;
    const toolEvents = Array.from({ length: 2_000 }, (_, index): ProductionTraceEventDto => ({
      schemaVersion: 1,
      projectId: 'project-phase0-benchmark',
      conversationId: projectionDto.conversationId,
      sourceMessageId,
      assistantMessageId,
      traceId: sourceMessageId,
      sequence: index + 1,
      code: index % 2 === 0 ? 'tool_call' : 'tool_result',
      status: index % 2 === 0 ? 'started' : 'completed',
      operationId: `tool-call-${index >> 1}`,
      facts: { purpose: 'tool', tool: 'analyze', count: index >> 1 },
      occurredAt: createdAt
    }));
    const projectionStart = performance.now();
    const projection = projectProductionMessages(projectionDto, toolEvents);
    const projectionMs = performance.now() - projectionStart;
    expect(projection.timelineByMessage.get(assistantMessageId)).toHaveLength(toolEvents.length);

    let streamPersistCalls = 0;
    let streamPersistBytes = 0;
    const batcher = new ConversationStreamDeltaBatcher({
      persist: async segments => {
        streamPersistCalls += 1;
        streamPersistBytes += segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.delta), 0);
      }
    });
    const streamStart = performance.now();
    for (let index = 0; index < 1_024; index += 1) {
      await batcher.append('content', 'x'.repeat(1_024));
    }
    await batcher.sealAndDrain();
    const streamMs = performance.now() - streamStart;
    expect(streamPersistBytes).toBe(1_024 * 1_024);

    let sustainedPersistCalls = 0;
    let sustainedPersistBytes = 0;
    const sustainedBatcher = new ConversationStreamDeltaBatcher({
      persist: async segments => {
        sustainedPersistCalls += 1;
        sustainedPersistBytes += segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.delta), 0);
      }
    });
    const sustainedStart = performance.now();
    for (let index = 0; index < 1_024; index += 1) {
      await sustainedBatcher.append('content', 'y'.repeat(1_024));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await sustainedBatcher.sealAndDrain();
    const sustainedMs = performance.now() - sustainedStart;
    expect(sustainedPersistBytes).toBe(1_024 * 1_024);

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model.trim(),
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytesAtReport: os.freemem()
      },
      measurementBoundary: 'synthetic Node/Vitest process; not Electron main or browser React commit',
      scenarios: scenarioMetrics,
      markdown: { characters: markdown.length, ssrHtmlBytes: Buffer.byteLength(markdownHtml), markdownSsrMs: round(markdownSsrMs) },
      toolProjection: { eventCount: toolEvents.length, projectionMs: round(projectionMs) },
      streamBatcher: {
        burst: { inputBytes: streamPersistBytes, persistBatchCount: streamPersistCalls, elapsedMs: round(streamMs) },
        sustained: { inputBytes: sustainedPersistBytes, persistBatchCount: sustainedPersistCalls, elapsedMs: round(sustainedMs) }
      }
    };
    const reportDirectory = path.resolve('outputs/conversation-phase0');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(path.join(reportDirectory, 'baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.info(`conversation-phase0-baseline ${JSON.stringify(report)}`);
  }, 120_000);
});

async function measureFullDocumentSave(
  repository: JsonConversationRepository,
  repositoryPath: string,
  conversation: Conversation
) {
  const backupPath = `${repositoryPath}.bak`;
  const previousMessage = conversation.messages[0]!;
  const updatedMessage: Message = {
    ...previousMessage,
    revision: previousMessage.revision + 1,
    content: `${previousMessage.content} updated`,
    updatedAt: updatedAt,
    ...(previousMessage.role === 'user' || previousMessage.state === 'completed'
      ? { completedAt: updatedAt }
      : {})
  } as Message;
  const messages = [...conversation.messages];
  messages[0] = updatedMessage;
  const next: Conversation = { ...conversation, revision: conversation.revision + 1, updatedAt, messages };
  const startedAt = performance.now();
  await repository.save(next, conversation.revision);
  const elapsedMs = performance.now() - startedAt;
  const primaryBytes = (await stat(repositoryPath)).size;
  const backupBytes = (await stat(backupPath)).size;
  return {
    elapsedMs: round(elapsedMs),
    sourceDerivedWriteCalls: 2,
    observedPrimaryBytesAfterWrite: primaryBytes,
    observedBackupBytesAfterWrite: backupBytes,
    sourceDerivedBytesWritten: primaryBytes + backupBytes
  };
}

function makeConversationDocument(scenario: Scenario) {
  const projectId = toProjectId('project-phase0-benchmark');
  const conversations: Conversation[] = Array.from({ length: scenario.conversationCount }, (_, conversationIndex) => {
    const id = toConversationId(`conversation-phase0-${conversationIndex}`);
    const messages: Message[] = Array.from({ length: scenario.messagesPerConversation }, (_, messageIndex) => ({
      schemaVersion: 1,
      id: toMessageId(`message-phase0-${conversationIndex}-${messageIndex}`),
      conversationId: id,
      revision: 0,
      role: messageIndex % 2 === 0 ? 'user' : 'assistant',
      state: 'completed',
      content: `Synthetic conversation ${conversationIndex}, message ${messageIndex}. ${'x'.repeat(48)}`,
      attachments: [],
      streamSequence: 0,
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt
    } as Message));
    return {
      schemaVersion: 1 as const,
      id,
      revision: scenario.messagesPerConversation,
      projectId,
      title: `Synthetic thread ${conversationIndex}`,
      status: 'active' as const,
      messages,
      createdAt,
      updatedAt
    };
  });
  return {
    schemaVersion: 1,
    revision: scenario.conversationCount,
    updatedAt,
    conversations
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
