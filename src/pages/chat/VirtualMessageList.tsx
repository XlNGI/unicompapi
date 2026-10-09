import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from 'react';

export interface VirtualMessageListProps {
  readonly itemIds: readonly string[];
  readonly containerRef: RefObject<HTMLDivElement>;
  readonly renderItem: (itemId: string, style: CSSProperties) => ReactElement | null;
  readonly estimatedItemHeight?: number;
  readonly overscan?: number;
  readonly className?: string;
}

/** A dependency-free variable-height list for the chat viewport. */
export function VirtualMessageList({ itemIds, containerRef, renderItem, estimatedItemHeight = 112, overscan = 5, className = 'uc-chat-page__message-list' }: VirtualMessageListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const heightsRef = useRef(new Map<string, number>());
  const [layoutVersion, setLayoutVersion] = useState(0);
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

  const layout = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const itemId of itemIds) {
      offsets.push(total);
      total += heightsRef.current.get(itemId) ?? estimatedItemHeight;
    }
    return { offsets, total };
  }, [estimatedItemHeight, itemIds, layoutVersion]);

  const listTop = listRef.current?.offsetTop ?? 0;
  const localTop = Math.max(0, scrollTop - listTop);
  let start = 0;
  while (start < itemIds.length && layout.offsets[start]! + (heightsRef.current.get(itemIds[start]!) ?? estimatedItemHeight) < localTop) start += 1;
  const endLimit = localTop + viewportHeight;
  let end = start;
  while (end < itemIds.length && layout.offsets[end]! < endLimit) end += 1;
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
        const height = Math.ceil(entry.contentRect.height);
        if (height > 0 && heightsRef.current.get(itemId) !== height) {
          heightsRef.current.set(itemId, height);
          changed = true;
        }
      }
      if (changed) setLayoutVersion(version => version + 1);
    });
    for (const row of list.querySelectorAll<HTMLElement>('[data-virtual-item-id]')) observer.observe(row);
    return () => observer.disconnect();
  }, [end, itemIds, start]);

  return (
    <ol className={className} ref={listRef} style={{ position: 'relative', height: layout.total, minHeight: layout.total }}>
      {itemIds.slice(start, end).map((itemId, index) => {
        const absoluteIndex = start + index;
        const style: CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${layout.offsets[absoluteIndex]}px)` };
        const element = renderItem(itemId, style);
        return element ? <div data-virtual-item-id={itemId} key={itemId} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: style.transform }}>{element}</div> : null;
      })}
    </ol>
  );
}
