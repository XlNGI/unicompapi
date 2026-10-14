import type { PresentationPageConstraint } from '../../domain/entities/presentation-layout-constraints';
import { createHash } from 'node:crypto';
import type { PresentationDesignNode, PresentationNodeStyle, PresentationTextSpan } from '../../domain/entities/presentation-design-tree';
import type { PresentationLayoutGeometry, PresentationLayoutPageResult, PresentationLayoutDiagnostic } from './presentation-layout-engine';

export interface ResolvedPresentationDesignNode {
  readonly node: PresentationDesignNode;
  readonly geometry: PresentationLayoutGeometry;
  readonly style: PresentationNodeStyle;
}
/** Resolve proportions and relationships exactly. No choice of page recipe or composition. */
export function solvePresentationDesignTree(page: PresentationPageConstraint, canvas: { width: number; height: number }): {
  readonly page?: PresentationLayoutPageResult; readonly diagnostics: readonly PresentationLayoutDiagnostic[];
} {
  const tree = page.designTree!;
  const diagnostics: PresentationLayoutDiagnostic[] = [];
  const nodes: ResolvedPresentationDesignNode[] = [];
  const placements: PresentationLayoutPageResult['placements'][number][] = [];
  const elements = new Map(page.elements.map(element => [element.sourceRef, element]));
  const covered = new Set<string>();
  const error = (code: PresentationLayoutDiagnostic['code'], nodeId: string) => diagnostics.push({ code, pageNumber: page.pageNumber, nodeId });
  const footer = elements.get('generated.page-number');
  const area = { x: page.safeArea.leftInset, y: page.safeArea.topInset,
    width: canvas.width - page.safeArea.leftInset - page.safeArea.rightInset,
    height: canvas.height - page.safeArea.topInset - page.safeArea.bottomInset - (footer ? footer.preferredHeight + page.preferredGap : 0) };
  const visit = (node: PresentationDesignNode, box: PresentationLayoutGeometry, inherited: PresentationNodeStyle) => {
    const style = { ...inherited, ...node.style };
    if (box.width < 0.01 || box.height < 0.01 || !Object.values(box).every(Number.isFinite)) { error('unsatisfied_constraint', node.nodeId); return; }
    nodes.push({ node, geometry: rounded(box), style });
    if (node.type === 'content') {
      const element = elements.get(node.contentRef!);
      if (!element || covered.has(node.contentRef!)) { error('unsatisfied_constraint', node.nodeId); return; }
      covered.add(node.contentRef!);
      const desired = style.fontSize ?? element.preferredFontSize;
      const largest = Math.max(desired, ...((node.textSpans ?? []).map(span => span.style.fontSize ?? 0)));
      const minimum = Math.max(14, desired * (tree.minimumFontScale ?? (style.fontSize === undefined && !node.textSpans?.some(span => span.style.fontSize) ? 0.7 : 1)));
      const fits = (font: number): boolean => {
        if (element.role === 'chart') return box.width >= element.minWidth && box.height >= element.minHeight;
        if (element.role === 'table') {
          const rows = element.tableCellWidthsEm ?? [];
          const cols = element.tableColumns ?? 1;
          const colWidth = (box.width - cols * 0.12) / cols;
          const height = rows.reduce((sum, row) => sum + Math.max(1, ...row.map(width => Math.ceil(width * font / 72 / Math.max(0.05, colWidth)))) * font / 72 * (style.lineSpacing ?? 1.2) + 0.12, 0);
          return height <= box.height && colWidth >= 0.15;
        }
        const maxFont = largest * font / desired;
        const width = element.estimatedTextWidthEm * maxFont / 72 + Math.max(0, element.textLength - 1) * Math.max(0, style.charSpacing ?? 0) / 72;
        const lines = Math.max(1, Math.ceil(width / Math.max(0.05, box.width - 0.06)));
        return lines * maxFont / 72 * (style.lineSpacing ?? 1.2) + 0.08 <= box.height;
      };
      let fontSize = desired;
      while (fontSize >= minimum && !fits(fontSize)) fontSize -= 0.5;
      if (fontSize < minimum) { error('font_below_minimum', node.nodeId); return; }
      placements.push({ sourceRef: element.sourceRef, role: element.role, hierarchy: element.hierarchy, region: 'center',
        geometry: rounded(box), fontSize, alignment: style.alignment === 'left' ? 'start' : style.alignment === 'right' ? 'end' : style.alignment ?? element.alignment,
        zIndex: placements.length, designNodeId: node.nodeId, designStyle: style,
        ...(node.textSpans ? { textSpans: node.textSpans.map(span => ({ ...span, style: { ...span.style,
          ...(span.style.fontSize === undefined ? {} : { fontSize: span.style.fontSize * fontSize / desired }) } })) as readonly PresentationTextSpan[] } : {}) });
      return;
    }
    if (!node.children) return;
    const short = Math.min(box.width, box.height), pad = (node.padding ?? 0) * short;
    const inner = { x: box.x + pad, y: box.y + pad, width: box.width - pad * 2, height: box.height - pad * 2 };
    const gap = (node.gap ?? 0) * Math.min(inner.width, inner.height);
    const children = node.children;
    const childStyle = { ...style }; delete childStyle.fill; delete childStyle.borderColor; delete childStyle.borderWidth;
    if (node.type === 'overlay') {
      children.forEach(child => {
        const width = inner.width * (child.widthFraction ?? 1), height = inner.height * (child.heightFraction ?? 1);
        const anchor = child.anchor!;
        const x = anchor.includes('left') ? inner.x : anchor.includes('right') ? inner.x + inner.width - width : inner.x + (inner.width - width) / 2;
        const y = anchor.includes('top') ? inner.y : anchor.includes('bottom') ? inner.y + inner.height - height : inner.y + (inner.height - height) / 2;
        visit(child, { x, y, width, height }, childStyle);
      });
    } else if (node.type === 'grid') {
      const columns = node.columns!;
      const slots: { child: PresentationDesignNode; row: number; column: number; span: number }[] = [];
      let row = 0, column = 0;
      children.forEach(child => {
        const span = child.columnSpan ?? 1;
        if (column + span > columns) { row += 1; column = 0; }
        slots.push({ child, row, column, span }); column += span;
        if (column === columns) { row += 1; column = 0; }
      });
      const rows = Math.max(...slots.map(slot => slot.row)) + 1;
      const cellWidth = (inner.width - gap * (columns - 1)) / columns, cellHeight = (inner.height - gap * (rows - 1)) / rows;
      slots.forEach(slot => visit(slot.child, { x: inner.x + slot.column * (cellWidth + gap), y: inner.y + slot.row * (cellHeight + gap),
        width: cellWidth * slot.span + gap * (slot.span - 1), height: cellHeight }, childStyle));
    } else {
      const horizontal = node.type === 'row';
      const available = (horizontal ? inner.width : inner.height) - gap * (children.length - 1);
      const total = children.reduce((sum, child) => sum + (child.weight ?? 1), 0);
      let offset = horizontal ? inner.x : inner.y;
      children.forEach(child => {
        const extent = available * (child.weight ?? 1) / total;
        visit(child, horizontal ? { x: offset, y: inner.y, width: extent, height: inner.height }
          : { x: inner.x, y: offset, width: inner.width, height: extent }, childStyle);
        offset += extent + gap;
      });
    }
  };
  visit(tree.root, area, {});
  if (covered.size !== page.elements.filter(element => element !== footer).length) error('unsatisfied_constraint', tree.root.nodeId);
  // Background shapes may overlap. Content and image foreground boxes must be distinct.
  const foreground = nodes.filter(item => item.node.type === 'content' || item.node.type === 'image');
  foreground.forEach((left, index) => foreground.slice(index + 1).forEach(right => {
    const a = left.geometry, b = right.geometry;
    if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.015 &&
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.015) error('layout_overlap', right.node.nodeId);
  }));
  if (footer) placements.push({ sourceRef: footer.sourceRef, role: footer.role, hierarchy: footer.hierarchy, region: 'bottom', fontSize: footer.preferredFontSize,
    alignment: 'end', zIndex: placements.length, geometry: { x: canvas.width - page.safeArea.rightInset - footer.preferredWidth,
      y: canvas.height - page.safeArea.bottomInset - footer.preferredHeight, width: footer.preferredWidth, height: footer.preferredHeight } });
  if (diagnostics.length) return { diagnostics };
  return { diagnostics, page: { pageNumber: page.pageNumber, pageRole: page.pageRole, composition: 'authored', selectedLayout: 'design-tree',
    density: page.density, whitespace: page.designIntent.whitespace, primaryRegion: 'center', placements,
    geometrySignature: createHash('sha256').update(JSON.stringify(placements.map(item => [item.sourceRef, item.geometry, item.fontSize]))).digest('hex'), authoredNodes: nodes,
    ...(page.contentOrganization ? { contentOrganization: page.contentOrganization } : {}) } };
}
function rounded(box: PresentationLayoutGeometry): PresentationLayoutGeometry {
  return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10000) / 10000])) as unknown as PresentationLayoutGeometry;
}
