import { stat } from 'node:fs/promises';
import {
  buildProviderInvocationReadModel,
  parseProductFeature,
  parseUsageSchema,
  providerInvocationStates,
  summarizeProviderUsage,
  toIsoTimestamp,
  toProviderInvocationAttemptId,
  type IsoTimestamp,
  type LocalResultObservationV1,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderInvocationAttemptV1,
  type ProviderInvocationEventV1,
  type ProviderInvocationReadModelV1,
  type ProviderUsageObservationV1,
  type ProviderUsageSummaryV1,
  type UsageSchemaV1,
  type Work
} from '../../domain';
import type {
  StorageCallDetailsDto,
  StorageCallRecordListDto,
  StorageCallRecordSummaryDto,
  StorageCallResultRegistrationDto,
  StorageConsumptionConversionSourceDto,
  StorageConsumptionProviderSliceDto,
  StorageConsumptionSummaryDto,
  StorageIpcResult,
  StorageReadModelIssueDto,
  StorageTaskTimelineDto
} from '../../shared/storage-ipc';
import {
  JsonLocalResultObservationRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderUsageObservationRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { ProjectCatalogEntry, ProjectCatalogService } from './project-catalog';
import { resolveOfficialPricingRule } from '../providers/official-pricing-rules';
import {
  addExactDecimal,
  calculateExactSuccessfulCallFee,
  compareExactDecimal,
  formatExactDecimal,
  multiplyExactDecimal,
  parseExactDecimal,
  zeroExactDecimal,
  type ExactDecimal
} from '../providers/provider-consumption-calculator';

export interface ProviderUsageSchemaResolverPort {
  resolve(input: {
    readonly usageSchemaId: string;
    readonly usageSchemaRevision: number;
  }): Promise<UsageSchemaV1 | undefined>;
}

export class ProviderUsageSchemaRegistry implements ProviderUsageSchemaResolverPort {
  private readonly schemas: ReadonlyMap<string, UsageSchemaV1>;

  constructor(schemas: readonly UsageSchemaV1[]) {
    const parsed = schemas.map(parseUsageSchema);
    const entries = parsed.map((schema) => [schemaKey(schema.id, schema.revision), schema] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new TypeError('Provider usage schema identities must be unique');
    }
    this.schemas = new Map(entries);
  }

  async resolve(input: {
    readonly usageSchemaId: string;
    readonly usageSchemaRevision: number;
  }): Promise<UsageSchemaV1 | undefined> {
    const schema = this.schemas.get(
      schemaKey(input.usageSchemaId, input.usageSchemaRevision)
    );
    return schema ? structuredClone(schema) : undefined;
  }
}

const noUsageSchemas = new ProviderUsageSchemaRegistry([]);

export interface CurrencyConversionFactV1 {
  readonly sourceCurrencyCode: string;
  readonly targetCurrencyCode: 'CNY';
  readonly rate: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly sourceCheckedAt: string;
}

export interface CurrencyConversionFactResolverPort {
  listApprovedFacts(targetCurrencyCode: 'CNY'): Promise<readonly CurrencyConversionFactV1[]>;
}

const noCurrencyConversions: CurrencyConversionFactResolverPort = {
  async listApprovedFacts() {
    return [];
  }
};

interface ParsedCallFilter {
  readonly projectId?: string;
  readonly productFeature?: string;
  readonly providerId?: string;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly state?: string;
  readonly createdFrom?: IsoTimestamp;
  readonly createdTo?: IsoTimestamp;
  readonly offset: number;
  readonly limit: number;
}

interface ProjectCallFacts {
  readonly attempts: readonly ProviderInvocationAttemptV1[];
  readonly eventsByAttempt: ReadonlyMap<string, readonly ProviderInvocationEventV1[]>;
  readonly routesById: ReadonlyMap<string, ProviderExecutionRouteSnapshotV1>;
  readonly usageByAttempt: ReadonlyMap<string, readonly ProviderUsageObservationV1[]>;
  readonly localResultsByAttempt: ReadonlyMap<string, readonly LocalResultObservationV1[]>;
  readonly worksByExecution: ReadonlyMap<string, readonly Work[]>;
}

interface BuiltCallRecord {
  readonly summary: StorageCallRecordSummaryDto;
  readonly details: StorageCallDetailsDto;
}

interface ParsedCurrencyConversionFact extends Omit<CurrencyConversionFactV1, 'rate'> {
  readonly rate: ExactDecimal;
}

interface ConsumptionTotal {
  readonly amount: ExactDecimal;
  readonly callCount: number;
}

interface ProviderConsumptionTotal extends ConsumptionTotal {
  readonly providerId: string;
  readonly label: string;
}

export class ProviderInvocationReadModelController {
  constructor(
    private readonly catalog: ProjectCatalogService,
    private readonly usageSchemas: ProviderUsageSchemaResolverPort = noUsageSchemas,
    private readonly currencyConversions: CurrencyConversionFactResolverPort = noCurrencyConversions,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listCallRecords(
    request: unknown = {}
  ): Promise<StorageIpcResult<StorageCallRecordListDto>> {
    let filter: ParsedCallFilter;
    try {
      filter = parseCallFilter(request);
    } catch {
      return invalidRequestFailure();
    }

    try {
      const items: StorageCallRecordSummaryDto[] = [];
      const issues = new Map<string, StorageReadModelIssueDto>();

      const entries = await this.catalog.getEntries();
      for (const entry of filter.projectId
        ? entries.filter((candidate) => candidate.projectId === filter.projectId)
        : entries) {
        if (!(await isAvailable(entry))) {
          addIssue(issues, entry, 'unavailable');
          continue;
        }
        try {
          const facts = await loadProjectFacts(entry);
          for (const attempt of facts.attempts) {
            try {
              const built = await this.buildRecord(entry, facts, attempt);
              if (matchesFilter(built.summary, filter)) items.push(built.summary);
            } catch {
              addIssue(issues, entry, 'invalid_data');
            }
          }
        } catch {
          addIssue(issues, entry, 'invalid_data');
        }
      }

      const sorted = items.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.projectId.localeCompare(right.projectId) ||
        left.invocationAttemptId.localeCompare(right.invocationAttemptId)
      );
      return {
        ok: true,
        value: {
          items: sorted.slice(filter.offset, filter.offset + filter.limit),
          total: sorted.length,
          offset: filter.offset,
          limit: filter.limit,
          issues: [...issues.values()]
        }
      };
    } catch {
      return readFailure();
    }
  }

  async getCallDetails(
    request: unknown
  ): Promise<StorageIpcResult<StorageCallDetailsDto | undefined>> {
    let parsed: { readonly projectId: string; readonly invocationAttemptId: string };
    try {
      parsed = parseDetailsRequest(request);
    } catch {
      return invalidRequestFailure();
    }

    try {
      const entry = (await this.catalog.getEntries()).find(
        (candidate) => candidate.projectId === parsed.projectId
      );
      if (!entry || !(await isAvailable(entry))) return { ok: true, value: undefined };
      const facts = await loadProjectFacts(entry);
      const attempt = facts.attempts.find(
        (candidate) => candidate.id === toProviderInvocationAttemptId(parsed.invocationAttemptId)
      );
      if (!attempt || attempt.projectId !== parsed.projectId) {
        return { ok: true, value: undefined };
      }
      return { ok: true, value: (await this.buildRecord(entry, facts, attempt)).details };
    } catch {
      return readFailure();
    }
  }

  async getTaskTimeline(
    request: unknown
  ): Promise<StorageIpcResult<StorageTaskTimelineDto>> {
    let parsed: { readonly projectId: string; readonly taskId: string };
    try {
      parsed = parseTaskTimelineRequest(request);
    } catch {
      return invalidRequestFailure();
    }

    try {
      const entry = (await this.catalog.getEntries()).find(
        (candidate) => candidate.projectId === parsed.projectId
      );
      if (!entry) return { ok: true, value: { items: [], issues: [] } };
      if (!(await isAvailable(entry))) {
        return {
          ok: true,
          value: { items: [], issues: [toIssue(entry, 'unavailable')] }
        };
      }
      try {
        const facts = await loadProjectFacts(entry);
        const attempts = facts.attempts.filter((attempt) =>
          attempt.projectId === parsed.projectId &&
          attempt.subject.kind === 'media' &&
          attempt.subject.taskId === parsed.taskId
        );
        const items = await Promise.all(
          attempts.map(async (attempt) => (await this.buildRecord(entry, facts, attempt)).details)
        );
        return {
          ok: true,
          value: {
            items: items.sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.invocationAttemptId.localeCompare(right.invocationAttemptId)
            ),
            issues: []
          }
        };
      } catch {
        return {
          ok: true,
          value: { items: [], issues: [toIssue(entry, 'invalid_data')] }
        };
      }
    } catch {
      return readFailure();
    }
  }

  async getConsumptionSummary(
    request: unknown = {}
  ): Promise<StorageIpcResult<StorageConsumptionSummaryDto>> {
    let calendarDays: number;
    try {
      calendarDays = parseConsumptionSummaryRequest(request);
    } catch {
      return invalidRequestFailure();
    }

    try {
      const period = consumptionPeriod(this.now(), calendarDays);
      const conversionFacts = parseConversionFacts(
        await this.currencyConversions.listApprovedFacts('CNY')
      );
      const conversionsByCurrency = new Map(
        conversionFacts.map((fact) => [fact.sourceCurrencyCode, fact])
      );
      const usedConversionCurrencies = new Set<string>();
      const issues = new Map<string, StorageReadModelIssueDto>();
      const bucketTotals = new Map(period.dates.map((date) => [date, emptyConsumptionTotal()]));
      const providerTotals = new Map<string, ProviderConsumptionTotal>();
      const pendingCurrencies = new Map<string, number>();
      let totalAmount = zeroExactDecimal();
      let totalCallCount = 0;
      let successfulCallCount = 0;
      let pricedCallCount = 0;
      let includedCallCount = 0;
      let pendingConversionCallCount = 0;
      let missingPricingRuleCount = 0;
      let missingUsageCount = 0;
      let invalidFeeCount = 0;

      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) {
          addIssue(issues, entry, 'unavailable');
          continue;
        }
        try {
          const facts = await loadProjectFacts(entry);
          for (const attempt of facts.attempts) {
            if (!period.includes(attempt.createdAt)) continue;
            totalCallCount += 1;
            try {
              const call = (await this.buildRecord(entry, facts, attempt)).details;
              if (call.state !== 'completed') continue;
              successfulCallCount += 1;
              const fee = calculateExactSuccessfulCallFee(call);
              if (fee.state === 'missing_pricing') {
                missingPricingRuleCount += 1;
                continue;
              }
              if (fee.state === 'missing_usage') {
                missingUsageCount += 1;
                continue;
              }
              if (fee.state !== 'calculated') {
                invalidFeeCount += 1;
                continue;
              }
              pricedCallCount += 1;
              let cnyAmount = fee.amount;
              if (fee.currencyCode !== 'CNY') {
                const conversion = conversionsByCurrency.get(fee.currencyCode);
                if (!conversion) {
                  pendingConversionCallCount += 1;
                  pendingCurrencies.set(
                    fee.currencyCode,
                    (pendingCurrencies.get(fee.currencyCode) ?? 0) + 1
                  );
                  continue;
                }
                cnyAmount = multiplyExactDecimal(cnyAmount, conversion.rate);
                usedConversionCurrencies.add(fee.currencyCode);
              }

              includedCallCount += 1;
              totalAmount = addExactDecimal(totalAmount, cnyAmount);
              const date = utcDateKey(call.createdAt);
              const bucket = bucketTotals.get(date);
              if (bucket) {
                bucketTotals.set(date, {
                  amount: addExactDecimal(bucket.amount, cnyAmount),
                  callCount: bucket.callCount + 1
                });
              }
              const providerKey = call.providerId;
              const provider = providerTotals.get(providerKey) ?? {
                providerId: providerKey,
                label: call.providerName ?? providerKey,
                amount: zeroExactDecimal(),
                callCount: 0
              };
              providerTotals.set(providerKey, {
                ...provider,
                label: preferredProviderLabel(provider.label, call.providerName, providerKey),
                amount: addExactDecimal(provider.amount, cnyAmount),
                callCount: provider.callCount + 1
              });
            } catch {
              addIssue(issues, entry, 'invalid_data');
              invalidFeeCount += 1;
            }
          }
        } catch {
          addIssue(issues, entry, 'invalid_data');
        }
      }

      return {
        ok: true,
        value: {
          currencyCode: 'CNY',
          currencyLabel: '人民币',
          period: {
            startDate: period.dates[0]!,
            endDate: period.dates.at(-1)!,
            calendarDays,
            timeZone: 'UTC'
          },
          totalAmount: formatExactDecimal(totalAmount),
          totalCallCount,
          successfulCallCount,
          pricedCallCount,
          includedCallCount,
          pendingConversionCallCount,
          missingPricingRuleCount,
          missingUsageCount,
          invalidFeeCount,
          timeBuckets: period.dates.map((date) => {
            const bucket = bucketTotals.get(date)!;
            return {
              date,
              amount: formatExactDecimal(bucket.amount),
              callCount: bucket.callCount
            };
          }),
          providerSlices: buildProviderSlices(providerTotals, totalAmount),
          pendingCurrencies: [...pendingCurrencies.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([currencyCode, callCount]) => ({ currencyCode, callCount })),
          conversionSources: conversionFacts
            .filter((fact) => usedConversionCurrencies.has(fact.sourceCurrencyCode))
            .map(toConversionSourceDto),
          issues: [...issues.values()],
          disclaimer: 'local_estimate_not_provider_bill'
        }
      };
    } catch {
      return readFailure();
    }
  }

  private async buildRecord(
    entry: ProjectCatalogEntry,
    facts: ProjectCallFacts,
    attempt: ProviderInvocationAttemptV1
  ): Promise<BuiltCallRecord> {
    const route = facts.routesById.get(attempt.routeSnapshotId);
    if (
      !route ||
      route.projectId !== attempt.projectId ||
      route.id !== attempt.routeSnapshotId
    ) {
      throw new TypeError('Provider invocation route snapshot is unavailable');
    }
    const events = facts.eventsByAttempt.get(attempt.id) ?? [];
    const observations = facts.usageByAttempt.get(attempt.id) ?? [];
    const localResults = facts.localResultsByAttempt.get(attempt.id) ?? [];
    const calculatedAt = latestTimestamp(attempt, events, observations, localResults);
    const schema = await this.usageSchemas.resolve({
      usageSchemaId: route.usageSchemaId,
      usageSchemaRevision: route.usageSchemaRevision
    });
    if (!schema && observations.length > 0) {
      throw new TypeError('Provider usage schema is unavailable for recorded observations');
    }
    const usage = schema
      ? summarizeProviderUsage({
          invocationAttemptId: attempt.id,
          schema,
          observations,
          attemptState: attempt.state,
          calculatedAt
        })
      : noObservationUsage(attempt, calculatedAt);
    const readModel = buildProviderInvocationReadModel({
      attempt,
      events,
      usage,
      localResults
    });
    const registration = resultRegistration(
      readModel,
      facts.worksByExecution
    );
    const officialPricingRule = resolveOfficialPricingRule(route);
    const updatedAt = readModel.timeline.at(-1)?.occurredAt ?? readModel.createdAt;
    const providerName = route.providerDisplayName;
    const connectionName = route.connectionDisplayName;
    const modelName = route.modelDisplayName;
    const summary: StorageCallRecordSummaryDto = {
      invocationAttemptId: readModel.invocationAttemptId,
      projectId: entry.projectId,
      projectName: entry.projectName,
      subjectKind: readModel.subject.kind,
      productFeature: route.productFeature,
      providerId: route.providerId,
      connectionId: route.connectionId,
      modelId: route.modelId,
      ...(providerName ? { providerName } : {}),
      ...(connectionName ? { connectionName } : {}),
      ...(modelName ? { modelName } : {}),
      displayNameAvailability: providerName && connectionName && modelName
        ? 'snapshotted'
        : 'unavailable',
      state: readModel.state,
      createdAt: readModel.createdAt,
      updatedAt,
      ...(isTerminal(readModel.state)
        ? { durationMs: durationBetween(readModel.createdAt, updatedAt) }
        : {}),
      ...(readModel.retryOfInvocationAttemptId
        ? { retryOfInvocationAttemptId: readModel.retryOfInvocationAttemptId }
        : {}),
      usageAvailability: readModel.usage.availability,
      localResultCount: readModel.localResults.length,
      resultRegistrationState: registration.state
    };
    return {
      summary,
      details: {
        ...summary,
        subject: structuredClone(readModel.subject),
        timeline: readModel.timeline.map((event) => ({ ...event })),
        usage: {
          availability: readModel.usage.availability,
          facts: readModel.usage.facts.map((fact) => ({ ...fact })),
          calculatedAt: readModel.usage.calculatedAt
        },
        ...(officialPricingRule ? { officialPricingRule } : {}),
        localResults: readModel.localResults.map((result) => ({
          mediaKind: result.mediaKind,
          outputCount: result.outputCount,
          ...(result.durationMs ? { durationMs: result.durationMs } : {}),
          ...(result.width === undefined ? {} : { width: result.width }),
          ...(result.height === undefined ? {} : { height: result.height }),
          ...(result.byteLength ? { byteLength: result.byteLength } : {}),
          ...(result.resultImageUrl
            ? { resultImageUrl: result.resultImageUrl }
            : {}),
          validationState: result.validationState,
          observedAt: result.observedAt
        })),
        resultRegistration: registration
      }
    };
  }
}

