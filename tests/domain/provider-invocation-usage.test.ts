import { describe, expect, it } from 'vitest';
import {
  buildProviderInvocationReadModel,
  createLocalResultObservation,
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createProviderUsageObservation,
  createUsageSchema,
  parseProviderUsageObservation,
  projectProviderInvocationState,
  summarizeProviderUsage,
  toExecutionId,
  toIsoTimestamp,
  toLocalResultObservationId,
  toProjectId,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderUsageObservationId,
  toTaskId,
  toUsageSchemaId
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-08-03T06:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T06:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T06:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T06:03:00.000Z');
const attemptId = toProviderInvocationAttemptId('invocation-usage-domain');

const usageSchema = createUsageSchema({
  id: toUsageSchemaId('usage-schema-domain'),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    {
      metricId: 'input_tokens',
      allowedUnits: ['token'],
      numericKind: 'integer',
      aggregation: 'cumulative_latest',
      requiredForComplete: true,
      allowedStages: ['submit', 'poll', 'result']
    },
    {
      metricId: 'output_tokens',
      allowedUnits: ['token'],
      numericKind: 'integer',
      aggregation: 'delta_sum',
      requiredForComplete: true,
      allowedStages: ['submit', 'poll', 'result']
    },
    {
      metricId: 'cached_tokens',
      allowedUnits: ['token'],
      numericKind: 'integer',
      aggregation: 'first_reported',
      requiredForComplete: false,
      allowedStages: ['submit', 'poll', 'result']
    },
    {
      metricId: 'reported_amount',
      allowedUnits: ['USD'],
      numericKind: 'decimal',
      aggregation: 'final_authoritative',
      requiredForComplete: false,
      allowedStages: ['submit', 'poll', 'result']
    }
  ]
});

function usageObservation(input: {
  id: string;
  sequence: number;
  key: string;
  stage: 'submit' | 'poll' | 'result';
  inputTokens: string;
  outputTokens: string;
  amount: string;
}) {
  return createProviderUsageObservation({
    id: toProviderUsageObservationId(input.id),
    invocationAttemptId: attemptId,
    usageSchemaId: usageSchema.id,
    usageSchemaRevision: usageSchema.revision,
    sourceEventKey: input.key,
    sequence: input.sequence,
    status: 'reported',
    sourceStage: input.stage,
    facts: [
      { metricId: 'input_tokens', quantity: input.inputTokens, unit: 'token', source: 'provider_body' },
      { metricId: 'output_tokens', quantity: input.outputTokens, unit: 'token', source: 'provider_body' },
      { metricId: 'cached_tokens', quantity: '1', unit: 'token', source: 'provider_body' },
      { metricId: 'reported_amount', quantity: input.amount, unit: 'USD', source: 'provider_body' }
    ],
    observedAt: [t1, t2, t3][input.sequence - 1]
  }, usageSchema);
}

describe('provider invocation lifecycle contracts', () => {
  it('rebuilds one media invocation from a contiguous safe event timeline', () => {
    const attempt = createProviderInvocationAttempt({
      id: attemptId,
      projectId: toProjectId('project-invocation-domain'),
      subject: {
        kind: 'media',
        taskId: toTaskId('task-invocation-domain'),
        executionId: toExecutionId('execution-invocation-domain')
      },
      routeSnapshotId: toProviderExecutionRouteSnapshotId('route-invocation-domain'),
      createdAt: t0
    });
    const events = [
      createProviderInvocationEvent({
        id: toProviderInvocationEventId('event-invocation-1'),
        invocationAttemptId: attempt.id,
        sequence: 1,
        type: 'submission_started',
        occurredAt: t0
      }),
      createProviderInvocationEvent({
        id: toProviderInvocationEventId('event-invocation-2'),
        invocationAttemptId: attempt.id,
        sequence: 2,
        type: 'provider_accepted',
        occurredAt: t1
      }),
      createProviderInvocationEvent({
        id: toProviderInvocationEventId('event-invocation-3'),
        invocationAttemptId: attempt.id,
        sequence: 3,
        type: 'completed',
        safeCode: 'provider.completed',
        occurredAt: t2
      })
    ];
    expect(projectProviderInvocationState(attempt, events)).toBe('completed');
    expect(() => createProviderInvocationEvent({
      ...events[2],
      id: toProviderInvocationEventId('event-unsafe-code'),
      safeCode: 'https://signed.example/result'
    })).toThrow('safe code');
    expect(() => projectProviderInvocationState(attempt, [events[0], events[2]])).toThrow(
      'contiguous'
    );
  });
});

