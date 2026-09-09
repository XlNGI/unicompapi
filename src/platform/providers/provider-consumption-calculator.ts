import type {
  StorageCallDetailsDto,
  StorageCallOfficialPricingRuleDto,
  StorageCallPricingRateDto,
  StorageCallUsageFactDto
} from '../../shared/storage-ipc';

export interface ExactDecimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type ExactCallFeeCalculation =
  | {
      readonly state: 'calculated';
      readonly amount: ExactDecimal;
      readonly currencyCode: string;
    }
  | {
      readonly state: 'not_successful' | 'missing_pricing' | 'missing_usage' | 'invalid_facts';
    };

const zero = Object.freeze({ numerator: 0n, denominator: 1n });
const creditMetricIds = new Set([
  'credit',
  'credits',
  'credit_amount',
  'point',
  'points',
  'point_amount'
]);
const creditUnits = new Set(['credit', 'credits', 'point', 'points']);

export function calculateExactSuccessfulCallFee(
  call: StorageCallDetailsDto
): ExactCallFeeCalculation {
  if (call.state !== 'completed') return { state: 'not_successful' };
  const rule = call.officialPricingRule ?? legacyUnitPriceRule(call);
  if (!rule) return { state: 'missing_pricing' };

  try {
    const amount = calculateWithRule(call, rule);
    return amount
      ? { state: 'calculated', amount, currencyCode: normalizeCurrency(rule.currencyCode) }
      : { state: 'missing_usage' };
  } catch {
    return { state: 'invalid_facts' };
  }
}

export function parseExactDecimal(value: string): ExactDecimal {
  const normalized = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(normalized);
  if (!match || normalized.length > 128) throw new TypeError('Invalid decimal');
  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  return reduce({
    numerator: sign * BigInt(`${match[2]}${fraction}`),
    denominator: 10n ** BigInt(fraction.length)
  });
}

export function addExactDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return reduce({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  });
}

export function multiplyExactDecimal(
  left: ExactDecimal,
  right: ExactDecimal
): ExactDecimal {
  return reduce({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator
  });
}

export function compareExactDecimal(left: ExactDecimal, right: ExactDecimal): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function zeroExactDecimal(): ExactDecimal {
  return zero;
}

export function formatExactDecimal(value: ExactDecimal, maximumFractionDigits = 12): string {
  if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 18) {
    throw new TypeError('Invalid decimal precision');
  }
  const negative = value.numerator < 0n;
  const absolute = negative ? -value.numerator : value.numerator;
  const scale = 10n ** BigInt(maximumFractionDigits);
  const scaledNumerator = absolute * scale;
  let units = scaledNumerator / value.denominator;
  const remainder = scaledNumerator % value.denominator;
  if (remainder * 2n >= value.denominator) units += 1n;
  const integer = units / scale;
  const fraction = (units % scale).toString().padStart(maximumFractionDigits, '0')
    .replace(/0+$/u, '');
  const rendered = fraction ? `${integer}.${fraction}` : integer.toString();
  return negative && units !== 0n ? `-${rendered}` : rendered;
}

function calculateWithRule(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto
): ExactDecimal | undefined {
  if (rule.strategy === 'provider_billing') {
    const cashAmount = positiveFact(call.usage.facts, 'cash_amount');
    return cashAmount ?? calculateRateSum(call, rule, ['package_unit_amount']);
  }
  if (rule.strategy === 'credit') {
    const quantity = findPositiveFact(call.usage.facts, isCreditFact);
    return quantity ? multiplyRate(quantity, firstRate(rule)) : undefined;
  }
  if (rule.strategy === 'provider_unit') {
    return calculateRateSum(call, rule, ['package_unit_amount']);
  }
  if (rule.strategy === 'video_token') {
    return calculateRateSum(call, rule, ['completion_tokens', 'total_tokens']);
  }
  if (rule.strategy === 'token_split') {
    const parts = rule.rates.flatMap((rate) => {
      const quantity = positiveFact(call.usage.facts, rate.metricId);
      return quantity ? [multiplyRate(quantity, rate)] : [];
    });
    return parts.length > 0
      ? parts.reduce(addExactDecimal, zeroExactDecimal())
      : undefined;
  }
  if (rule.strategy === 'image_count') {
    return calculateDerivedCount(call, rule, 'image_count', imageCount(call));
  }
  return calculateDerivedCount(call, rule, 'video_seconds', videoSeconds(call));
}

