import { describe, expect, it } from 'vitest';
import { failureDiagnostic } from '../../src/platform/providers/failure-diagnostic';
import { createProviderInvocationEvent, toProviderInvocationEventId, toProviderInvocationAttemptId, toIsoTimestamp } from '../../src/domain';

describe('failure diagnostics', () => {
  it('preserves bounded upstream facts through the event contract', () => {
    const diagnostic = failureDiagnostic({ message: 'Upstream request failed', statusCode: 500, code: 'upstream_error', requestId: 'Req-123', stage: 'upstream_response' });
    const event = createProviderInvocationEvent({ id: toProviderInvocationEventId('event-1'), invocationAttemptId: toProviderInvocationAttemptId('attempt-1'), sequence: 1, type: 'failed', occurredAt: toIsoTimestamp('2026-09-10T00:00:00.000Z'), failureDiagnostic: diagnostic });
    expect(event.failureDiagnostic).toEqual(diagnostic);
  });
  it('redacts credentials and addresses and bounds messages', () => {
    const result = failureDiagnostic({ message: 'failed Bearer secret token=private https://example.test/?key=secret C:\\private\\data abc-secret' }, ['abc-secret']);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|example/);
    expect(failureDiagnostic({ message: 'x'.repeat(1000) })?.message).toHaveLength(512);
    expect(failureDiagnostic({ message: '' })).toBeUndefined();
  });
});
