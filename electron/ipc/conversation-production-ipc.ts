import { ipcMain, type WebContents } from 'electron';
import { getProductionTraceStore } from '../../src/platform/conversation-production-trace';
import type { StorageProjectSession } from '../../src/platform/ipc/storage-ipc-controller';
import { productionTraceIpcChannels, productionTraceIdentifier, type ProductionTraceResult } from '../../src/shared/conversation-production-ipc';

export function registerConversationProductionIpcHandlers(options: { getSession(): StorageProjectSession | undefined }) {
  const subscriptions = new Map<string, { readonly senderId: number; dispose(): void }>();
  const failure = (code: 'project_not_open' | 'invalid_request' | 'storage_error'): ProductionTraceResult<never> =>
    ({ ok: false, error: { code, message: code === 'storage_error' ? 'Production records are unavailable' : 'Production trace request is unavailable' } });
  function parseRequest(request: unknown): Record<string, unknown> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Invalid production request');
    return request as Record<string, unknown>;
  }
  ipcMain.handle(productionTraceIpcChannels.list, async (_event, request: unknown) => {
    const session = options.getSession();
    if (!session) return failure('project_not_open');
    try {
      const input = parseRequest(request);
      if (Object.keys(input).some((key) => key !== 'conversationId')) return failure('invalid_request');
      const conversationId = productionTraceIdentifier(input.conversationId);
      const value = await getProductionTraceStore(session).list({ conversationId });
      if (options.getSession() !== session) return failure('project_not_open');
      return { ok: true, value } as const;
    } catch (error) { return failure(error instanceof TypeError ? 'invalid_request' : 'storage_error'); }
  });
  ipcMain.handle(productionTraceIpcChannels.subscribe, async (event, request: unknown) => {
    const session = options.getSession();
    if (!session) return failure('project_not_open');
    try {
      const input = parseRequest(request);
      if (Object.keys(input).some((key) => !['subscriberId', 'conversationId', 'clientCommandId', 'afterSequence'].includes(key)) ||
        (input.conversationId === undefined) === (input.clientCommandId === undefined)) return failure('invalid_request');
      const subscriberId = productionTraceIdentifier(input.subscriberId);
      const key = `${event.sender.id}:${subscriberId}`;
      if (subscriptions.has(key) || subscriptions.size >= 128) return failure('invalid_request');
      const conversationId = input.conversationId === undefined ? undefined : productionTraceIdentifier(input.conversationId);
      const clientCommandId = input.clientCommandId === undefined ? undefined : productionTraceIdentifier(input.clientCommandId);
      const afterSequence = input.afterSequence ?? 0;
      if (!Number.isSafeInteger(afterSequence) || Number(afterSequence) < 0) return failure('invalid_request');
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;
      const sender: WebContents = event.sender;
      const dispose = () => {
        cancelled = true; unsubscribe?.(); subscriptions.delete(key); sender.removeListener('destroyed', dispose);
      };
      subscriptions.set(key, { senderId: sender.id, dispose });
      sender.once('destroyed', dispose);
      const deliver = (payload: object) => {
        if (cancelled || sender.isDestroyed() || options.getSession() !== session) { dispose(); return; }
        sender.send(productionTraceIpcChannels.event, { subscriberId, ...payload });
      };
      try {
        unsubscribe = await getProductionTraceStore(session).subscribe({ conversationId, clientCommandId, afterSequence: Number(afterSequence) },
          (item) => deliver({ event: item }), (issue) => deliver({ issue }));
        if (cancelled || options.getSession() !== session) { dispose(); return failure('project_not_open'); }
        return { ok: true, value: true } as const;
      } catch (error) { dispose(); throw error; }
    } catch (error) { return failure(error instanceof TypeError ? 'invalid_request' : 'storage_error'); }
  });
  ipcMain.on(productionTraceIpcChannels.unsubscribe, (event, request: unknown) => {
    try {
      const input = parseRequest(request);
      const key = `${event.sender.id}:${productionTraceIdentifier(input.subscriberId)}`;
      subscriptions.get(key)?.dispose();
    } catch { /* Malformed unsubscribe has no authority over other subscriptions. */ }
  });
  return { clearSubscriptions: async () => { for (const subscription of subscriptions.values()) subscription.dispose(); } };
}
