import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  toProviderInvocationAttemptId,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionState
} from '../../src/domain';
import {
  ControlledConversationResponseStreamChannel,
  ConversationResponseExecutionLifecycle,
  JsonConversationResponseExecutionRepository,
  NodeProjectStorage
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-response-stream');
const otherProjectId = toProjectId('project-response-stream-other');
const t0 = toIsoTimestamp('2026-08-03T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T10:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T10:03:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-response-stream-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  return {
    storage,
    repository: new JsonConversationResponseExecutionRepository(storage, projectId)
  };
}

function execution(input: {
  readonly id?: string;
  readonly attemptId?: string;
  readonly assistantMessageId?: string;
  readonly state?: ConversationResponseExecutionState;
  readonly productFeature?: 'text_chat' | 'text_reasoning';
  readonly retryOfExecutionId?: ConversationResponseExecutionId;
  readonly ownerProjectId?: typeof projectId;
} = {}) {
  return {
    ...createConversationResponseExecution({
      id: toConversationResponseExecutionId(input.id ?? 'response-execution-platform'),
      projectId: input.ownerProjectId ?? projectId,
      providerInvocationAttemptId: toProviderInvocationAttemptId(
        input.attemptId ?? 'attempt-response-platform'
      ),
      ...(input.retryOfExecutionId ? { retryOfExecutionId: input.retryOfExecutionId } : {}),
      snapshot: {
        schemaVersion: 1 as const,
        responseDraftId: toConversationResponseDraftId('response-draft-platform'),
        responseDraftRevision: 1,
        conversationId: toConversationId('conversation-response-platform'),
        conversationRevision: 3,
        userMessageId: toMessageId('message-user-platform'),
        userMessageRevision: 0,
        assistantMessageId: toMessageId(
          input.assistantMessageId ?? 'message-assistant-platform'
        ),
        productFeature: input.productFeature ?? 'text_chat',
        routeSnapshotId: toProviderExecutionRouteSnapshotId('route-response-platform'),
        candidate: {
          schemaVersion: 1 as const,
          providerId: toProviderId('provider-response-platform'),
          connectionId: toConnectionId('connection-response-platform'),
          connectionRevision: 2,
          modelId: toModelId('model-response-platform'),
          modelRevision: 2,
          profileId: 'profile.chat',
          profileRevision: 1,
          protocolBindingId: toProtocolBindingId('binding-response-platform'),
          protocolBindingRevision: 1,
          runtimeSource: 'newapi_gateway' as const
        },
        outboundUserTextSnapshot: '流式合同测试',
        contextSnapshots: []
      },
      createdAt: t0
    }),
    state: input.state ?? 'pending'
  };
}

function createdEvent(id: ConversationResponseExecutionId, eventId = 'event-created-platform') {
  return createConversationResponseStreamEvent({
    id: toConversationResponseStreamEventId(eventId),
    responseExecutionId: id,
    sequence: 1,
    type: 'execution_created',
    occurredAt: t0
  });
}

function ids() {
  let sequence = 0;
  return {
    nextConversationResponseStreamEventId: () =>
      toConversationResponseStreamEventId(`event-lifecycle-${++sequence}`)
  };
}

describe('conversation response execution repository', () => {
  it('persists a contiguous stream and updates the recoverable execution state', async () => {
    const { repository } = await fixture();
    const item = execution();
    await repository.create(item, createdEvent(item.id));
    await repository.appendEvent(createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-start-platform'),
      responseExecutionId: item.id,
      sequence: 2,
      type: 'stream_started',
      occurredAt: t1
    }));
    await repository.appendEvent(createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-delta-platform'),
      responseExecutionId: item.id,
      sequence: 3,
      type: 'content_delta',
      contentDelta: '已持久化的增量',
      occurredAt: t2
    }));
    await repository.appendEvent(createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-interrupted-platform'),
      responseExecutionId: item.id,
      sequence: 4,
      type: 'stream_interrupted',
      interruptionReason: 'transport_interrupted',
      occurredAt: t3
    }));
    await expect(repository.get(item.id)).resolves.toMatchObject({ state: 'interrupted' });
    await expect(repository.listEvents(item.id)).resolves.toHaveLength(4);
    await expect(repository.appendEvent(createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-gap-platform'),
      responseExecutionId: item.id,
      sequence: 6,
      type: 'stream_resumed',
      occurredAt: t3
    }))).rejects.toThrow('contiguous');
  });

  it('requires retryable same-subject predecessors and rejects project or identity reuse', async () => {
    const { repository } = await fixture();
    const previous = execution({ state: 'failed' });
    await expect(repository.create(previous, createdEvent(previous.id)))
      .rejects.toThrow('must start');

    const pending = execution();
    await repository.create(pending, createdEvent(pending.id));
    const invalidRetry = execution({
      id: 'response-execution-retry-invalid',
      attemptId: 'attempt-retry-invalid',
      assistantMessageId: 'message-assistant-retry-invalid',
      retryOfExecutionId: pending.id
    });
    await expect(repository.create(
      invalidRetry,
      createdEvent(invalidRetry.id, 'event-created-retry-invalid')
    )).rejects.toThrow('retryable execution');
    await repository.appendEvent(createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-failed-for-retry'),
      responseExecutionId: pending.id,
      sequence: 2,
      type: 'stream_failed',
      safeCode: 'provider.unavailable',
      occurredAt: t1
    }));
    const validRetry = execution({
      id: 'response-execution-retry-valid',
      attemptId: 'attempt-retry-valid',
      assistantMessageId: 'message-assistant-retry-valid',
      retryOfExecutionId: pending.id
    });
    await expect(repository.create(
      validRetry,
      createdEvent(validRetry.id, 'event-created-retry-valid')
    )).resolves.toBeUndefined();
    await expect(repository.create(
      execution({
        id: 'response-execution-cross-project',
        attemptId: 'attempt-cross-project',
        assistantMessageId: 'message-cross-project',
        ownerProjectId: otherProjectId as typeof projectId
      }),
      createdEvent(toConversationResponseExecutionId('response-execution-cross-project'))
    )).rejects.toThrow('another project');
  });
});

