type Listener = () => void;

interface ItemStreamContent {
  value: string;
}

const maximumCachedItems = 16;
const contentByItemId = new Map<string, ItemStreamContent>();
const listenersByItemId = new Map<string, Set<Listener>>();

export function getThreadItemStreamContent(itemId: string): string | undefined {
  const content = contentByItemId.get(itemId);
  if (!content) return undefined;
  contentByItemId.delete(itemId);
  contentByItemId.set(itemId, content);
  return content.value;
}

export function subscribeThreadItemStream(itemId: string, listener: Listener): () => void {
  const listeners = listenersByItemId.get(itemId) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByItemId.set(itemId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByItemId.delete(itemId);
  };
}

export function setThreadItemStreamSnapshot(itemId: string, content: string): void {
  const current = getThreadItemStreamContent(itemId);
  if (current === content) return;
  contentByItemId.delete(itemId);
  contentByItemId.set(itemId, { value: content });
  while (contentByItemId.size > maximumCachedItems) {
    const oldest = [...contentByItemId.keys()].find(key => (listenersByItemId.get(key)?.size ?? 0) === 0);
    if (!oldest) break;
    contentByItemId.delete(oldest);
  }
  notify(itemId);
}

export function appendThreadItemStreamContent(itemId: string, delta: string): void {
  if (!delta) return;
  const content = contentByItemId.get(itemId) ?? { value: '' };
  content.value += delta;
  contentByItemId.delete(itemId);
  contentByItemId.set(itemId, content);
  notify(itemId);
}

export function clearThreadItemStreamContent(itemId: string): void {
  if (!contentByItemId.delete(itemId)) return;
  notify(itemId);
}

function notify(itemId: string): void {
  for (const listener of listenersByItemId.get(itemId) ?? []) listener();
}
