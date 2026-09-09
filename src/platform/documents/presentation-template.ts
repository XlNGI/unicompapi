import type {
  DocumentOutlineSection,
  PresentationPageKind
} from './document-outline-parser';
import {
  presentationTemplateIds,
  type PresentationTemplateId
} from '../../shared/document-generation-ipc';

export { presentationTemplateIds };
export type { PresentationTemplateId };
export type PresentationLayoutKind = PresentationPageKind;
export type PresentationCompositionKind =
  | 'cover'
  | 'section'
  | 'editorial'
  | 'split'
  | 'cards'
  | 'timeline'
  | 'data'
  | 'image_text'
  | 'closing';

export interface PresentationLayout {
  readonly kind: PresentationLayoutKind;
  readonly maxContentGroups: number;
  readonly maxBodyCharacters: number;
  readonly maxTableColumns: number;
  readonly minBodyFontSize: number;
  readonly supportsContinuation: boolean;
  readonly supportsChart: boolean;
  readonly supportsTable: boolean;
}

export interface PresentationTemplateTokens {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly secondaryAccent: string;
}

export type PresentationFrameStyle =
  | 'work_report'
  | 'natural_minimal'
  | 'business_minimal'
  | 'technology'
  | 'financing';

export interface PresentationTemplate {
  readonly id: PresentationTemplateId;
  readonly name: string;
  readonly frameStyle: PresentationFrameStyle;
  readonly tokens: PresentationTemplateTokens;
  readonly layouts: Readonly<Record<PresentationLayoutKind, PresentationLayout>>;
  readonly compositionCycle: readonly PresentationCompositionKind[];
}

export const presentationTemplates: Readonly<
  Record<PresentationTemplateId, PresentationTemplate>
> = {
  work_report: createTemplate('work_report', '工作汇报', {
    background: 'F4F8FC',
    surface: 'FFFFFF',
    text: '1B2638',
    muted: '64748B',
    accent: '1F5FBF',
    secondaryAccent: 'F29A38'
  }, 'work_report', ['cards', 'split', 'editorial', 'timeline']),
  natural_minimal: createTemplate('natural_minimal', '自然简约', {
    background: 'F1F7F0',
    surface: 'FFFFFF',
    text: '20372B',
    muted: '627269',
    accent: '4E8B61',
    secondaryAccent: 'D27B4A'
  }, 'natural_minimal', ['editorial', 'split', 'cards', 'timeline']),
  business_minimal: createTemplate('business_minimal', '极简商务', {
    background: 'F7F7F5',
    surface: 'FFFFFF',
    text: '242A2E',
    muted: '677078',
    accent: '2D3A3E',
    secondaryAccent: 'B56A3A'
  }, 'business_minimal', ['split', 'editorial', 'cards', 'timeline']),
  technology: createTemplate('technology', '科技风', {
    background: '0B1220',
    surface: '152238',
    text: 'F5FAFF',
    muted: 'A5B7CD',
    accent: '35D6C8',
    secondaryAccent: 'FE5EA8'
  }, 'technology', ['timeline', 'cards', 'split', 'editorial'], 18, 900),
  financing: createTemplate('financing', '融资演讲稿', {
    background: '171C26',
    surface: '222A37',
    text: 'F8FAFC',
    muted: 'B8C2CE',
    accent: '00A9C0',
    secondaryAccent: 'F4B942'
  }, 'financing', ['editorial', 'cards', 'timeline', 'split'], 18, 840)
};

export function isPresentationTemplateId(
  value: unknown
): value is PresentationTemplateId {
  return (
    typeof value === 'string' &&
    presentationTemplateIds.includes(value as PresentationTemplateId)
  );
}

export function resolvePresentationTemplate(
  value: unknown,
  fallback: PresentationTemplateId = 'work_report'
): PresentationTemplate {
  return presentationTemplates[
    isPresentationTemplateId(value) ? value : fallback
  ];
}

