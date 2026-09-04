import { InvariantViolationError } from '../errors';
import {
  toLocalResultObservationId,
  toProviderInvocationAttemptId,
  toProviderUsageObservationId,
  toUsageSchemaId,
  type LocalResultObservationId,
  type ProviderInvocationAttemptId,
  type ProviderUsageObservationId,
  type UsageSchemaId
} from '../ids';
import { toIsoTimestamp, type IsoTimestamp } from '../timestamps';
import type { ProviderInvocationState } from './provider-invocation';

export const usageAggregationKinds = [
  'final_authoritative',
  'cumulative_latest',
  'delta_sum',
  'first_reported'
] as const;
export type UsageAggregationKind = (typeof usageAggregationKinds)[number];

export const usageStages = ['submit', 'poll', 'result'] as const;
export type UsageStage = (typeof usageStages)[number];

export const usageSources = [
  'provider_body',
  'provider_header',
  'provider_usage_endpoint'
] as const;
export type UsageSource = (typeof usageSources)[number];

export const usageAvailabilities = [
  'reported_complete',
  'reported_partial',
  'not_reported',
  'invalid_response',
  'unknown_outcome',
  'not_applicable',
  'not_collected_legacy'
] as const;
export type UsageAvailability = (typeof usageAvailabilities)[number];
export type UsageAvailabilityOverride = Extract<
  UsageAvailability,
  'not_applicable' | 'not_collected_legacy'
>;

export const usageObservationStatuses = [
  'reported',
  'not_reported',
  'invalid_response',
  'unknown_outcome'
] as const;
export type UsageObservationStatus =
  (typeof usageObservationStatuses)[number];

export interface UsageMetricDefinitionV1 {
  readonly metricId: string;
  readonly allowedUnits: readonly string[];
  readonly numericKind: 'integer' | 'decimal';
  readonly aggregation: UsageAggregationKind;
  readonly requiredForComplete: boolean;
  readonly allowedStages: readonly UsageStage[];
}

export interface UsageSchemaV1 {
  readonly schemaVersion: 1;
  readonly id: UsageSchemaId;
  readonly revision: number;
  readonly metrics: readonly UsageMetricDefinitionV1[];
  readonly completenessRule: 'all_required_metrics' | 'provider_status_only';
  readonly conflictPolicy: 'mark_invalid_response';
}

export interface UsageFactV1 {
  readonly metricId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly source: UsageSource;
}

export interface ProviderUsageObservationV1 {
  readonly schemaVersion: 1;
  readonly id: ProviderUsageObservationId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly usageSchemaId: UsageSchemaId;
  readonly usageSchemaRevision: number;
  readonly sourceEventKey: string;
  readonly sequence: number;
  readonly status: UsageObservationStatus;
  readonly sourceStage: UsageStage;
  readonly facts: readonly UsageFactV1[];
  /** Provider/gateway request identifier used for later billing reconciliation. */
  readonly providerRequestId?: string;
  readonly observedAt: IsoTimestamp;
}

export interface ProviderUsageSummaryV1 {
  readonly schemaVersion: 1;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly availability: UsageAvailability;
  readonly facts: readonly UsageFactV1[];
  readonly providerRequestId?: string;
  readonly calculatedAt: IsoTimestamp;
}

export interface LocalResultObservationV1 {
  readonly schemaVersion: 1;
  readonly id: LocalResultObservationId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly mediaKind: 'image' | 'video' | 'text';
  readonly outputCount: number;
  readonly durationMs?: string;
  readonly width?: number;
  readonly height?: number;
  readonly byteLength?: string;
  /** Provider-returned image URL; persisted per owner decision for call records. */
  readonly resultImageUrl?: string;
  readonly validationState: 'pending' | 'valid' | 'invalid';
  readonly observedAt: IsoTimestamp;
}

export function createUsageSchema(input: Omit<UsageSchemaV1, 'schemaVersion'>): UsageSchemaV1 {
  return parseUsageSchema({ schemaVersion: 1, ...input });
}

