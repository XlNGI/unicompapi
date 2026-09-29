import type { DocumentOutline, DocumentOutlineBlock } from '../../domain/entities/document-generation';
import {
  parsePresentationDesignIR,
  type PresentationDesignGlobal,
  type PresentationDesignIRPage,
  type ProductionPresentationDesignIR
} from '../../domain/entities/presentation-design-contract';

export type PresentationDesignStrategy = 'single-focus' | 'comparison' | 'evidence' | 'sequence' | 'structured';
export interface PresentationDesignCompilerDiagnostic {
  readonly code: 'invalid_design_ir' | 'unsupported_design_value' | 'unsupported_capacity' |
    'unresolved_content_reference' | 'advisory_intent' | 'advisory_visual_tone' |
    'legacy_pagination' | 'legacy_image' | 'design_render_failed';
  readonly pageNumber?: number;
}
export interface PresentationDesignBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
type DataBlock = Extract<DocumentOutlineBlock, { readonly type: 'chart' | 'table' }>;
export type PresentationDesignSource = { readonly type: 'text'; readonly text: string } | DataBlock;
interface ContentAtom {
  readonly sourceRef: string;
  readonly aliases: readonly string[];
  readonly source: PresentationDesignSource;
  readonly role: 'title' | 'body' | 'metric' | 'evidence' | 'chart' | 'action';
}
export interface CompiledPresentationDesignItem {
  readonly sourceRef: string;
  readonly source: PresentationDesignSource;
  readonly box: PresentationDesignBox;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly color: 'text' | 'muted' | 'accent';
  readonly align: 'left' | 'center' | 'right';
  readonly valign: 'top' | 'middle';
  readonly focal: boolean;
}
/** A finite page adapter result, not a general Layout IR or Render Plan. */
export interface CompiledPresentationDesignPage {
  readonly pageNumber: number;
  readonly strategy: PresentationDesignStrategy;
  readonly items: readonly CompiledPresentationDesignItem[];
  readonly rule?: PresentationDesignBox;
  readonly ruleColor: 'text' | 'accent';
}
export interface PresentationDesignCompilation {
  readonly designIR?: ProductionPresentationDesignIR;
  readonly pages: readonly CompiledPresentationDesignPage[];
  readonly diagnostics: readonly PresentationDesignCompilerDiagnostic[];
}
/** Bounded, private diagnostics suitable for an existing execution recorder. */
export interface PresentationDesignCompilationSnapshot {
  readonly designIR?: ProductionPresentationDesignIR;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly pageNumber?: number;
    readonly path?: string;
    readonly message?: string;
  }[];
  readonly strategies: readonly { readonly pageNumber: number; readonly strategy: string | 'legacy-template' }[];
  readonly designPath?: 'design-aware' | 'legacy-fallback';
  readonly fallbackReason?: string;
  readonly artDirectionStatus?: 'validated' | 'invalid' | 'missing';
  readonly designIrStatus?: 'validated' | 'invalid' | 'missing';
  readonly layoutStatus?: 'success' | 'failed' | 'skipped';
  readonly renderPlanStatus?: 'valid' | 'invalid' | 'skipped';
  readonly repairCount?: number;
  readonly pages?: readonly {
    readonly pageNumber: number;
    readonly pageRole: string;
    readonly pageIntent: string;
    readonly composition?: string;
    readonly selectedLayout?: string;
    readonly elementCount: number;
    readonly density: string;
    readonly whitespace: string;
    readonly primaryRegion?: string;
    readonly geometrySignature?: string;
    readonly fallback: boolean;
  }[];
}

const canvas = { width: 13.333, height: 7.5 };

/**
 * D2 compiles a small vocabulary of page relationships. Every content atom is
 * resolved from the validated outline; design text never becomes slide facts.
 * Unsupported intent/capacity produces a page fallback, never dropped content.
 */
