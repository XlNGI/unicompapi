type FlushHandler = (deadlineMs: number) => Promise<boolean>;

const handlers = new Set<FlushHandler>();
const editors = new Set<() => void>();

export function registerPendingEditor(commit: () => void): () => void {
  editors.add(commit);
  return () => { editors.delete(commit); };
}

// Commit local text before any coordinator checks or saves its pending snapshot.
export function commitPendingEditors(): void {
  for (const commit of [...editors]) commit();
}

export function registerAutosaveFlush(handler: FlushHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export async function flushRegisteredAutosaves(deadlineMs = 3_000): Promise<boolean> {
  commitPendingEditors();
  if (handlers.size === 0) return true;
  const deadline = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), deadlineMs);
  });
  const flush = Promise.all([...handlers].map((handler) => handler(deadlineMs)))
    .then((results) => results.every(Boolean));
  return Promise.race([flush, deadline]);
}
