export const documentContextSourceKinds = [
  'project',
  'attachment',
  'retrieval',
  'brand'
] as const;
export type DocumentContextSourceKind = (typeof documentContextSourceKinds)[number];

export const documentContextSourcePolicies = ['internal_only', 'web_only', 'mixed'] as const;
export type DocumentContextSourcePolicy = (typeof documentContextSourcePolicies)[number];

export interface DocumentContextAttachment {
  readonly fileId: string;
  readonly contentHash?: string;
}

export interface DocumentContextExistingDocument {
  readonly documentRef: string;
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly fileName: string;
  readonly revision?: number;
}

export interface DocumentContextReference {
  readonly sourceId: string;
  readonly sourceKind: DocumentContextSourceKind;
  readonly contentHash: string;
  readonly excerpt: string;
  readonly location?: string;
}

export interface DocumentContextSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly requestText: string;
  readonly requestHash: string;
  readonly attachments: readonly DocumentContextAttachment[];
  readonly existingDocuments: readonly DocumentContextExistingDocument[];
  readonly references: readonly DocumentContextReference[];
  readonly styleConstraints: readonly string[];
  readonly sourcePolicy: DocumentContextSourcePolicy;
  readonly truncated: boolean;
}

const maxTextLength = 8_000;
const maxItems = 64;
const maxExcerptLength = 4_000;

export function parseDocumentContextSnapshot(value: unknown): DocumentContextSnapshot {
  const record = requireRecord(value, 'DocumentContextSnapshot');
  requireExactKeys(record, [
    'schemaVersion', 'projectId', 'conversationId', 'sourceMessageId', 'requestText',
    'requestHash', 'attachments', 'existingDocuments', 'references', 'styleConstraints',
    'sourcePolicy', 'truncated'
  ]);
  if (record.schemaVersion !== 1) throw new TypeError('DocumentContextSnapshot.schemaVersion is invalid');
  const requestText = safeText(record.requestText, 'requestText', maxTextLength);
  const requestHash = hash(record.requestHash, 'requestHash');
  const attachments = parseAttachments(record.attachments);
  const existingDocuments = parseExistingDocuments(record.existingDocuments);
  const references = parseReferences(record.references);
  const styleConstraints = textList(record.styleConstraints, 'styleConstraints');
  if (!documentContextSourcePolicies.includes(record.sourcePolicy as DocumentContextSourcePolicy)) {
    throw new TypeError('DocumentContextSnapshot.sourcePolicy is invalid');
  }
  if (typeof record.truncated !== 'boolean') throw new TypeError('DocumentContextSnapshot.truncated is invalid');
  return {
    schemaVersion: 1,
    projectId: safeId(record.projectId, 'projectId'),
    conversationId: safeId(record.conversationId, 'conversationId'),
    sourceMessageId: safeId(record.sourceMessageId, 'sourceMessageId'),
    requestText,
    requestHash,
    attachments,
    existingDocuments,
    references,
    styleConstraints,
    sourcePolicy: record.sourcePolicy as DocumentContextSourcePolicy,
    truncated: record.truncated
  };
}

function parseAttachments(value: unknown): readonly DocumentContextAttachment[] {
  const items = boundedArray(value, 'attachments');
  return items.map((item, index) => {
    const record = requireRecord(item, `attachments[${index}]`);
    requireExactKeys(record, ['fileId', 'contentHash']);
    return {
      fileId: safeId(record.fileId, `attachments[${index}].fileId`),
      ...(record.contentHash === undefined ? {} : { contentHash: hash(record.contentHash, `attachments[${index}].contentHash`) })
    };
  });
}

function parseExistingDocuments(value: unknown): readonly DocumentContextExistingDocument[] {
  const items = boundedArray(value, 'existingDocuments');
  return items.map((item, index) => {
    const record = requireRecord(item, `existingDocuments[${index}]`);
    requireExactKeys(record, ['documentRef', 'kind', 'fileName', 'revision']);
    if (!['word', 'excel', 'ppt'].includes(String(record.kind))) throw new TypeError(`existingDocuments[${index}].kind is invalid`);
    return {
      documentRef: safeId(record.documentRef, `existingDocuments[${index}].documentRef`),
      kind: record.kind as DocumentContextExistingDocument['kind'],
      fileName: safeText(record.fileName, `existingDocuments[${index}].fileName`, 240),
      ...(record.revision === undefined ? {} : { revision: nonNegativeInteger(record.revision, `existingDocuments[${index}].revision`) })
    };
  });
}

function parseReferences(value: unknown): readonly DocumentContextReference[] {
  const items = boundedArray(value, 'references');
  const ids = new Set<string>();
  return items.map((item, index) => {
    const record = requireRecord(item, `references[${index}]`);
    requireExactKeys(record, ['sourceId', 'sourceKind', 'contentHash', 'excerpt', 'location']);
    const sourceId = safeId(record.sourceId, `references[${index}].sourceId`);
    if (ids.has(sourceId)) throw new TypeError(`references[${index}].sourceId is duplicated`);
    ids.add(sourceId);
    if (!documentContextSourceKinds.includes(record.sourceKind as DocumentContextSourceKind)) throw new TypeError(`references[${index}].sourceKind is invalid`);
    return {
      sourceId,
      sourceKind: record.sourceKind as DocumentContextSourceKind,
      contentHash: hash(record.contentHash, `references[${index}].contentHash`),
      excerpt: safeText(record.excerpt, `references[${index}].excerpt`, maxExcerptLength),
      ...(record.location === undefined ? {} : { location: safeText(record.location, `references[${index}].location`, 240) })
    };
  });
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} is invalid`);
  return value;
}

function textList(value: unknown, label: string): readonly string[] {
  return boundedArray(value, label).map((item, index) => safeText(item, `${label}[${index}]`, 500));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`unsupported field: ${unsupported}`);
}

function safeId(value: unknown, label: string): string {
  const text = safeText(value, label, 240);
  if (!/^[a-zA-Z0-9._:-]+$/u.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function safeText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new TypeError(`${label} is invalid`);
  if (/(?:api[_ -]?key|access[_ -]?token|secret|password|凭证|密钥)\s*[:=：]\s*\S+/iu.test(value)) throw new TypeError(`${label} contains a protected value`);
  if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|\\\\|\/)/iu.test(value)) throw new TypeError(`${label} must not contain a path or URL`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32,128}$/iu.test(value)) throw new TypeError(`${label} is invalid`);
  return value.toLowerCase();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} is invalid`);
  return Number(value);
}
