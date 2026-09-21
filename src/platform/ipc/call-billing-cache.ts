import type { StorageCallBillingDto } from '../../shared/storage-ipc';

interface CachedBill {
  readonly signature: string;
  readonly result: Promise<StorageCallBillingDto>;
  attempts: number;
  nextRefreshAt?: number;
}

// Shared by summary and detail reads: navigation is never a billing retry.
export class CallBillingCache {
  private readonly records = new Map<string, CachedBill>();

  read(id: string, signature: string, now: number, load: () => Promise<StorageCallBillingDto>): Promise<StorageCallBillingDto> {
    const previous = this.records.get(id);
    if (previous?.signature === signature &&
      (previous.nextRefreshAt === undefined || previous.nextRefreshAt > now)) return previous.result;
    const attempts = previous?.signature === signature ? previous.attempts + 1 : 0;
    const entry: CachedBill = {
      signature, attempts,
      result: Promise.resolve().then(load).then(billing => {
        const retryable = billing.state === 'pending_reconciliation' ||
          billing.state === 'estimated_station_price' || billing.state === 'estimated_official_price' ||
          (billing.state === 'unestimated' && ['logs_transport_error', 'logs_rate_limited', 'usage_not_reported']
            .includes(billing.reasonCode ?? ''));
        const delay = [5000, 30000, 120000][attempts];
        if (retryable && delay !== undefined) entry.nextRefreshAt = now + delay;
        return billing;
      }).catch(error => {
        if (this.records.get(id) === entry) this.records.delete(id);
        throw error;
      })
    };
    this.records.set(id, entry);
    return entry.result;
  }

  nextRefreshAt(ids?: ReadonlySet<string>): number | undefined {
    const deadlines = [...this.records.entries()].filter(([id]) => !ids || ids.has(id)).flatMap(([, entry]) =>
      entry.nextRefreshAt === undefined ? [] : [entry.nextRefreshAt]);
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }

  clear(): void {
    this.records.clear();
  }
}