function calculateRateSum(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto,
  metricIds: readonly string[]
): ExactDecimal | undefined {
  for (const metricId of metricIds) {
    const rate = rule.rates.find((item) => item.metricId === metricId);
    const quantity = positiveFact(call.usage.facts, metricId);
    if (rate && quantity) return multiplyRate(quantity, rate);
  }
  return undefined;
}

function calculateDerivedCount(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto,
  metricId: string,
  derivedQuantity: ExactDecimal
): ExactDecimal | undefined {
  const rate = rule.rates.find((item) => item.metricId === metricId);
  if (!rate) throw new TypeError('Missing rate');
  const factQuantity = positiveFact(call.usage.facts, metricId);
  const quantity = factQuantity ?? derivedQuantity;
  return isPositive(quantity) ? multiplyRate(quantity, rate) : undefined;
}

function multiplyRate(quantity: ExactDecimal, rate: StorageCallPricingRateDto): ExactDecimal {
  const amount = parseExactDecimal(rate.amount);
  const scale = parseExactDecimal(rate.scale ?? '1');
  if (!isNonNegative(amount) || !isPositive(scale)) throw new TypeError('Invalid rate');
  return reduce({
    numerator: quantity.numerator * amount.numerator * scale.denominator,
    denominator: quantity.denominator * amount.denominator * scale.numerator
  });
}

function positiveFact(
  facts: readonly StorageCallUsageFactDto[],
  metricId: string
): ExactDecimal | undefined {
  return findPositiveFact(facts, (fact) => fact.metricId === metricId);
}

function findPositiveFact(
  facts: readonly StorageCallUsageFactDto[],
  predicate: (fact: StorageCallUsageFactDto) => boolean
): ExactDecimal | undefined {
  for (const fact of facts) {
    if (!predicate(fact)) continue;
    const value = parseExactDecimal(fact.quantity);
    if (isPositive(value)) return value;
  }
  return undefined;
}

function isCreditFact(fact: StorageCallUsageFactDto): boolean {
  return creditMetricIds.has(fact.metricId) || creditUnits.has(fact.unit);
}

function imageCount(call: StorageCallDetailsDto): ExactDecimal {
  const count = call.localResults
    .filter((result) => result.mediaKind === 'image')
    .reduce((sum, result) => sum + BigInt(result.outputCount), 0n);
  return { numerator: count, denominator: 1n };
}

function videoSeconds(call: StorageCallDetailsDto): ExactDecimal {
  const milliseconds = call.localResults
    .filter((result) => result.mediaKind === 'video' && result.durationMs)
    .reduce((sum, result) => sum + BigInt(result.durationMs ?? '0'), 0n);
  return reduce({ numerator: milliseconds, denominator: 1000n });
}

function legacyUnitPriceRule(
  call: StorageCallDetailsDto
): StorageCallOfficialPricingRuleDto | undefined {
  if (!call.officialUnitPrice) return undefined;
  return {
    strategy: call.officialUnitPrice.creditUnit === 'provider_unit'
      ? 'provider_unit'
      : 'credit',
    currencyCode: call.officialUnitPrice.currencyCode,
    sourceTitle: call.officialUnitPrice.sourceTitle,
    sourceUrl: call.officialUnitPrice.sourceUrl,
    sourceCheckedAt: call.officialUnitPrice.sourceCheckedAt,
    rates: [{
      metricId: call.officialUnitPrice.creditUnit === 'provider_unit'
        ? 'package_unit_amount'
        : 'credit_amount',
      amount: call.officialUnitPrice.amount,
      unit: call.officialUnitPrice.creditUnit,
      label: call.officialUnitPrice.creditUnit
    }]
  };
}

function firstRate(rule: StorageCallOfficialPricingRuleDto): StorageCallPricingRateDto {
  const rate = rule.rates[0];
  if (!rate) throw new TypeError('Missing rate');
  return rate;
}

function normalizeCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) throw new TypeError('Invalid currency');
  return normalized;
}

function isPositive(value: ExactDecimal): boolean {
  return value.numerator > 0n && value.denominator > 0n;
}

function isNonNegative(value: ExactDecimal): boolean {
  return value.numerator >= 0n && value.denominator > 0n;
}

function reduce(value: ExactDecimal): ExactDecimal {
  if (value.denominator <= 0n) throw new TypeError('Invalid denominator');
  if (value.numerator === 0n) return zero;
  const divisor = greatestCommonDivisor(
    value.numerator < 0n ? -value.numerator : value.numerator,
    value.denominator
  );
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
