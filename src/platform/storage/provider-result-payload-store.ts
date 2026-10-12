import { createHash } from 'node:crypto';
import type { ProviderImmediateResultReference } from '../../domain/entities/provider';
import type { ProviderOperationRecord } from '../../domain/entities/provider-operation';
import { toProjectRelativePath } from './project-paths';
import type { ProjectStorageAdapter } from './storage-adapter';

type Base64Result = Extract<ProviderImmediateResultReference, { kind: 'base64' }>;
type StoredBase64Result = Extract<ProviderImmediateResultReference, { kind: 'stored_base64' }>;

const maximumBase64Length = Math.ceil(128 * 1024 * 1024 / 3) * 4;
const maximumMimeTypeLength = 1024;

export class ProviderResultPayloadStore {
  constructor(private readonly storage: ProjectStorageAdapter) {}

  async externalize(record: ProviderOperationRecord): Promise<ProviderOperationRecord> {
    if (record.outcome.kind !== 'completed_sync' || !record.outcome.results.some((result) => result.kind === 'base64')) {
      return record;
    }
    const results: ProviderImmediateResultReference[] = [];
    for (const result of record.outcome.results) {
      results.push(result.kind === 'base64' ? await this.store(result) : result);
    }
    return { ...record, outcome: { ...record.outcome, results } };
  }

  async resolve(result: StoredBase64Result): Promise<Base64Result> {
    const payloadPath = pathForReference(result);
    return verifyPayload(await this.storage.readJson<unknown>(payloadPath), result);
  }

  private async store(result: Base64Result): Promise<StoredBase64Result> {
    const payload = parsePayload(result);
    const reference: StoredBase64Result = {
      kind: 'stored_base64',
      value: payloadHash(payload),
      mimeType: payload.mimeType
    };
    const payloadPath = pathForReference(reference);
    await this.storage.withExclusiveAccess([payloadPath], async () => {
      const existing = await this.storage.readJson<unknown>(payloadPath);
      if (existing !== undefined) {
        const verified = verifyPayload(existing, reference);
        if (verified.value !== payload.value) throw new TypeError('Provider result payload content mismatch');
        return;
      }
      await this.storage.writeJsonAtomically(payloadPath, payload);
      const verified = verifyPayload(await this.storage.readJson<unknown>(payloadPath), reference);
      if (verified.value !== payload.value) throw new TypeError('Provider result payload content mismatch');
    });
    return reference;
  }
}

function pathForReference(result: StoredBase64Result) {
  if (
    result.kind !== 'stored_base64' ||
    typeof result.value !== 'string' ||
    result.value.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(result.value)
  ) {
    throw new TypeError('Invalid stored provider result hash');
  }
  validateMimeType(result.mimeType);
  return toProjectRelativePath(`results/provider-payloads/${result.value}.json`);
}

function parsePayload(value: unknown): Base64Result {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider result payload is missing or invalid');
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.kind !== 'base64' ||
    typeof payload.value !== 'string' ||
    payload.value.length > maximumBase64Length
  ) {
    throw new TypeError('Provider result payload is invalid or too large');
  }
  validateMimeType(payload.mimeType);
  return { kind: 'base64', value: payload.value, mimeType: payload.mimeType };
}

function validateMimeType(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > maximumMimeTypeLength || value.trim().length === 0) {
    throw new TypeError('Invalid provider result MIME type');
  }
}

function verifyPayload(value: unknown, reference: StoredBase64Result): Base64Result {
  const payload = parsePayload(value);
  if (payload.mimeType !== reference.mimeType || payloadHash(payload) !== reference.value) {
    throw new TypeError('Provider result payload integrity check failed');
  }
  return payload;
}

function payloadHash(payload: Base64Result): string {
  return createHash('sha256').update(JSON.stringify([payload.mimeType, payload.value])).digest('hex');
}
