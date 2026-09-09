import type { DocumentOutlineSection } from './document-outline-parser';

export type DocumentComponentId =
  | 'title'
  | 'body'
  | 'cards'
  | 'timeline'
  | 'comparison'
  | 'metrics'
  | 'callout'
  | 'table'
  | 'chart'
  | 'image-text'
  | 'closing';

export type DocumentComponentStatus = 'active' | 'deprecated';

export interface DocumentComponentVariant {
  readonly id: string;
  readonly maxItems?: number;
  readonly maxTitleChars?: number;
  readonly maxBodyChars?: number;
}

export interface DocumentComponentDefinition {
  readonly id: DocumentComponentId;
  readonly version: string;
  readonly status: DocumentComponentStatus;
  readonly capabilities: readonly string[];
  readonly variants: readonly DocumentComponentVariant[];
}

export interface DocumentComponentSelection {
  readonly id: DocumentComponentId;
  readonly version: string;
  readonly variant: string;
  readonly reason:
    | 'chart'
    | 'table'
    | 'image'
    | 'numbered'
    | 'bullets'
    | 'narrative'
    | 'metrics'
    | 'callout';
}

export interface DocumentComponentPlanOptions {
  readonly images?: readonly unknown[];
}

/**
 * The registry is intentionally independent from any PPT theme. A theme only
 * provides the renderer and visual tokens for a selected component.
 */
export const documentComponentRegistry: readonly DocumentComponentDefinition[] = [
  {
    id: 'title',
    version: '1.0',
    status: 'active',
    capabilities: ['heading'],
    variants: [
      { id: 'cover', maxTitleChars: 32 },
      { id: 'section', maxTitleChars: 48 },
      { id: 'content', maxTitleChars: 28 },
      { id: 'card', maxTitleChars: 18 }
    ]
  },
  {
    id: 'body',
    version: '1.0',
    status: 'active',
    capabilities: ['paragraph', 'quote'],
    variants: [{ id: 'standard', maxBodyChars: 420 }]
  },
  {
    id: 'cards',
    version: '1.0',
    status: 'active',
    capabilities: ['bullets'],
    variants: [{ id: 'four-up', maxItems: 4, maxBodyChars: 90 }]
  },
  {
    id: 'timeline',
    version: '1.0',
    status: 'active',
    capabilities: ['numbered', 'steps'],
    variants: [{ id: 'horizontal', maxItems: 5, maxBodyChars: 90 }]
  },
  {
    id: 'comparison',
    version: '1.0',
    status: 'active',
    capabilities: ['comparison'],
    variants: [{ id: 'two-column', maxItems: 2, maxBodyChars: 120 }]
  },
  {
    id: 'metrics',
    version: '1.0',
    status: 'active',
    capabilities: ['evaluation', 'metrics', 'findings'],
    variants: [{ id: 'three-up', maxItems: 4, maxBodyChars: 90 }]
  },
  {
    id: 'callout',
    version: '1.0',
    status: 'active',
    capabilities: ['risk', 'warning', 'recommendation'],
    variants: [{ id: 'emphasis', maxItems: 4, maxBodyChars: 110 }]
  },
  {
    id: 'table',
    version: '1.0',
    status: 'active',
    capabilities: ['tabular-data'],
    variants: [{ id: 'standard', maxItems: 6 }]
  },
  {
    id: 'chart',
    version: '1.0',
    status: 'active',
    capabilities: ['quantitative-data'],
    variants: [{ id: 'native', maxItems: 8 }]
  },
  {
    id: 'image-text',
    version: '1.0',
    status: 'active',
    capabilities: ['image', 'narrative'],
    variants: [{ id: 'right-image', maxBodyChars: 260 }]
  },
  {
    id: 'closing',
    version: '1.0',
    status: 'active',
    capabilities: ['closing'],
    variants: [{ id: 'standard', maxTitleChars: 48 }]
  }
] as const;

export function getDocumentComponent(
  id: DocumentComponentId,
  version?: string
): DocumentComponentDefinition | undefined {
  return documentComponentRegistry.find(
    (component) =>
      component.id === id &&
      component.status !== 'deprecated' &&
      (version === undefined || component.version === version)
  );
}

/**
 * Selects a bounded component from document structure. An LLM hint can be
 * added later without allowing arbitrary coordinates or unsupported layouts.
 */