export function createProviderUsageObservation(
  input: Omit<ProviderUsageObservationV1, 'schemaVersion'>,
  schema: UsageSchemaV1
): ProviderUsageObservationV1 {
  const observation = parseProviderUsageObservation({ schemaVersion: 1, ...input });
  validateUsageObservationAgainstSchema(observation, schema);
  return observation;
}

export function createLocalResultObservation(
  input: Omit<LocalResultObservationV1, 'schemaVersion'>
): LocalResultObservationV1 {
  return parseLocalResultObservation({ schemaVersion: 1, ...input });
}

export function parseUsageSchema(value: unknown): UsageSchemaV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'id',
    'revision',
    'metrics',
    'completenessRule',
    'conflictPolicy'
  ], 'usage schema');
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 1 ||
    !Array.isArray(item.metrics) ||
    !['all_required_metrics', 'provider_status_only'].includes(
      String(item.completenessRule)
    ) ||
    item.conflictPolicy !== 'mark_invalid_response'
  ) {
    throw new InvariantViolationError('usage schema is invalid');
  }
  const metrics = item.metrics.map(parseUsageMetricDefinition);
  const metricIds = metrics.map((metric) => metric.metricId);
  if (new Set(metricIds).size !== metricIds.length) {
    throw new InvariantViolationError('usage schema metric IDs must be unique');
  }
  return {
    schemaVersion: 1,
    id: toUsageSchemaId(nonBlank(item.id, 'usageSchema.id')),
    revision: Number(item.revision),
    metrics,
    completenessRule: item.completenessRule as UsageSchemaV1['completenessRule'],
    conflictPolicy: 'mark_invalid_response'
  };
}

export function parseProviderUsageObservation(
  value: unknown
): ProviderUsageObservationV1 {
  const item = flexibleExactRecord(value, [
    'schemaVersion',
    'id',
    'invocationAttemptId',
    'usageSchemaId',
    'usageSchemaRevision',
    'sourceEventKey',
    'sequence',
    'status',
    'sourceStage',
    'facts',
    'observedAt'
  ], ['providerRequestId'], 'provider usage observation');
  if (
    item.providerRequestId !== undefined &&
    !isValidProviderRequestId(item.providerRequestId)
  ) {
    throw new InvariantViolationError('provider request ID is invalid');
  }
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.usageSchemaRevision) ||
    Number(item.usageSchemaRevision) < 1 ||
    !Number.isSafeInteger(item.sequence) ||
    Number(item.sequence) < 1 ||
    !usageObservationStatuses.includes(item.status as UsageObservationStatus) ||
    !usageStages.includes(item.sourceStage as UsageStage) ||
    !Array.isArray(item.facts)
  ) {
    throw new InvariantViolationError('provider usage observation is invalid');
  }
  const facts = item.facts.map(parseUsageFact);
  const metricIds = facts.map((fact) => fact.metricId);
  if (new Set(metricIds).size !== metricIds.length) {
    throw new InvariantViolationError('usage observation metric IDs must be unique');
  }
  if (item.status !== 'reported' && facts.length > 0) {
    throw new InvariantViolationError(
      'non-reported usage observations cannot contain facts'
    );
  }
  return {
    schemaVersion: 1,
    id: toProviderUsageObservationId(nonBlank(item.id, 'usageObservation.id')),
    invocationAttemptId: toProviderInvocationAttemptId(
      nonBlank(item.invocationAttemptId, 'usageObservation.invocationAttemptId')
    ),
    usageSchemaId: toUsageSchemaId(
      nonBlank(item.usageSchemaId, 'usageObservation.usageSchemaId')
    ),
    usageSchemaRevision: Number(item.usageSchemaRevision),
    sourceEventKey: parseSourceEventKey(item.sourceEventKey),
    sequence: Number(item.sequence),
    status: item.status as UsageObservationStatus,
    sourceStage: item.sourceStage as UsageStage,
    facts,
    ...(item.providerRequestId === undefined
      ? {}
      : { providerRequestId: item.providerRequestId }),
    observedAt: toIsoTimestamp(String(item.observedAt))
  };
}

