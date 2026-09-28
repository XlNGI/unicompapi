import {
  createCanonicalToolRegistry,
  type ToolExecutionContext
} from '../../src/domain/entities/canonical-tool-contract';

export const readDocumentToolContract = createCanonicalToolRegistry().get('read_document_structure')!;

/** Host-only fixture. Neither document identity nor authorization belongs in model arguments. */
export function readDocumentToolContext(): ToolExecutionContext {
  return {
    operation: 'analyze',
    currentDocumentId: 'document-current',
    currentDocumentIR: { operation: 'analyze', attachmentRefs: [], documentRef: 'document-current' },
    revision: 3,
    capabilities: [readDocumentToolContract.toolId],
    projectContext: { projectId: 'project-current' },
    authorization: { canRead: true, canWrite: false, allowedToolIds: [readDocumentToolContract.toolId] },
    abortSignal: new AbortController().signal,
    taskContext: { taskId: 'task-current' }
  };
}
