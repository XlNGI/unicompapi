import { describe, expect, it } from 'vitest';
import {
  explainMissingBilling,
  withReasonCode
} from '../../src/platform/ipc/call-billing-explanation';
import { formatCallBilling } from '../../src/pages/tasks/call-fees';
import {
  storageCallBillingReasonCodes,
  type StorageCallBillingDto,
  type StorageCallBillingReasonCode,
  type StorageCallOfficialPricingRuleDto
} from '../../src/shared/storage-ipc';

/**
 * P2 evidence suite for explainable billing states.
 *
 * Covers the two halves of the contract: which bounded reason wins when several
 * facts are missing, and how that reason is rendered in the task centre without
 * leaking any upstream detail.
 */

const cnyRule = {
  strategy: 'image_count',
  currencyCode: 'CNY',
  sourceTitle: '来源',
  sourceUrl: 'https://example.invalid/pricing',
  sourceCheckedAt: '2026-09-18T00:00:00.000Z',
  rates: [{ metricId: 'image_count', amount: '0.03', unit: 'image' }]
} as unknown as StorageCallOfficialPricingRuleDto;

const usdRule = { ...cnyRule, currencyCode: 'USD' } as StorageCallOfficialPricingRuleDto;

describe('P2 billing explanation precedence', () => {
  it('blames the missing correlation id before anything downstream', () => {
    // No request id and no operation id: nothing can ever be matched, so the
    // station-side symptoms below are consequences, not the root cause.
    expect(explainMissingBilling({
      diagnosed: ['logs_unavailable_404', 'pricing_model_missing'],
      providerRequestId: undefined,
      providerOperationId: undefined,
      usageFacts: [],
      pricingRule: usdRule
    })).toBe('request_id_unavailable');
  });

  it('prefers the station diagnosis once a correlation id exists', () => {
    expect(explainMissingBilling({
      diagnosed: ['logs_rate_limited'],
      providerRequestId: 'req-station-a-0001',
      providerOperationId: undefined,
      usageFacts: [],
      pricingRule: cnyRule
    })).toBe('logs_rate_limited');
  });

  it('falls back to the usage, then the official rule, then silence', () => {
    expect(explainMissingBilling({
      diagnosed: [],
      providerRequestId: 'req-station-a-0001',
      providerOperationId: undefined,
      usageFacts: [],
      pricingRule: cnyRule
    })).toBe('usage_not_reported');

    expect(explainMissingBilling({
      diagnosed: [],
      providerRequestId: 'req-station-a-0001',
      providerOperationId: undefined,
      usageFacts: [{ metricId: 'image_count', quantity: '1' }],
      pricingRule: usdRule
    })).toBe('official_rule_missing');

    expect(explainMissingBilling({
      diagnosed: [],
      providerRequestId: 'req-station-a-0001',
      providerOperationId: undefined,
      usageFacts: [{ metricId: 'image_count', quantity: '1' }],
      pricingRule: cnyRule
    })).toBeUndefined();
  });

  it('treats an operation id as a valid correlation handle for async calls', () => {
    expect(explainMissingBilling({
      diagnosed: [],
      providerRequestId: undefined,
      providerOperationId: 'operation-station-a-1',
      usageFacts: [{ metricId: 'video_seconds', quantity: '5' }],
      pricingRule: cnyRule
    })).toBeUndefined();
  });
});

describe('P2 billing reason attachment', () => {
  it('never overwrites a state that already carries an amount', () => {
    const billed: StorageCallBillingDto = {
      state: 'actual_bill',
      currencyCode: 'CNY',
      amount: '0.0315'
    };
    expect(withReasonCode(billed, 'logs_rate_limited')).toBe(billed);
  });

  it('adds the reason only when there is one', () => {
    const base: StorageCallBillingDto = { state: 'unestimated', currencyCode: 'CNY' };
    expect(withReasonCode(base, undefined)).toBe(base);
    expect(withReasonCode(base, 'pricing_model_missing')).toEqual({
      state: 'unestimated',
      currencyCode: 'CNY',
      reasonCode: 'pricing_model_missing'
    });
  });
});

describe('P2 task centre billing text', () => {
  it('shows the amount when the station reported one', () => {
    expect(formatCallBilling({
      state: 'actual_bill',
      currencyCode: 'CNY',
      amount: '0.0315'
    })).toBe('¥0.0315');
  });

  it('shows the state and the missing fact together', () => {
    expect(formatCallBilling({
      state: 'unestimated',
      currencyCode: 'CNY',
      reasonCode: 'request_id_unavailable'
    })).toBe('无法估算（缺少上游请求 ID，无法关联账单）');
    expect(formatCallBilling({
      state: 'pending_reconciliation',
      currencyCode: 'CNY',
      reasonCode: 'logs_rate_limited'
    })).toBe('等待中转站账单确认（中转站账单接口限流）');
    expect(formatCallBilling({
      state: 'unestimated',
      currencyCode: 'CNY',
      reasonCode: 'station_protocol_unsupported'
    })).toBe('无法估算（该连接未提供账单协议）');
  });

  it('keeps the previous label when no reason is attached', () => {
    expect(formatCallBilling({ state: 'unestimated', currencyCode: 'CNY' })).toBe('无法估算');
    expect(formatCallBilling(undefined)).toBeUndefined();
  });

  it('has a fixed sentence for every reason in the closed vocabulary', () => {
    const seen = new Set<string>();
    for (const reasonCode of storageCallBillingReasonCodes) {
      const text = formatCallBilling({
        state: 'unestimated',
        currencyCode: 'CNY',
        reasonCode: reasonCode as StorageCallBillingReasonCode
      });
      expect(text, reasonCode).toBeDefined();
      // Every code is explained, never rendered as its raw identifier.
      expect(text, reasonCode).not.toContain(reasonCode);
      expect(text, reasonCode).toContain('（');
      seen.add(text as string);
    }
    // One sentence per code: no two reasons share a message.
    expect(seen.size).toBe(storageCallBillingReasonCodes.length);
  });

  it('never exposes upstream URLs, bodies or credentials in the text', () => {
    for (const reasonCode of storageCallBillingReasonCodes) {
      const text = formatCallBilling({
        state: 'unestimated',
        currencyCode: 'CNY',
        reasonCode: reasonCode as StorageCallBillingReasonCode
      }) as string;
      expect(text, reasonCode).not.toMatch(/https?:|\/api\/|Bearer|sk-|Authorization|\/|\\/u);
    }
  });
});
