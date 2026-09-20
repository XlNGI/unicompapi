/**
 * Desensitized billing fixtures for the OpenAI-compatible station call that the
 * task centre could only display as "无法估算".
 *
 * Every identifier here is synthetic. Only status codes, counts, shapes and
 * amounts are preserved, per the plan's rule that fixtures may carry only
 * desensitized IDs, states, counts and amounts. No API key, token, prompt,
 * absolute path or raw upstream body is present.
 *
 * The fixture is transport-level on purpose: it lets a test rebuild the four
 * observable facts of the original call without reading any credential and
 * without issuing a single real paid request.
 */

import { NewApiBillingReconciler } from '../../src/platform/providers/newapi/newapi-billing';
import {
  NewApiRuntimeError,
  NewApiTransportFailure
} from '../../src/platform/providers/newapi/newapi-runtime';

/** Outcome of one upstream billing-protocol request. */
export interface DesensitizedTransportOutcome {
  /** HTTP status the station returned, or `undefined` for a transport failure. */
  readonly status: number | undefined;
  /** Upstream body for successful responses only; omitted for failures. */
  readonly body?: unknown;
  /** Bounded transport failure label; never a raw error message. */
  readonly transportError?: 'timeout' | 'network' | 'proxy_unavailable';
}

/** A complete desensitized billing scenario for one connection. */
export interface DesensitizedBillingScenario {
  readonly scenarioId: string;
  readonly connectionId: string;
  readonly modelKey: string;
  readonly tokenLogs: DesensitizedTransportOutcome;
  readonly siteStatus: DesensitizedTransportOutcome;
  readonly modelPricing: DesensitizedTransportOutcome;
}

export const DESENSITIZED_CONNECTION_ID = 'connection-station-a';

/**
 * The model key of the screenshot call. It is image-only on the station's
 * pricing list and never appears there under a video or pricing-exact key.
 */
export const DESENSITIZED_MODEL_KEY = 'image-model-x';

/** The upstream request identity the submit response did NOT carry back. */
export const DESENSITIZED_ABSENT_REQUEST_ID = 'req-not-captured';

/** What the invocation's usage observation actually recorded. */
export const DESENSITIZED_USAGE_OBSERVATION = {
  /** The station accepted the submit, but no response request id was captured. */
  status: 'not_reported',
  facts: [],
  providerRequestId: undefined,
  /** One local image result was validated and registered. */
  localResultCount: 1
} as const;

/**
 * A well-formed station status body, so that the scenarios below isolate the
 * log and pricing failures instead of failing on the quota policy first.
 */
const siteStatusOkBody = {
  quota_per_unit: 500_000,
  quota_display_type: 'USD'
};

/** Station status returning HTTP 404 `model_not_found`. */
const siteStatusNotFound: DesensitizedTransportOutcome = {
  status: 404,
  body: { success: false, message: 'model_not_found' }
};

/** Station status refusing the request with HTTP 429. */
const siteStatusRateLimited: DesensitizedTransportOutcome = {
  status: 429,
  body: { success: false, message: 'rate_limited' }
};

const logsNotFound: DesensitizedTransportOutcome = {
  status: 404,
  body: { success: false, message: 'model_not_found' }
};

const logsRateLimited: DesensitizedTransportOutcome = {
  status: 429,
  body: { success: false, message: 'rate_limited' }
};

const logsTransportTimeout: DesensitizedTransportOutcome = {
  status: undefined,
  transportError: 'timeout'
};

const logsEmptyOk: DesensitizedTransportOutcome = {
  status: 200,
  body: { success: true, message: '', data: [] }
};

/**
 * Pricing response that is structurally valid but has no exact key for
 * {@link DESENSITIZED_MODEL_KEY}; the key must never be guessed from the name.
 */
const pricingWithoutModelKey: DesensitizedTransportOutcome = {
  status: 200,
  body: {
    success: true,
    group_ratio: { default: 1 },
    data: [{
      model_name: 'some-other-model',
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.0315,
      completion_ratio: 0
    }]
  }
};

const pricingOk: DesensitizedTransportOutcome = {
  status: 200,
  body: {
    success: true,
    group_ratio: { default: 1 },
    data: [{
      model_name: DESENSITIZED_MODEL_KEY,
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.0315,
      completion_ratio: 0
    }]
  }
};

/** Request id used by the control scenario, so a bill can be matched. */
export const DESENSITIZED_MATCHING_REQUEST_ID = 'req-station-a-0001';

/** A distinct safe request id used to prove a log row exists but cannot match. */
export const DESENSITIZED_MODULE_SAFE_REQUEST_ID = 'req-station-a-9999';

/**
 * The four failure facts that the task centre currently collapses into a single
 * "无法估算" label. Each scenario isolates exactly one missing fact.
 */
