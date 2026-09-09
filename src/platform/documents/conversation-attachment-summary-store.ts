import { createHash } from 'node:crypto';
import { toProjectRelativePath, type NodeProjectStorage } from '../storage';

export const conversationSummaryCachePath = toProjectRelativePath('entities/conversation-attachment-summaries.json');
export interface AttachmentSummaryPart {
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly start: number;
  readonly end: number;
  readonly summary?: string;
  readonly summaryHash?: string;
}
export interface AttachmentSummaryCacheRecord {
  readonly key: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly parts: readonly AttachmentSummaryPart[];
  readonly failureOutcome?: 'not_sent' | 'known_failure' | 'unknown';
}
interface CacheDocument { readonly schemaVersion: 1; readonly records: readonly AttachmentSummaryCacheRecord[] }

export class AttachmentSummaryCacheBlockedError extends Error {}

export class ConversationAttachmentSummaryStore {
  constructor(private readonly storage: NodeProjectStorage, private readonly projectId: string) {}

  async get(key: string): Promise<AttachmentSummaryCacheRecord | undefined> {
    return this.parse(await this.storage.readJson(conversationSummaryCachePath)).records.find((record) => record.key === key);
  }

  async acquire(record: AttachmentSummaryCacheRecord): Promise<AttachmentSummaryCacheRecord> {
    this.parse({ schemaVersion: 1, records: [record] });
    let selected = record;
    await this.storage.mutateJsonAtomically(conversationSummaryCachePath, (current) => {
      const document = this.parse(current);
      const existing = document.records.find((item) => item.key === record.key);
      if (existing?.status === 'running' || existing?.failureOutcome === 'unknown') {
        throw new AttachmentSummaryCacheBlockedError('Previous source summary outcome is unknown');
      }
      if (existing?.status === 'completed') { selected = existing; return document; }
      if (existing && JSON.stringify(normalizeParts(existing.parts)) !== JSON.stringify(normalizeParts(record.parts))) {
        throw new Error('Attachment summary coverage changed');
      }
      selected = existing ? { ...existing, status: 'running', failureOutcome: undefined } : record;
      const records = document.records.filter((item) => item.key !== record.key);
      if (records.length >= 100) {
        const evict = records.findIndex((item) => item.status !== 'running' && item.failureOutcome !== 'unknown');
        if (evict < 0) throw new AttachmentSummaryCacheBlockedError('Source summary cache is awaiting outcomes');
        records.splice(evict, 1);
      }
      return { schemaVersion: 1, records: [...records, selected] };
    }, { backup: true });
    return selected;
  }

  async save(record: AttachmentSummaryCacheRecord): Promise<void> {
    this.parse({ schemaVersion: 1, records: [record] });
    await this.storage.mutateJsonAtomically(conversationSummaryCachePath, (current) => {
      const document = this.parse(current);
      if (!document.records.some((item) => item.key === record.key)) throw new Error('Attachment summary reservation is missing');
      return { schemaVersion: 1, records: document.records.map((item) => item.key === record.key ? record : item) };
    }, { backup: true });
  }

  private parse(value: unknown): CacheDocument {
    if (value === undefined) return { schemaVersion: 1, records: [] };
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records) || value.records.length > 100) {
      throw new Error('Invalid attachment summary cache');
    }
    for (const record of value.records) {
      if (!isRecord(record) || !isHash(record.key) || record.projectId !== this.projectId || typeof record.conversationId !== 'string' ||
        !['running', 'completed', 'failed'].includes(String(record.status)) || !Array.isArray(record.parts) || record.parts.length < 1 || record.parts.length > 4 ||
        (record.failureOutcome !== undefined && !['not_sent', 'known_failure', 'unknown'].includes(String(record.failureOutcome)))) throw new Error('Invalid attachment summary record');
      for (const part of record.parts) {
        if (!isRecord(part) || typeof part.sourceId !== 'string' || !isHash(part.sourceHash) ||
          !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || Number(part.start) < 0 ||
          Number(part.end) <= Number(part.start) || Number(part.end) - Number(part.start) > 8000 ||
          (part.summary !== undefined && (typeof part.summary !== 'string' || !part.summary.trim() || part.summary.length > 1800 ||
            part.summaryHash !== summaryHash(part.summary))) ||
          (record.status === 'completed' && part.summary === undefined)) throw new Error('Invalid attachment summary part');
      }
    }
    if (new Set(value.records.map((record: AttachmentSummaryCacheRecord) => record.key)).size !== value.records.length) {
      throw new Error('Duplicate attachment summary records');
    }
    return value as unknown as CacheDocument;
  }
}

function normalizeParts(parts: readonly AttachmentSummaryPart[]): readonly Pick<AttachmentSummaryPart, 'sourceId' | 'sourceHash' | 'start' | 'end'>[] {
  return parts.map(({ sourceId, sourceHash, start, end }) => ({ sourceId, sourceHash, start, end }));
}

export function summaryHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function isHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