export function parseProviderUsageSummary(value: unknown): ProviderUsageSummaryV1 {
  const item = flexibleExactRecord(
    value,
    ['schemaVersion', 'invocationAttemptId', 'availability', 'facts', 'calculatedAt'],
    ['providerRequestId'],
    'provider usage summary'
  );
  if (
    item.providerRequestId !== undefined &&
    !isValidProviderRequestId(item.providerRequestId)
  ) {
    throw new InvariantViolationError('provider request ID is invalid');
  }
  if (
    item.schemaVersion !== 1 ||
    !usageAvailabilities.includes(item.availability as UsageAvailability) ||
    !Array.isArray(item.facts)
  ) {
    throw new InvariantViolationError('provider usage summary is invalid');
  }
  const facts = item.facts.map(parseUsageFact);
  if (new Set(facts.map((fact) => fact.metricId)).size !== facts.length) {
    throw new InvariantViolationError('usage summary metric IDs must be unique');
  }
  if (
    !['reported_complete', 'reported_partial'].includes(String(item.availability)) &&
    facts.length > 0
  ) {
    throw new InvariantViolationError('unavailable usage summary cannot contain facts');
  }
  return {
    schemaVersion: 1,
    invocationAttemptId: toProviderInvocationAttemptId(
      nonBlank(item.invocationAttemptId, 'usageSummary.invocationAttemptId')
    ),
    availability: item.availability as UsageAvailability,
    facts,
    ...(item.providerRequestId === undefined
      ? {}
      : { providerRequestId: item.providerRequestId }),
    calculatedAt: toIsoTimestamp(String(item.calculatedAt))
  };
}

export function parseLocalResultObservation(
  value: unknown
): LocalResultObservationV1 {
  const item = flexibleExactRecord(
    value,
    [
      'schemaVersion',
      'id',
      'invocationAttemptId',
      'mediaKind',
      'outputCount',
      'validationState',
      'observedAt'
    ],
    ['durationMs', 'width', 'height', 'byteLength', 'resultImageUrl'],
    'local result observation'
  );
  if (
    item.schemaVersion !== 1 ||
    !['image', 'video', 'text'].includes(String(item.mediaKind)) ||
    !Number.isSafeInteger(item.outputCount) ||
    Number(item.outputCount) < 0 ||
    !['pending', 'valid', 'invalid'].includes(String(item.validationState))
  ) {
    throw new InvariantViolationError('local result observation is invalid');
  }
  const durationMs = item.durationMs === undefined
    ? undefined
    : canonicalIntegerQuantity(item.durationMs, 'localResult.durationMs');
  const byteLength = item.byteLength === undefined
    ? undefined
    : canonicalIntegerQuantity(item.byteLength, 'localResult.byteLength');
  const width = item.width === undefined
    ? undefined
    : positiveInteger(item.width, 'localResult.width');
  const height = item.height === undefined
    ? undefined
    : positiveInteger(item.height, 'localResult.height');
  const resultImageUrl = item.resultImageUrl === undefined
    ? undefined
    : nonBlank(item.resultImageUrl, 'localResult.resultImageUrl');
  if (resultImageUrl !== undefined && resultImageUrl.length > 8_192) {
    throw new InvariantViolationError('localResult.resultImageUrl is too long');
  }
  return {
    schemaVersion: 1,
    id: toLocalResultObservationId(nonBlank(item.id, 'localResult.id')),
    invocationAttemptId: toProviderInvocationAttemptId(
      nonBlank(item.invocationAttemptId, 'localResult.invocationAttemptId')
    ),
    mediaKind: item.mediaKind as LocalResultObservationV1['mediaKind'],
    outputCount: Number(item.outputCount),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(resultImageUrl !== undefined ? { resultImageUrl } : {}),
    validationState: item.validationState as LocalResultObservationV1['validationState'],
    observedAt: toIsoTimestamp(String(item.observedAt))
  };
}

