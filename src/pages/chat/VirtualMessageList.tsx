import { cloneElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from 'react';

export interface VirtualMessageListProps {
  readonly itemIds: readonly string[];
  readonly containerRef: RefObject<HTMLDivElement>;
  readonly renderItem: (itemId: string, style: CSSProperties) => ReactElement | null;
  readonly estimatedItemHeight?: number;
  readonly overscan?: number;
  readonly rowGap?: number;
  readonly className?: string;
}

export class VirtualMessageLayoutIndex {
  private readonly tree: number[];
  private readonly heights: number[];

  constructor(heights: readonly number[], private readonly rowGap: number) {
    this.heights = [...heights];
    this.tree = Array(heights.length + 1).fill(0);
    for (let index = 0; index < heights.length; index += 1) {
      const node = index + 1;
      this.tree[node] += heights[index]! + rowGap;
      const parent = node + (node & -node);
      if (parent < this.tree.length) this.tree[parent] += this.tree[node]!;
    }
  }

  get totalHeight(): number {
    return this.prefixHeight(this.heights.length) - (this.heights.length > 0 ? this.rowGap : 0);
  }

  offsetOf(index: number): number {
    return this.prefixHeight(index);
  }

  update(index: number, height: number): boolean {
    const previous = this.heights[index];
    if (previous === undefined || previous === height) return false;
    this.heights[index] = height;
    const difference = height - previous;
    for (let node = index + 1; node < this.tree.length; node += node & -node) {
      this.tree[node] += difference;
    }
    return true;
  }

  itemAt(offset: number): number {
    if (this.heights.length === 0 || offset <= 0) return 0;
    let index = 0;
    let height = 0;
    let step = 2 ** Math.floor(Math.log2(this.heights.length));
    for (; step > 0; step = Math.floor(step / 2)) {
      const candidate = index + step;
      if (candidate < this.tree.length && height + this.tree[candidate]! <= offset) {
        index = candidate;
        height += this.tree[candidate]!;
      }
    }
    return Math.min(index, this.heights.length - 1);
  }

  private prefixHeight(count: number): number {
    let total = 0;
    for (let node = count; node > 0; node -= node & -node) total += this.tree[node]!;
    return total;
  }
}

/** A dependency-free variable-height list for the chat viewport. */
export function VirtualMessageList({ itemIds, containerRef, renderItem, estimatedItemHeight = 112, overscan = 5, rowGap = 24, className = 'uc-chat-page__message-list' }: VirtualMessageListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const heightsRef = useRef(new Map<string, number>());
  const [, setLayoutVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      setScrollTop(container.scrollTop);
      setViewportHeight(container.clientHeight || 640);
    };
    update();
    container.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(container);
    return () => {
      container.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [containerRef]);

  const layout = useMemo(() => new VirtualMessageLayoutIndex(
    itemIds.map(itemId => heightsRef.current.get(itemId) ?? estimatedItemHeight), rowGap
  ), [estimatedItemHeight, itemIds, rowGap]);

  const indexById = useMemo(() => new Map(itemIds.map((itemId, index) => [itemId, index])), [itemIds]);
  const listTop = listRef.current?.offsetTop ?? 0;
  const localTop = Math.max(0, scrollTop - listTop);
  let start = layout.itemAt(localTop);
  const endLimit = localTop + viewportHeight;
  const lastVisible = layout.itemAt(endLimit);
  let end = Math.min(itemIds.length, lastVisible + (layout.offsetOf(lastVisible) < endLimit ? 1 : 0));
  start = Math.max(0, start - overscan);
  end = Math.min(itemIds.length, end + overscan);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const itemId = (entry.target as HTMLElement).dataset.virtualItemId;
        if (!itemId) continue;
        const itemIndex = indexById.get(itemId);
        if (itemIndex === undefined) continue;
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (height > 0 && heightsRef.current.get(itemId) !== height && layout.update(itemIndex, height)) {
          heightsRef.current.set(itemId, height);
          changed = true;
        }
      }
      if (changed) setLayoutVersion(version => version + 1);
    });
    for (const row of list.querySelectorAll<HTMLElement>('[data-virtual-item-id]')) observer.observe(row);
    return () => observer.disconnect();
  }, [end, indexById, itemIds, layout, start]);

  return (
    <ol className={className} ref={listRef} style={{ position: 'relative', height: layout.totalHeight, minHeight: layout.totalHeight }}>
      {itemIds.slice(start, end).map((itemId, index) => {
        const absoluteIndex = start + index;
        const style: CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${layout.offsetOf(absoluteIndex)}px)` };
        const element = renderItem(itemId, style);
        if (!element) return null;
        return cloneElement(element as ReactElement<{
          readonly style?: CSSProperties;
          readonly 'data-virtual-item-id'?: string;
          readonly 'data-virtual-item-index'?: number;
        }>, {
          key: itemId,
          'data-virtual-item-id': itemId,
          'data-virtual-item-index': absoluteIndex,
          style: { ...element.props.style, ...style }
        });
      })}
    </ol>
  );
}