function createContext(entry: ProjectCatalogEntry) {
  const storage = new NodeProjectStorage(entry.rootDirectory);
  return {
    invocations: new JsonProviderInvocationRepository(storage, entry.projectId),
    routes: new JsonProviderExecutionRouteSnapshotRepository(storage, entry.projectId),
    usage: new JsonProviderUsageObservationRepository(storage),
    localResults: new JsonLocalResultObservationRepository(storage),
    works: new JsonWorkRepository(storage, entry.projectId)
  };
}

async function loadProjectFacts(
  entry: ProjectCatalogEntry,
  context = createContext(entry)
): Promise<ProjectCallFacts> {
  const [invocations, routes, usage, localResults, works] = await Promise.all([
    context.invocations.readAll(),
    context.routes.list(),
    context.usage.list(),
    context.localResults.list(),
    context.works.list(entry.projectId)
  ]);
  return {
    attempts: invocations.attempts,
    eventsByAttempt: groupBy(invocations.events, (event) => event.invocationAttemptId),
    routesById: new Map(routes.map((route) => [route.id, route])),
    usageByAttempt: groupBy(usage, (observation) => observation.invocationAttemptId),
    localResultsByAttempt: groupBy(
      localResults,
      (observation) => observation.invocationAttemptId
    ),
    worksByExecution: groupBy(works, (work) => work.sourceExecutionId)
  };
}