export function validateUsageObservationAgainstSchema(
  observation: ProviderUsageObservationV1,
  schema: UsageSchemaV1
): void {
  const parsedObservation = parseProviderUsageObservation(observation);
  const parsedSchema = parseUsageSchema(schema);
  if (
    parsedObservation.usageSchemaId !== parsedSchema.id ||
    parsedObservation.usageSchemaRevision !== parsedSchema.revision
  ) {
    throw new InvariantViolationError('usage observation references another schema');
  }
  const definitions = new Map(
    parsedSchema.metrics.map((metric) => [metric.metricId, metric] as const)
  );
  for (const fact of parsedObservation.facts) {
    const definition = definitions.get(fact.metricId);
    if (!definition) {
      throw new InvariantViolationError(`usage metric ${fact.metricId} is not registered`);
    }
    if (!definition.allowedUnits.includes(fact.unit)) {
      throw new InvariantViolationError(`usage metric ${fact.metricId} unit is invalid`);
    }
    if (!definition.allowedStages.includes(parsedObservation.sourceStage)) {
      throw new InvariantViolationError(`usage metric ${fact.metricId} stage is invalid`);
    }
    parseQuantity(fact.quantity, definition.numericKind);
  }
}

export function summarizeProviderUsage(input: {
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly schema: UsageSchemaV1;
  readonly observations: readonly ProviderUsageObservationV1[];
  readonly attemptState: ProviderInvocationState;
  readonly calculatedAt: IsoTimestamp;
  readonly availabilityOverride?: UsageAvailabilityOverride;
}): ProviderUsageSummaryV1 {
  const schema = parseUsageSchema(input.schema);
  const observations = input.observations
    .map(parseProviderUsageObservation)
    .sort((left, right) => left.sequence - right.sequence);
  if (
    observations.some((item) => item.invocationAttemptId !== input.invocationAttemptId)
  ) {
    throw new InvariantViolationError('usage observations belong to another attempt');
  }
  observations.forEach((item) => validateUsageObservationAgainstSchema(item, schema));
  const providerRequestId = latestProviderRequestId(observations).providerRequestId;
  if (input.availabilityOverride !== undefined) {
    if (observations.length > 0) {
      throw new InvariantViolationError('usage availability override cannot hide observations');
    }
    return summary(input.invocationAttemptId, input.availabilityOverride, [], input.calculatedAt, providerRequestId);
  }
  if (
    input.attemptState === 'unknown_outcome' ||
    observations.some((item) => item.status === 'unknown_outcome')
  ) {
    return summary(input.invocationAttemptId, 'unknown_outcome', [], input.calculatedAt, providerRequestId);
  }
  if (observations.some((item) => item.status === 'invalid_response')) {
    return summary(input.invocationAttemptId, 'invalid_response', [], input.calculatedAt, providerRequestId);
  }
  const reported = observations.filter((item) => item.status === 'reported');
  if (reported.length === 0) {
    return summary(input.invocationAttemptId, 'not_reported', [], input.calculatedAt, providerRequestId);
  }
  const aggregated: UsageFactV1[] = [];
  for (const definition of schema.metrics) {
    const values = reported.flatMap((observation) =>
      observation.facts
        .filter((fact) => fact.metricId === definition.metricId)
        .map((fact) => ({ observation, fact }))
    );
    if (values.length === 0) continue;
    const fact = aggregateMetric(definition, values);
    if (!fact) {
      return summary(input.invocationAttemptId, 'invalid_response', [], input.calculatedAt, providerRequestId);
    }
    aggregated.push(fact);
  }
  const availability = schema.completenessRule === 'provider_status_only'
    ? 'reported_complete'
    : schema.metrics
        .filter((metric) => metric.requiredForComplete)
        .every((metric) => aggregated.some((fact) => fact.metricId === metric.metricId))
      ? 'reported_complete'
      : 'reported_partial';
  return summary(input.invocationAttemptId, availability, aggregated, input.calculatedAt, providerRequestId);
}