export function compilePresentationDesign(outline: DocumentOutline, candidate: unknown): PresentationDesignCompilation {
  let designIR: ProductionPresentationDesignIR;
  try {
    if (outline.kind !== 'ppt') throw new TypeError('PPT required');
    designIR = parsePresentationDesignIR(candidate, {
      outline, expectedPageCount: outline.sections.length === 0 ? 1 : outline.sections.length + 2
    });
  } catch {
    return { pages: [], diagnostics: [{ code: 'invalid_design_ir' }] };
  }
  const diagnostics: PresentationDesignCompilerDiagnostic[] = [];
  const pages: CompiledPresentationDesignPage[] = [];
  if (!['editorial', 'minimal', 'bold'].includes(designIR.globalDesign.visualTone)) diagnostics.push({ code: 'advisory_visual_tone' });
  for (const page of designIR.pages) {
    // Intent/rationale is retained for review. Free text is not an executable
    // layout instruction; the bounded hierarchy/composition fields are.
    diagnostics.push({ code: 'advisory_intent', pageNumber: page.pageNumber });
    if (page.composition.flow === 'radial' || page.composition.focalArea === 'full-bleed' || page.contentRoles.image.length > 0) {
      diagnostics.push({ code: 'unsupported_design_value', pageNumber: page.pageNumber });
      continue;
    }
    const atoms = contentAtoms(outline, page);
    const refs = [...page.hierarchy.primary, ...page.hierarchy.secondary, ...page.hierarchy.supporting,
      ...Object.values(page.contentRoles).flat(), page.emphasis.target];
    if (refs.some(ref => !atoms.some(atom => matches(atom, ref)))) {
      diagnostics.push({ code: 'unresolved_content_reference', pageNumber: page.pageNumber });
      continue;
    }
    if (atoms.length > 14) {
      diagnostics.push({ code: 'unsupported_capacity', pageNumber: page.pageNumber });
      continue;
    }
    const compiled = compilePage(atoms, page, designIR.globalDesign);
    if (compiled) pages.push(compiled);
    else diagnostics.push({ code: 'unsupported_capacity', pageNumber: page.pageNumber });
  }
  return { designIR, pages, diagnostics };
}

function contentAtoms(outline: DocumentOutline, design: PresentationDesignIRPage): ContentAtom[] {
  const atom = (sourceRef: string, text: string, role: ContentAtom['role'], aliases: readonly string[] = []): ContentAtom =>
    ({ sourceRef, source: { type: 'text', text }, role, aliases });
  if (design.pageNumber === 1) {
    return [atom('outline.title', outline.title, 'title'),
      ...(outline.sections[0] ? [atom('outline.sections[0].heading', outline.sections[0].heading, 'body', ['outline.sections[0]'])] : [])];
  }
  if (design.pageNumber === outline.sections.length + 2) {
    const last = outline.sections.length - 1;
    let takeawayIndex = last;
    while (takeawayIndex >= 0 && !outline.sections[takeawayIndex].takeaway) takeawayIndex -= 1;
    return [atom('application.closing-label', '谢谢观看', 'body'),
      ...(outline.sections[last].action ? [atom('outline.sections[' + last + '].action', outline.sections[last].action!, 'body', ['outline.sections[' + last + ']'])] : []),
      ...(takeawayIndex >= 0 ? [atom('outline.sections[' + takeawayIndex + '].takeaway', outline.sections[takeawayIndex].takeaway!, 'title', ['outline.sections[' + takeawayIndex + ']'])] : []),
      atom('outline.title', outline.title, takeawayIndex >= 0 ? 'body' : 'title', ['outline.sections[' + last + ']'])];
  }
  const sectionIndex = design.pageNumber - 2;
  const section = outline.sections[sectionIndex];
  const prefix = 'outline.sections[' + sectionIndex + ']';
  const atoms: ContentAtom[] = [atom(prefix + '.heading', section.heading, 'title', [prefix])];
  if (section.takeaway) atoms.push(atom(prefix + '.takeaway', section.takeaway, 'body', [prefix]));
  section.blocks.forEach((block, index) => {
    const ref = prefix + '.blocks[' + index + ']';
    if (block.type === 'bullets' || block.type === 'numbered') {
      block.items.forEach((text, itemIndex) => atoms.push(atom(ref + '.items[' + itemIndex + ']', text, 'body', [ref, prefix])));
    } else if (block.type === 'paragraph' || block.type === 'quote') {
      atoms.push(atom(ref, block.text, 'body', [prefix]));
    } else {
      atoms.push({ sourceRef: ref, source: block, role: block.type === 'chart' ? 'chart' : 'evidence', aliases: [prefix] });
    }
  });
  if (section.action) atoms.push(atom(prefix + '.action', section.action, 'action', [prefix]));
  return atoms.map(item => ({ ...item, role: pageRoleForAtom(item, design) }));
}