function resultRegistration(
  readModel: ProviderInvocationReadModelV1,
  worksByExecution: ReadonlyMap<string, readonly Work[]>
): StorageCallResultRegistrationDto {
  const subject = readModel.subject;
  if (subject.kind !== 'media') {
    return { state: 'not_applicable', workIds: [] };
  }
  const works = [...(worksByExecution.get(subject.executionId) ?? [])]
    .filter((work) => work.sourceTaskId === subject.taskId)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  return {
    state: works.length > 0 ? 'registered' : 'not_registered',
    workIds: works.map((work) => work.id)
  };
}

function noObservationUsage(
  attempt: ProviderInvocationAttemptV1,
  calculatedAt: IsoTimestamp
): ProviderUsageSummaryV1 {
  return {
    schemaVersion: 1,
    invocationAttemptId: attempt.id,
    availability: attempt.state === 'unknown_outcome'
      ? 'unknown_outcome'
      : 'not_reported',
    facts: [],
    calculatedAt
  };
}

function latestTimestamp(
  attempt: ProviderInvocationAttemptV1,
  events: readonly ProviderInvocationEventV1[],
  observations: readonly ProviderUsageObservationV1[],
  localResults: readonly LocalResultObservationV1[]
): IsoTimestamp {
  return toIsoTimestamp([
    attempt.createdAt,
    ...events.map((event) => event.occurredAt),
    ...observations.map((observation) => observation.observedAt),
    ...localResults.map((result) => result.observedAt)
  ].sort().at(-1)!);
}

