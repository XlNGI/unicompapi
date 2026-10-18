export type ConversationDocumentPageErrorCode =
  | 'document_page_unavailable'
  | 'document_page_out_of_range'
  | 'document_page_ambiguous'
  | 'document_page_scope_exceeded';

export class ConversationDocumentPageError extends Error {
  constructor(readonly code: ConversationDocumentPageErrorCode, message: string) {
    super(message);
    this.name = 'ConversationDocumentPageError';
  }
}