export function choosePresentationLayout(
  template: PresentationTemplate,
  section: DocumentOutlineSection
): PresentationLayout {
  if (section.pageKind) return template.layouts[section.pageKind];
  if (section.blocks.some((block) => block.type === 'chart' || block.type === 'table')) {
    return template.layouts.data;
  }
  if (section.blocks.some((block) => block.type === 'numbered')) {
    return template.layouts.process;
  }
  return template.layouts.insight;
}

export function choosePresentationComposition(
  template: PresentationTemplate,
  input: {
    readonly layoutKind: PresentationLayoutKind;
    readonly textGroupCount: number;
    readonly totalCharacters: number;
    readonly pageIndex: number;
    readonly previous?: PresentationCompositionKind;
  }
): PresentationCompositionKind {
  if (input.layoutKind === 'cover') return 'cover';
  if (input.layoutKind === 'section') return 'section';
  if (input.layoutKind === 'closing') return 'closing';
  if (input.layoutKind === 'data') return 'data';
  if (input.layoutKind === 'image_text') return 'image_text';
  if (input.layoutKind === 'process' && input.totalCharacters <= 560) {
    return 'timeline';
  }
  if (input.layoutKind === 'comparison' && input.textGroupCount >= 2) {
    return 'split';
  }

  const candidates = template.compositionCycle.filter((composition) => {
    if (composition === 'timeline') {
      return (
        input.textGroupCount >= 3 &&
        input.textGroupCount <= 5 &&
        input.totalCharacters <= 520
      );
    }
    if (composition === 'split') {
      return input.textGroupCount >= 2 && input.textGroupCount <= 4;
    }
    if (composition === 'cards') {
      return input.textGroupCount >= 2 && input.textGroupCount <= 5;
    }
    return input.textGroupCount <= 4;
  });
  const eligible = candidates.length > 0 ? candidates : ['cards'] as const;
  let composition = eligible[input.pageIndex % eligible.length];
  if (eligible.length > 1 && composition === input.previous) {
    composition = eligible[(input.pageIndex + 1) % eligible.length];
  }
  return composition;
}

function createTemplate(
  id: PresentationTemplateId,
  name: string,
  tokens: PresentationTemplateTokens,
  frameStyle: PresentationFrameStyle,
  compositionCycle: readonly PresentationCompositionKind[],
  minBodyFontSize = 17,
  maxBodyCharacters = 960
): PresentationTemplate {
  return {
    id,
    name,
    frameStyle,
    tokens,
    layouts: createLayouts(minBodyFontSize, maxBodyCharacters),
    compositionCycle
  };
}

function createLayouts(
  minBodyFontSize: number,
  maxBodyCharacters: number
): Readonly<Record<PresentationLayoutKind, PresentationLayout>> {
  return {
    cover: createLayout('cover', 0, 180, minBodyFontSize, false, false, false),
    section: createLayout('section', 2, 420, minBodyFontSize, false, false, false),
    insight: createLayout('insight', 4, maxBodyCharacters, minBodyFontSize, true, false, false),
    comparison: createLayout('comparison', 4, 760, minBodyFontSize, true, false, true),
    process: createLayout('process', 5, 820, minBodyFontSize, true, false, false),
    data: createLayout('data', 3, 560, minBodyFontSize, false, true, true),
    image_text: createLayout('image_text', 3, 620, minBodyFontSize, true, false, false),
    closing: createLayout('closing', 3, 620, minBodyFontSize, false, false, false)
  };
}

function createLayout(
  kind: PresentationLayoutKind,
  maxContentGroups: number,
  maxBodyCharacters: number,
  minBodyFontSize: number,
  supportsContinuation: boolean,
  supportsChart: boolean,
  supportsTable: boolean
): PresentationLayout {
  return {
    kind,
    maxContentGroups,
    maxBodyCharacters,
    maxTableColumns: 5,
    minBodyFontSize,
    supportsContinuation,
    supportsChart,
    supportsTable
  };
}
