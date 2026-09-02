import {
  runDocumentAgentLoop,
  type DocumentAgentDecision,
  type DocumentAgentToolExecutor
} from './document-agent-loop';
import type {
  DocumentAgentResult,
  DocumentOutline,
  DocumentOutlineSection,
  DocumentToolObservation,
  DocumentWorkspaceKind,
  WorkId
} from '../domain';

export interface DocumentRevisionAgentInput {
  readonly baseWorkId: WorkId;
  readonly expectedRevision: number;
  readonly kind: DocumentWorkspaceKind;
  readonly requestText: string;
  readonly outline: DocumentOutline;
  /** Provider output is content data only; it cannot choose tools or paths. */
  readonly proposedOutline?: DocumentOutline;
  readonly signal?: AbortSignal;
}

export interface DocumentRevisionAgentResult {
  readonly outline: DocumentOutline;
  readonly agent: DocumentAgentResult;
  readonly changed: boolean;
  readonly targetSectionIndex?: number;
  readonly patch?: DocumentRevisionPatch;
  readonly patches?: readonly DocumentRevisionPatch[];
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

export type DocumentRevisionPatch =
  | {
      readonly operation: 'clear_section';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly pageNumber?: number;
      };
    }
  | {
      readonly operation: 'replace_section';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly pageNumber?: number;
      };
      readonly replacement: DocumentOutlineSection;
    }
  | {
      readonly operation: 'replace_text';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly blockIndex: number;
      };
      readonly value: string;
    }
  | {
      readonly operation: 'update_cells';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly blockIndex: number;
        readonly rowIndex: number;
        readonly columnIndex: number;
      };
      readonly value: string;
    };

/**
 * Executes high-confidence local revision requests through the same bounded
 * tool-loop contract used by provider-backed agents. No provider is called for
 * deterministic requests such as “清空第二章”.
 */
export async function runLocalDocumentRevisionAgent(
  input: DocumentRevisionAgentInput,
  ports: DocumentRevisionAgentPorts
): Promise<DocumentRevisionAgentResult> {
  const patches = resolveRevisionPatches(input);
  if (patches.length === 0) {
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

  const targetSectionIndex = patches[0].target.sectionIndex;
  let current = input.outline;
  const execute: DocumentAgentToolExecutor = async (request, context) => {
    if (context.signal.aborted) throw new Error('cancelled');
    switch (request.toolId) {
      case 'read_document_structure':
        return ports.readStructure(current) as Readonly<Record<string, unknown>>;
      case 'apply_document_patch': {
        const requestedPatches = parsePatchJson(request.input.patchJson);
        let changed = false;
        const affectedSections = new Set<number>();
        for (const patch of requestedPatches) {
          const applied = ports.applyPatch(current, patch);
          current = applied.document;
          changed ||= applied.changed;
          applied.affectedSections.forEach((section) => affectedSections.add(section));
        }
        return {
          changed,
          affectedSections: [...affectedSections].sort((a, b) => a - b)
        };
      }
      case 'render_preview':
        return { scheduledForRunner: true, rendered: false };
      case 'inspect_layout':
        return { scheduledForRunner: true, inspected: false };
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
        patches
    )
  });
  if (agent.state !== 'completed') {
    return {
      outline: input.outline,
      agent,
      changed: false,
      targetSectionIndex,
      patches
    };
  }
  const renderObservation = agent.observations.find(
    (observation) => observation.toolId === 'render_preview'
  );
  const inspectObservation = agent.observations.find(
    (observation) => observation.toolId === 'inspect_layout'
  );
  const finalAgent =
    renderObservation?.data.rendered !== true || inspectObservation?.data.inspected !== true
      ? {
          ...agent,
          state: 'completed_unvalidated' as const,
          summary:
            'Revision patch structurally validated; rendering and visual inspection remain with the runner'
        }
      : agent;
  const changed = JSON.stringify(current) !== JSON.stringify(input.outline);
  return {
    outline: current,
    agent: finalAgent,
    changed,
    targetSectionIndex,
    ...(changed
      ? {
          ...(patches.length === 1 ? { patch: patches[0] } : {}),
          patches
        }
      : {})
  };
}

