import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalResultObservation,
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createProviderUsageObservation,
  createUsageSchema,
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
import {
  JsonLocalResultObservationRepository,
  JsonProviderInvocationRepository,
  JsonProviderUsageObservationRepository,
  LocalResultObservationRepositoryDataError,
  NodeProjectStorage,
  ProviderInvocationRepositoryDataError
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-invocation-repository');
const t0 = toIsoTimestamp('2026-08-03T07:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-03T07:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-03T07:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-03T07:03:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-invocation-usage-'));
  roots.push(root);
  const storage = new NodeProjectStorage(root);
  return {
    storage,
    invocations: new JsonProviderInvocationRepository(storage, projectId),
    usage: new JsonProviderUsageObservationRepository(storage),
    localResults: new JsonLocalResultObservationRepository(storage)
  };
}

function invocation(id: string) {
  const attempt = createProviderInvocationAttempt({
    id: toProviderInvocationAttemptId(id),
    projectId,
    subject: {
      kind: 'media',
      taskId: toTaskId(`task-${id}`),
      executionId: toExecutionId(`execution-${id}`)
    },
    routeSnapshotId: toProviderExecutionRouteSnapshotId(`route-${id}`),
    createdAt: t0
  });
  const initialEvent = createProviderInvocationEvent({
    id: toProviderInvocationEventId(`event-${id}-1`),
    invocationAttemptId: attempt.id,
    sequence: 1,
    type: 'submission_started',
    occurredAt: t0
  });
  return { attempt, initialEvent };
}

const schema = createUsageSchema({
  id: toUsageSchemaId('usage-schema-repository'),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [{
    metricId: 'total_tokens',
    allowedUnits: ['token'],
    numericKind: 'integer',
    aggregation: 'cumulative_latest',
    requiredForComplete: true,
    allowedStages: ['submit', 'poll', 'result']
  }]
});

describe('provider invocation repository', () => {
  it('serializes project attempts, event state and explicit retry lineage', async () => {
    const { storage, invocations } = await fixture();
    const other = new JsonProviderInvocationRepository(storage, projectId);
    const first = invocation('attempt-repository-1');
    const second = invocation('attempt-repository-2');
    await Promise.all([
      invocations.create(first.attempt, first.initialEvent),
      other.create(second.attempt, second.initialEvent)
    ]);
    await invocations.appendEvent(createProviderInvocationEvent({
      id: toProviderInvocationEventId('event-attempt-repository-1-2'),
      invocationAttemptId: first.attempt.id,
      sequence: 2,
      type: 'provider_accepted',
      occurredAt: t1
    }));
    await invocations.appendEvent(createProviderInvocationEvent({
      id: toProviderInvocationEventId('event-attempt-repository-1-3'),
      invocationAttemptId: first.attempt.id,
      sequence: 3,
      type: 'completed',
      occurredAt: t2
    }));
    await expect(invocations.get(first.attempt.id)).resolves.toMatchObject({ state: 'completed' });

    const retry = {
      ...invocation('attempt-repository-retry').attempt,
      retryOfInvocationAttemptId: first.attempt.id
    };
    const retryEvent = createProviderInvocationEvent({
      id: toProviderInvocationEventId('event-attempt-repository-retry-1'),
      invocationAttemptId: retry.id,
      sequence: 1,
      type: 'submission_started',
      occurredAt: t3
    });
    await expect(invocations.create(retry, retryEvent)).rejects.toThrow('same subject');
    const sameSubjectRetry = {
      ...retry,
      subject: first.attempt.subject
    };
    await invocations.create(sameSubjectRetry, retryEvent);
    await expect(invocations.list()).resolves.toHaveLength(3);
  });

  it('keeps duplicate events idempotent and rejects sequence conflicts', async () => {
    const { invocations } = await fixture();
    const created = invocation('attempt-event-conflict');
    await invocations.create(created.attempt, created.initialEvent);
    await invocations.create(created.attempt, created.initialEvent);
    const accepted = createProviderInvocationEvent({
      id: toProviderInvocationEventId('event-conflict-2'),
      invocationAttemptId: created.attempt.id,
      sequence: 2,
      type: 'provider_accepted',
      occurredAt: t1
    });
    await invocations.appendEvent(accepted);
    await invocations.appendEvent(accepted);
    await expect(invocations.appendEvent(createProviderInvocationEvent({
      ...accepted,
      id: toProviderInvocationEventId('event-conflict-other'),
      type: 'outcome_unknown'
    }))).rejects.toBeInstanceOf(ProviderInvocationRepositoryDataError);
    await expect(invocations.listEvents(created.attempt.id)).resolves.toHaveLength(2);
  });
});

describe('usage and local result repositories', () => {
  it('keeps source events idempotent and marks conflicting content invalid', async () => {
    const { usage } = await fixture();
    const id = toProviderInvocationAttemptId('attempt-usage-repository');
    const first = createProviderUsageObservation({
      id: toProviderUsageObservationId('usage-repository-1'),
      invocationAttemptId: id,
      usageSchemaId: schema.id,
      usageSchemaRevision: schema.revision,
      sourceEventKey: 'usageevent01',
      sequence: 1,
      status: 'reported',
      sourceStage: 'poll',
      facts: [{ metricId: 'total_tokens', quantity: '8', unit: 'token', source: 'provider_body' }],
      observedAt: t1
    }, schema);
    await usage.append(first, schema);
    await usage.append({ ...first, id: toProviderUsageObservationId('usage-repository-duplicate'), observedAt: t2 }, schema);
    expect(await usage.list(id)).toHaveLength(1);

    const conflict = createProviderUsageObservation({
      ...first,
      id: toProviderUsageObservationId('usage-repository-conflict'),
      facts: [{ metricId: 'total_tokens', quantity: '9', unit: 'token', source: 'provider_body' }],
      observedAt: t2
    }, schema);
    await usage.append(conflict, schema);
    await usage.append(conflict, schema);
    expect(await usage.summarize({
      attemptId: id,
      schema,
      attemptState: 'completed',
      calculatedAt: t3
    })).toMatchObject({ availability: 'invalid_response', facts: [] });
  });

  it('stores immutable local result properties without paths, hashes or provider response data', async () => {
    const { localResults } = await fixture();
    const observation = createLocalResultObservation({
      id: toLocalResultObservationId('local-result-repository'),
      invocationAttemptId: toProviderInvocationAttemptId('attempt-local-result'),
      mediaKind: 'video',
      outputCount: 1,
      durationMs: '1200',
      width: 1920,
      height: 1080,
      byteLength: '4096',
      validationState: 'valid',
      observedAt: t2
    });
    await localResults.append(observation);
    await localResults.append(observation);
    await expect(localResults.append({ ...observation, outputCount: 2 }))
      .rejects.toBeInstanceOf(LocalResultObservationRepositoryDataError);
    const serialized = JSON.stringify(await localResults.list());
    expect(serialized).not.toMatch(/absolutePath|contentHash|remoteOperation|prompt|authorization/i);
  });
});