describe('controlled conversation response stream lifecycle', () => {
  it('persists a failed terminal event before publishing it to the renderer', async () => {
    const { repository } = await fixture();
    const item = execution({ id: 'response-execution-deferred-failure' });
    await repository.create(item, createdEvent(item.id, 'event-created-deferred-failure'));
    const channel = new ControlledConversationResponseStreamChannel();
    const received: string[] = [];
    channel.subscribe({
      subscriberId: 'renderer-deferred-failure',
      executionId: item.id,
      onEvent: (event) => received.push(`${event.type}:${event.safeCode ?? ''}`)
    });
    const lifecycle = new ConversationResponseExecutionLifecycle(
      repository,
      ids(),
      channel,
      () => t1
    );

    const event = await lifecycle.failDeferredPublish(item.id, 'newapi.invalid_response');
    await expect(repository.get(item.id)).resolves.toMatchObject({ state: 'failed' });
    expect(received).toEqual([]);

    await lifecycle.publish(event);
    expect(received).toEqual(['stream_failed:newapi.invalid_response']);
  });

  it('applies bounded backpressure and supports replay after renderer disconnect', async () => {
    const { repository } = await fixture();
    const item = execution({ productFeature: 'text_reasoning' });
    await repository.create(item, createdEvent(item.id));
    const channel = new ControlledConversationResponseStreamChannel();
    const received: number[] = [];
    const disconnected: string[] = [];
    channel.subscribe({
      subscriberId: 'renderer-1',
      executionId: item.id,
      maximumInFlight: 1,
      onEvent: (event) => received.push(event.sequence),
      onDisconnect: (reason) => disconnected.push(reason)
    });
    const lifecycle = new ConversationResponseExecutionLifecycle(
      repository,
      ids(),
      channel,
      () => t1
    );
    await lifecycle.start(item.id);
    await lifecycle.appendReasoning(item.id, '真实推理增量');
    await lifecycle.appendContent(item.id, '不会丢失');
    expect(received).toEqual([2]);
    expect(disconnected).toEqual(['backpressure_exceeded']);
    await expect(lifecycle.replayControlledEvents(item.id, 1)).resolves.toMatchObject([
      { sequence: 2, type: 'stream_started' },
      { sequence: 3, type: 'reasoning_delta', reasoningDelta: '真实推理增量' },
      { sequence: 4, type: 'content_delta', contentDelta: '不会丢失' }
    ]);
    await expect(lifecycle.readModel(item.id)).resolves.toMatchObject({
      reasoningContent: '真实推理增量',
      content: '不会丢失'
    });
  });

  it('interrupts active streams on application shutdown and resumes only explicitly', async () => {
    const { repository } = await fixture();
    const item = execution();
    await repository.create(item, createdEvent(item.id));
    const lifecycle = new ConversationResponseExecutionLifecycle(
      repository,
      ids(),
      undefined,
      (() => {
        const values = [t1, t2, t3];
        return () => values.shift() ?? t3;
      })()
    );
    await lifecycle.start(item.id);
    await expect(lifecycle.interruptActiveForApplicationShutdown()).resolves.toBe(1);
    await expect(lifecycle.readModel(item.id)).resolves.toMatchObject({
      state: 'interrupted',
      content: ''
    });
    await lifecycle.resume(item.id);
    await lifecycle.appendContent(item.id, '恢复后的内容');
    await expect(lifecycle.readModel(item.id)).resolves.toMatchObject({
      state: 'streaming',
      content: '恢复后的内容'
    });
  });

  it('recovers both pending and streaming executions after a process restart', async () => {
    const { repository } = await fixture();
    const pending = execution({ id: 'response-execution-recovery-pending' });
    const streaming = execution({
      id: 'response-execution-recovery-streaming',
      attemptId: 'attempt-response-recovery-streaming',
      assistantMessageId: 'message-assistant-recovery-streaming'
    });
    await repository.create(pending, createdEvent(pending.id, 'event-recovery-pending'));
    await repository.create(streaming, createdEvent(streaming.id, 'event-recovery-streaming'));
    const initialLifecycle = new ConversationResponseExecutionLifecycle(
      repository,
      ids(),
      undefined,
      () => t1
    );
    await initialLifecycle.start(streaming.id);

    const restartedLifecycle = new ConversationResponseExecutionLifecycle(
      repository,
      {
        nextConversationResponseStreamEventId: (() => {
          let sequence = 0;
          return () => toConversationResponseStreamEventId(`event-recovery-restart-${++sequence}`);
        })()
      },
      undefined,
      () => t2
    );
    await expect(restartedLifecycle.interruptActiveForApplicationShutdown()).resolves.toBe(2);
    await expect(restartedLifecycle.readModel(pending.id)).resolves.toMatchObject({
      state: 'interrupted',
      streamSequence: 2
    });
    await expect(restartedLifecycle.readModel(streaming.id)).resolves.toMatchObject({
      state: 'interrupted',
      streamSequence: 3
    });
  });
});