export function sameUsageSourceEvent(
  left: ProviderUsageObservationV1,
  right: ProviderUsageObservationV1
): boolean {
  const a = parseProviderUsageObservation(left);
  const b = parseProviderUsageObservation(right);
  return JSON.stringify({
    invocationAttemptId: a.invocationAttemptId,
    usageSchemaId: a.usageSchemaId,
    usageSchemaRevision: a.usageSchemaRevision,
    sourceEventKey: a.sourceEventKey,
    sequence: a.sequence,
    status: a.status,
    sourceStage: a.sourceStage,
    facts: a.facts
  }) === JSON.stringify({
    invocationAttemptId: b.invocationAttemptId,
    usageSchemaId: b.usageSchemaId,
    usageSchemaRevision: b.usageSchemaRevision,
    sourceEventKey: b.sourceEventKey,
    sequence: b.sequence,
    status: b.status,
    sourceStage: b.sourceStage,
    facts: b.facts
  });
}

function aggregateMetric(
  definition: UsageMetricDefinitionV1,
  values: readonly { observation: ProviderUsageObservationV1; fact: UsageFactV1 }[]
): UsageFactV1 | undefined {
  if (new Set(values.map((item) => item.fact.unit)).size !== 1) return undefined;
  if (definition.aggregation === 'first_reported') {
    const sorted = [...values].sort((a, b) => a.observation.sequence - b.observation.sequence);
    const first = sorted[0].fact;
    if (sorted.some((item) => item.fact.quantity !== first.quantity)) return undefined;
    return { ...first };
  }
  if (definition.aggregation === 'delta_sum') {
    const bySource = new Map<string, (typeof values)[number]>();
    for (const value of values) {
      if (!bySource.has(value.observation.sourceEventKey)) {
        bySource.set(value.observation.sourceEventKey, value);
      }
    }
    const unique = [...bySource.values()].sort(
      (a, b) => a.observation.sequence - b.observation.sequence
    );
    const quantity = addDecimalQuantities(unique.map((item) => item.fact.quantity));
    const latest = unique[unique.length - 1].fact;
    return { ...latest, quantity };
  }
  if (definition.aggregation === 'cumulative_latest') {
    const latest = [...values].sort(
      (a, b) => b.observation.sequence - a.observation.sequence
    )[0].fact;
    return { ...latest };
  }
  const stageRank: Record<UsageStage, number> = { submit: 0, poll: 1, result: 2 };
  const authoritative = [...values].sort((a, b) =>
    stageRank[b.observation.sourceStage] - stageRank[a.observation.sourceStage] ||
    b.observation.sequence - a.observation.sequence
  )[0].fact;
  return { ...authoritative };
}

function parseUsageMetricDefinition(value: unknown): UsageMetricDefinitionV1 {
  const item = exactRecord(value, [
    'metricId',
    'allowedUnits',
    'numericKind',
    'aggregation',
    'requiredForComplete',
    'allowedStages'
  ], 'usage metric definition');
  if (
    !Array.isArray(item.allowedUnits) ||
    item.allowedUnits.length === 0 ||
    !['integer', 'decimal'].includes(String(item.numericKind)) ||
    !usageAggregationKinds.includes(item.aggregation as UsageAggregationKind) ||
    typeof item.requiredForComplete !== 'boolean' ||
    !Array.isArray(item.allowedStages) ||
    item.allowedStages.length === 0
  ) {
    throw new InvariantViolationError('usage metric definition is invalid');
  }
  const allowedUnits = item.allowedUnits.map(parseUnit);
  const allowedStages = item.allowedStages.map((stage) => {
    if (!usageStages.includes(stage as UsageStage)) {
      throw new InvariantViolationError('usage metric stage is invalid');
    }
    return stage as UsageStage;
  });
  if (
    new Set(allowedUnits).size !== allowedUnits.length ||
    new Set(allowedStages).size !== allowedStages.length
  ) {
    throw new InvariantViolationError('usage metric units and stages must be unique');
  }
  return {
    metricId: parseMetricId(item.metricId),
    allowedUnits,
    numericKind: item.numericKind as UsageMetricDefinitionV1['numericKind'],
    aggregation: item.aggregation as UsageAggregationKind,
    requiredForComplete: item.requiredForComplete,
    allowedStages
  };
}

