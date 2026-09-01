import { TextDecoder } from 'node:util';
import type { StructuredCredentialRecord } from '../../../domain';
import type { JsonProviderRegistryStore } from '../provider-registry';
import type { SecureCredentialVault } from '../credential-vault';
import type { NewApiSharedRuntime } from './newapi-runtime';

export const NEWAPI_LOG_TYPE_CONSUME = 2;
export const NEWAPI_LOG_TYPE_REFUND = 6;

export interface NewApiTokenLogRecord {
  readonly requestId?: string;
  readonly taskId?: string;
  readonly quota: bigint;
  readonly consumedQuota?: bigint;
  readonly refundedQuota?: bigint;
  readonly type: number;
  readonly createdAt: number;
  readonly modelName?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly amountCny?: string;
  readonly refundAmountCny?: string;
  readonly amountSource?: string;
}

export interface NewApiBillingReconciliationPort {
  reconcile(input: {
    readonly connectionId: string;
  }): Promise<ReadonlyMap<string, NewApiTokenLogRecord>>;
  estimate(input: {
    readonly connectionId: string;
    readonly modelName: string;
    readonly promptTokens?: string;
    readonly completionTokens?: string;
    readonly billableUnits?: string;
  }): Promise<{ readonly amountCny: string; readonly source: string } | undefined>;
  invalidate(): void;
}

/** Read-only NewAPI billing adapter. It never submits a model request. */
export class NewApiBillingReconciler implements NewApiBillingReconciliationPort {
  private readonly cache = new Map<string, Promise<NewApiBillingContext>>();
  // Keep the last valid log snapshot across refreshes. A transient 429 or
  // transport failure must not turn previously reconciled charges into zero.
  private readonly successfulLogRows = new Map<
    string,
    ReadonlyMap<string, NewApiTokenLogRecord>
  >();

  constructor(
    private readonly registry: JsonProviderRegistryStore,
    private readonly credentials: SecureCredentialVault,
    private readonly runtime: NewApiSharedRuntime
  ) {}

  reconcile(input: { readonly connectionId: string }): Promise<ReadonlyMap<string, NewApiTokenLogRecord>> {
    return this.context(input.connectionId).then((value) => value.logs);
  }

  async estimate(input: {
    readonly connectionId: string;
    readonly modelName: string;
    readonly promptTokens?: string;
    readonly completionTokens?: string;
    readonly billableUnits?: string;
  }): Promise<{ readonly amountCny: string; readonly source: string } | undefined> {
    const context = await this.context(input.connectionId);
    const pricing = context.pricing.get(input.modelName);
    if (!pricing) return undefined;
    const quota = pricing.quotaType === 1
      ? multiply(
          pricing.modelPrice,
          exactDecimal(input.billableUnits ?? '1'),
          context.policy.quotaPerUnit,
          pricing.groupRatio
        )
      : input.promptTokens !== undefined && input.completionTokens !== undefined
        ? multiply(
            add(
              exactDecimal(input.promptTokens),
              multiply(exactDecimal(input.completionTokens), pricing.completionRatio)
            ),
            pricing.modelRatio,
            pricing.groupRatio
          )
        : undefined;
    if (!quota) return undefined;
    return {
      amountCny: formatDecimal(divide(multiply(quota, context.policy.cnyMultiplier), context.policy.quotaPerUnit)),
      source: '当前中转站模型广场价格快照'
    };
  }

  invalidate(): void {
    this.cache.clear();
  }

  private context(connectionId: string): Promise<NewApiBillingContext> {
    const cached = this.cache.get(connectionId);
    if (cached) return cached;
    const pending = this.load(connectionId).catch((error) => {
      this.cache.delete(connectionId);
      throw error;
    });
    this.cache.set(connectionId, pending);
    return pending;
  }

