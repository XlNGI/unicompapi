import {
  parsePresentationPlan,
  type DocumentOutline,
  type DocumentOutlineBlock,
  type PresentationPlan,
  type PresentationPlanElement,
  type PresentationPlanPage,
  type PresentationPlanRevision,
  type PresentationTemplateId
} from '../../domain';
import {
  choosePresentationComposition,
  choosePresentationLayout,
  resolvePresentationTemplate,
  type PresentationCompositionKind,
  type PresentationLayout
} from './presentation-template';

export interface PresentationPlanBuildOptions {
  readonly templateId?: PresentationTemplateId;
  readonly sourceRefs?: readonly string[];
  readonly sectionSourceRefs?: Readonly<Record<number, readonly string[]>>;
  readonly preserve?: readonly string[];
  readonly revision?: PresentationPlanRevision;
  readonly includeClosing?: boolean;
}

export function buildPresentationPlanFromOutline(
  outline: DocumentOutline,
  options: PresentationPlanBuildOptions = {}
): PresentationPlan {
  if (outline.kind !== 'ppt') {
    throw new TypeError('PresentationPlan can only be built from a PPT outline');
  }
  const template = resolvePresentationTemplate(options.templateId);
  const sourceRefs = unique(options.sourceRefs ?? []);
  const preserve = unique(options.preserve ?? []);
  const pages: PresentationPlanPage[] = [];

  pages.push(createSyntheticPage({
    pageNumber: 1,
    sourceSection: 'outline.title',
    pageKind: 'cover',
    composition: 'cover',
    title: outline.title,
    layout: template.layouts.cover,
    sourceRefs,
    preserve: options.revision !== undefined && options.revision.targetPages.includes(1)
      ? preserve
      : unique([...preserve, 'page_outside_revision_scope_unchanged'])
  }));

  let previous: PresentationCompositionKind = 'cover';
  outline.sections.forEach((section, sectionIndex) => {
    const layout = choosePresentationLayout(template, section);
    const elements = section.blocks.map((block, blockIndex) => ({
      elementId: `section-${sectionIndex + 1}-block-${blockIndex + 1}`,
      sourceBlockIndex: blockIndex,
      content: block
    }));
    const capacity = measureCapacity(elements, layout);
    const composition = choosePresentationComposition(template, {
      layoutKind: layout.kind,
      textGroupCount: capacity.contentGroups,
      totalCharacters: capacity.bodyCharacters,
      pageIndex: pages.length - 1,
      previous
    });
    const sectionRefs = unique([
      ...sourceRefs,
      ...(options.sectionSourceRefs?.[sectionIndex] ?? [])
    ]);
    const pagePreserve = options.revision !== undefined && options.revision.targetPages.includes(pages.length + 1)
      ? preserve
      : unique([...preserve, 'page_outside_revision_scope_unchanged']);
    pages.push({
      pageNumber: pages.length + 1,
      sourceSection: `outline.sections[${sectionIndex}]`,
      pageKind: layout.kind,
      layout: layout.kind,
      composition,
      ...(section.takeaway !== undefined ? { takeaway: section.takeaway } : {}),
      elements,
      capacity,
      sourceRefs: sectionRefs,
      preserve: pagePreserve
    });
    previous = composition;
  });

  if ((options.includeClosing ?? true) && outline.sections.length > 0) {
    const closingPageNumber = pages.length + 1;
    pages.push(createSyntheticPage({
      pageNumber: closingPageNumber,
      sourceSection: 'outline.closing',
      pageKind: 'closing',
      composition: 'closing',
      title: outline.sections.at(-1)?.action ?? outline.title,
      layout: template.layouts.closing,
      sourceRefs,
      preserve: options.revision !== undefined && options.revision.targetPages.includes(closingPageNumber)
        ? preserve
        : unique([...preserve, 'page_outside_revision_scope_unchanged'])
    }));
  }

  return parsePresentationPlan({
    kind: 'ppt',
    title: outline.title,
    templateId: template.id,
    pages,
    sourceRefs,
    preserve,
    ...(options.revision !== undefined ? { revision: options.revision } : {})
  });
}

function createSyntheticPage(input: {
  readonly pageNumber: number;
  readonly sourceSection: string;
  readonly pageKind: 'cover' | 'closing';
  readonly composition: 'cover' | 'closing';
  readonly title: string;
  readonly layout: PresentationLayout;
  readonly sourceRefs: readonly string[];
  readonly preserve: readonly string[];
}): PresentationPlanPage {
  const elements: readonly PresentationPlanElement[] = [{
    elementId: `${input.pageKind}-title`,
    content: { type: 'paragraph', text: input.title }
  }];
  return {
    pageNumber: input.pageNumber,
    sourceSection: input.sourceSection,
    pageKind: input.pageKind,
    layout: input.pageKind,
    composition: input.composition,
    elements,
    capacity: measureCapacity(elements, input.layout, input.pageKind === 'cover'),
    sourceRefs: input.sourceRefs,
    preserve: input.preserve
  };
}

function measureCapacity(
  elements: readonly PresentationPlanElement[],
  layout: PresentationLayout,
  titleOnly = false
): PresentationPlanPage['capacity'] {
  const contentGroups = titleOnly ? 0 : elements.reduce(
    (total, element) => total + blockGroupCount(element.content),
    0
  );
  const bodyCharacters = titleOnly ? 0 : elements.reduce(
    (total, element) => total + blockCharacterCount(element.content),
    0
  );
  return {
    contentGroups,
    bodyCharacters,
    maxContentGroups: layout.maxContentGroups,
    maxBodyCharacters: layout.maxBodyCharacters,
    maxTableColumns: layout.maxTableColumns,
    minBodyFontSize: layout.minBodyFontSize,
    withinLimit:
      contentGroups <= layout.maxContentGroups &&
      bodyCharacters <= layout.maxBodyCharacters
  };
}

function blockGroupCount(block: DocumentOutlineBlock): number {
  switch (block.type) {
    case 'bullets':
    case 'numbered':
      return block.items.length;
    case 'table':
      return Math.max(1, block.rows.length);
    case 'chart':
      return Math.max(1, block.data.length);
    default:
      return 1;
  }
}

function blockCharacterCount(block: DocumentOutlineBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'quote':
      return block.text.length;
    case 'bullets':
    case 'numbered':
      return block.items.reduce((total, item) => total + item.length, 0);
    case 'table':
      return [...block.header, ...block.rows.flat()].reduce(
        (total, cell) => total + cell.length,
        0
      );
    case 'chart':
      return (
        (block.title?.length ?? 0) +
        block.data.reduce((total, item) => total + item.label.length, 0)
      );
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
