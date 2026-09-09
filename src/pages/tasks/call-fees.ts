import type {
  StorageCallDetailsDto,
  StorageCallOfficialPricingRuleDto,
  StorageCallPricingRateDto,
  StorageCallUsageFactDto
} from '../../shared/storage-ipc';

export type CallFeeCalculation =
  | {
      readonly state: 'calculated';
      readonly fee: number;
      readonly currencyLabel: string;
      readonly formula: string;
      readonly sourceLabel: string;
    }
  | {
      readonly state: 'not_successful' | 'missing_inputs' | 'invalid_facts';
      readonly reason: string;
    };

const creditMetricIds = new Set([
  'credit',
  'credits',
  'credit_amount',
  'point',
  'points',
  'point_amount'
]);

const creditUnits = new Set([
  'credit',
  'credits',
  'point',
  'points'
]);

export function calculateSuccessfulCallFee(
  call: StorageCallDetailsDto
): CallFeeCalculation {
  if (call.state !== 'completed') {
    return { state: 'not_successful', reason: '调用未成功，不计入费用' };
  }
  const pricingRule = call.officialPricingRule ?? legacyUnitPriceRule(call);
  if (!pricingRule) {
    return { state: 'missing_inputs', reason: '缺少官方价格规则，无法计算费用' };
  }

  try {
    return calculateWithRule(call, pricingRule);
  } catch {
    return { state: 'invalid_facts', reason: '费用用量或价格格式异常，无法计算费用' };
  }
}

export function formatCallFee(calculation: CallFeeCalculation): string {
  if (calculation.state !== 'calculated') return calculation.reason;
  return `${formatFeeAmount(calculation.fee)} ${calculation.currencyLabel}`;
}

export function formatCallFeeFormula(calculation: CallFeeCalculation): string {
  if (calculation.state !== 'calculated') return calculation.reason;
  return calculation.formula;
}

export function formatFeeAmount(value: number): string {
  if (!Number.isFinite(value)) return '不可用';
  if (value === 0) return '0';
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return trimNumber(value.toFixed(1));
  if (Math.abs(value) >= 1) return trimNumber(value.toFixed(2));
  return trimNumber(value.toFixed(4));
}

function calculateWithRule(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto
): CallFeeCalculation {
  const currency = currencyLabel(rule.currencyCode);
  if (rule.strategy === 'provider_billing') {
    const cashAmount = positiveFact(call.usage.facts, 'cash_amount');
    if (cashAmount) {
      return calculated(
        cashAmount.value,
        currency,
        rule,
        `${rule.sourceTitle}：响应体现金扣费 ${formatFeeAmount(cashAmount.value)} ${currency}`
      );
    }
    return calculateRateSum(call, rule, ['package_unit_amount']);
  }
  if (rule.strategy === 'credit') {
    const quantity = findPositiveFact(call.usage.facts, isCreditFact);
    if (!quantity) {
      return { state: 'missing_inputs', reason: '缺少积分数，无法计算费用' };
    }
    const rate = firstRate(rule);
    const fee = multiply(quantity.value, rate);
    return calculated(
      fee,
      currency,
      rule,
      `${rule.sourceTitle}：${formatRate(rate, currency)} × ${formatFeeAmount(quantity.value)} ${rate.label ?? rate.unit}`
    );
  }
  if (rule.strategy === 'provider_unit') {
    return calculateRateSum(call, rule, ['package_unit_amount']);
  }
  if (rule.strategy === 'video_token') {
    return calculateRateSum(call, rule, ['completion_tokens', 'total_tokens']);
  }
  if (rule.strategy === 'token_split') {
    return calculateTokenSplit(call, rule);
  }
  if (rule.strategy === 'image_count') {
    return calculateDerivedCount(call, rule, 'image_count', imageCount(call));
  }
  return calculateDerivedCount(call, rule, 'video_seconds', videoSeconds(call));
}

function calculateTokenSplit(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto
): CallFeeCalculation {
  const parts = rule.rates.flatMap((rate) => {
    const quantity = positiveFact(call.usage.facts, rate.metricId);
    return quantity ? [{ rate, quantity: quantity.value }] : [];
  });
  if (parts.length === 0) {
    return { state: 'missing_inputs', reason: '缺少计费 token 用量，无法计算费用' };
  }
  const fee = parts.reduce((sum, part) => sum + multiply(part.quantity, part.rate), 0);
  const currency = currencyLabel(rule.currencyCode);
  return calculated(
    fee,
    currency,
    rule,
    `${rule.sourceTitle}：${parts.map((part) =>
      `${formatRate(part.rate, currency)} × ${formatFeeAmount(part.quantity)} ${part.rate.label ?? part.rate.metricId}`
    ).join(' + ')}`
  );
}

