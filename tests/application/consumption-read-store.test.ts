import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageApi, StorageConsumptionSummaryDto } from '../../src/shared/storage-ipc';
import { ConsumptionReadStore } from '../../src/ui/consumption-read-store';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T04:00:00Z'));
  let notify = () => {};
  const value = { period: { endDate: '2026-09-21' }, totalAmount: '1' } as StorageConsumptionSummaryDto;
  const read = vi.fn().mockResolvedValue({ ok: true, value });
  const storage = { getConsumptionSummary: read, onConsumptionChanged: (listener: () => void) => {
    notify = listener;
    return () => { notify = () => {}; };
  } } as Pick<StorageApi, 'getConsumptionSummary' | 'onConsumptionChanged'>;
  const store = new ConsumptionReadStore(storage);
  return { store, read, value, notify: () => notify() };
}
describe('event driven consumption store', () => {
  it('keeps the same snapshot across navigation, ignores idle time, and observes changes while unmounted', async () => {
    const f = fixture();
    const stop = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(150);
    const cached = f.store.getSnapshot();
    stop();
    await vi.advanceTimersByTimeAsync(70000);
    const stopAgain = f.store.subscribe(() => {});
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.store.getSnapshot()).toBe(cached);
    stopAgain();
    f.read.mockResolvedValue({ ok: true, value: { ...f.value, totalAmount: '2' } });
    f.notify();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.store.getSnapshot().summary?.totalAmount).toBe('2');
    expect(f.read).toHaveBeenCalledTimes(2);
    f.store.dispose();
  });
  it('rejects obsolete responses and coalesces bursts into one subsequent read', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(150);
    for (let i = 0; i < 10; i++) f.notify();
    resolve({ ok: true, value: { ...f.value, totalAmount: '99' } });
    await vi.advanceTimersByTimeAsync(150);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.store.getSnapshot().summary?.totalAmount).toBe('1');
    f.store.dispose();
  });
  it('refreshes at the server billing deadline, then stops, and rolls the date at Shanghai midnight', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ ok: true, value: { ...f.value, nextBillingRefreshAt: Date.now() + 5000 } });
    f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(5150);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(70000);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12 * 3600000 - 75000);
    expect(f.read).toHaveBeenCalledTimes(3);
    f.store.dispose();
  });
  it('retains the last total on errors and bounds failure retries across remounts', async () => {
    const f = fixture();
    f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(150);
    f.read.mockResolvedValue({ ok: false });
    f.notify();
    await vi.advanceTimersByTimeAsync(200000);
    expect(f.read).toHaveBeenCalledTimes(5);
    expect(f.store.getSnapshot()).toMatchObject({ summary: { totalAmount: '1' }, message: '读取消费统计失败，请重试' });
    f.store.subscribe(() => {})();
    await vi.advanceTimersByTimeAsync(70000);
    expect(f.read).toHaveBeenCalledTimes(5);
    f.store.dispose();
  });
});
