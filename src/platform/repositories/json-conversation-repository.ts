import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  parseConversation,
  toIsoTimestamp,
  type Conversation,
  type ConversationId,
  type ConversationListOptions,
  type ConversationRepository,
  type ConversationStatus,
  type IsoTimestamp
} from '../../domain';

export type ConversationLoadSource = 'primary' | 'backup' | 'default';

export interface ConversationDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly conversations: readonly Conversation[];
}

export interface ConversationDocumentMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(value: Readonly<Record<string, unknown>>): unknown;
}

export class ConversationRevisionConflictError extends Error {
  constructor(
    readonly conversationId: ConversationId,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super(
      `Conversation revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`
    );
    this.name = 'ConversationRevisionConflictError';
  }
}

export class ConversationRepositoryDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationRepositoryDataError';
  }
}

interface ConversationLoadResult {
  readonly document: ConversationDocumentV1;
  readonly source: ConversationLoadSource;
  readonly primaryText?: string;
}

const writeQueues = new Map<string, Promise<void>>();

export class JsonConversationRepository implements ConversationRepository {
  private readonly conversationPath: string;
  private readonly backupPath: string;

  constructor(
    conversationPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly migrations: readonly ConversationDocumentMigration[] = []
  ) {
    if (conversationPath.trim().length === 0) {
      throw new TypeError('Conversation repository path cannot be empty');
    }
    this.conversationPath = path.resolve(conversationPath);
    this.backupPath = `${this.conversationPath}.bak`;
  }

  async get(id: ConversationId): Promise<Conversation | undefined> {
    await this.waitForWrites();
    const { document } = await this.readCurrent();
    return document.conversations.find((conversation) => conversation.id === id);
  }

  async list(
    options: ConversationListOptions = {}
  ): Promise<readonly Conversation[]> {
    await this.waitForWrites();
    const { document } = await this.readCurrent();
    const statuses = normalizeStatuses(options.statuses);
    return document.conversations
      .filter((conversation) => statuses.has(conversation.status))
      .filter((conversation) =>
        options.projectId === undefined || conversation.projectId === options.projectId
      )
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      );
  }

  async create(conversation: Conversation): Promise<void> {
    const validated = parseConversation(conversation);
    if (validated.revision !== 0) {
      throw new ConversationRepositoryDataError(
        'A newly created conversation must have revision 0'
      );
    }
    await this.enqueueWrite(async () => {
      const current = await this.readCurrent();
      const existing = current.document.conversations.find(
        (item) => item.id === validated.id
      );
      if (existing) {
        throw new ConversationRevisionConflictError(validated.id, null, existing.revision);
      }
      await this.writeDocument(
        {
          schemaVersion: 1,
          revision: current.document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          conversations: [...current.document.conversations, validated]
        },
        current
      );
    });
  }

  async save(
    conversation: Conversation,
    expectedRevision: number
  ): Promise<void> {
    const validated = parseConversation(conversation);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('Expected conversation revision is invalid');
    }
    if (validated.revision !== expectedRevision + 1) {
      throw new ConversationRepositoryDataError(
        'Saved conversation revision must increment exactly once'
      );
    }
    await this.enqueueWrite(async () => {
      const current = await this.readCurrent();
      const index = current.document.conversations.findIndex(
        (item) => item.id === validated.id
      );
      const actualRevision = index < 0
        ? null
        : current.document.conversations[index].revision;
      if (actualRevision !== expectedRevision) {
        throw new ConversationRevisionConflictError(
          validated.id,
          expectedRevision,
          actualRevision
        );
      }
      const conversations = [...current.document.conversations];
      conversations[index] = validated;
      await this.writeDocument(
        {
          schemaVersion: 1,
          revision: current.document.revision + 1,
          updatedAt: toIsoTimestamp(this.now()),
          conversations
        },
        current
      );
    });
  }

  private async waitForWrites(): Promise<void> {
    await (writeQueues.get(this.conversationPath) ?? Promise.resolve());
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const previous = writeQueues.get(this.conversationPath) ?? Promise.resolve();
    const current = previous.then(operation);
    writeQueues.set(this.conversationPath, current.catch(() => undefined));
    await current;
  }

  private async readCurrent(): Promise<ConversationLoadResult> {
    try {
      const primaryText = await readFile(this.conversationPath, 'utf8');
      return {
        document: migrateConversationDocument(
          JSON.parse(primaryText),
          this.migrations
        ),
        source: 'primary',
        primaryText
      };
    } catch (primaryError) {
      if (isNodeError(primaryError) && primaryError.code === 'ENOENT') {
        return this.readBackupOrDefault();
      }
      try {
        const backupText = await readFile(this.backupPath, 'utf8');
        return {
          document: migrateConversationDocument(
            JSON.parse(backupText),
            this.migrations
          ),
          source: 'backup'
        };
      } catch (backupError) {
        throw new ConversationRepositoryDataError(
          'Conversation data is invalid and no valid backup is available',
          { primaryError, backupError }
        );
      }
    }
  }

  private async readBackupOrDefault(): Promise<ConversationLoadResult> {
    try {
      const backupText = await readFile(this.backupPath, 'utf8');
      return {
        document: migrateConversationDocument(
          JSON.parse(backupText),
          this.migrations
        ),
        source: 'backup'
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw new ConversationRepositoryDataError(
          'Conversation backup is invalid',
          error
        );
      }
      return {
        document: {
          schemaVersion: 1,
          revision: 0,
          updatedAt: toIsoTimestamp(this.now()),
          conversations: []
        },
        source: 'default'
      };
    }
  }

  private async writeDocument(
    document: ConversationDocumentV1,
    current: ConversationLoadResult
  ): Promise<void> {
    const validated = parseConversationDocument(document);
    if (current.source === 'primary' && current.primaryText !== undefined) {
      migrateConversationDocument(JSON.parse(current.primaryText), this.migrations);
      await writeTextAtomically(this.backupPath, current.primaryText);
    }
    await writeTextAtomically(
      this.conversationPath,
      `${JSON.stringify(validated, null, 2)}\n`
    );
  }
}