function nextLocalDecision(
  observations: readonly DocumentToolObservation[],
  kind: DocumentWorkspaceKind,
  patches: readonly DocumentRevisionPatch[]
): DocumentAgentDecision {
  const last = observations.at(-1)?.toolId;
  if (last === undefined) {
    return {
      kind: 'tool',
      request: {
        toolId: 'read_document_structure',
        input: { sectionIndexes: JSON.stringify(patches.map((patch) => patch.target.sectionIndex)) },
        reason: 'Inspect the requested revision scope'
      }
    };
  }
  if (last === 'read_document_structure') {
    return {
      kind: 'tool',
      request: {
        toolId: 'apply_document_patch',
        input: { patchJson: JSON.stringify(patches.length === 1 ? patches[0] : patches) },
        reason: patches.every((patch) => patch.operation === 'clear_section')
          ? 'Clear only the requested sections'
          : 'Apply only the bounded requested revisions'
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
  return {
    kind: 'complete',
    summary: 'Revision patch validated; file verification remains with the runner'
  };
}

function resolveRevisionPatches(
  input: DocumentRevisionAgentInput
): readonly DocumentRevisionPatch[] {
  const ordinals = parseRevisionOrdinals(input.requestText)
    .filter((ordinal) => ordinal <= input.outline.sections.length);
  if (ordinals.length === 0) return [];
  if (isExplicitClearRequest(input.requestText)) {
    return ordinals.map((ordinal) => ({
      operation: 'clear_section' as const,
      target: revisionTarget(input, ordinal)
    }));
  }
  if (
    !/(?:改写|重写|修改|改成|改为|调整|优化|精简|润色|扩写|扩充|丰富|补充|更新)/u.test(
      input.requestText
    )
  ) {
    return [];
  }
  if (
    !input.proposedOutline ||
    input.proposedOutline.kind !== input.outline.kind ||
    ordinals.some((ordinal) => !input.proposedOutline?.sections[ordinal - 1])
  ) {
    return [];
  }
  return ordinals.map((ordinal) => {
    const sectionIndex = ordinal - 1;
    const replacementSection = input.proposedOutline!.sections[sectionIndex];
    const target = revisionTarget(input, ordinal);
    return resolveFineGrainedPatches(
      input.kind,
      input.outline.sections[sectionIndex],
      replacementSection,
      target
    ) ?? [{
      operation: 'replace_section' as const,
      target,
      replacement: replacementSection
    }];
  }).flat();
}

function parseRevisionOrdinals(requestText: string): readonly number[] {
  const matches = [...requestText.matchAll(/第\s*([0-9一二两三四五六七八九十百零〇]+)\s*(?:章|节|页|部分)/gu)]
    .map((match) => parseOrdinalToken(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return [...new Set(matches)].slice(0, 8);
}

function parseOrdinalToken(token: string): number {
  if (/^\d+$/u.test(token)) return Number(token);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9
  };
  if (token === '十') return 10;
  if (token.startsWith('十')) return 10 + (digits[token.slice(1)] ?? 0);
  const ten = token.indexOf('十');
  if (ten >= 0) {
    return (digits[token.slice(0, ten)] ?? 0) * 10 + (digits[token.slice(ten + 1)] ?? 0);
  }
  return Number(token.split('').map((character) => digits[character] ?? '').join(''));
}

function revisionTarget(input: DocumentRevisionAgentInput, ordinal: number) {
  const sectionIndex = ordinal - 1;
  return {
    sectionIndex,
    sectionHeading: input.outline.sections[sectionIndex].heading,
    ...(input.kind === 'ppt' ? { pageNumber: ordinal + 1 } : {})
  };
}

function resolveFineGrainedPatches(
  kind: DocumentWorkspaceKind,
  current: DocumentOutlineSection,
  replacement: DocumentOutlineSection,
  target: { readonly sectionIndex: number; readonly sectionHeading: string; readonly pageNumber?: number }
): readonly DocumentRevisionPatch[] | undefined {
  if (kind === 'word' && current.blocks.length === replacement.blocks.length) {
    const changed = current.blocks
      .map((block, blockIndex) => ({ block, next: replacement.blocks[blockIndex], blockIndex }))
      .filter(({ block, next }) => JSON.stringify(block) !== JSON.stringify(next));
    if (changed.length > 0 && current.blocks.slice(0, Math.max(...changed.map((item) => item.blockIndex)) + 1).every((block, index) => {
      const next = replacement.blocks[index];
      return (block.type === 'paragraph' || block.type === 'quote' || block.type === 'chart') &&
        (next?.type === block.type);
    }) && changed.every((item) => (item.block.type === 'paragraph' || item.block.type === 'quote') && item.next?.type === item.block.type)) {
      return changed.map((item) => ({
          operation: 'replace_text',
          target: {
            sectionIndex: target.sectionIndex,
            sectionHeading: target.sectionHeading,
            blockIndex: item.blockIndex
          },
          value: (item.next as Extract<DocumentOutlineSection['blocks'][number], { type: 'paragraph' | 'quote' }>).text
        }));
    }
  }
  if (kind === 'excel' && current.blocks.length === replacement.blocks.length) {
    const changes: Array<{ blockIndex: number; rowIndex: number; columnIndex: number; value: string }> = [];
    for (let blockIndex = 0; blockIndex < current.blocks.length; blockIndex += 1) {
      const block = current.blocks[blockIndex];
      const next = replacement.blocks[blockIndex];
      if (block.type !== 'table' || next?.type !== 'table') {
        if (JSON.stringify(block) !== JSON.stringify(next)) return undefined;
        continue;
      }
      if (
        JSON.stringify(block.header) !== JSON.stringify(next.header) ||
        block.rows.length !== next.rows.length
      ) return undefined;
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        if (block.rows[rowIndex].length !== next.rows[rowIndex]?.length) return undefined;
        for (let columnIndex = 0; columnIndex < block.rows[rowIndex].length; columnIndex += 1) {
          if (block.rows[rowIndex][columnIndex] !== next.rows[rowIndex][columnIndex]) {
            changes.push({
              blockIndex,
              rowIndex,
              columnIndex,
              value: next.rows[rowIndex][columnIndex]
            });
          }
        }
      }
    }
    if (changes.length > 0) {
      return changes.map((change) => ({
        operation: 'update_cells',
        target: {
          sectionIndex: target.sectionIndex,
          sectionHeading: target.sectionHeading,
          blockIndex: change.blockIndex,
          rowIndex: change.rowIndex,
          columnIndex: change.columnIndex
        },
        value: change.value
      }));
    }
  }
  return undefined;
}

function isExplicitClearRequest(requestText: string): boolean {
  // The target ordinal is validated above, so only accept clear/delete
  // wording that is explicitly tied to the section's content. Users commonly
  // place the action before the target ("删除第二章的内容") or after it
  // ("将第二章的内容删掉"). Keep this bounded instead of treating every
  // generic "删除" request as a destructive clear operation.
  const clearsContent =
    /(?:清空|清除)[\s\S]{0,24}|(?:删除|删掉)[\s\S]{0,24}(?:内容|本章|这一章|该章节)|(?:内容|本章|这一章|该章节)[\s\S]{0,24}(?:删除|删掉)/u.test(requestText);
  return clearsContent;
}

function parsePatchJson(value: unknown): readonly DocumentRevisionPatch[] {
  if (typeof value !== 'string' || value.length > 64_000) {
    throw new Error('invalid_patch');
  }
  const decoded = JSON.parse(value) as unknown;
  const items = Array.isArray(decoded) ? decoded : [decoded];
  if (items.length < 1 || items.length > 8) throw new Error('invalid_patch');
  return items.map((item) => parseSinglePatch(item));
}

function parseSinglePatch(value: unknown): DocumentRevisionPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_patch');
  }
  const parsed = value as Record<string, unknown>;
  if (
    !['clear_section', 'replace_section', 'replace_text', 'update_cells'].includes(String(parsed.operation)) ||
    typeof parsed.target !== 'object' ||
    parsed.target === null ||
    typeof (parsed.target as Record<string, unknown>).sectionIndex !== 'number'
  ) {
    throw new Error('invalid_patch');
  }
  if (
    parsed.operation === 'replace_section' &&
    (typeof parsed.replacement !== 'object' || parsed.replacement === null)
  ) {
    throw new Error('invalid_patch');
  }
  if (
    (parsed.operation === 'replace_text' || parsed.operation === 'update_cells') &&
    typeof parsed.value !== 'string'
  ) {
    throw new Error('invalid_patch');
  }
  return parsed as unknown as DocumentRevisionPatch;
}