function matchesFilter(
  item: StorageCallRecordSummaryDto,
  filter: ParsedCallFilter
): boolean {
  return (
    (filter.projectId === undefined || item.projectId === filter.projectId) &&
    (filter.productFeature === undefined || item.productFeature === filter.productFeature) &&
    (filter.providerId === undefined || item.providerId === filter.providerId) &&
    (filter.connectionId === undefined || item.connectionId === filter.connectionId) &&
    (filter.modelId === undefined || item.modelId === filter.modelId) &&
    (filter.state === undefined || item.state === filter.state) &&
    (filter.createdFrom === undefined || item.createdAt >= filter.createdFrom) &&
    (filter.createdTo === undefined || item.createdAt <= filter.createdTo)
  );
}

function parseCallFilter(value: unknown): ParsedCallFilter {
  if (!isRecord(value)) throw invalidRequest();
  const allowed = new Set([
    'projectId',
    'productFeature',
    'providerId',
    'connectionId',
    'modelId',
    'state',
    'createdFrom',
    'createdTo',
    'offset',
    'limit'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidRequest();
  const createdFrom = optionalTimestamp(value.createdFrom);
  const createdTo = optionalTimestamp(value.createdTo);
  if (createdFrom && createdTo && createdFrom > createdTo) throw invalidRequest();
  const state = optionalString(value.state);
  if (state && !providerInvocationStates.includes(state as never)) throw invalidRequest();
  let productFeature: string | undefined;
  if (value.productFeature !== undefined) {
    try {
      productFeature = parseProductFeature(value.productFeature);
    } catch {
      throw invalidRequest();
    }
  }
  return {
    ...(optionalId(value.projectId) ? { projectId: optionalId(value.projectId) } : {}),
    ...(productFeature ? { productFeature } : {}),
    ...(optionalId(value.providerId) ? { providerId: optionalId(value.providerId) } : {}),
    ...(optionalId(value.connectionId)
      ? { connectionId: optionalId(value.connectionId) }
      : {}),
    ...(optionalId(value.modelId) ? { modelId: optionalId(value.modelId) } : {}),
    ...(state ? { state } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
    offset: boundedInteger(value.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    limit: boundedInteger(value.limit, 1, 200, 50)
  };
}

function parseConsumptionSummaryRequest(value: unknown): number {
  if (!isRecord(value)) throw invalidRequest();
  if (Object.keys(value).some((key) => key !== 'calendarDays')) throw invalidRequest();
  return boundedInteger(value.calendarDays, 1, 31, 7);
}

function consumptionPeriod(now: Date, calendarDays: number) {
  if (Number.isNaN(now.getTime())) throw new TypeError('Invalid current time');
  const end = new Date(now);
  const start = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate() - calendarDays + 1
  ));
  const dates = Array.from({ length: calendarDays }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return utcDateKey(date.toISOString());
  });
  const startTimestamp = start.toISOString();
  const endTimestamp = end.toISOString();
  return {
    dates,
    includes(value: string) {
      return value >= startTimestamp && value <= endTimestamp;
    }
  };
}

function utcDateKey(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('Invalid timestamp');
  return parsed.toISOString().slice(0, 10);
}

function parseConversionFacts(
  values: readonly CurrencyConversionFactV1[]
): readonly ParsedCurrencyConversionFact[] {
  const currencies = new Set<string>();
  return values.map((value) => {
    const sourceCurrencyCode = normalizeCurrencyCode(value.sourceCurrencyCode);
    if (sourceCurrencyCode === 'CNY' || value.targetCurrencyCode !== 'CNY') {
      throw new TypeError('Invalid conversion pair');
    }
    if (currencies.has(sourceCurrencyCode)) throw new TypeError('Duplicate conversion fact');
    currencies.add(sourceCurrencyCode);
    const rate = parseExactDecimal(value.rate);
    if (rate.numerator <= 0n) throw new TypeError('Invalid conversion rate');
    if (
      typeof value.sourceTitle !== 'string' ||
      value.sourceTitle.trim().length < 1 ||
      value.sourceTitle.trim().length > 200
    ) {
      throw new TypeError('Invalid conversion source');
    }
    const sourceUrl = new URL(value.sourceUrl);
    if (
      sourceUrl.protocol !== 'https:' ||
      sourceUrl.username ||
      sourceUrl.password ||
      sourceUrl.search ||
      sourceUrl.hash
    ) {
      throw new TypeError('Invalid conversion source URL');
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(value.sourceCheckedAt) ||
      utcDateKey(`${value.sourceCheckedAt}T00:00:00.000Z`) !== value.sourceCheckedAt
    ) {
      throw new TypeError('Invalid conversion check date');
    }
    return {
      sourceCurrencyCode,
      targetCurrencyCode: 'CNY',
      rate,
      sourceTitle: value.sourceTitle.trim(),
      sourceUrl: sourceUrl.toString(),
      sourceCheckedAt: value.sourceCheckedAt
    };
  });
}

function normalizeCurrencyCode(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Invalid currency');
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) throw new TypeError('Invalid currency');
  return normalized;
}

