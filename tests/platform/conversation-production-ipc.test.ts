import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { toProjectId } from '../../src/domain';
import { getProductionTraceStore, type ProductionTraceScope } from '../../src/platform/conversation-production-trace';
import { productionTraceIpcChannels } from '../../src/shared/conversation-production-ipc';
import { registerConversationProductionIpcHandlers } from '../../electron/ipc/conversation-production-ipc';
import type { StorageProjectSession } from '../../src/platform/ipc/storage-ipc-controller';

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown, request: unknown) => void>()
}));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) => mocked.handlers.set(channel, handler),
  on: (channel: string, handler: (event: unknown, request: unknown) => void) => mocked.listeners.set(channel, handler)
} }));
const roots: string[] = [];
const disposers: (() => Promise<void>)[] = [];
beforeEach(() => { mocked.handlers.clear(); mocked.listeners.clear(); });
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-production-ipc-'));
  roots.push(rootDirectory);
  let session: StorageProjectSession | undefined = { rootDirectory, projectId: toProjectId('project-trace'), projectName: 'Trace' };
  const scope: ProductionTraceScope = { ...session, conversationId: 'conversation-trace', sourceMessageId: 'message-trace', traceId: 'message-trace', clientCommandId: 'command-trace' };
  const lifecycle = registerConversationProductionIpcHandlers({ getSession: () => session });
  disposers.push(lifecycle.clearSubscriptions);
  const sender = Object.assign(new EventEmitter(), { id: 4, send: vi.fn(), isDestroyed: () => false });
  const invoke = (channel: string, input: unknown) => mocked.handlers.get(channel)!({ sender }, input);
  return { scope, sender, invoke, lifecycle, switchSession: () => { session = undefined; }, store: getProductionTraceStore(scope) };
}

describe('conversation production IPC', () => {
  it('replays a command subscription registered before its first event and enforces sender ownership', async () => {
    const f = await fixture();
    expect(await f.invoke(productionTraceIpcChannels.subscribe, { subscriberId: 'subscription-a', clientCommandId: 'command-trace' }))
      .toEqual({ ok: true, value: true });
    mocked.listeners.get(productionTraceIpcChannels.unsubscribe)!({ sender: { id: 99 } }, { subscriberId: 'subscription-a' });
    await f.store.append(f.scope, { code: 'model_request', status: 'started' });
    expect(f.sender.send).toHaveBeenCalledTimes(1);
    expect(f.sender.send.mock.calls[0][1]).toMatchObject({ subscriberId: 'subscription-a', event: { sequence: 1, traceId: 'message-trace' } });
    mocked.listeners.get(productionTraceIpcChannels.unsubscribe)!({ sender: f.sender }, { subscriberId: 'subscription-a' });
    await f.store.append(f.scope, { code: 'model_response', status: 'completed' });
    expect(f.sender.send).toHaveBeenCalledTimes(1);
  });

  it('stops subscriptions across a project session switch and rejects late list results', async () => {
    const f = await fixture();
    await f.store.append(f.scope, { code: 'request_received', status: 'completed' });
    await f.invoke(productionTraceIpcChannels.subscribe, { subscriberId: 'subscription-a', conversationId: 'conversation-trace', afterSequence: 1 });
    const list = f.invoke(productionTraceIpcChannels.list, { conversationId: 'conversation-trace' });
    f.switchSession();
    expect(await list).toMatchObject({ ok: false, error: { code: 'project_not_open' } });
    await f.store.append(f.scope, { code: 'model_response', status: 'completed' });
    expect(f.sender.send).not.toHaveBeenCalled();
  });

  it('rejects renderer supplied project/root scopes and ambiguous filters', async () => {
    const f = await fixture();
    expect(await f.invoke(productionTraceIpcChannels.list, { conversationId: 'conversation-trace', projectId: 'another-project' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await f.invoke(productionTraceIpcChannels.subscribe, { subscriberId: 'subscription-a', conversationId: 'conversation-trace', clientCommandId: 'command-trace' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await f.invoke(productionTraceIpcChannels.subscribe, { subscriberId: 'subscription-a', conversationId: '../secret', rootDirectory: 'anything' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});