function pageRoleForAtom(atom: ContentAtom, page: PresentationDesignIRPage): ContentAtom['role'] {
  for (const role of ['metric', 'chart', 'evidence', 'title', 'body'] as const) {
    if (page.contentRoles[role].some(ref => matches(atom, ref))) return role;
  }
  return atom.role;
}

function matches(atom: ContentAtom, ref: string): boolean {
  return atom.sourceRef === ref || atom.aliases.includes(ref);
}

function hierarchyRank(atom: ContentAtom, page: PresentationDesignIRPage): number {
  for (const [index, refs] of [page.hierarchy.primary, page.hierarchy.secondary, page.hierarchy.supporting].entries()) {
    const position = refs.findIndex(ref => matches(atom, ref));
    if (position !== -1) return index * 100 + position;
  }
  return 300;
}

function compilePage(atoms: readonly ContentAtom[], page: PresentationDesignIRPage, global: PresentationDesignGlobal): CompiledPresentationDesignPage | undefined {
  const margin = (page.whitespace === 'generous' ? 1.12 : page.whitespace === 'minimal' ? 0.48 : 0.76) +
    (global.whitespace === 'generous' ? 0.05 : global.whitespace === 'minimal' ? -0.03 : 0);
  const gap = (page.whitespace === 'generous' ? 0.38 : page.whitespace === 'minimal' ? 0.14 : 0.24) *
    (global.visualRhythm === 'calm' ? 1.1 : global.visualRhythm === 'dynamic' ? 0.85 : 1) *
    (global.density === 'dense' ? 0.94 : global.density === 'sparse' ? 1.06 : 1);
  const title = atoms.find(atom => atom.sourceRef.endsWith('.heading'));
  const mainAtoms = atoms.filter(atom => atom !== title);
  const sorted = [...mainAtoms].sort((left, right) => hierarchyRank(left, page) - hierarchyRank(right, page));
  const exactFocus = atoms.find(atom => atom.sourceRef === page.emphasis.target);
  const focus = exactFocus ?? atoms.find(atom => matches(atom, page.emphasis.target)) ?? sorted[0];
  const activeFocus = focus === title ? sorted[0] : focus;
  const support = sorted.filter(atom => atom !== activeFocus);
  const headerHeight = title ? (focus === title && page.emphasis.strength === 'dominant' ? 1.06 : 0.74) : 0;
  const rhythmShift = title && global.visualRhythm === 'varied' && page.pageNumber % 2 === 0 ? 0.14
    : title && global.visualRhythm === 'progressive' ? Math.min(0.2, page.pageNumber * 0.015) : 0;
  const area: PresentationDesignBox = {
    x: margin, y: margin * 0.7 + (title ? headerHeight + gap : 0) + rhythmShift,
    width: canvas.width - margin * 2,
    height: canvas.height - margin * 1.5 - (title ? headerHeight + gap : 0) - rhythmShift - 0.25
  };
  const placed: { atom: ContentAtom; box: PresentationDesignBox }[] = [];
  if (title) placed.push({ atom: title, box: { x: margin, y: margin * 0.65, width: area.width, height: headerHeight } });
  const principle = page.composition.principle;
  const strategy: PresentationDesignStrategy = principle === 'single-focus' || principle === 'centered' ? 'single-focus'
    : principle === 'comparison' ? 'comparison' : principle === 'timeline' ? 'sequence'
      : principle === 'grid' || principle === 'stacked' ? 'structured' : 'evidence';
  if (!activeFocus) return undefined;
  if (mainAtoms.length === 1) {
    placed.push({ atom: activeFocus, box: insetBox(area, page.whitespace === 'generous' ? 0.35 : 0) });
  } else if (strategy === 'structured') {
    const columns = principle === 'stacked' ? 1 : page.density === 'dense' && sorted.length >= 6 ? 3 : 2;
    const ordered = sorted.filter(atom => atom !== activeFocus);
    const focusIndex = page.composition.focalArea === 'bottom' ? ordered.length
      : page.composition.focalArea === 'right' ? Math.min(columns - 1, ordered.length)
        : page.composition.focalArea === 'center' ? Math.floor(ordered.length / 2) : 0;
    ordered.splice(focusIndex, 0, activeFocus);
    placed.push(...grid(ordered, area, columns, gap, page.composition.flow === 'top-to-bottom'));
  } else if (strategy === 'sequence') {
    const horizontal = page.composition.flow !== 'top-to-bottom';
    placed.push(...grid(sorted, area, horizontal ? sorted.length : 1, gap, false));
  } else if (strategy === 'comparison') {
    const focusOnRight = page.composition.focalArea === 'right' || page.composition.balance === 'asymmetric-right';
    const primary = sorted.filter(atom => atom === activeFocus || hierarchyRank(atom, page) < 100);
    const secondary = sorted.filter(atom => !primary.includes(atom));
    // A single primary group still compares against every secondary fact.
    if (secondary.length === 0) secondary.push(...primary.splice(Math.ceil(primary.length / 2)));
    const ratio = page.composition.balance === 'symmetric' || page.composition.balance === 'centered' ? 0.5 : 0.6;
    const [focusBox, supportBox] = splitArea(area, gap, ratio, focusOnRight ? 'right' : 'left');
    placed.push(...grid(primary, focusBox, 1, gap, false), ...grid(secondary, supportBox, 1, gap, false));
  } else {
    let focal = page.composition.focalArea;
    if (focal === 'center') focal = strategy === 'single-focus' ? 'top' : page.composition.balance === 'asymmetric-right' ? 'right' : 'left';
    if (page.composition.balance === 'asymmetric-right' && focal === 'left') focal = 'right';
    if (page.composition.balance === 'asymmetric-left' && focal === 'right') focal = 'left';
    const ratio = strategy === 'single-focus' ? 0.46
      : page.composition.focalArea === 'right' ? 0.5
      : page.composition.balance === 'symmetric' ? 0.5
      : page.composition.balance === 'weighted' ? 0.64
        : page.emphasis.strength === 'dominant' ? 0.61 : 0.55;
    const [focusBox, supportBox] = splitArea(area, gap, ratio, focal as 'left' | 'right' | 'top' | 'bottom');
    placed.push({ atom: activeFocus, box: focusBox });
    const columns = (focal === 'top' || focal === 'bottom') && page.composition.flow !== 'top-to-bottom'
      ? (page.density === 'dense' ? Math.min(3, support.length) : Math.min(2, support.length))
      : strategy === 'single-focus' ? Math.min(2, support.length) : 1;
    placed.push(...grid(support, supportBox, Math.max(1, columns), gap, false));
  }
  if (placed.length !== atoms.length || new Set(placed.map(item => item.atom.sourceRef)).size !== atoms.length) return undefined;
  const items: CompiledPresentationDesignItem[] = [];
  for (const { atom, box } of placed) {
    const focal = atom === focus;
    const rank = hierarchyRank(atom, page);
    const scale = global.typographyDirection === 'display-led' ? (rank < 100 || focal ? 1.14 : 1)
      : global.typographyDirection === 'body-led' ? (rank >= 100 ? 1.08 : 0.96)
        : global.typographyDirection === 'data-led' && atom.role === 'metric' ? 1.12 : 1;
    const emphasisSize = page.emphasis.strength === 'dominant' ? 40 : page.emphasis.strength === 'strong' ? 32
      : page.emphasis.strength === 'moderate' ? 26 : 21;
    const base = focal ? emphasisSize : atom === title ? 29 : rank < 100 ? 25 : rank < 200 ? 20 : 17;
    const requestedSize = Math.min(48, base * scale + (page.density === 'dense' ? -2 : page.density === 'sparse' ? 1 : 0));
    const fontSize = fitSource(atom.source, box, requestedSize);
    if (fontSize === undefined) return undefined;
    const monochrome = global.colorDirection === 'monochrome' || global.colorDirection === 'neutral';
    items.push({ sourceRef: atom.sourceRef, source: atom.source, box, fontSize,
      bold: focal || rank < 100 || atom === title || (global.colorDirection === 'high-contrast' && rank < 200),
      color: focal && !monochrome ? 'accent' : rank >= 200 && global.colorDirection === 'restrained' ? 'muted' : 'text',
      align: page.composition.principle === 'centered' || (focal && page.composition.focalArea === 'center') ? 'center'
        : focal && page.composition.focalArea === 'right' ? 'right' : 'left',
      valign: focal && strategy !== 'sequence' ? 'middle' : 'top', focal });
  }
  const focalBox = items.find(item => item.focal)?.box;
  const rule = global.visualTone === 'minimal' || page.emphasis.strength === 'subtle' || !focalBox ? undefined
    : { x: focalBox.x, y: Math.max(0.25, focalBox.y - 0.12), width: Math.min(1.0, focalBox.width * 0.25), height: 0.025 };
  return { pageNumber: page.pageNumber, strategy, items, ...(rule ? { rule } : {}), ruleColor: global.colorDirection === 'monochrome' ? 'text' : 'accent' };
}