  private async load(connectionId: string): Promise<NewApiBillingContext> {
    const snapshot = await this.registry.load();
    const connection = snapshot.connections.find((item) => item.id === connectionId);
    if (!connection?.credentialReference) throw new TypeError('NewAPI credential is unavailable');
    const result = await this.credentials.useRecord(
      connection.credentialReference,
      async (record: StructuredCredentialRecord) => {
        const [logs, status, pricing] = await Promise.all([
          this.runtime.requestTokenLogs({ connection, credentials: record }).catch(() => undefined),
          this.runtime.requestSiteStatus({ connection, credentials: record }),
          this.runtime.requestModelPricing({ connection, credentials: record }).catch(() => undefined)
        ]);
        let parsedPricing: ReadonlyMap<string, NewApiModelPricing> = new Map();
        if (pricing) {
          try {
            parsedPricing = parseNewApiModelPricing(pricing);
          } catch {
            // A malformed or legacy pricing response must not hide actual quota logs.
          }
        }
        let parsedLogs = groupTokenLogs(
          [...(this.successfulLogRows.get(connectionId)?.values() ?? [])],
          parseNewApiBillingPolicy(status)
        );
        if (logs !== undefined) {
          try {
            const rows = mergeTokenLogRows(
              this.successfulLogRows.get(connectionId) ?? new Map(),
              parseNewApiTokenLogs(logs)
            );
            this.successfulLogRows.set(connectionId, rows);
            parsedLogs = groupTokenLogs([...rows.values()], parseNewApiBillingPolicy(status));
          } catch {
            // Keep the last valid snapshot when a response is malformed.
          }
        }
        return {
          logs: parsedLogs,
          policy: parseNewApiBillingPolicy(status),
          pricing: parsedPricing
        };
      }
    );
    return result;
  }
}

function mergeTokenLogRows(
  previous: ReadonlyMap<string, NewApiTokenLogRecord>,
  current: readonly NewApiTokenLogRecord[]
): ReadonlyMap<string, NewApiTokenLogRecord> {
  const merged = new Map(previous);
  for (const log of current) merged.set(tokenLogRowKey(log), log);
  return merged;
}

function tokenLogRowKey(log: NewApiTokenLogRecord): string {
  return `${log.requestId ?? ''}\u0000${log.taskId ?? ''}\u0000${log.createdAt}\u0000${log.type}\u0000${log.quota}`;
}

