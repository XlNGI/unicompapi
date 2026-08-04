import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { toIsoTimestamp, type IsoTimestamp } from '../../domain';
import { sharedFileWriteCoordinator } from '../storage';

export type ConnectionOutboundScope =
  | 'external_service'
  | 'local_network'
  | 'local_device'
  | 'unknown';

export interface ConnectionOutboundAuthorizationRecordV1 {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly recipientName: string;
  readonly scope: ConnectionOutboundScope;
  readonly authorizationRevision: number;
  readonly confirmedAt: IsoTimestamp;
}

interface ConnectionOutboundAuthorizationDocumentV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly records: readonly ConnectionOutboundAuthorizationRecordV1[];
}

export interface ConnectionOutboundAuthorizationPort {
  check(input: {
    readonly connectionId: string;
    readonly connectionRevision: number;
    readonly recipientName: string;
    readonly scope: ConnectionOutboundScope;
    readonly expectedAuthorizationRevision?: number;
    readonly now: IsoTimestamp;
  }): Promise<{ readonly authorized: boolean; readonly authorizationRevision?: number }>;
  authorize(input: {
    readonly connectionId: string;
    readonly connectionRevision: number;
    readonly recipientName: string;
    readonly scope: ConnectionOutboundScope;
    readonly confirmedAt: IsoTimestamp;
  }): Promise<{ readonly authorizationRevision: number }>;
}

export const noConnectionOutboundAuthorization: ConnectionOutboundAuthorizationPort = {
  async check() { return { authorized: false }; },
  async authorize() { return { authorizationRevision: 1 }; }
};

export class JsonConnectionOutboundAuthorizationStore
  implements ConnectionOutboundAuthorizationPort {
  constructor(
    private readonly documentPath: string,
    private readonly lifetimeMs = 30 * 24 * 60 * 60 * 1000
  ) {
    if (!path.isAbsolute(documentPath) ||
      !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000) {
      throw new TypeError('Connection outbound authorization configuration is invalid');
    }
  }

  async check(input: {
    readonly connectionId: string;
    readonly connectionRevision: number;
    readonly recipientName: string;
    readonly scope: ConnectionOutboundScope;
    readonly expectedAuthorizationRevision?: number;
    readonly now: IsoTimestamp;
  }): Promise<{ readonly authorized: boolean; readonly authorizationRevision?: number }> {
    const request = parseCheck(input);
    const record = (await this.load()).records.find((candidate) =>
      candidate.connectionId === request.connectionId &&
      candidate.connectionRevision === request.connectionRevision &&
      candidate.recipientName === request.recipientName &&
      candidate.scope === request.scope
    );
    const age = record
      ? Date.parse(request.now) - Date.parse(record.confirmedAt)
      : -1;
    const authorized = Boolean(
      record &&
      (request.expectedAuthorizationRevision === undefined ||
        record.authorizationRevision === request.expectedAuthorizationRevision) &&
      age >= 0 && age < this.lifetimeMs
    );
    return authorized
      ? { authorized: true, authorizationRevision: record!.authorizationRevision }
      : { authorized: false };
  }

  async authorize(input: {
    readonly connectionId: string;
    readonly connectionRevision: number;
    readonly recipientName: string;
    readonly scope: ConnectionOutboundScope;
    readonly confirmedAt: IsoTimestamp;
  }): Promise<{ readonly authorizationRevision: number }> {
    const request = parseAuthorization(input);
    return sharedFileWriteCoordinator.runExclusive(this.documentPath, async () => {
      const current = await this.loadDisk() ?? emptyDocument();
      const existing = current.records.find((record) =>
        record.connectionId === request.connectionId && record.scope === request.scope
      );
      const record: ConnectionOutboundAuthorizationRecordV1 = {
        schemaVersion: 1,
        ...request,
        authorizationRevision: (existing?.authorizationRevision ?? 0) + 1
      };
      const document: ConnectionOutboundAuthorizationDocumentV1 = {
        schemaVersion: 1,
        revision: current.revision + 1,
        records: [
          ...current.records.filter((candidate) =>
            candidate.connectionId !== request.connectionId || candidate.scope !== request.scope
          ),
          record
        ]
      };
      await writeJsonAtomically(this.documentPath, document);
      return { authorizationRevision: record.authorizationRevision };
    });
  }

  private async load(): Promise<ConnectionOutboundAuthorizationDocumentV1> {
    return await this.loadDisk() ?? emptyDocument();
  }

  private async loadDisk(): Promise<ConnectionOutboundAuthorizationDocumentV1 | undefined> {
    try {
      return parseDocument(JSON.parse(await readFile(this.documentPath, 'utf8')));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

function emptyDocument(): ConnectionOutboundAuthorizationDocumentV1 {
  return { schemaVersion: 1, revision: 0, records: [] };
}

function parseDocument(value: unknown): ConnectionOutboundAuthorizationDocumentV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.records) ||
    Object.keys(value).some((key) => !['schemaVersion', 'revision', 'records'].includes(key))) {
    throw new TypeError('Connection outbound authorization document is invalid');
  }
  const records = value.records.map(parseRecord);
  if (new Set(records.map((record) => `${record.connectionId}\u0000${record.scope}`)).size !==
    records.length) {
    throw new TypeError('Connection outbound authorization records must be unique');
  }
  return {
    schemaVersion: 1,
    revision: Number(value.revision),
    records
  };
}