describe('provider usage and local result contracts', () => {
  it('aggregates final, cumulative, delta and first-reported metrics without double counting polls', () => {
    const observations = [
      usageObservation({ id: 'usage-domain-1', sequence: 1, key: 'usageevt001', stage: 'submit', inputTokens: '10', outputTokens: '2', amount: '0.10' }),
      usageObservation({ id: 'usage-domain-2', sequence: 2, key: 'usageevt002', stage: 'poll', inputTokens: '20', outputTokens: '3', amount: '0.20' }),
      usageObservation({ id: 'usage-domain-3', sequence: 3, key: 'usageevt003', stage: 'result', inputTokens: '20', outputTokens: '4', amount: '0.30' })
    ];
    const result = summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations,
      attemptState: 'completed',
      calculatedAt: t3
    });
    expect(result.availability).toBe('reported_complete');
    expect(Object.fromEntries(result.facts.map((fact) => [fact.metricId, fact.quantity])))
      .toEqual({
        input_tokens: '20',
        output_tokens: '9',
        cached_tokens: '1',
        reported_amount: '0.30'
      });
    const conflictingFirstReported = {
      ...observations[2],
      facts: observations[2].facts.map((fact) =>
        fact.metricId === 'cached_tokens' ? { ...fact, quantity: '2' } : fact
      )
    };
    expect(summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations: [observations[0], observations[1], conflictingFirstReported],
      attemptState: 'completed',
      calculatedAt: t3
    }).availability).toBe('invalid_response');
  });

  it('distinguishes partial, absent, unknown, not-applicable and legacy availability', () => {
    const partial = createProviderUsageObservation({
      id: toProviderUsageObservationId('usage-domain-partial'),
      invocationAttemptId: attemptId,
      usageSchemaId: usageSchema.id,
      usageSchemaRevision: usageSchema.revision,
      sourceEventKey: 'usagepartial1',
      sequence: 1,
      status: 'reported',
      sourceStage: 'result',
      facts: [{ metricId: 'input_tokens', quantity: '5', unit: 'token', source: 'provider_body' }],
      observedAt: t1
    }, usageSchema);
    expect(summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations: [partial],
      attemptState: 'completed',
      calculatedAt: t2
    }).availability).toBe('reported_partial');
    expect(summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations: [],
      attemptState: 'completed',
      calculatedAt: t2
    }).availability).toBe('not_reported');
    expect(summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations: [],
      attemptState: 'unknown_outcome',
      calculatedAt: t2
    }).availability).toBe('unknown_outcome');
    expect(summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations: [],
      attemptState: 'completed',
      calculatedAt: t2,
      availabilityOverride: 'not_applicable'
    }).availability).toBe('not_applicable');
    expect(summarizeProviderUsage({
      invocationAttemptId: attemptId,
      schema: usageSchema,
      observations: [],
      attemptState: 'completed',
      calculatedAt: t2,
      availabilityOverride: 'not_collected_legacy'
    }).availability).toBe('not_collected_legacy');
  });

  it('rejects unknown metrics, illegal integer forms and protected response fields', () => {
    expect(() => createProviderUsageObservation({
      id: toProviderUsageObservationId('usage-domain-invalid'),
      invocationAttemptId: attemptId,
      usageSchemaId: usageSchema.id,
      usageSchemaRevision: usageSchema.revision,
      sourceEventKey: 'usageinvalid1',
      sequence: 1,
      status: 'reported',
      sourceStage: 'result',
      facts: [{ metricId: 'input_tokens', quantity: '1.0', unit: 'token', source: 'provider_body' }],
      observedAt: t1
    }, usageSchema)).toThrow('integer string');
    expect(() => parseProviderUsageObservation({
      ...usageObservation({ id: 'usage-domain-extra', sequence: 1, key: 'usageextra01', stage: 'result', inputTokens: '1', outputTokens: '1', amount: '0.1' }),
      rawResponse: { authorization: 'secret' }
    })).toThrow('unsupported fields');
  });

  it('keeps local result facts separate and produces a path-free unified read model', () => {
    const attempt = {
      ...createProviderInvocationAttempt({
        id: attemptId,
        projectId: toProjectId('project-read-model'),
        subject: {
          kind: 'media' as const,
          taskId: toTaskId('task-read-model'),
          executionId: toExecutionId('execution-read-model')
        },
        routeSnapshotId: toProviderExecutionRouteSnapshotId('route-read-model'),
        createdAt: t0
      }),
      state: 'failed_before_submission' as const
    };
    const events = [
      createProviderInvocationEvent({
        id: toProviderInvocationEventId('event-read-model-1'),
        invocationAttemptId: attempt.id,
        sequence: 1,
        type: 'submission_started',
        occurredAt: t0
      }),
      createProviderInvocationEvent({
        id: toProviderInvocationEventId('event-read-model-2'),
        invocationAttemptId: attempt.id,
        sequence: 2,
        type: 'submission_failed_before_request',
        safeCode: 'transport.unavailable',
        occurredAt: t1
      })
    ];
    const localResult = createLocalResultObservation({
      id: toLocalResultObservationId('local-result-domain'),
      invocationAttemptId: attempt.id,
      mediaKind: 'image',
      outputCount: 0,
      validationState: 'invalid',
      observedAt: t2
    });
    const usage = summarizeProviderUsage({
      invocationAttemptId: attempt.id,
      schema: usageSchema,
      observations: [],
      attemptState: attempt.state,
      calculatedAt: t2
    });
    const readModel = buildProviderInvocationReadModel({
      attempt,
      events,
      usage,
      localResults: [localResult]
    });
    expect(JSON.stringify(readModel)).not.toMatch(/routeSnapshot|absolutePath|contentHash|prompt/i);
    expect(readModel).toMatchObject({
      state: 'failed_before_submission',
      usage: { availability: 'not_reported' },
      localResults: [{ validationState: 'invalid' }]
    });
  });
});
