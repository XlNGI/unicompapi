import { toWorkId, type WorkId } from '../ids';

export const documentWorkspaceKinds = ['word', 'excel', 'ppt'] as const;
export type DocumentWorkspaceKind = (typeof documentWorkspaceKinds)[number];

export const documentWorkspaceKindExtensions: Readonly<
  Record<DocumentWorkspaceKind, string>
> = {
  word: '.docx',
  excel: '.xlsx',
  ppt: '.pptx'
};

export interface DocumentMessageResult {
  readonly workId: WorkId;
  readonly fileName: string;
  readonly kind: DocumentWorkspaceKind;
  readonly sizeBytes: number;
}

export function parseDocumentMessageResult(
  value: unknown
): DocumentMessageResult {
  if (!isRecord(value)) {
    throw new TypeError('message.documentResult must be an object');
  }
  const workId = toWorkId(
    requireNonBlankString(value.workId, 'message.documentResult.workId')
  );
  const fileName = requireNonBlankString(
    value.fileName,
    'message.documentResult.fileName'
  );
  if (fileName.length > 255) {
    throw new TypeError('message.documentResult.fileName exceeds the maximum length');
  }
  const kind = requireKind(value.kind);
  const sizeBytes = requireNonNegativeInteger(
    value.sizeBytes,
    'message.documentResult.sizeBytes'
  );
  return { workId, fileName, kind, sizeBytes };
}

export function isDocumentMessageResult(
  value: unknown
): value is DocumentMessageResult {
  try {
    parseDocumentMessageResult(value);
    return true;
  } catch {
    return false;
  }
}

function requireKind(value: unknown): DocumentWorkspaceKind {
  if (
    typeof value !== 'string' ||
    !documentWorkspaceKinds.includes(value as DocumentWorkspaceKind)
  ) {
    throw new TypeError('message.documentResult.kind is invalid');
  }
  return value as DocumentWorkspaceKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}
