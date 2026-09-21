import { describe, expect, it, vi } from 'vitest';
import { CallBillingCache } from '../../src/platform/ipc/call-billing-cache';

describe('call billing refresh policy', () => {
  it('reuses settled records, deduplicates in-flight reads, and updates changed facts', async () => {
    const cache = new CallBillingCache();
    const read = vi.fn(async () => ({ state: 'actual_bill' as const, currencyCode: 'CNY' as const, amount: '2' }));
    const values = await Promise.all([cache.read('call', 'facts1', 0, read), cache.read('call', 'facts1', 0, read)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(values[0]).toEqual(values[1]);
    await cache.read('call', 'facts1', 999999, read);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.read('call', 'facts2', 999999, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rechecks pending bills only at three bounded deadlines; settlement cancels retry', async () => {
    const cache = new CallBillingCache();
    const read = vi.fn(async () => ({ state: 'pending_reconciliation' as const, currencyCode: 'CNY' as const }));
    await cache.read('call', 'facts', 0, read);
    expect(cache.nextRefreshAt()).toBe(5000);
    await cache.read('call', 'facts', 4999, read);
    expect(read).toHaveBeenCalledTimes(1);
    for (const now of [5000, 35000, 155000]) await cache.read('call', 'facts', now, read);
    expect(read).toHaveBeenCalledTimes(4);
    expect(cache.nextRefreshAt()).toBeUndefined();
    await cache.read('call', 'facts', 999999, read);
    expect(read).toHaveBeenCalledTimes(4);
    cache.clear();
    await cache.read('call', 'facts', 0, read);
    await cache.read('call', 'facts', 5000, async () => ({ state: 'actual_bill', currencyCode: 'CNY', amount: '1.5' }));
    expect(cache.nextRefreshAt()).toBeUndefined();
  });

  it('rechecks estimates but does not repeatedly query unsupported protocols', async () => {
    const cache = new CallBillingCache();
    await cache.read('estimate', 'facts', 0, async () => ({ state: 'estimated_station_price', currencyCode: 'CNY', amount: '1' }));
    expect(cache.nextRefreshAt()).toBe(5000);
    cache.clear();
    await cache.read('unsupported', 'facts', 0, async () => ({ state: 'unestimated', currencyCode: 'CNY', reasonCode: 'station_protocol_unsupported' }));
    expect(cache.nextRefreshAt()).toBeUndefined();
  });
});
