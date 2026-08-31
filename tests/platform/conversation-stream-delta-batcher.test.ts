import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId
} from '../../src/domain';
import {
  ConversationResponseExecutionLifecycle,
  JsonConversationResponseExecutionRepository,
  NodeProjectStorage
} from '../../src/platform';
import {
  ConversationStreamDeltaBatcher,
  type ConversationStreamDeltaSegment
} from '../../src/platform/providers/conversation-stream-delta-batcher';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe('conversation stream delta batcher', () => {
  it('merges adjacent deltas while preserving reasoning and content order', async () => {
    const batches: (readonly ConversationStreamDeltaSegment[])[] = [];
    const batcher = new ConversationStreamDeltaBatcher({
      persist: async (segments) => {
        batches.push(segments);
      }
    });

    await batcher.append('reasoning', 'reason-1');
    await batcher.append('reasoning', '+reason-2');
    await batcher.append('content', 'answer-1');
    await batcher.append('content', '+answer-2');
    await batcher.append('reasoning', 'reason-3');
    await batcher.sealAndDrain();

    expect(batches).toEqual([[
      { kind: 'reasoning', delta: 'reason-1+reason-2' },
      { kind: 'content', delta: 'answer-1+answer-2' },
      { kind: 'reasoning', delta: 'reason-3' }
    ]]);
    expect(batcher.pendingByteCount).toBe(0);
  });

  it('flushes the default batch after 120ms', async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => undefined);
    const batcher = new ConversationStreamDeltaBatcher({ persist });

    await batcher.append('content', 'small delta');
    await vi.advanceTimersByTimeAsync(119);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    await batcher.sealAndDrain();
  });

  it('flushes immediately at the default 8KB UTF-8 threshold', async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => undefined);
    const batcher = new ConversationStreamDeltaBatcher({ persist });

    await batcher.append('content', '\u4e2d'.repeat(2_731));
    await Promise.resolve();

    expect(persist).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await batcher.sealAndDrain();
  });

  it('applies backpressure when outstanding data reaches the configured limit', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    const batcher = new ConversationStreamDeltaBatcher({
      flushByteThreshold: 1,
      maximumOutstandingBytes: 4,
      persist: async () => {
        writes += 1;
        if (writes === 1) await firstWrite;
      }
    });

    await batcher.append('content', 'a');
    await batcher.append('content', 'b');
    await batcher.append('content', 'c');
    let backpressureReleased = false;
    const blocked = batcher.append('content', 'd').then(() => {
      backpressureReleased = true;
    });
    await Promise.resolve();

    expect(backpressureReleased).toBe(false);
    expect(batcher.pendingByteCount).toBe(4);

    releaseFirstWrite?.();
    await blocked;
    expect(backpressureReleased).toBe(true);
    expect(batcher.pendingByteCount).toBe(0);
    await batcher.sealAndDrain();
  });

  it('propagates persistence failures and rejects later appends', async () => {
    const failure = new Error('synthetic persistence failure');
    const batcher = new ConversationStreamDeltaBatcher({
      flushByteThreshold: 1,
      maximumOutstandingBytes: 1,
      persist: async () => {
        throw failure;
      }
    });

    await expect(batcher.append('content', 'x')).rejects.toBe(failure);
    await expect(batcher.append('content', 'y')).rejects.toBe(failure);
    await expect(batcher.sealAndDrain()).rejects.toBe(failure);
  });

  it('surfaces a background timer flush failure on the next lifecycle action', async () => {
    vi.useFakeTimers();
    const failure = new Error('synthetic background persistence failure');
    const batcher = new ConversationStreamDeltaBatcher({
      persist: async () => {
        throw failure;
      }
    });

    await expect(batcher.append('content', 'small delta')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(120);

    await expect(batcher.append('content', 'next delta')).rejects.toBe(failure);
    await expect(batcher.sealAndDrain()).rejects.toBe(failure);
  });

  it('flushes accepted data before sealing and rejects late deltas', async () => {
    const persisted: ConversationStreamDeltaSegment[][] = [];
    const batcher = new ConversationStreamDeltaBatcher({
      persist: async (segments) => {
        persisted.push([...segments]);
      }
    });

    await batcher.append('content', 'accepted');
    await batcher.sealAndDrain();

    expect(persisted).toEqual([[
      { kind: 'content', delta: 'accepted' }
    ]]);
    await expect(batcher.append('content', 'late')).rejects.toThrow('sealed');
  });
});

