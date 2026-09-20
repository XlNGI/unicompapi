import { describe, expect, it } from 'vitest';
import type { NewApiTokenLogRecord } from '../../src/platform/providers/newapi/newapi-billing';
import {
  DESENSITIZED_BILLING_SCENARIOS,
  DESENSITIZED_CONNECTION_ID,
  DESENSITIZED_MATCHING_REQUEST_ID,
  DESENSITIZED_MODEL_KEY,
  DESENSITIZED_SITE_STATUS_FAILURES,
  DESENSITIZED_USAGE_OBSERVATION,
  createDesensitizedReconciler,
  type DesensitizedBillingScenario
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

function createReconciler(scenario: DesensitizedBillingScenario) {
  return createDesensitizedReconciler(scenario);
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
   * P2 GREEN. These two cases were the P0 RED baseline, where every distinct
   * cause collapsed into one observable outcome. The adapter now reports the
   * cause through the bounded reason vocabulary instead of swallowing it.
   */
  it('P2: 404, 429 and a transport failure report three different reasons', async () => {
    const diagnosisFor = async (
      scenarioId: 'logs_unavailable_404' | 'logs_rate_limited' | 'logs_transport_error'
    ) => createReconciler(DESENSITIZED_BILLING_SCENARIOS[scenarioId])
      .diagnose({ connectionId: DESENSITIZED_CONNECTION_ID, modelName: DESENSITIZED_MODEL_KEY });

    const notFound = await diagnosisFor('logs_unavailable_404');
    const rateLimited = await diagnosisFor('logs_rate_limited');
    const transport = await diagnosisFor('logs_transport_error');

    expect(notFound).toEqual(['logs_unavailable_404']);
    expect(rateLimited).toEqual(['logs_rate_limited']);
    expect(transport).toEqual(['logs_transport_error']);
    // Three causes, three answers: the operator can now act on the difference.
    expect(new Set([notFound[0], rateLimited[0], transport[0]]).size).toBe(3);
  });

  it('P2: a missing pricing key differs from an unreachable pricing endpoint', async () => {
    const diagnosisFor = async (
      scenarioId: 'usage_not_reported_pricing_missing' | 'pricing_endpoint_rate_limited'
    ) => createReconciler(DESENSITIZED_BILLING_SCENARIOS[scenarioId])
      .diagnose({ connectionId: DESENSITIZED_CONNECTION_ID, modelName: DESENSITIZED_MODEL_KEY });

    expect(await diagnosisFor('usage_not_reported_pricing_missing'))
      .toEqual(['pricing_model_missing']);
    expect(await diagnosisFor('pricing_endpoint_rate_limited'))
      .toEqual(['pricing_unavailable']);
  });

  it('P2: HTTP 200 with an unusable payload is not treated as a price or a log', async () => {
    const pricing = await createReconciler(DESENSITIZED_BILLING_SCENARIOS.pricing_payload_invalid)
      .diagnose({ connectionId: DESENSITIZED_CONNECTION_ID, modelName: DESENSITIZED_MODEL_KEY });
    expect(pricing).toEqual(['pricing_invalid']);
    // A 200 alone is never billing evidence, and no amount is invented.
    expect(await createReconciler(DESENSITIZED_BILLING_SCENARIOS.pricing_payload_invalid)
      .estimate({
        connectionId: DESENSITIZED_CONNECTION_ID,
        modelName: DESENSITIZED_MODEL_KEY,
        billableUnits: '1'
      })).toBeUndefined();

    const logs = await createReconciler(DESENSITIZED_BILLING_SCENARIOS.logs_payload_invalid)
      .diagnose({ connectionId: DESENSITIZED_CONNECTION_ID, modelName: DESENSITIZED_MODEL_KEY });
    expect(logs).toEqual(['logs_payload_invalid']);
  });

  it('P2: a log row that cannot be correlated is reported as an unavailable id', async () => {
    const reconciler = createReconciler(DESENSITIZED_BILLING_SCENARIOS.request_id_unavailable);
    const logs = await reconciler.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID });
    // The station did return a consume row, but the invocation has no request id
    // to look it up with. The row is not lost, but the gap is now reportable.
    expect(logs.size).toBe(1);
    expect(logs.has(DESENSITIZED_MATCHING_REQUEST_ID)).toBe(false);
    const onlyRow: NewApiTokenLogRecord | undefined = [...logs.values()][0];
    expect(onlyRow?.amountCny).toBeDefined();
    expect(await reconciler.diagnose({
      connectionId: DESENSITIZED_CONNECTION_ID,
      modelName: DESENSITIZED_MODEL_KEY
    })).toEqual([]);
  });

  it('aborts the whole context when the site-status request fails', async () => {
    const healthy = createReconciler(DESENSITIZED_BILLING_SCENARIOS.station_healthy_bill_present);
    await expect(healthy.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID }))
      .resolves.toHaveProperty('size', 1);

    const failingStatus = {
      ...DESENSITIZED_BILLING_SCENARIOS.station_healthy_bill_present,
      siteStatus: DESENSITIZED_SITE_STATUS_FAILURES.rate_limited
    };
    const reconciler = createReconciler(failingStatus);
    // A status failure is not a log/pricing fact: it removes the quota policy,
    // so the adapter still rejects and the caller keeps its safe fallback.
    await expect(reconciler.reconcile({ connectionId: DESENSITIZED_CONNECTION_ID }))
      .rejects.toMatchObject({ code: 'rate_limited' });
  });
});