function emptyConsumptionTotal(): ConsumptionTotal {
  return { amount: zeroExactDecimal(), callCount: 0 };
}

function preferredProviderLabel(
  current: string,
  candidate: string | undefined,
  providerId: string
): string {
  if (!candidate) return current;
  if (current === providerId) return candidate;
  return current.localeCompare(candidate) <= 0 ? current : candidate;
}

function buildProviderSlices(
  totals: ReadonlyMap<string, ProviderConsumptionTotal>,
  totalAmount: ExactDecimal
): readonly StorageConsumptionProviderSliceDto[] {
  if (totalAmount.numerator <= 0n) return [];
  const sorted = [...totals.values()]
    .filter((item) => item.amount.numerator > 0n)
    .sort((left, right) =>
      compareExactDecimal(right.amount, left.amount) ||
      left.providerId.localeCompare(right.providerId)
    );
  const visible = sorted.slice(0, 5).map((item) => ({
    key: item.providerId,
    providerId: item.providerId,
    label: item.label,
    amount: item.amount,
    callCount: item.callCount,
    isOther: false
  }));
  const remainder = sorted.slice(5);
  if (remainder.length > 0) {
    visible.push({
      key: 'other',
      providerId: '',
      label: '其他',
      amount: remainder.reduce(
        (sum, item) => addExactDecimal(sum, item.amount),
        zeroExactDecimal()
      ),
      callCount: remainder.reduce((sum, item) => sum + item.callCount, 0),
      isOther: true
    });
  }
  const ratios = allocateBasisPoints(visible.map((item) => item.amount), totalAmount);
  return visible.map((item, index) => ({
    key: item.key,
    ...(item.isOther ? {} : { providerId: item.providerId }),
    label: item.label,
    amount: formatExactDecimal(item.amount),
    callCount: item.callCount,
    ratioBasisPoints: ratios[index]!,
    isOther: item.isOther
  }));
}