function groupTokenLogs(
  logs: readonly NewApiTokenLogRecord[],
  policy: NewApiBillingPolicy
): ReadonlyMap<string, NewApiTokenLogRecord> {
  const grouped = new Map<string, NewApiTokenLogRecord>();
  for (const log of logs) {
    if (log.type !== NEWAPI_LOG_TYPE_CONSUME && log.type !== NEWAPI_LOG_TYPE_REFUND) continue;
    const keys = [
      ...(log.requestId ? [log.requestId] : []),
      ...(log.taskId ? [`task:${log.taskId}`] : [])
    ];
    for (const key of keys) {
      const previous = grouped.get(key);
      const consumedQuota = (previous?.consumedQuota ?? 0n) +
        (log.type === NEWAPI_LOG_TYPE_CONSUME ? log.quota : 0n);
      const refundedQuota = (previous?.refundedQuota ?? 0n) +
        (log.type === NEWAPI_LOG_TYPE_REFUND ? absoluteBigInt(log.quota) : 0n);
      grouped.set(key, withAmount({
        ...log,
        requestId: previous?.requestId ?? log.requestId,
        taskId: previous?.taskId ?? log.taskId,
        quota: consumedQuota - refundedQuota,
        consumedQuota,
        refundedQuota,
        type: refundedQuota > 0n ? NEWAPI_LOG_TYPE_REFUND : NEWAPI_LOG_TYPE_CONSUME,
        createdAt: Math.max(previous?.createdAt ?? 0, log.createdAt)
      }, policy));
    }
  }
  return grouped;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

interface NewApiBillingContext {
  readonly logs: ReadonlyMap<string, NewApiTokenLogRecord>;
  readonly policy: NewApiBillingPolicy;
  readonly pricing: ReadonlyMap<string, NewApiModelPricing>;
}

interface NewApiModelPricing {
  readonly quotaType: 0 | 1;
  readonly modelRatio: ExactDecimal;
  readonly modelPrice: ExactDecimal;
  readonly completionRatio: ExactDecimal;
  readonly groupRatio: ExactDecimal;
}

interface NewApiBillingPolicy {
  readonly quotaPerUnit: ExactDecimal;
  readonly cnyMultiplier: ExactDecimal;
  readonly source: string;
}

interface ExactDecimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function parseNewApiBillingPolicy(body: Uint8Array | string): NewApiBillingPolicy {
  const parsed = typeof body === 'string'
    ? JSON.parse(body) as unknown
    : JSON.parse(new TextDecoder().decode(body)) as unknown;
  const value = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
  if (!isRecord(value)) throw new TypeError('NewAPI status response is invalid');
  const quotaPerUnit = exactDecimal(value.quota_per_unit);
  if (quotaPerUnit.numerator <= 0n) throw new TypeError('NewAPI quota unit is invalid');
  const displayType = typeof value.quota_display_type === 'string'
    ? value.quota_display_type.trim().toUpperCase()
    : '';
  if (displayType === 'TOKENS') throw new TypeError('Token display cannot be converted to RMB');
  const cnyMultiplier = displayType === 'CNY'
    ? exactDecimal(value.usd_exchange_rate)
    : displayType === 'CUSTOM'
      ? exactDecimal(value.custom_currency_exchange_rate)
      : { numerator: 1n, denominator: 1n };
  if (cnyMultiplier.numerator <= 0n) throw new TypeError('NewAPI RMB multiplier is invalid');
  return {
    quotaPerUnit,
    cnyMultiplier,
    source: displayType === 'CNY'
      ? 'NewAPI 站点 CNY 配置'
      : 'NewAPI 站点显示单位按人民币 1:1 结算'
  };
}

export function parseNewApiModelPricing(
  body: Uint8Array | string
): ReadonlyMap<string, NewApiModelPricing> {
  const parsed = typeof body === 'string'
    ? JSON.parse(body) as unknown
    : JSON.parse(new TextDecoder().decode(body)) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.success === false ||
    !Array.isArray(parsed.data)
  ) {
    throw new TypeError('NewAPI pricing response is invalid');
  }
  const groupRatios = isRecord(parsed.group_ratio) ? parsed.group_ratio : {};
  const defaultGroupRatio = groupRatios.default === undefined
    ? { numerator: 1n, denominator: 1n }
    : exactDecimal(groupRatios.default);
  const prices = new Map<string, NewApiModelPricing>();
  for (const value of parsed.data) {
    if (!isRecord(value) || typeof value.model_name !== 'string' || !value.model_name.trim()) {
      throw new TypeError('NewAPI pricing item is invalid');
    }
    if (value.quota_type !== 0 && value.quota_type !== 1) {
      throw new TypeError('NewAPI pricing quota type is invalid');
    }
    prices.set(value.model_name.trim(), {
      quotaType: value.quota_type,
      modelRatio: exactDecimal(value.model_ratio ?? 0),
      modelPrice: exactDecimal(value.model_price ?? 0),
      completionRatio: exactDecimal(value.completion_ratio ?? 1),
      groupRatio: defaultGroupRatio
    });
  }
  return prices;
}

function withAmount(
  log: NewApiTokenLogRecord,
  policy: NewApiBillingPolicy
): NewApiTokenLogRecord {
  return {
    ...log,
    amountCny: formatDecimal({
      numerator: log.quota * policy.cnyMultiplier.numerator * policy.quotaPerUnit.denominator,
      denominator: policy.cnyMultiplier.denominator * policy.quotaPerUnit.numerator
    }),
    ...(log.refundedQuota && log.refundedQuota > 0n
      ? {
          refundAmountCny: formatDecimal({
            numerator: log.refundedQuota * policy.cnyMultiplier.numerator * policy.quotaPerUnit.denominator,
            denominator: policy.cnyMultiplier.denominator * policy.quotaPerUnit.numerator
          })
        }
      : {}),
    amountSource: policy.source
  };
}

