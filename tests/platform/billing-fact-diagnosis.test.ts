import { describe, expect, it } from 'vitest';
import {
  NewApiBillingReconciler,
  type NewApiTokenLogRecord
} from '../../src/platform/providers/newapi/newapi-billing';
import {
  DESENSITIZED_BILLING_SCENARIOS,
  DESENSITIZED_CONNECTION_ID,
  DESENSITIZED_MATCHING_REQUEST_ID,
  DESENSITIZED_MODEL_KEY,
  DESENSITIZED_USAGE_OBSERVATION,
  type DesensitizedBillingScenario,
  type DesensitizedTransportOutcome
} from '../fixtures/billing-desensitized-call';

/**
 * P0 evidence suite.
 *
 * It rebuilds the four observable facts of the screenshot call purely from
 * desensitized fixtures — no credential is read and no paid request is issued —
 * and then pins the current platform behaviour that the plan calls the defect:
 * all of those facts collapse into one indistinguishable "no amount" outcome.
 *
 * The `RED baseline` block is intentionally a characterisation of today's
 * behaviour. P2 must replace it with real bounded reason codes; when it does,
 * these assertions are expected to change from "cannot distinguish" to
 * "distinguishes with `reasonCode`".
 */

function createReconciler(scenario: DesensitizedBillingScenario): NewApiBillingReconciler {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const respond = (outcome: DesensitizedTransportOutcome): Uint8Array => {
    if (outcome.status === undefined) {
      throw new Error(outcome.transportError ?? 'transport_error');
    }
    if (outcome.status >= 400) {
      throw new Error(`HTTP ${outcome.status}`);
    }
    return encode(outcome.body);
  };
  return new NewApiBillingReconciler(
    {
      async load() {
        return {
          connections: [{
            id: scenario.connectionId,
            credentialReference: 'credential-desensitized-1'
          }]
        };
      }
    } as never,
    {
      async useRecord(
        _reference: string,
        operation: (record: unknown) => Promise<unknown>
      ) {
        return operation({
          schemaId: 'openai-compatible.api-key',
          schemaVersion: 1,
          values: { api_key: 'redacted-in-fixture' }
        });
      }
    } as never,
    {
      async requestTokenLogs() {
        return respond(scenario.tokenLogs);
      },
      async requestSiteStatus() {
        return respond(scenario.siteStatus);
      },
      async requestModelPricing() {
        return respond(scenario.modelPricing);
      }
    } as never
  );
}