export const DESENSITIZED_BILLING_SCENARIOS: Readonly<Record<
  | 'request_id_unavailable'
  | 'logs_unavailable_404'
  | 'logs_rate_limited'
  | 'logs_transport_error'
  | 'usage_not_reported_pricing_missing'
  | 'pricing_endpoint_rate_limited'
  | 'pricing_payload_invalid'
  | 'logs_payload_invalid'
  | 'station_healthy_bill_present',
  DesensitizedBillingScenario
>> = {
  /**
   * The submit succeeded, but the response carried no request id, so the
   * station's own log rows cannot be correlated to this invocation at all.
   */
  request_id_unavailable: {
    scenarioId: 'request_id_unavailable',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: {
      status: 200,
      body: {
        success: true,
        data: [{
          request_id: DESENSITIZED_MODULE_SAFE_REQUEST_ID,
          quota: 1_550,
          type: 2,
          created_at: 1,
          model_name: DESENSITIZED_MODEL_KEY
        }]
      }
    },
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingOk
  },
  /** The billing log endpoint answered HTTP 404 `model_not_found`. */
  logs_unavailable_404: {
    scenarioId: 'logs_unavailable_404',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: logsNotFound,
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingOk
  },
  /** The billing log endpoint answered HTTP 429 `rate_limited`. */
  logs_rate_limited: {
    scenarioId: 'logs_rate_limited',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: logsRateLimited,
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingOk
  },
  /** The billing log request never received a response. */
  logs_transport_error: {
    scenarioId: 'logs_transport_error',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: logsTransportTimeout,
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingOk
  },
  /**
   * Usage was never reported by the station and the pricing list has no exact
   * key for this model, so no estimate can be produced from station facts.
   */
  usage_not_reported_pricing_missing: {
    scenarioId: 'usage_not_reported_pricing_missing',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: logsEmptyOk,
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingWithoutModelKey
  },
  /**
   * The pricing endpoint itself was rate limited, so the model's price is
   * unknown for a completely different reason than an absent key.
   */
  pricing_endpoint_rate_limited: {
    scenarioId: 'pricing_endpoint_rate_limited',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: logsEmptyOk,
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: logsRateLimited
  },
  /**
   * HTTP 200 with a payload that is not a price list. A 200 alone must never be
   * treated as a successful price, and it must not silently look like "no price".
   */
  pricing_payload_invalid: {
    scenarioId: 'pricing_payload_invalid',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: logsEmptyOk,
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: { status: 200, body: { success: true, data: 'not-a-list' } }
  },
  /** HTTP 200 with an unusable billing-log payload. */
  logs_payload_invalid: {
    scenarioId: 'logs_payload_invalid',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: { status: 200, body: { success: true, data: 'not-a-list' } },
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingOk
  },
  /** Control scenario: the station answers everything and the bill is real. */
  station_healthy_bill_present: {
    scenarioId: 'station_healthy_bill_present',
    connectionId: DESENSITIZED_CONNECTION_ID,
    modelKey: DESENSITIZED_MODEL_KEY,
    tokenLogs: {
      status: 200,
      body: {
        success: true,
        data: [{
          request_id: DESENSITIZED_MATCHING_REQUEST_ID,
          quota: 1_550,
          type: 2,
          created_at: 1,
          model_name: DESENSITIZED_MODEL_KEY
        }]
      }
    },
    siteStatus: { status: 200, body: siteStatusOkBody },
    modelPricing: pricingOk
  }
};

/** Simultaneous site-status failures observed around the same call window. */
export const DESENSITIZED_SITE_STATUS_FAILURES = {
  not_found: siteStatusNotFound,
  rate_limited: siteStatusRateLimited
} as const;

/**
 * Turns one scenario into the exact error the real runtime would raise for that
 * HTTP outcome, so the platform's failure classifiers are exercised for real.
 */
function transportErrorFor(outcome: DesensitizedTransportOutcome): Error {
  if (outcome.status === undefined) {
    return new NewApiTransportFailure(outcome.transportError ?? 'network');
  }
  if (outcome.status === 404 || outcome.status === 410) {
    return new NewApiRuntimeError('model_not_found', 'not_retryable');
  }
  if (outcome.status === 429) {
    return new NewApiRuntimeError('rate_limited', 'retryable');
  }
  if (outcome.status >= 500) {
    return new NewApiRuntimeError('provider_unavailable', 'retryable');
  }
  return new NewApiRuntimeError('invalid_response', 'not_retryable');
}

/**
 * Builds the read-only NewAPI billing adapter over one desensitized scenario.
 *
 * The credential record contains a placeholder value only; no real credential is
 * read, and the mocked runtime never opens a socket.
 */
export function createDesensitizedReconciler(
  scenario: DesensitizedBillingScenario
): NewApiBillingReconciler {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const respond = (outcome: DesensitizedTransportOutcome): Uint8Array => {
    if (outcome.status === undefined || outcome.status >= 400) {
      throw transportErrorFor(outcome);
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
          values: { api_key: 'placeholder-not-a-credential' }
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
