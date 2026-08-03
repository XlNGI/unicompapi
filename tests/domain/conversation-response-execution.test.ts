import { describe, expect, it } from 'vitest';
import {
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  parseConversationResponseExecution,
  projectConversationResponseExecution,
  toConnectionId,
  toConversationId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toModelId,
  toProjectContextId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toControlledConversationResponseStreamEventDto,
  type ConversationResponseExecutionState,
  type ConversationResponseStreamEventType
} from '../../src/domain';

const projectId = toProjectId('project-response-execution');
const executionId = toConversationResponseExecutionId('response-execution-domain');
const t0 = toIsoTimestamp('2026-08-03T09:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T09:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T09:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T09:03:00.000Z');

function execution(state: ConversationResponseExecutionState = 'pending') {
  return {
    ...createConversationResponseExecution({
      id: executionId,
      projectId,
      providerInvocationAttemptId: toProviderInvocationAttemptId('attempt-response-domain'),
      snapshot: {
        schemaVersion: 1 as const,
        responseDraftId: toConversationResponseDraftId('response-draft-domain'),
        responseDraftRevision: 2,
        conversationId: toConversationId('conversation-response-domain'),
        conversationRevision: 4,
        userMessageId: toMessageId('message-user-domain'),
        userMessageRevision: 1,
        assistantMessageId: toMessageId('message-assistant-domain'),
        productFeature: 'text_reasoning' as const,
        routeSnapshotId: toProviderExecutionRouteSnapshotId('route-response-domain'),
        candidate: {
          schemaVersion: 1 as const,
          providerId: toProviderId('provider-response-domain'),
          connectionId: toConnectionId('connection-response-domain'),
          connectionRevision: 3,
          modelId: toModelId('model-response-domain'),
          modelRevision: 5,
          profileId: 'profile.deepseek-reasoning',
          profileRevision: 4,
          protocolBindingId: toProtocolBindingId('binding-response-domain'),
          protocolBindingRevision: 2,
          runtimeSource: 'official_direct' as const
        },
        outboundUserTextSnapshot: '请根据固定上下文回答。',
        contextSnapshots: [{
          schemaVersion: 1 as const,
          contextId: toProjectContextId('context-response-domain'),
          contextRevision: 2,
          contentHash: 'a'.repeat(64),
          contentSnapshot: '这是用户明确勾选的项目上下文。'
        }]
      },
      createdAt: t0
    }),
    state
  };
}

function event(
  sequence: number,
  type: ConversationResponseStreamEventType,
  occurredAt = t1,
  details: Record<string, unknown> = {}
) {
  return createConversationResponseStreamEvent({
    id: toConversationResponseStreamEventId(`response-event-${sequence}`),
    responseExecutionId: executionId,
    sequence,
    type,
    ...details,
    occurredAt
  });
}

describe('conversation response execution contract', () => {
  it('projects interruption, explicit resume and completion without losing streamed content', () => {
    const events = [
      event(1, 'execution_created', t0),
      event(2, 'stream_started', t1),
      event(3, 'content_delta', t1, { contentDelta: '第一段' }),
      event(4, 'stream_interrupted', t2, { interruptionReason: 'provider_disconnected' }),
      event(5, 'stream_resumed', t2),
      event(6, 'content_delta', t3, { contentDelta: '第二段' }),
      event(7, 'stream_completed', t3)
    ];
    const readModel = projectConversationResponseExecution({
      execution: execution('completed'),
      events
    });
    expect(readModel).toMatchObject({
      state: 'completed',
      streamSequence: 7,
      content: '第一段第二段',
      runtimeSource: 'official_direct'
    });

    const controlled = toControlledConversationResponseStreamEventDto({
      execution: execution('completed'),
      event: events[2]
    });
    expect(controlled).toMatchObject({
      type: 'content_delta',
      contentDelta: '第一段',
      conversationId: 'conversation-response-domain'
    });
    expect(JSON.stringify(controlled)).not.toMatch(
      /routeSnapshot|outboundUserText|contentHash|profileId|protocolBinding/i
    );
  });

  it('rejects media features, hidden provider fields and invalid stream transitions', () => {
    const valid = execution();
    expect(() => parseConversationResponseExecution({
      ...valid,
      snapshot: { ...valid.snapshot, productFeature: 'text_to_image' }
    })).toThrow('text feature');
    expect(() => parseConversationResponseExecution({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        candidate: {
          ...valid.snapshot.candidate,
          authorization: 'Bearer secret'
        }
      }
    })).toThrow('unsupported fields');
    expect(() => projectConversationResponseExecution({
      execution: execution('completed'),
      events: [
        event(1, 'execution_created', t0),
        event(2, 'stream_started', t1),
        event(3, 'stream_completed', t2)
      ]
    })).toThrow('cannot be empty');
    expect(() => projectConversationResponseExecution({
      execution: execution('streaming'),
      events: [
        event(1, 'execution_created', t0),
        event(2, 'content_delta', t1, { contentDelta: '非法增量' })
      ]
    })).toThrow('cannot transition from pending to content_delta');
  });
});