function exactDecimal(value: unknown): ExactDecimal {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/u.test(text)) {
    throw new TypeError('NewAPI billing decimal is invalid');
  }
  const [whole, fraction = ''] = text.split('.');
  return {
    numerator: BigInt(`${whole}${fraction}`),
    denominator: 10n ** BigInt(fraction.length)
  };
}

function add(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return {
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  };
}

function multiply(...values: readonly ExactDecimal[]): ExactDecimal {
  return values.reduce<ExactDecimal>((result, value) => ({
    numerator: result.numerator * value.numerator,
    denominator: result.denominator * value.denominator
  }), { numerator: 1n, denominator: 1n });
}

function divide(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  if (right.numerator === 0n) throw new TypeError('NewAPI billing divisor is zero');
  return {
    numerator: left.numerator * right.denominator,
    denominator: left.denominator * right.numerator
  };
}

function formatDecimal(value: ExactDecimal): string {
  const negative = value.numerator < 0n;
  const absolute = negative ? -value.numerator : value.numerator;
  const precision = 12n;
  const scale = 10n ** precision;
  let scaled = absolute * scale / value.denominator;
  const remainder = absolute * scale % value.denominator;
  if (remainder * 2n >= value.denominator) scaled += 1n;
  const integer = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(Number(precision), '0').replace(/0+$/u, '');
  const output = fraction ? `${integer}.${fraction}` : integer.toString();
  return negative && scaled !== 0n ? `-${output}` : output;
}

export function parseNewApiTokenLogs(
  body: Uint8Array | string
): readonly NewApiTokenLogRecord[] {
  const value = typeof body === 'string'
    ? JSON.parse(body) as unknown
    : JSON.parse(new TextDecoder().decode(body)) as unknown;
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.data)) {
    throw new TypeError('NewAPI token log response is invalid');
  }
  return value.data.flatMap((item) => {
    try {
      const parsed = parseLogRecord(item);
      return [parsed];
    } catch {
      // One legacy/malformed row must not hide valid consume/refund rows.
      return [];
    }
  });
}

function parseLogRecord(value: unknown): NewApiTokenLogRecord {
  if (!isRecord(value)) throw new TypeError('NewAPI token log item is invalid');
  const quota = parseInteger(value.quota, 'quota');
  const type = parseSafeInteger(value.type, 'type');
  const createdAt = parseSafeInteger(value.created_at, 'created_at');
  const requestId = optionalLogId(value.request_id, 128);
  const taskId = parseTaskId(value.other);
  if (!requestId && !(type === NEWAPI_LOG_TYPE_REFUND && taskId)) {
    throw new TypeError('NewAPI token log identity is invalid');
  }
  if (createdAt < 0) throw new TypeError('NewAPI token log timestamp is invalid');
  return {
    ...(requestId ? { requestId: requestId.toLowerCase() } : {}),
    ...(taskId ? { taskId } : {}),
    quota,
    type,
    createdAt,
    ...(typeof value.model_name === 'string' && value.model_name.trim()
      ? { modelName: value.model_name.trim() }
      : {}),
    ...(optionalNonNegativeInteger(value.prompt_tokens) === undefined
      ? {}
      : { promptTokens: optionalNonNegativeInteger(value.prompt_tokens) }),
    ...(optionalNonNegativeInteger(value.completion_tokens) === undefined
      ? {}
      : { completionTokens: optionalNonNegativeInteger(value.completion_tokens) })
  };
}

function parseTaskId(value: unknown): string | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;
  return optionalLogId(parsed.task_id, 192);
}

function optionalLogId(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim();
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maximumLength - 1}}$`, 'u').test(normalized)
    ? normalized
    : undefined;
}

function parseInteger(value: unknown, label: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`Invalid ${label}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/u.test(value)) return BigInt(value);
  throw new TypeError(`Invalid ${label}`);
}

function parseSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Invalid ${label}`);
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
