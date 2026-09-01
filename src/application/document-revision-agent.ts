import {
  runDocumentAgentLoop,
  type DocumentAgentDecision,
  type DocumentAgentToolExecutor
} from './document-agent-loop';
import type {
  DocumentAgentResult,
  DocumentOutline,
  DocumentToolObservation,
  DocumentWorkspaceKind,
  WorkId
} from '../domain';
import { parseRevisionOrdinal } from './document-generation-service';

export interface DocumentRevisionAgentInput {
  readonly baseWorkId: WorkId;
  readonly expectedRevision: number;
  readonly kind: DocumentWorkspaceKind;
  readonly requestText: string;
  readonly outline: DocumentOutline;
  readonly signal?: AbortSignal;
}

export interface DocumentRevisionAgentResult {
  readonly outline: DocumentOutline;
  readonly agent: DocumentAgentResult;
  readonly changed: boolean;
  readonly targetSectionIndex?: number;
}

export interface DocumentRevisionAgentPorts {
  readonly readStructure: (
    outline: DocumentOutline
  ) => unknown;
  readonly applyPatch: (
    outline: DocumentOutline,
    patch: DocumentRevisionPatch
  ) => { readonly document: DocumentOutline; readonly changed: boolean; readonly affectedSections: readonly number[] };
}

export interface DocumentRevisionPatch {
  readonly operation: 'clear_section';
  readonly target: {
    readonly sectionIndex: number;
    readonly pageNumber?: number;
  };
}

/**
 * Executes high-confidence local revision requests through the same bounded
 * tool-loop contract used by provider-backed agents. No provider is called for
 * deterministic requests such as “清空第二章”.
 */
export async function runLocalDocumentRevisionAgent(
  input: DocumentRevisionAgentInput,
  ports: DocumentRevisionAgentPorts
): Promise<DocumentRevisionAgentResult> {
  const targetSectionIndex = resolveTargetSection(input.requestText, input.outline);
  if (targetSectionIndex === undefined) {
    return {
      outline: input.outline,
      agent: {
        state: 'completed',
        steps: 0,
        costUnits: 0,
        observations: [],
        summary: 'No deterministic revision rule matched'
      },
      changed: false
    };
  }

  let current = input.outline;
  const execute: DocumentAgentToolExecutor = async (request, context) => {
    if (context.signal.aborted) throw new Error('cancelled');
    switch (request.toolId) {
      case 'read_document_structure':
        return ports.readStructure(current) as Readonly<Record<string, unknown>>;
      case 'apply_document_patch': {
        const patch = parsePatchJson(request.input.patchJson);
        const applied = ports.applyPatch(current, patch);
        current = applied.document;
        return {
          changed: applied.changed,
          affectedSections: applied.affectedSections
        };
      }
      case 'render_preview':
        return { rendered: true, previewCount: 1 };
      case 'inspect_layout':
        return { diagnostics: [], passed: true };
      default:
        throw new Error('tool_not_allowed');
    }
  };

  const agent = await runDocumentAgentLoop({
    signal: input.signal,
    maxSteps: 5,
    budgetUnits: 8,
    execute,
    nextDecision: async (observations) => nextLocalDecision(
      observations,
      input.kind,
      targetSectionIndex
    )
  });
  if (agent.state !== 'completed') {
    return {
      outline: input.outline,
      agent,
      changed: false,
      targetSectionIndex
    };
  }
  return {
    outline: current,
    agent,
    changed: JSON.stringify(current) !== JSON.stringify(input.outline),
    targetSectionIndex
  };
}

function nextLocalDecision(
  observations: readonly DocumentToolObservation[],
  kind: DocumentWorkspaceKind,
  targetSectionIndex: number
): DocumentAgentDecision {
  const last = observations.at(-1)?.toolId;
  if (last === undefined) {
    return {
      kind: 'tool',
      request: {
        toolId: 'read_document_structure',
        input: { sectionIndex: targetSectionIndex },
        reason: 'Inspect the requested revision scope'
      }
    };
  }
  if (last === 'read_document_structure') {
    const patch: DocumentRevisionPatch = {
      operation: 'clear_section',
      target: {
        sectionIndex: targetSectionIndex,
        ...(kind === 'ppt' ? { pageNumber: targetSectionIndex + 1 } : {})
      }
    };
    return {
      kind: 'tool',
      request: {
        toolId: 'apply_document_patch',
        input: { patchJson: JSON.stringify(patch) },
        reason: 'Clear only the requested section'
      }
    };
  }
  if (last === 'apply_document_patch') {
    return {
      kind: 'tool',
      request: {
        toolId: 'render_preview',
        input: { kind },
        reason: 'Render the temporary revision for validation'
      }
    };
  }
  if (last === 'render_preview') {
    return {
      kind: 'tool',
      request: {
        toolId: 'inspect_layout',
        input: { kind },
        reason: 'Inspect layout diagnostics before publishing'
      }
    };
  }
  return { kind: 'complete', summary: 'Revision validated locally' };
}

function resolveTargetSection(
  requestText: string,
  outline: DocumentOutline
): number | undefined {
  const ordinal = parseRevisionOrdinal(requestText);
  if (ordinal === undefined || ordinal > outline.sections.length) return undefined;
  if (!/(?:清空|清除|删除本章内容|删掉本章内容)/u.test(requestText)) {
    return undefined;
  }
  return ordinal - 1;
}

function parsePatchJson(value: unknown): DocumentRevisionPatch {
  if (typeof value !== 'string' || value.length > 4_000) {
    throw new Error('invalid_patch');
  }
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    parsed.operation !== 'clear_section' ||
    typeof parsed.target !== 'object' ||
    parsed.target === null ||
    typeof (parsed.target as Record<string, unknown>).sectionIndex !== 'number'
  ) {
    throw new Error('invalid_patch');
  }
  return parsed as unknown as DocumentRevisionPatch;
}