function allocateBasisPoints(
  amounts: readonly ExactDecimal[],
  total: ExactDecimal
): readonly number[] {
  const allocations = amounts.map((amount, index) => {
    const numerator = amount.numerator * total.denominator * 10_000n;
    const denominator = amount.denominator * total.numerator;
    return {
      index,
      points: Number(numerator / denominator),
      remainder: numerator % denominator,
      denominator
    };
  });
  const missing = 10_000 - allocations.reduce((sum, item) => sum + item.points, 0);
  const byRemainder = [...allocations].sort((left, right) => {
    const comparison = left.remainder * right.denominator - right.remainder * left.denominator;
    return comparison > 0n ? -1 : comparison < 0n ? 1 : left.index - right.index;
  });
  for (let index = 0; index < missing; index += 1) {
    byRemainder[index % byRemainder.length]!.points += 1;
  }
  return allocations.sort((left, right) => left.index - right.index).map((item) => item.points);
}

function toConversionSourceDto(
  fact: ParsedCurrencyConversionFact
): StorageConsumptionConversionSourceDto {
  return {
    sourceCurrencyCode: fact.sourceCurrencyCode,
    targetCurrencyCode: 'CNY',
    sourceTitle: fact.sourceTitle,
    sourceUrl: fact.sourceUrl,
    sourceCheckedAt: fact.sourceCheckedAt
  };
}

