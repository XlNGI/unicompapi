import type {
  StorageCallBillingDto,
  StorageCallBillingReasonCode,
  StorageCallOfficialPricingRuleDto
} from '../../shared/storage-ipc';

/**
 * Single owner for "why is there no amount?".
 *
 * The task centre may only ever show a fixed sentence chosen from the bounded
 * reason vocabulary, so this module is the one place that decides which reason
 * applies. Keeping it separate from the read-model controller makes the
 * precedence rules directly testable without standing up a project fixture.
 */

/** Attaches a bounded explanation without disturbing the money-bearing states. */
export function withReasonCode(
  billing: StorageCallBillingDto,
  reasonCode: StorageCallBillingReasonCode | undefined
): StorageCallBillingDto {
  if (!reasonCode || billing.amount !== undefined) return billing;
  return { ...billing, reasonCode };
}

/**
 * Picks the single most actionable reason the amount is unknown.
 *
 * Precedence follows the debugging order an operator would take: a fact that
 * blocks every later step (no correlation id, an unreachable log endpoint) wins
 * over a fact that only blocks the fallback estimate.
 */
export function explainMissingBilling(input: {
  readonly diagnosed: readonly StorageCallBillingReasonCode[];
  readonly providerRequestId: string | undefined;
  readonly providerOperationId: string | undefined;
  readonly usageFacts: readonly { readonly metricId: string; readonly quantity: string }[];
  readonly pricingRule: StorageCallOfficialPricingRuleDto | undefined;
}): StorageCallBillingReasonCode | undefined {
  if (!input.providerRequestId && !input.providerOperationId) {
    // Nothing can ever be correlated with the station's bill for this call.
    return 'request_id_unavailable';
  }
  if (input.diagnosed.length > 0) return input.diagnosed[0];
  if (input.usageFacts.length === 0) return 'usage_not_reported';
  if (input.pricingRule?.currencyCode.trim().toUpperCase() !== 'CNY') {
    return 'official_rule_missing';
  }
  return undefined;
}