describe('P0 billing fact reconstruction from desensitized fixtures', () => {
  it('rebuilds fact 1: the submit response carried no upstream request id', () => {
    expect(DESENSITIZED_USAGE_OBSERVATION.status).toBe('not_reported');
    expect(DESENSITIZED_USAGE_OBSERVATION.facts).toHaveLength(0);
    expect(DESENSITIZED_USAGE_OBSERVATION.providerRequestId).toBeUndefined();
    // A valid result did land locally, so the call itself is not the problem.
    expect(DESENSITIZED_USAGE_OBSERVATION.localResultCount).toBe(1);
  });

  it('rebuilds fact 2 and 3: billing endpoints answered 404 and 429', () => {
    expect(DESENSITIZED_BILLING_SCENARIOS.logs_unavailable_404.tokenLogs.status).toBe(404);
    expect(DESENSITIZED_BILLING_SCENARIOS.logs_rate_limited.tokenLogs.status).toBe(429);
    expect(DESENSITIZED_BILLING_SCENARIOS.logs_transport_error.tokenLogs.status).toBeUndefined();
    expect(DESENSITIZED_BILLING_SCENARIOS.logs_transport_error.tokenLogs.transportError)
      .toBe('timeout');
  });

  it('rebuilds fact 4: the pricing list has no exact key for the model', () => {
    const body = DESENSITIZED_BILLING_SCENARIOS.usage_not_reported_pricing_missing
      .modelPricing.body as { readonly data: readonly { readonly model_name: string }[] };
    expect(body.data.map((item) => item.model_name)).not.toContain(DESENSITIZED_MODEL_KEY);
    // The model key must never be guessed from a similar name.
    expect(DESENSITIZED_MODEL_KEY).not.toBe(body.data[0]?.model_name);
  });

  it('keeps every fixture free of credentials, prompts and absolute paths', () => {
    const serialized = JSON.stringify(DESENSITIZED_BILLING_SCENARIOS);
    for (const forbidden of [
      'api_key',
      'sk-',
      'Bearer',
      'Authorization',
      '\\\\',
      'C:/',
      'prompt'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('obtains a real bill when the station protocol is healthy', async () => {
    const reconciler = createReconciler(DESENSITIZED_BILLING_SCENARIOS.station_healthy_bill_present);
    const logs = await reconciler.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID });
    const row = logs.get(DESENSITIZED_MATCHING_REQUEST_ID);
    expect(row).toBeDefined();
    expect(row?.amountCny).toBeDefined();
    // A reachable station protocol is therefore NOT the reason for "无法估算".
    await expect(reconciler.estimate({
      connectionId: DESENSITIZED_CONNECTION_ID,
      modelName: DESENSITIZED_MODEL_KEY,
      billableUnits: '1'
    })).resolves.toMatchObject({ source: '当前中转站模型广场价格快照' });
  });

  /**
   * The defect P2 must fix is not "no outcome at all" — a healthy station does
   * produce real amounts. It is that **distinct causes produce identical
   * observable results**, so the task centre can never explain what is missing.
   */
  it('RED baseline: 404, 429 and a transport failure collide into the same empty result', async () => {
    const results: readonly string[] = await Promise.all(
      (['logs_unavailable_404', 'logs_rate_limited', 'logs_transport_error'] as const)
        .map(async (scenarioId) => {
          const reconciler = createReconciler(DESENSITIZED_BILLING_SCENARIOS[scenarioId]);
          const logs = await reconciler.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID });
          return JSON.stringify({ size: logs.size, keys: [...logs.keys()] });
        })
    );
    // Three different root causes; one single observable outcome.
    expect(results[0]).toBe('{"size":0,"keys":[]}');
    expect(new Set(results).size).toBe(1);
  });

  it('RED baseline: a missing pricing key collides with a rate-limited pricing endpoint', async () => {
    const estimateFor = async (scenarioId: 'usage_not_reported_pricing_missing' | 'pricing_endpoint_rate_limited') => {
      const reconciler = createReconciler(DESENSITIZED_BILLING_SCENARIOS[scenarioId]);
      return reconciler.estimate({
        connectionId: DESENSITIZED_CONNECTION_ID,
        modelName: DESENSITIZED_MODEL_KEY,
        billableUnits: '1'
      }).then(
        (value) => JSON.stringify({ outcome: 'estimate', value }),
        (error: unknown) => JSON.stringify({ outcome: 'rejected', message: String(error) })
      );
    };
    const missingKey = await estimateFor('usage_not_reported_pricing_missing');
    const rateLimited = await estimateFor('pricing_endpoint_rate_limited');
    expect(missingKey).toBe('{"outcome":"estimate"}');
    expect(rateLimited).toBe(missingKey);
  });

  it('RED baseline: a log row that cannot be correlated is still returned as an empty match', async () => {
    const reconciler = createReconciler(DESENSITIZED_BILLING_SCENARIOS.request_id_unavailable);
    const logs = await reconciler.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID });
    // The station did return a consume row, but the invocation has no request id
    // to look it up with, and no reason code records that gap.
    expect(logs.size).toBe(1);
    expect(logs.has(DESENSITIZED_MATCHING_REQUEST_ID)).toBe(false);
    const onlyRow: NewApiTokenLogRecord | undefined = [...logs.values()][0];
    expect(onlyRow?.amountCny).toBeDefined();
  });

  it('RED baseline: a failing site-status request aborts the whole context', async () => {
    const healthy = createReconciler(DESENSITIZED_BILLING_SCENARIOS.station_healthy_bill_present);
    await expect(healthy.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID }))
      .resolves.toHaveProperty('size', 1);

    const failingStatus = {
      ...DESENSITIZED_BILLING_SCENARIOS.station_healthy_bill_present,
      siteStatus: { status: 429, body: { success: false, message: 'rate_limited' } }
    };
    const reconciler = createReconciler(failingStatus);
    // Today the rejection escapes the adapter, so the caller can only fall back
    // to `unestimated`; it never learns that the cause was rate limiting.
    await expect(reconciler.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID }))
      .rejects.toThrow('HTTP 429');
  });
});
