export interface DocumentVersionPin {
  readonly documentLineageId: string;
  readonly headWorkId: string;
  readonly fileId: string;
  readonly sourceExecutionId: string;
  readonly checksumSha256: string;
  readonly runtimeRevision: number;
  readonly identityIndexVersion: number;
}

export function parseDocumentVersionPin(value: unknown): DocumentVersionPin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_document_version_pin');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['documentLineageId', 'headWorkId', 'fileId', 'sourceExecutionId', 'checksumSha256', 'runtimeRevision', 'identityIndexVersion'].includes(key)) ||
      ![item.documentLineageId, item.headWorkId, item.fileId, item.sourceExecutionId].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) ||
      typeof item.checksumSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.checksumSha256) ||
      !Number.isSafeInteger(item.runtimeRevision) || Number(item.runtimeRevision) < 0 ||
      item.identityIndexVersion !== 1) throw new TypeError('invalid_document_version_pin');
  return Object.freeze({ documentLineageId: item.documentLineageId as string, headWorkId: item.headWorkId as string,
    fileId: item.fileId as string, sourceExecutionId: item.sourceExecutionId as string, checksumSha256: item.checksumSha256,
    runtimeRevision: Number(item.runtimeRevision), identityIndexVersion: 1 });
}