export function selectSectionComponent(
  section: DocumentOutlineSection,
  options: { readonly hasImage?: boolean } = {}
): DocumentComponentSelection {
  if (section.blocks.some((block) => block.type === 'chart')) {
    return selection('chart', 'native', 'chart');
  }
  if (section.blocks.some((block) => block.type === 'table')) {
    return selection('table', 'standard', 'table');
  }
  if (options.hasImage) {
    return selection('image-text', 'right-image', 'image');
  }
  if (section.blocks.some((block) => block.type === 'numbered')) {
    return selection('timeline', 'horizontal', 'numbered');
  }
  if (section.blocks.some((block) => block.type === 'bullets')) {
    if (isProcessSection(section)) {
      return selection('timeline', 'horizontal', 'bullets');
    }
    if (isComparisonSection(section)) {
      return selection('comparison', 'two-column', 'bullets');
    }
    if (isMetricsSection(section)) {
      return selection('metrics', 'three-up', 'metrics');
    }
    if (isCalloutSection(section)) {
      return selection('callout', 'emphasis', 'callout');
    }
    return selection('cards', 'four-up', 'bullets');
  }
  return selection('body', 'standard', 'narrative');
}

/**
 * Plans components for the whole document before rendering starts. Semantic
 * components are hard constraints; ordinary bullet sections may alternate
 * between cards and a body list so a long deck does not become a stack of
 * visually identical pages.
 */
export function planDocumentComponents(
  sections: readonly DocumentOutlineSection[],
  options: DocumentComponentPlanOptions = {}
): readonly DocumentComponentSelection[] {
  const counts = new Map<DocumentComponentId, number>();
  let previous: DocumentComponentId | undefined;
  return sections.map((section, index) => {
    const base = selectSectionComponent(section, {
      hasImage: Boolean(options.images?.[index])
    });
    const planned = isFlexibleSelection(base)
      ? chooseFlexibleComponent(base, previous, counts)
      : base;
    counts.set(planned.id, (counts.get(planned.id) ?? 0) + 1);
    previous = planned.id;
    return planned;
  });
}

function isFlexibleSelection(selectionValue: DocumentComponentSelection): boolean {
  return selectionValue.id === 'cards' && selectionValue.reason === 'bullets';
}

function chooseFlexibleComponent(
  base: DocumentComponentSelection,
  previous: DocumentComponentId | undefined,
  counts: ReadonlyMap<DocumentComponentId, number>
): DocumentComponentSelection {
  const cardsCount = counts.get('cards') ?? 0;
  const bodyCount = counts.get('body') ?? 0;
  const preferred: DocumentComponentId = cardsCount <= bodyCount ? 'cards' : 'body';
  const chosen = preferred === previous ? (preferred === 'cards' ? 'body' : 'cards') : preferred;
  return chosen === 'cards'
    ? base
    : selection('body', 'standard', 'bullets');
}

function isComparisonSection(section: DocumentOutlineSection): boolean {
  const items = section.blocks.flatMap((block) =>
    block.type === 'bullets' || block.type === 'numbered' ? block.items : []
  );
  const signal = `${section.heading} ${items.join(' ')}`;
  return items.length === 2 && /对比|比较|区别|优点|缺点|传统|现在|之前|之后|vs|VS/.test(signal);
}

function sectionSignal(section: DocumentOutlineSection): string {
  const items = section.blocks.flatMap((block) =>
    block.type === 'bullets' || block.type === 'numbered' ? block.items : []
  );
  return `${section.heading} ${items.join(' ')}`;
}

function isProcessSection(section: DocumentOutlineSection): boolean {
  return /流程|步骤|路径|阶段|方法|实施|实践|操作|工作流/.test(sectionSignal(section));
}

function isMetricsSection(section: DocumentOutlineSection): boolean {
  const items = section.blocks.flatMap((block) =>
    block.type === 'bullets' || block.type === 'numbered' ? block.items : []
  );
  return /结果|评估|指标|效果|结论|发现|验证|表现/.test(section.heading) ||
    items.some((item) => /准确率|召回率|得分|增长率|成功率|误差率|百分比|同比|环比/.test(item));
}

function isCalloutSection(section: DocumentOutlineSection): boolean {
  return /问题|风险|注意|提醒|挑战|局限|错误|误区|建议|原则/.test(section.heading);
}

function selection(
  id: DocumentComponentId,
  variant: string,
  reason: DocumentComponentSelection['reason']
): DocumentComponentSelection {
  const component = getDocumentComponent(id);
  if (!component) {
    throw new Error(`Active document component is not registered: ${id}`);
  }
  return { id, version: component.version, variant, reason };
}
