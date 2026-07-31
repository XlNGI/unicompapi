export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonDocumentEnvelopeV1<TData extends JsonValue> {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly data: TData;
}

export interface LegacyJsonReadModel<T> {
  readonly document: T;
  readonly sourceSchemaVersion: number;
  readonly migrated: boolean;
  readonly readOnly: true;
}

export interface JsonDocumentMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(value: Readonly<Record<string, unknown>>): unknown;
}

export class JsonDocumentDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'JsonDocumentDataError';
  }
}

export class JsonRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`JSON revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'JsonRevisionConflictError';
  }
}

export function migrateJsonDocument<T>(
  value: unknown,
  targetVersion: number,
  migrations: readonly JsonDocumentMigration[],
  parse: (value: unknown) => T
): T {
  let current = requireRecord(value, 'JSON document');
  let version = requireVersion(current.schemaVersion);
  const registry = new Map<number, JsonDocumentMigration>();

  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      migration.fromVersion < 0 ||
      migration.toVersion !== migration.fromVersion + 1 ||
      registry.has(migration.fromVersion)
    ) {
      throw new JsonDocumentDataError('JSON migration registry is invalid');
    }
    registry.set(migration.fromVersion, migration);
  }

  if (version > targetVersion) {
    throw new JsonDocumentDataError(
      `JSON schema version ${version} is newer than supported ${targetVersion}`
    );
  }
  while (version < targetVersion) {
    const migration = registry.get(version);
    if (!migration) {
      throw new JsonDocumentDataError(`No JSON migration exists for version ${version}`);
    }
    current = requireRecord(migration.migrate(current), 'Migrated JSON document');
    const nextVersion = requireVersion(current.schemaVersion);
    if (nextVersion !== migration.toVersion) {
      throw new JsonDocumentDataError('JSON migration returned an unexpected version');
    }
    version = nextVersion;
  }
  return parse(current);
}

export function createJsonDocumentEnvelope<TData extends JsonValue>(
  data: TData,
  updatedAt: string,
  revision = 0
): JsonDocumentEnvelopeV1<TData> {
  requireRevision(revision);
  requireCanonicalTimestamp(updatedAt);
  assertSafeJsonValue(data, 'JSON document data');
  return {
    schemaVersion: 1,
    revision,
    updatedAt,
    data: structuredClone(data)
  };
}

export function parseJsonDocumentEnvelope<TData extends JsonValue>(
  value: unknown,
  parseData: (value: unknown) => TData
): JsonDocumentEnvelopeV1<TData> {
  const item = requireRecord(value, 'JSON document envelope');
  const expected = new Set(['schemaVersion', 'revision', 'updatedAt', 'data']);
  if (
    Object.keys(item).length !== expected.size ||
    Object.keys(item).some((key) => !expected.has(key)) ||
    item.schemaVersion !== 1
  ) {
    throw new JsonDocumentDataError('JSON document envelope is invalid');
  }
  requireRevision(item.revision);
  const updatedAt = requireCanonicalTimestamp(item.updatedAt);
  const data = parseData(item.data);
  assertSafeJsonValue(data, 'JSON document data');
  return {
    schemaVersion: 1,
    revision: Number(item.revision),
    updatedAt,
    data: structuredClone(data)
  };
}

export function createLegacyJsonReadModel<T>(
  value: unknown,
  targetVersion: number,
  migrations: readonly JsonDocumentMigration[],
  parse: (value: unknown) => T
): LegacyJsonReadModel<T> {
  const source = requireRecord(value, 'Legacy JSON document');
  const sourceSchemaVersion = requireVersion(source.schemaVersion);
  return {
    document: migrateJsonDocument(value, targetVersion, migrations, parse),
    sourceSchemaVersion,
    migrated: sourceSchemaVersion !== targetVersion,
    readOnly: true
  };
}

export function assertSafeJsonValue(value: unknown, label = 'JSON value'): asserts value is JsonValue {
  assertSafeJsonNode(value, label, new Set<object>());
}

function assertSafeJsonNode(value: unknown, label: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && /^Bearer\s+/i.test(value)) {
      throw new JsonDocumentDataError(`${label} contains authorization material`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonDocumentDataError(`${label} is not finite`);
    return;
  }
  if (typeof value !== 'object') {
    throw new JsonDocumentDataError(`${label} is not JSON serializable`);
  }
  if (seen.has(value)) throw new JsonDocumentDataError(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJsonNode(item, `${label}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonDocumentDataError(`${label} must contain plain objects only`);
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        throw new JsonDocumentDataError(`${label} contains forbidden field ${key}`);
      }
      assertSafeJsonNode(item, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function isSensitiveKey(key: string): boolean {
  return /^(api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|password|secret|signature|signed[-_]?url|credential)$/i.test(
    key
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonDocumentDataError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new JsonDocumentDataError('JSON schema version is invalid');
  }
  return Number(value);
}

function requireRevision(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new JsonDocumentDataError('JSON document revision is invalid');
  }
}

function requireCanonicalTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new JsonDocumentDataError('JSON document timestamp is invalid');
  }
  return value;
}