function parseDetailsRequest(
  value: unknown
): { readonly projectId: string; readonly invocationAttemptId: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['projectId', 'invocationAttemptId'].includes(key))
  ) throw invalidRequest();
  return {
    projectId: requireId(value.projectId),
    invocationAttemptId: requireId(value.invocationAttemptId)
  };
}

function parseTaskTimelineRequest(
  value: unknown
): { readonly projectId: string; readonly taskId: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['projectId', 'taskId'].includes(key))
  ) throw invalidRequest();
  return {
    projectId: requireId(value.projectId),
    taskId: requireId(value.taskId)
  };
}

function optionalId(value: unknown): string | undefined {
  return value === undefined ? undefined : requireId(value);
}

function requireId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.trim().length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidRequest();
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length < 1) throw invalidRequest();
  return value.trim();
}

function optionalTimestamp(value: unknown): IsoTimestamp | undefined {
  if (value === undefined) return undefined;
  try {
    return toIsoTimestamp(String(value));
  } catch {
    throw invalidRequest();
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  defaultValue: number
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw invalidRequest();
  }
  return Number(value);
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const existing = groups.get(key);
    if (existing) existing.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function addIssue(
  issues: Map<string, StorageReadModelIssueDto>,
  entry: ProjectCatalogEntry,
  reason: StorageReadModelIssueDto['reason']
): void {
  issues.set(entry.projectId, {
    projectId: entry.projectId,
    projectName: entry.projectName,
    reason
  });
}

function toIssue(
  entry: ProjectCatalogEntry,
  reason: StorageReadModelIssueDto['reason']
): StorageReadModelIssueDto {
  return {
    projectId: entry.projectId,
    projectName: entry.projectName,
    reason
  };
}

async function isAvailable(entry: ProjectCatalogEntry): Promise<boolean> {
  try {
    return (await stat(entry.rootDirectory)).isDirectory();
  } catch {
    return false;
  }
}

function durationBetween(start: string, end: string): string {
  return String(Math.max(0, Date.parse(end) - Date.parse(start)));
}

function isTerminal(state: string): boolean {
  return [
    'failed_before_submission',
    'completed',
    'failed',
    'cancelled',
    'unknown_outcome'
  ].includes(state);
}

function schemaKey(id: string, revision: number): string {
  return `${id}\u0000${revision}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): TypeError {
  return new TypeError('The call record request is invalid');
}

function invalidRequestFailure<T>(): StorageIpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'The call record request is invalid'
    }
  };
}

function readFailure<T>(): StorageIpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'read_model_failed',
      message: 'The local call record read model could not be loaded'
    }
  };
}
