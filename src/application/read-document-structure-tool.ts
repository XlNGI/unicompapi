import {
  createCanonicalToolRegistry, validateCanonicalToolArguments,
  type CanonicalToolRegistry, type CanonicalToolArguments, type DocumentToolResult
} from '../domain/entities/canonical-tool-contract';
import type { DocumentIR } from '../domain/entities/document-agent';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from './document-atomic-tools';

/** Read-only binding. Document selection and physical-page resolution are host-owned. */
export function createReadDocumentStructureBinding(options: {
  readonly registry?: CanonicalToolRegistry;
  /** A host may supply a verified physical-page reader; never infer page numbers from sections. */
  readonly readPage?: (ordinal: number, context: DocumentAtomicExecutionContext) => Promise<Readonly<Record<string, unknown>>>;
} = {}): DocumentAtomicToolBinding {
  const contract = (options.registry ?? createCanonicalToolRegistry()).get('read_document_structure');
  if (!contract) throw new TypeError('tool_not_registered');
  return {
    contract,
    authorize: async (_args, context) => Boolean(context.currentDocumentId && context.currentDocumentIR &&
      Number.isSafeInteger(context.revision) && Number(context.revision) >= 0 && context.authorization.canRead &&
      context.authorization.allowedToolIds.includes(contract.toolId) && !context.abortSignal.aborted),
    execute: async (input, context) => {
      const args: CanonicalToolArguments = validateCanonicalToolArguments(contract, input);
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      const ir = context.currentDocumentIR;
      if (!ir || !context.currentDocumentId) return failed('TOOL_PRECONDITION_FAILED');
      const content = ir.content;
      if (args.scope === 'page') {
        if (!options.readPage) return failed('page_scope_unavailable');
        if (content?.pageCount !== undefined && Number(args.ordinal) > content.pageCount) return failed('target_not_found');
        const page = await options.readPage(Number(args.ordinal), context);
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        return { schemaVersion: 1, status: 'success', observation: { scope: args.scope, ordinal: args.ordinal,
          revision: context.revision!, page } };
      }
      const sections = content?.sections ?? [];
      const selected = args.scope === 'section' ? sections.slice(Number(args.ordinal) - 1, Number(args.ordinal)) : sections;
      if (args.scope === 'section' && selected.length !== 1) return failed('target_not_found');
      return {
        schemaVersion: 1, status: 'success', observation: {
          scope: args.scope, revision: context.revision!, totalSections: sections.length,
          ...(args.ordinal === undefined ? {} : { ordinal: args.ordinal }),
          ...(content ? { title: content.title } : {}),
          ...(content?.pageCount === undefined ? {} : { pageCount: content.pageCount }),
          sections: selected.map(sectionObservation)
        }
      };
    }
  };
}

function sectionObservation(section: NonNullable<DocumentIR['content']>['sections'][number]) {
  return { sectionId: section.sectionId, heading: section.heading, blockCount: section.blocks.length,
    blocks: section.blocks.map(block => ({ blockId: block.blockId, kind: block.kind,
      ...(block.content === undefined ? {} : { text: block.content }) })) };
}

function failed(code: string, status: 'failed' | 'cancelled' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}