function calculateRateSum(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto,
  metricIds: readonly string[]
): CallFeeCalculation {
  for (const metricId of metricIds) {
    const rate = rule.rates.find((item) => item.metricId === metricId);
    const quantity = positiveFact(call.usage.facts, metricId);
    if (!rate || !quantity) continue;
    const currency = currencyLabel(rule.currencyCode);
    return calculated(
      multiply(quantity.value, rate),
      currency,
      rule,
      `${rule.sourceTitle}：${formatRate(rate, currency)} × ${formatFeeAmount(quantity.value)} ${rate.label ?? rate.unit}`
    );
  }
  return { state: 'missing_inputs', reason: '缺少计费用量，无法计算费用' };
}

function calculateDerivedCount(
  call: StorageCallDetailsDto,
  rule: StorageCallOfficialPricingRuleDto,
  metricId: string,
  derivedQuantity: number
): CallFeeCalculation {
  const rate = rule.rates.find((item) => item.metricId === metricId);
  if (!rate) {
    return { state: 'missing_inputs', reason: '缺少官方价格规则，无法计算费用' };
  }
  const factQuantity = positiveFact(call.usage.facts, metricId)?.value;
  const quantity = factQuantity ?? derivedQuantity;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { state: 'missing_inputs', reason: '缺少计费用量，无法计算费用' };
  }
  const currency = currencyLabel(rule.currencyCode);
  return calculated(
    multiply(quantity, rate),
    currency,
    rule,
    `${rule.sourceTitle}：${formatRate(rate, currency)} × ${formatFeeAmount(quantity)} ${rate.label ?? rate.unit}`
  );
}

function calculated(
  fee: number,
  currencyLabelValue: string,
  rule: StorageCallOfficialPricingRuleDto,
  formula: string
): CallFeeCalculation {
  if (!Number.isFinite(fee) || fee < 0) {
    return { state: 'invalid_facts', reason: '费用用量或价格格式异常，无法计算费用' };
  }
  return {
    state: 'calculated',
    fee,
    currencyLabel: currencyLabelValue,
    formula,
    sourceLabel: rule.sourceTitle
  };
}

function multiply(quantity: number, rate: StorageCallPricingRateDto): number {
  const amount = Number(rate.amount);
  const scale = rate.scale === undefined ? 1 : Number(rate.scale);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(scale) || scale <= 0) {
    throw new TypeError('invalid rate');
  }
  return quantity / scale * amount;
}

function firstRate(rule: StorageCallOfficialPricingRuleDto): StorageCallPricingRateDto {
  const rate = rule.rates[0];
  if (!rate) throw new TypeError('missing rate');
  return rate;
}

function findPositiveFact(
  facts: readonly StorageCallUsageFactDto[],
  predicate: (fact: StorageCallUsageFactDto) => boolean
): { readonly fact: StorageCallUsageFactDto; readonly value: number } | undefined {
  for (const fact of facts) {
    if (!predicate(fact)) continue;
    const value = Number(fact.quantity);
    if (Number.isFinite(value) && value > 0) return { fact, value };
  }
  return undefined;
}

function positiveFact(
  facts: readonly StorageCallUsageFactDto[],
  metricId: string
): { readonly fact: StorageCallUsageFactDto; readonly value: number } | undefined {
  return findPositiveFact(facts, (fact) => fact.metricId === metricId);
}

function isCreditFact(fact: StorageCallUsageFactDto): boolean {
  return creditMetricIds.has(fact.metricId) || creditUnits.has(fact.unit);
}

function imageCount(call: StorageCallDetailsDto): number {
  return call.localResults
    .filter((result) => result.mediaKind === 'image')
    .reduce((sum, result) => sum + result.outputCount, 0);
}

function videoSeconds(call: StorageCallDetailsDto): number {
  return call.localResults
    .filter((result) => result.mediaKind === 'video' && result.durationMs)
    .reduce((sum, result) => sum + Number(result.durationMs) / 1000, 0);
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

function formatRate(rate: StorageCallPricingRateDto, currency: string): string {
  const scale = rate.scale === undefined ? 1 : Number(rate.scale);
  const base = `${formatFeeAmount(Number(rate.amount))} ${currency}`;
  return scale === 1
    ? `${base}/${rate.label ?? rate.unit}`
    : `${base}/${formatFeeAmount(scale)} ${rate.label ?? rate.unit}`;
}

function currencyLabel(unit: string): string {
  if (/cny|rmb|yuan/i.test(unit)) return '元';
  if (/usd/i.test(unit)) return '美元';
  return '金额单位';
}

function trimNumber(value: string): string {
  return value.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1');
}