function grid(atoms: readonly ContentAtom[], area: PresentationDesignBox, columns: number, gap: number, columnMajor: boolean): { atom: ContentAtom; box: PresentationDesignBox }[] {
  if (atoms.length === 0) return [];
  const rows = Math.ceil(atoms.length / columns);
  const width = (area.width - (columns - 1) * gap) / columns;
  const height = (area.height - (rows - 1) * gap) / rows;
  return atoms.map((atom, index) => {
    const column = columnMajor ? Math.floor(index / rows) : index % columns;
    const row = columnMajor ? index % rows : Math.floor(index / columns);
    return { atom, box: { x: area.x + column * (width + gap), y: area.y + row * (height + gap), width, height } };
  });
}

function splitArea(area: PresentationDesignBox, gap: number, ratio: number, focal: 'left' | 'right' | 'top' | 'bottom'): [PresentationDesignBox, PresentationDesignBox] {
  if (focal === 'left' || focal === 'right') {
    const width = (area.width - gap) * ratio;
    const otherWidth = area.width - width - gap;
    return focal === 'left'
      ? [{ ...area, width }, { ...area, x: area.x + width + gap, width: otherWidth }]
      : [{ ...area, x: area.x + otherWidth + gap, width }, { ...area, width: otherWidth }];
  }
  const height = (area.height - gap) * ratio;
  const otherHeight = area.height - height - gap;
  return focal === 'top'
    ? [{ ...area, height }, { ...area, y: area.y + height + gap, height: otherHeight }]
    : [{ ...area, y: area.y + otherHeight + gap, height }, { ...area, height: otherHeight }];
}

function insetBox(box: PresentationDesignBox, inset: number): PresentationDesignBox {
  return { x: box.x + inset, y: box.y + inset, width: box.width - inset * 2, height: box.height - inset * 2 };
}

function fitSource(source: PresentationDesignSource, box: PresentationDesignBox, requested: number): number | undefined {
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > canvas.width || box.y + box.height > canvas.height) return undefined;
  if (source.type === 'chart') return box.width >= 3.0 && box.height >= 2.0 && source.data.length <= 15 ? 16 : undefined;
  if (source.type === 'table') {
    const count = source.rows.length + 1;
    if (source.header.length > 5 || count > 8 || box.width < source.header.length * 1.05 || box.height < count * 0.29) return undefined;
    return 14;
  }
  for (let size = Math.floor(requested); size >= 14; size -= 1) {
    const available = Math.max(1, (box.width * 72 - 6) / size);
    const lines = source.text.split('\n').reduce((total, line) => {
      const weighted = [...line].reduce((count, character) => count + (/[^\x00-\xff]/u.test(character) ? 1.1 : 0.64), 0);
      return total + Math.max(1, Math.ceil(weighted / available));
    }, 0);
    if (lines * size * 1.32 <= box.height * 72 - 6) return size;
  }
  return undefined;
}
