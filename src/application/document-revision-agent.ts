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

export type RevisionTargetUnit = 'section' | 'page';

export interface RevisionOrdinalTarget {
  readonly ordinal: number;
  readonly unit: RevisionTargetUnit;
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
        readonly targetUnit?: RevisionTargetUnit;
      };
    }
  | {
      readonly operation: 'replace_section';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly pageNumber?: number;
        readonly targetUnit?: RevisionTargetUnit;
      };
      readonly replacement: DocumentOutlineSection;
    }
  | {
      readonly operation: 'replace_text';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly blockIndex: number;
        readonly targetUnit?: RevisionTargetUnit;
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
        readonly targetUnit?: RevisionTargetUnit;
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
  const targets = parseRevisionTargets(input.requestText)
    .map((target) => ({
      target,
      sectionIndex: revisionSectionIndex(input.kind, target)
    }))
    .filter(({ sectionIndex }) =>
      sectionIndex >= 0 && sectionIndex < input.outline.sections.length
    );
  if (targets.length === 0) return [];
  if (isExplicitClearRevisionRequest(input.requestText)) {
    return targets.map(({ target }) => ({
      operation: 'clear_section' as const,
      target: revisionTarget(input, target)
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
    targets.some(({ sectionIndex }) => !input.proposedOutline?.sections[sectionIndex])
  ) {
    return [];
  }
  return targets.map(({ target }) => {
    const sectionIndex = revisionSectionIndex(input.kind, target);
    const replacementSection = input.proposedOutline!.sections[sectionIndex];
    const revisionTargetValue = revisionTarget(input, target);
    return resolveFineGrainedPatches(
      input.kind,
      input.outline.sections[sectionIndex],
      replacementSection,
      revisionTargetValue
    ) ?? [{
      operation: 'replace_section' as const,
      target: revisionTargetValue,
      replacement: replacementSection
    }];
  }).flat();
}

export function parseRevisionTargets(requestText: string): readonly RevisionOrdinalTarget[] {
  const matches = [...requestText.matchAll(/第\s*([0-9一二两三四五六七八九十百零〇]+)\s*(章|节|页|张|部分)/gu)]
    .map((match) => ({
      ordinal: parseOrdinalToken(match[1]),
      unit: /^(?:页|张)$/u.test(match[2]) ? 'page' as const : 'section' as const
    }))
    .filter((target) => Number.isSafeInteger(target.ordinal) && target.ordinal > 0);
  const seen = new Set<string>();
  return matches.filter((target) => {
    const key = `${target.unit}:${target.ordinal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
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

export function revisionSectionIndex(
  kind: DocumentWorkspaceKind,
  target: RevisionOrdinalTarget
): number {
  // PPT page numbers are physical slide numbers; slide 1 is the cover.
  // Section ordinals continue to address logical content sections.
  if (target.unit === 'page') {
    return kind === 'ppt' ? target.ordinal - 2 : -1;
  }
  return target.ordinal - 1;
}

export function parseRevisionTarget(
  requestText: string
): RevisionOrdinalTarget | undefined {
  const match = /第\s*([0-9一二两三四五六七八九十百零〇]+)\s*(章|节|页|张|部分)/u.exec(
    requestText
  );
  if (!match) return undefined;
  const ordinal = parseOrdinalToken(match[1]);
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) return undefined;
  return {
    ordinal,
    unit: /^(?:页|张)$/u.test(match[2]) ? 'page' : 'section'
  };
}

function revisionTarget(
  input: DocumentRevisionAgentInput,
  target: RevisionOrdinalTarget
) {
  const sectionIndex = revisionSectionIndex(input.kind, target);
  return {
    sectionIndex,
    sectionHeading: input.outline.sections[sectionIndex].heading,
    ...(input.kind === 'ppt'
      ? {
          pageNumber: target.unit === 'page' ? target.ordinal : sectionIndex + 2,
          ...(target.unit === 'page' ? { targetUnit: target.unit } : {})
        }
      : target.unit === 'page'
        ? { targetUnit: target.unit }
        : {})
  };
}

function resolveFineGrainedPatches(
  kind: DocumentWorkspaceKind,
  current: DocumentOutlineSection,
  replacement: DocumentOutlineSection,
  target: {
    readonly sectionIndex: number;
    readonly sectionHeading: string;
    readonly pageNumber?: number;
    readonly targetUnit?: RevisionTargetUnit;
  }
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
            ...(target.pageNumber !== undefined ? { pageNumber: target.pageNumber } : {}),
            ...(target.targetUnit !== undefined ? { targetUnit: target.targetUnit } : {}),
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
          ...(target.pageNumber !== undefined ? { pageNumber: target.pageNumber } : {}),
          ...(target.targetUnit !== undefined ? { targetUnit: target.targetUnit } : {}),
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

export function isExplicitClearRevisionRequest(requestText: string): boolean {
  // The target ordinal is validated above, so only accept clear/delete
  // wording that is explicitly tied to the section's content. Users commonly
  // place the action before the target ("删除第二章的内容") or after it
  // ("将第二章的内容删掉"). Keep this bounded instead of treating every
  // generic "删除" request as a destructive clear operation.
  const clearsContent =
    /(?:清空|清除)[\s\S]{0,24}|(?:删除|删掉)[\s\S]{0,24}(?:内容|本章|这一章|该章节)|(?:内容|本章|这一章|该章节)[\s\S]{0,24}(?:删除|删掉)/u.test(requestText);
  return clearsContent;
}

export function parseDeterministicClearRevisionTarget(
  requestText: string
): RevisionOrdinalTarget | undefined {
  const targets = parseRevisionTargets(requestText);
  if (targets.length !== 1 || !isExplicitClearRevisionRequest(requestText)) {
    return undefined;
  }
  const ordinal = '[0-9一二两三四五六七八九十百零〇]+';
  const target = `第\\s*${ordinal}\\s*(?:章|节|页|张|部分)`;
  const document = '(?:(?:当前|这个|这份)?(?:PPT|演示文稿|文档)(?:的)?)?';
  const content = '(?:\\s*(?:的\\s*)?(?:(?:全部|所有)\\s*)?(?:正文(?:内容)?|内容|本章内容|这一章(?:的)?内容|该章节(?:的)?内容))?';
  const clear = '(?:清空|清除|删除|删掉)';
  const polite = '(?:请(?:帮我|帮忙)?|麻烦(?:帮我|帮忙)?|帮我)?\\s*';
  const preserve = '(?:\\s*[,，]\\s*(?:(?:其他|其余)(?:页面|页|章节|地方|内容)?(?:都)?(?:保持不变|不变|不动)|保留(?:其他|其余)(?:页面|页|章节|内容)?))?';
  const terminal = '\\s*[。！!]?\\s*';
  const grammar = new RegExp(
    `^${polite}(?:(?:将|把)\\s*${document}${target}${content}\\s*${clear}|${clear}\\s*${document}${target}${content})${preserve}${terminal}$`,
    'u'
  );
  if (!grammar.test(requestText.trim())) {
    return undefined;
  }
  return targets[0];
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