export function migrateConversationDocument(
  value: unknown,
  migrations: readonly ConversationDocumentMigration[] = []
): ConversationDocumentV1 {
  let current = requireRecord(value, 'conversation document');
  let version = requireSchemaVersion(current.schemaVersion);
  const byVersion = new Map<number, ConversationDocumentMigration>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      migration.fromVersion < 0 ||
      migration.toVersion !== migration.fromVersion + 1 ||
      byVersion.has(migration.fromVersion)
    ) {
      throw new ConversationRepositoryDataError(
        'Conversation migration registry is invalid'
      );
    }
    byVersion.set(migration.fromVersion, migration);
  }
  if (version > 1) {
    throw new ConversationRepositoryDataError(
      `Conversation schema version ${version} is newer than supported`
    );
  }
  while (version < 1) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new ConversationRepositoryDataError(
        `No conversation migration exists for version ${version}`
      );
    }
    current = requireRecord(
      migration.migrate(current),
      'migrated conversation document'
    );
    const nextVersion = requireSchemaVersion(current.schemaVersion);
    if (nextVersion !== migration.toVersion) {
      throw new ConversationRepositoryDataError(
        'Conversation migration returned an unexpected version'
      );
    }
    version = nextVersion;
  }
  return parseConversationDocument(current);
}

export function parseConversationDocument(value: unknown): ConversationDocumentV1 {
  const record = requireRecord(value, 'conversation document');
  requireExactKeys(
    record,
    ['schemaVersion', 'revision', 'updatedAt', 'conversations'],
    'conversation document'
  );
  if (record.schemaVersion !== 1) {
    throw new ConversationRepositoryDataError(
      'Conversation document schema version is unsupported'
    );
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw new ConversationRepositoryDataError(
      'Conversation document revision is invalid'
    );
  }
  if (!Array.isArray(record.conversations)) {
    throw new ConversationRepositoryDataError(
      'Conversation document conversations must be an array'
    );
  }
  const ids = new Set<string>();
  const conversations = record.conversations.map((value) => {
    try {
      const conversation = parseConversation(value);
      if (ids.has(conversation.id)) {
        throw new TypeError(`duplicate conversation id ${conversation.id}`);
      }
      ids.add(conversation.id);
      return conversation;
    } catch (error) {
      throw new ConversationRepositoryDataError(
        'Conversation document contains an invalid conversation',
        error
      );
    }
  });
  try {
    const updatedAt = toIsoTimestamp(
      requireString(record.updatedAt, 'document.updatedAt')
    );
    if (conversations.some((conversation) => conversation.updatedAt > updatedAt)) {
      throw new TypeError(
        'document.updatedAt cannot be older than a stored conversation'
      );
    }
    return {
      schemaVersion: 1,
      revision: Number(record.revision),
      updatedAt,
      conversations
    };
  } catch (error) {
    throw new ConversationRepositoryDataError(
      'Conversation document metadata is invalid',
      error
    );
  }
}

function normalizeStatuses(
  statuses: readonly ConversationStatus[] | undefined
): ReadonlySet<ConversationStatus> {
  const values = statuses ?? ['active'];
  const result = new Set<ConversationStatus>();
  for (const status of values) {
    if (!['active', 'archived', 'deleted'].includes(status)) {
      throw new TypeError(`Conversation status ${status} is invalid`);
    }
    result.add(status);
  }
  return result;
}

async function writeTextAtomically(target: string, content: string): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomUUID()}.tmp`
  );
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectoryBestEffort(parent);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConversationRepositoryDataError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw new ConversationRepositoryDataError(
      `${label} contains unexpected or missing fields`
    );
  }
}

function requireSchemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ConversationRepositoryDataError(
      'Conversation schema version is invalid'
    );
  }
  return Number(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