function parseUsageFact(value: unknown): UsageFactV1 {
  const item = exactRecord(
    value,
    ['metricId', 'quantity', 'unit', 'source'],
    'usage fact'
  );
  if (!usageSources.includes(item.source as UsageSource)) {
    throw new InvariantViolationError('usage fact source is invalid');
  }
  return {
    metricId: parseMetricId(item.metricId),
    quantity: decimalQuantityString(item.quantity, 'usageFact.quantity'),
    unit: parseUnit(item.unit),
    source: item.source as UsageSource
  };
}

function summary(
  invocationAttemptId: ProviderInvocationAttemptId,
  availability: UsageAvailability,
  facts: readonly UsageFactV1[],
  calculatedAt: IsoTimestamp,
  providerRequestId?: string
): ProviderUsageSummaryV1 {
  return parseProviderUsageSummary({
    schemaVersion: 1,
    invocationAttemptId,
    availability,
    facts,
    ...(providerRequestId ? { providerRequestId } : {}),
    calculatedAt
  });
}

function latestProviderRequestId(
  observations: readonly ProviderUsageObservationV1[]
): { readonly providerRequestId?: string } {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const providerRequestId = observations[index]?.providerRequestId;
    if (providerRequestId) return { providerRequestId };
  }
  return {};
}

function parseQuantity(value: string, numericKind: 'integer' | 'decimal'): string {
  return numericKind === 'integer'
    ? canonicalIntegerQuantity(value, 'usageFact.quantity')
    : canonicalDecimalQuantity(value, 'usageFact.quantity');
}

function canonicalIntegerQuantity(value: unknown, label: string): string {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new InvariantViolationError(`${label} must be a non-negative integer string`);
  }
  return text;
}

function canonicalDecimalQuantity(value: unknown, label: string): string {
  return normalizeDecimal(decimalQuantityString(value, label));
}

function decimalQuantityString(value: unknown, label: string): string {
  const text = String(value);
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    throw new InvariantViolationError(`${label} must be a non-negative decimal string`);
  }
  return text;
}

function addDecimalQuantities(values: readonly string[]): string {
  const decimals = values.map((value) => normalizeDecimal(value));
  const scale = Math.max(...decimals.map((value) => value.split('.')[1]?.length ?? 0));
  const total = decimals.reduce((sum, value) => {
    const [whole, fraction = ''] = value.split('.');
    return sum + BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }, 0n);
  if (scale === 0) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  return normalizeDecimal(`${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
}

function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const normalized = value.replace(/0+$/, '').replace(/\.$/, '');
  return normalized.length === 0 ? '0' : normalized;
}

function parseMetricId(value: unknown): string {
  const id = nonBlank(value, 'metricId');
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(id)) {
    throw new InvariantViolationError('usage metric ID is invalid');
  }
  return id;
}

function parseUnit(value: unknown): string {
  const unit = nonBlank(value, 'usage unit');
  if (!/^[A-Za-z0-9%_.\/-]{1,32}$/.test(unit)) {
    throw new InvariantViolationError('usage unit is invalid');
  }
  return unit;
}

function parseSourceEventKey(value: unknown): string {
  const key = nonBlank(value, 'usageObservation.sourceEventKey');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(key)) {
    throw new InvariantViolationError('usage source event key is invalid');
  }
  return key;
}

function isValidProviderRequestId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InvariantViolationError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  const allowed = new Set(keys);
  if (
    Object.keys(item).length !== allowed.size ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw new InvariantViolationError(`${label} contains unsupported fields`);
  }
  return item;
}

function flexibleExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in item)) ||
    Object.keys(item).some((key) => !allowed.has(key))
  ) {
    throw new InvariantViolationError(`${label} contains unsupported fields`);
  }
  return item;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantViolationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvariantViolationError(`${label} cannot be empty`);
  }
  return value.trim();
}