function parseRecord(value: unknown): ConnectionOutboundAuthorizationRecordV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    Object.keys(value).some((key) => ![
      'schemaVersion', 'connectionId', 'connectionRevision', 'recipientName', 'scope',
      'authorizationRevision', 'confirmedAt'
    ].includes(key))) {
    throw new TypeError('Connection outbound authorization record is invalid');
  }
  return {
    schemaVersion: 1,
    connectionId: stableId(value.connectionId),
    connectionRevision: positiveInteger(value.connectionRevision),
    recipientName: recipientName(value.recipientName),
    scope: scope(value.scope),
    authorizationRevision: positiveInteger(value.authorizationRevision),
    confirmedAt: toIsoTimestamp(String(value.confirmedAt))
  };
}

function parseCheck(input: {
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly recipientName: string;
  readonly scope: ConnectionOutboundScope;
  readonly expectedAuthorizationRevision?: number;
  readonly now: IsoTimestamp;
}) {
  return {
    connectionId: stableId(input.connectionId),
    connectionRevision: positiveInteger(input.connectionRevision),
    recipientName: recipientName(input.recipientName),
    scope: scope(input.scope),
    expectedAuthorizationRevision: input.expectedAuthorizationRevision === undefined
      ? undefined
      : positiveInteger(input.expectedAuthorizationRevision),
    now: toIsoTimestamp(input.now)
  };
}

function parseAuthorization(input: {
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly recipientName: string;
  readonly scope: ConnectionOutboundScope;
  readonly confirmedAt: IsoTimestamp;
}) {
  return {
    connectionId: stableId(input.connectionId),
    connectionRevision: positiveInteger(input.connectionRevision),
    recipientName: recipientName(input.recipientName),
    scope: scope(input.scope),
    confirmedAt: toIsoTimestamp(input.confirmedAt)
  };
}

function stableId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new TypeError('Connection outbound authorization ID is invalid');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError('Connection outbound authorization revision is invalid');
  }
  return Number(value);
}

function recipientName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
    value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Connection outbound authorization recipient is invalid');
  }
  return value.trim();
}

function scope(value: unknown): ConnectionOutboundScope {
  if (!['external_service', 'local_network', 'local_device', 'unknown'].includes(String(value))) {
    throw new TypeError('Connection outbound authorization scope is invalid');
  }
  return value as ConnectionOutboundScope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeJsonAtomically(targetPath: string, value: unknown): Promise<void> {
  const parent = path.dirname(targetPath);
  const temporary = path.join(parent, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, targetPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
