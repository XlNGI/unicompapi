import type {
  ConversationId,
  DocumentDraftId,
  MessageId,
  ProjectId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import type { DocumentWorkspaceKind } from './document-generation';

export const documentDraftSources = [
  'assistant_json',
  'user_paste',
  'attachment'
] as const;

export type DocumentDraftSource = (typeof documentDraftSources)[number];

export interface DocumentDraft {
  readonly schemaVersion: 1;
  readonly id: DocumentDraftId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly source: DocumentDraftSource;
  readonly format: DocumentWorkspaceKind;
  readonly summary: string;
  readonly rawJson: string;
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly supersedes?: DocumentDraftId;
  readonly createdAt: IsoTimestamp;
}

export function createDocumentDraft(
  input: Omit<DocumentDraft, 'schemaVersion'>
): DocumentDraft {
  return {
    ...input,
    schemaVersion: 1
  };
}
