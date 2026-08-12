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
  StorageIpcResult,
  StorageReadModelIssueDto
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

export class ProviderInvocationReadModelController {
  constructor(
    private readonly catalog: ProjectCatalogService,
    private readonly usageSchemas: ProviderUsageSchemaResolverPort = noUsageSchemas
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

      for (const entry of await this.catalog.getEntries()) {
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
    let invocationAttemptId: string;
    try {
      invocationAttemptId = parseDetailsRequest(request);
    } catch {
      return invalidRequestFailure();
    }

    try {
      let match: StorageCallDetailsDto | undefined;
      for (const entry of await this.catalog.getEntries()) {
        if (!(await isAvailable(entry))) continue;
        const context = createContext(entry);
        let attempt: ProviderInvocationAttemptV1 | undefined;
        try {
          attempt = await context.invocations.get(
            toProviderInvocationAttemptId(invocationAttemptId)
          );
        } catch {
          continue;
        }
        if (!attempt) continue;
        try {
          const facts = await loadProjectFacts(entry, context);
          const built = await this.buildRecord(entry, facts, attempt);
          if (match) return readFailure();
          match = built.details;
        } catch {
          return readFailure();
        }
      }
      return { ok: true, value: match };
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
  const [attempts, events, routes, usage, localResults, works] = await Promise.all([
    context.invocations.list(),
    context.invocations.listEvents(),
    context.routes.list(),
    context.usage.list(),
    context.localResults.list(),
    context.works.list(entry.projectId)
  ]);
  return {
    attempts,
    eventsByAttempt: groupBy(events, (event) => event.invocationAttemptId),
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

function parseDetailsRequest(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1) throw invalidRequest();
  return requireId(value.invocationAttemptId);
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