describe('conversation stream delta persistence integration', () => {
  it('reduces 100 tiny provider deltas to one persisted execution delta', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-delta-batch-'));
    temporaryRoots.push(root);
    const projectId = toProjectId('project-delta-batch');
    const executionId = toConversationResponseExecutionId('execution-delta-batch');
    const repository = new JsonConversationResponseExecutionRepository(
      new NodeProjectStorage(root),
      projectId
    );
    const createdAt = toIsoTimestamp('2026-08-14T10:00:00.000Z');
    const execution = createConversationResponseExecution({
      id: executionId,
      projectId,
      providerInvocationAttemptId: toProviderInvocationAttemptId('attempt-delta-batch'),
      snapshot: {
        schemaVersion: 1,
        responseDraftId: toConversationResponseDraftId('draft-delta-batch'),
        responseDraftRevision: 1,
        conversationId: toConversationId('conversation-delta-batch'),
        conversationRevision: 1,
        userMessageId: toMessageId('message-user-delta-batch'),
        userMessageRevision: 0,
        assistantMessageId: toMessageId('message-assistant-delta-batch'),
        productFeature: 'text_chat',
        routeSnapshotId: toProviderExecutionRouteSnapshotId('route-delta-batch'),
        candidate: {
          schemaVersion: 1,
          providerId: toProviderId('provider-delta-batch'),
          connectionId: toConnectionId('connection-delta-batch'),
          connectionRevision: 1,
          modelId: toModelId('model-delta-batch'),
          modelRevision: 1,
          profileId: 'profile.chat',
          profileRevision: 1,
          protocolBindingId: toProtocolBindingId('binding-delta-batch'),
          protocolBindingRevision: 1,
          runtimeSource: 'newapi_gateway'
        },
        outboundUserTextSnapshot: 'batch this response',
        contextSnapshots: []
      },
      createdAt
    });
    await repository.create(execution, createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-created-delta-batch'),
      responseExecutionId: executionId,
      sequence: 1,
      type: 'execution_created',
      occurredAt: createdAt
    }));
    let eventSequence = 0;
    const lifecycle = new ConversationResponseExecutionLifecycle(
      repository,
      {
        nextConversationResponseStreamEventId: () =>
          toConversationResponseStreamEventId(`event-delta-batch-${++eventSequence}`)
      },
      undefined,
      () => toIsoTimestamp('2026-08-14T10:01:00.000Z')
    );
    await lifecycle.start(executionId);
    const batcher = new ConversationStreamDeltaBatcher({
      persist: async (segments) => {
        for (const segment of segments) {
          if (segment.kind === 'content') {
            await lifecycle.appendContent(executionId, segment.delta);
          } else {
            await lifecycle.appendReasoning(executionId, segment.delta);
          }
        }
      }
    });

    for (let index = 0; index < 100; index += 1) {
      await batcher.append('content', String(index % 10));
    }
    await batcher.sealAndDrain();
    await lifecycle.complete(executionId);

    const events = await repository.listEvents(executionId);
    expect(events.map((event) => event.type)).toEqual([
      'execution_created',
      'stream_started',
      'content_delta',
      'stream_completed'
    ]);
    expect(events[2]).toMatchObject({
      contentDelta: Array.from({ length: 100 }, (_, index) => String(index % 10)).join('')
    });
  });
});
