import {
  parseDocumentContextSnapshot,
  type DocumentContextAttachment,
  type DocumentContextExistingDocument,
  type DocumentContextReference,
  type DocumentContextSnapshot,
  type DocumentContextSourcePolicy
} from '../domain';

export interface BuildDocumentContextSnapshotInput {
  readonly projectId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly requestText: string;
  readonly attachments?: readonly DocumentContextAttachment[];
  readonly existingDocuments?: readonly DocumentContextExistingDocument[];
  readonly references?: readonly DocumentContextReference[];
  readonly styleConstraints?: readonly string[];
  readonly sourcePolicy?: DocumentContextSourcePolicy;
  readonly truncated?: boolean;
}

export async function buildDocumentContextSnapshot(input: BuildDocumentContextSnapshotInput): Promise<DocumentContextSnapshot> {
  const requestHash = await sha256(input.requestText);
  return parseDocumentContextSnapshot({
    schemaVersion: 1,
    projectId: input.projectId,
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId,
    requestText: input.requestText,
    requestHash,
    attachments: input.attachments ?? [],
    existingDocuments: input.existingDocuments ?? [],
    references: input.references ?? [],
    styleConstraints: input.styleConstraints ?? [],
    sourcePolicy: input.sourcePolicy ?? 'internal_only',
    truncated: input.truncated ?? false
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
