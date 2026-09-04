import { describe, expect, it } from 'vitest';
import {
  NEWAPI_LOG_TYPE_CONSUME,
  NEWAPI_LOG_TYPE_REFUND,
  NewApiBillingReconciler,
  parseNewApiBillingPolicy,
  parseNewApiModelPricing,
  parseNewApiTokenLogs
} from '../../src/platform/providers/newapi/newapi-billing';

describe('NewAPI billing log parser', () => {
  it('parses consume and refund records without losing signed quota', () => {
    const records = parseNewApiTokenLogs(JSON.stringify({
      success: true,
      message: '',
      data: [
        {
          request_id: 'req-abc-1',
          quota: 1550,
          type: NEWAPI_LOG_TYPE_CONSUME,
          created_at: 1730000000,
          model_name: 'gpt-4o'
        },
        {
          request_id: 'req-abc-1',
          quota: -1550,
          type: NEWAPI_LOG_TYPE_REFUND,
          created_at: 1730000010
        }
      ]
    }));
    expect(records).toHaveLength(2);
    expect(records[0]?.quota).toBe(1550n);
    expect(records[1]?.quota).toBe(-1550n);
  });

  it('ignores malformed rows while retaining valid billing records', () => {
    expect(parseNewApiTokenLogs(JSON.stringify({
      success: true,
      data: [
        { request_id: 'bad id', quota: 1, type: 2, created_at: 1 },
        { request_id: 'req-valid-1', quota: 12, type: 2, created_at: 2 },
        { request_id: 'req-valid-2', quota: '1.5', type: 2, created_at: 3 }
      ]
    }))).toMatchObject([
      { requestId: 'req-valid-1', quota: 12n }
    ]);
  });

  it('accepts a task refund without request_id and keeps its remote task identity', () => {
    expect(parseNewApiTokenLogs(JSON.stringify({
      success: true,
      data: [{
        request_id: '',
        quota: 741620,
        type: NEWAPI_LOG_TYPE_REFUND,
        created_at: 2,
        other: JSON.stringify({ task_id: 'task_remote_video_1' })
      }]
    }))).toMatchObject([{
      taskId: 'task_remote_video_1',
      quota: 741620n,
      type: NEWAPI_LOG_TYPE_REFUND
    }]);
  });

  it('derives quota units from the station status instead of hardcoding them', () => {
    expect(parseNewApiBillingPolicy(JSON.stringify({
      quota_per_unit: 500000,
      quota_display_type: 'USD',
      usd_exchange_rate: 7.3
    }))).toMatchObject({
      quotaPerUnit: { numerator: 500000n, denominator: 1n },
      cnyMultiplier: { numerator: 1n, denominator: 1n }
    });
    expect(parseNewApiBillingPolicy(JSON.stringify({
      quota_per_unit: 500000,
      quota_display_type: 'CNY',
      usd_exchange_rate: 7.3
    }))).toMatchObject({
      cnyMultiplier: { numerator: 73n, denominator: 10n }
    });
    expect(() => parseNewApiBillingPolicy(JSON.stringify({
      quota_per_unit: 500000,
      quota_display_type: 'TOKENS'
    }))).toThrow();
  });

  it('accepts the native NewAPI pricing response without a success field', () => {
    expect(parseNewApiModelPricing(JSON.stringify({
      auto_groups: ['default'],
      data: [{
        model_name: 'viduq3-turbo',
        quota_type: 1,
        model_ratio: 0,
        model_price: 0.1875,
        completion_ratio: 0
      }]
    }))).toHaveProperty('size', 1);
  });

  it('prefers request quota and estimates from the same station pricing snapshot', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const reconciler = new NewApiBillingReconciler(
      {
        async load() {
          return { connections: [{ id: 'connection-1', credentialReference: 'credential-1' }] };
        }
      } as never,
      {
        async useRecord(_reference: string, operation: (record: unknown) => Promise<unknown>) {
          return operation({ schemaId: 'openai-compatible.api-key', schemaVersion: 1, values: { api_key: 'secret' } });
        }
      } as never,
      {
        async requestTokenLogs() {
          return encode({
            success: true,
            data: [{ request_id: 'req-actual-1', quota: 1550, type: 2, created_at: 1 }]
          });
        },
        async requestSiteStatus() {
          return encode({ quota_per_unit: 500000, quota_display_type: 'USD' });
        },
        async requestModelPricing() {
          return encode({
            success: true,
            group_ratio: { default: 1 },
            data: [{
              model_name: 'model-a', quota_type: 0, model_ratio: 1,
              model_price: 0, completion_ratio: 2
            }]
          });
        }
      } as never
    );
    expect((await reconciler.reconcile({ connectionId: 'connection-1' })).get('req-actual-1'))
      .toMatchObject({ amountCny: '0.0031' });
    await expect(reconciler.estimate({
      connectionId: 'connection-1',
      modelName: 'model-a',
      promptTokens: '100',
      completionTokens: '50'
    })).resolves.toEqual({
      amountCny: '0.0004',
      source: '当前中转站模型广场价格快照'
    });
  });

  it('estimates quota-type unit models without token usage', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const reconciler = new NewApiBillingReconciler(
      {
        async load() {
          return { connections: [{ id: 'connection-1', credentialReference: 'credential-1' }] };
        }
      } as never,
      {
        async useRecord(_reference: string, operation: (record: unknown) => Promise<unknown>) {
          return operation({ schemaId: 'openai-compatible.api-key', schemaVersion: 1, values: { api_key: 'secret' } });
        }
      } as never,
      {
        async requestTokenLogs() {
          return encode({ success: true, data: [] });
        },
        async requestSiteStatus() {
          return encode({ quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7.3 });
        },
        async requestModelPricing() {
          return encode({
            success: true,
            group_ratio: { default: 1 },
            data: [{
              model_name: 'image-model', quota_type: 1, model_ratio: 0,
              model_price: 0.0315, completion_ratio: 0
            }]
          });
        }
      } as never
    );
    await expect(reconciler.estimate({
      connectionId: 'connection-1',
      modelName: 'image-model',
      billableUnits: '2'
    })).resolves.toMatchObject({ amountCny: '0.4599' });
  });

  it('retains the last valid log snapshot when a refresh is rate limited', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    let failLogs = false;
    const reconciler = new NewApiBillingReconciler(
      {
        async load() {
          return { connections: [{ id: 'connection-1', credentialReference: 'credential-1' }] };
        }
      } as never,
      {
        async useRecord(_reference: string, operation: (record: unknown) => Promise<unknown>) {
          return operation({ schemaId: 'openai-compatible.api-key', schemaVersion: 1, values: { api_key: 'secret' } });
        }
      } as never,
      {
        async requestTokenLogs() {
          if (failLogs) throw new Error('429');
          return encode({ success: true, data: [{ request_id: 'req-stable', quota: 1550, type: 2, created_at: 1 }] });
        },
        async requestSiteStatus() {
          return encode({ quota_per_unit: 500000, quota_display_type: 'USD' });
        },
        async requestModelPricing() {
          return encode({ success: true, data: [] });
        }
      } as never
    );
    await expect(reconciler.reconcile({ connectionId: 'connection-1' })).resolves.toHaveProperty('size', 1);
    failLogs = true;
    reconciler.invalidate();
    await expect(reconciler.reconcile({ connectionId: 'connection-1' })).resolves.toMatchObject({
      get: expect.any(Function)
    });
    expect((await reconciler.reconcile({ connectionId: 'connection-1' })).get('req-stable'))
      .toMatchObject({ amountCny: '0.0031' });
  });

  it('merges recent-log windows so a newer image does not evict an older video charge', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    let window = [{ request_id: 'req-video', quota: 500000, type: 2, created_at: 1 }];
    const reconciler = new NewApiBillingReconciler(
      {
        async load() {
          return { connections: [{ id: 'connection-1', credentialReference: 'credential-1' }] };
        }
      } as never,
      {
        async useRecord(_reference: string, operation: (record: unknown) => Promise<unknown>) {
          return operation({ schemaId: 'openai-compatible.api-key', schemaVersion: 1, values: { api_key: 'secret' } });
        }
      } as never,
      {
        async requestTokenLogs() {
          return encode({ success: true, data: window });
        },
        async requestSiteStatus() {
          return encode({ quota_per_unit: 500000, quota_display_type: 'USD' });
        },
        async requestModelPricing() {
          return encode({ success: true, data: [] });
        }
      } as never
    );
    await expect(reconciler.reconcile({ connectionId: 'connection-1' })).resolves.toHaveProperty('size', 1);
    window = [{ request_id: 'req-image', quota: 250000, type: 2, created_at: 2 }];
    reconciler.invalidate();
    const logs = await reconciler.reconcile({ connectionId: 'connection-1' });
    expect(logs.get('req-video')).toMatchObject({ amountCny: '1' });
    expect(logs.get('req-image')).toMatchObject({ amountCny: '0.5' });
  });

  it('keeps consume and refund rows when they arrive in different recent-log windows', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    let window = [{ request_id: 'req-refunded', quota: 500000, type: 2, created_at: 1 }];
    const reconciler = new NewApiBillingReconciler(
      {
        async load() {
          return { connections: [{ id: 'connection-1', credentialReference: 'credential-1' }] };
        }
      } as never,
      {
        async useRecord(_reference: string, operation: (record: unknown) => Promise<unknown>) {
          return operation({ schemaId: 'openai-compatible.api-key', schemaVersion: 1, values: { api_key: 'secret' } });
        }
      } as never,
      {
        async requestTokenLogs() {
          return encode({ success: true, data: window });
        },
        async requestSiteStatus() {
          return encode({ quota_per_unit: 500000, quota_display_type: 'USD' });
        },
        async requestModelPricing() {
          return encode({ success: true, data: [] });
        }
      } as never
    );
    await reconciler.reconcile({ connectionId: 'connection-1' });
    window = [{ request_id: 'req-refunded', quota: -500000, type: 6, created_at: 2 }];
    reconciler.invalidate();
    expect((await reconciler.reconcile({ connectionId: 'connection-1' })).get('req-refunded'))
      .toMatchObject({ quota: 0n, type: 6, amountCny: '0' });
  });

  it('indexes an async refund by other.task_id when the refund has no request_id', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    let window: Array<Record<string, unknown>> = [{
      request_id: 'req-video-consume', quota: 6_570_000, type: 2, created_at: 1
    }];
    const reconciler = new NewApiBillingReconciler(
      {
        async load() {
          return { connections: [{ id: 'connection-1', credentialReference: 'credential-1' }] };
        }
      } as never,
      {
        async useRecord(_reference: string, operation: (record: unknown) => Promise<unknown>) {
          return operation({ schemaId: 'openai-compatible.api-key', schemaVersion: 1, values: { api_key: 'secret' } });
        }
      } as never,
      {
        async requestTokenLogs() {
          return encode({ success: true, data: window });
        },
        async requestSiteStatus() {
          return encode({ quota_per_unit: 500000, quota_display_type: 'USD' });
        },
        async requestModelPricing() {
          return encode({ success: true, data: [] });
        }
      } as never
    );
    await reconciler.reconcile({ connectionId: 'connection-1' });
    window = [{
      request_id: '', quota: 3_708_100, type: 6, created_at: 2,
      other: JSON.stringify({ task_id: 'task_remote_video_1' })
    }];
    reconciler.invalidate();
    const logs = await reconciler.reconcile({ connectionId: 'connection-1' });
    expect(logs.get('req-video-consume')).toMatchObject({ amountCny: '13.14' });
    expect(logs.get('task:task_remote_video_1')).toMatchObject({
      refundedQuota: 3_708_100n,
      refundAmountCny: '7.4162'
    });
  });
});
