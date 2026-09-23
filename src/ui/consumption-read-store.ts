import { useSyncExternalStore } from 'react';
import type { StorageApi, StorageConsumptionSummaryDto } from '../shared/storage-ipc';

interface ConsumptionSnapshot {
  readonly summary?: StorageConsumptionSummaryDto;
  readonly message: string;
}

// One renderer-lifetime reader: leaving the page neither loses its result nor
// restarts the retry budget. Only consumption events and actual deadlines read.
export class ConsumptionReadStore {
  private snapshot: ConsumptionSnapshot = { message: '' };
  private readonly listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private revision = 0;
  private failures = 0;
  private disposed = false;

  constructor(private readonly storage: Pick<StorageApi, 'getConsumptionSummary' | 'onConsumptionChanged'>) {}

  getSnapshot = (): ConsumptionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.unsubscribe) {
      this.unsubscribe = this.storage.onConsumptionChanged(() => {
        this.revision++;
        this.failures = 0;
        this.schedule(150);
      });
      this.schedule(150);
    }
    return () => { this.listeners.delete(listener); };
  };

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.read(); }, delay);
  }

  private async read(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;
    const revision = this.revision;
    let retryAt: number | undefined;
    try {
      const result = await this.storage.getConsumptionSummary();
      if (revision !== this.revision || this.disposed) return;
      if (!result.ok) throw new Error('Consumption read failed');
      this.failures = 0;
      retryAt = result.value.nextBillingRefreshAt;
      this.snapshot = { summary: result.value, message: '' };
    } catch {
      if (revision !== this.revision || this.disposed) return;
      const delay = [5000, 30000, 120000][this.failures++];
      retryAt = delay === undefined ? undefined : Date.now() + delay;
      this.snapshot = { ...this.snapshot, message: '读取消费统计失败，请重试' };
    } finally {
      this.inFlight = false;
      if (!this.disposed) {
        if (revision !== this.revision) this.schedule(150);
        else {
          for (const listener of this.listeners) listener();
          // Shanghai midnight is a real change in the meaning of "today".
          const now = Date.now();
          const day = 86400000;
          const midnight = (Math.floor((now + 8 * 3600000) / day) + 1) * day - 8 * 3600000;
          this.schedule(Math.max(150, Math.min(retryAt ?? midnight, midnight) - now));
        }
      }
    }
  }
}

let currentStorage: StorageApi | undefined;
let store: ConsumptionReadStore | undefined;
const unavailable: ConsumptionSnapshot = { message: '当前运行环境未连接桌面调用记录能力' };
const emptySubscribe = () => () => {};
const unavailableSnapshot = () => unavailable;

export function useConsumptionReadStore(): ConsumptionSnapshot {
  const storage = window.unicomp?.storage;
  if (currentStorage !== storage) {
    store?.dispose();
    currentStorage = storage;
    store = storage ? new ConsumptionReadStore(storage) : undefined;
  }
  return useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? unavailableSnapshot);
}
