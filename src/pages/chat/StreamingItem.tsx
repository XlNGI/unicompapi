import { useCallback, useSyncExternalStore } from 'react';
import { StreamingMarkdown } from './StreamingMarkdown';
import { getThreadItemStreamContent, subscribeThreadItemStream } from './threadItemStreamStore';

const emptySubscribe = () => () => undefined;

export interface StreamingItemProps {
  readonly itemId: string;
  readonly content: string;
  readonly streaming: boolean;
}

/** The active assistant Item owns its renderer subscription to streamed content. */
export function StreamingItem({ itemId, content, streaming }: StreamingItemProps) {
  const subscribe = useCallback((listener: () => void) => itemId
    ? subscribeThreadItemStream(itemId, listener) : emptySubscribe(), [itemId]);
  const getSnapshot = useCallback(() => itemId
    ? getThreadItemStreamContent(itemId) : undefined, [itemId]);
  const streamedContent = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return <StreamingMarkdown content={streamedContent ?? content} streaming={streaming} />;
}
