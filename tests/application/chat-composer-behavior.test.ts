import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type * as ReactModule from 'react';
import type { ThreadItemsPageDto, ThreadSummaryPageDto } from '../../src/shared/chat-context-ipc';
import type { ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';

// A small hook runner lets us exercise the real JSX event handlers without a DOM.
// State is allocated by React's hook ordering, never by component-specific indexes.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  effects: [] as (() => void)[]
}));
vi.mock('react', async (original) => ({
  ...await original<typeof ReactModule>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useMemo(factory: () => unknown) { return factory(); },
  useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
    const index = hooks.cursor++;
    const old = hooks.slots[index] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
    if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
      hooks.slots[index] = { deps };
      hooks.effects.push(() => {
        old?.cleanup?.();
        (hooks.slots[index] as { cleanup?: () => void }).cleanup = effect() ?? undefined;
      });
    }
  }
}));

import { ChatPage, type ChatModelSelection } from '../../src/pages/chat/ChatPage';
import { ChatAttachment } from '../../src/pages/chat/ChatAttachment';
import { PROJECT_SESSION_CHANGED_EVENT } from '../../src/ui/project-session-events';

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children as ReactNode, predicate);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe('chat composer event behavior', () => {
  let tree: ReactElement;
  let draftTree: ReactNode;
  const startWorkflow = vi.fn();
  const answerWorkflow = vi.fn();
  const startResponse = vi.fn();
  const getPendingWorkflow = vi.fn();
  const session = { projectId: 'project-1', projectName: 'Test', projectPath: '/project' };
  const conversation = {
    conversationId: 'conversation-1', projectId: 'project-1', revision: 1, title: '资料问答',
    status: 'active', readOnly: false, messages: [], updatedAt: '2026-09-09T00:00:00Z'
  };
  const workflow = {
    workflowId: 'workflow-1', conversationId: 'conversation-1', projectId: 'project-1',
    sourceMessageId: 'source-1', revision: 1, status: 'needs_clarification',
    plan: { kind: 'document', action: 'create', parameters: {}, sourcePolicy: 'none', ambiguities: [] },
    pendingQuestions: [{ field: 'topic', question: '需要讲什么？', required: true }]
  };
  let initialConversationId: string | undefined;
  let initialModelSelection: ChatModelSelection | undefined;
  let currentSession = session;
  const onModelSelectionChange = vi.fn();
  let candidateEnabled = false;
  async function settle(rounds = 8) {
    for (let turn = 0; turn < rounds; turn += 1) {
      hooks.cursor = 0;
      tree = ChatPage({ initialConversationId, initialModelSelection, onModelSelectionChange });
      const field = find(tree, (item) => typeof item.type === 'function' && (item.type as { name?: string }).name === 'ChatDraftField');
      draftTree = field
        ? (field.type as (props: Record<string, unknown>) => ReactNode)(field.props)
        : undefined;
      hooks.effects.splice(0).forEach((effect) => effect());
      await Promise.resolve();
    }
  }
  function element(label: string) {
    const found = find(tree, (item) => item.props['aria-label'] === label)
      ?? find(draftTree, (item) => item.props['aria-label'] === label);
    if (!found) throw new Error(`Missing ${label}`);
    return found;
  }
  function containsText(node: ReactNode, text: string): boolean {
    if (typeof node === 'string' || typeof node === 'number') return String(node) === text;
    if (Array.isArray(node)) return node.some((child) => containsText(child, text));
    if (node && typeof node === 'object' && 'props' in node) {
      return containsText((node as ReactElement).props.children as ReactNode, text);
    }
    return false;
  }
  function conversationButton(title: string) {
    const found = find(tree, (item) => item.type === 'button'
      && item.props.className === 'uc-chat-page__workspace-conversation'
      && containsText(item.props.children as ReactNode, title));
    if (!found) throw new Error(`Missing conversation ${title}`);
    return found;
  }
  function modelPicker() {
    return find(tree, (item) => item.props.ariaLabel === '模型设置')!;
  }
  function unmount() {
    for (const slot of hooks.slots) {
      if (slot && typeof slot === 'object' && 'cleanup' in slot && typeof slot.cleanup === 'function') slot.cleanup();
    }
    hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  }
  async function type(content: string) {
    (element('对话输入').props.onChange as (event: unknown) => void)({ currentTarget: { value: content } });
    await settle();
  }
  async function send(method: 'enter' | 'button') {
    if (method === 'enter') {
      (element('对话输入').props.onKeyDown as (event: unknown) => void)({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      });
    } else {
      (element('发送消息').props.onClick as () => void)();
    }
    await settle();
  }

  beforeEach(() => {
    hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
    initialConversationId = undefined;
    initialModelSelection = { projectId: session.projectId, candidateId: 'candidate-1', productFeature: 'text_chat' };
    currentSession = session;
    // Production chat requires an explicit selected model before planning;
    // these composer behavior fixtures represent that selected state.
    candidateEnabled = true;
    vi.clearAllMocks();
    getPendingWorkflow.mockResolvedValue({ ok: true, value: null });
    startWorkflow.mockResolvedValue({ ok: true, value: { conversation, workflow } });
    answerWorkflow.mockResolvedValue({ ok: true, value: {
      conversation, workflow: { ...workflow, status: 'cancelled', revision: 2 }
    } });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: () => true,
      requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
      cancelAnimationFrame: vi.fn(),
      unicomp: {
        chatContexts: {
          listConversations: vi.fn(async () => ({ ok: true, value: initialConversationId ? [conversation] : [] })),
          listProjectContextCandidates: vi.fn(async () => ({ ok: true, value: [] })),
          listTextCandidates: vi.fn(async (productFeature: 'text_chat' | 'text_reasoning') => ({ ok: true, value: candidateEnabled ? [{
            candidateId: productFeature === 'text_chat' ? 'candidate-1' : 'candidate-reasoning',
            available: true, providerName: 'Test', connectionName: 'Test', modelName: 'Test',
            parameterSchema: { productFeature, fields: [] }
          }] : [] })),
          getPendingWorkflow, startWorkflow, answerWorkflow, startResponse,
          getConversation: vi.fn(async () => ({ ok: true, value: conversation }))
        },
        storage: { getProjectSession: vi.fn(async () => ({ ok: true, value: currentSession })) },
        getPathForFile: () => '/selected/report.pdf',
        documentAttachments: { importAttachment: vi.fn(async () => ({ ok: true, value: {
          fileId: 'file-1', fileName: 'report.pdf', sizeBytes: 20,
          extraction: { status: 'extracted', preview: 'UNTRUSTED PREVIEW', warnings: [] }
        } })) }
      }
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('binds resize following to the message list when the selected history appears after mount', async () => {
    initialConversationId = conversation.conversationId;
    const pending = deferred<unknown>();
    vi.mocked(window.unicomp!.chatContexts!.listConversations).mockImplementation(() => pending.promise as never);
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = vi.fn(); });
    await settle(12);
    const pane = find(tree, item => item.props.className === 'uc-chat-page__messages uc-scrollbar');
    if (!pane) throw new Error('Expected a mounted message pane');
    const list = {};
    const ref = (pane as unknown as { ref: { current: unknown } }).ref;
    ref.current = { querySelector: vi.fn(() => list), firstElementChild: {}, scrollTo: vi.fn(), scrollHeight: 800,
      scrollTop: 0, clientHeight: 600 };
    const message = { messageId: 'late-resize-message', conversationId: conversation.conversationId, revision: 0,
      role: 'assistant' as const, state: 'completed' as const, content: '迟到加载的历史', attachments: [],
      createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt };
    vi.mocked(window.unicomp!.chatContexts!.getConversation).mockResolvedValue({ ok: true, value: { ...conversation, messages: [message] } } as never);
    pending.resolve({ ok: true, value: [{ ...conversation, messages: [message] }] });
    await settle(24);
    expect(observe).toHaveBeenCalledWith(list);
  });

  it.each(['summaries', 'items'] as const)('restores Thread messages after a page remount when %s arrive last', async (last) => {
    const message = {
      messageId: 'message-return-to-chat', role: 'assistant' as const, state: 'completed' as const,
      conversationId: conversation.conversationId,
      revision: 1, content: 'Persisted reply after returning to chat', attachments: [],
      createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt
    };
    const summaries = { ok: true as const, value: { items: [{
      ...conversation, threadId: conversation.conversationId, messageCount: 1, turnCount: 1,
      hasActiveDocumentGeneration: false, status: 'active', storageScope: 'current_project',
      createdAt: conversation.updatedAt
    }], readAtSequence: 1, hasMore: false } satisfies ThreadSummaryPageDto };
    const page = { ok: true as const, value: {
      threadId: conversation.conversationId, revision: 1, updatedAt: conversation.updatedAt,
      readAtSequence: 1, hasMore: false, items: [{
        itemId: { namespace: 'message', value: message.messageId }, itemType: 'assistant_message',
        threadId: conversation.conversationId, status: 'completed', createdAt: conversation.updatedAt,
        sequence: 1, updatedAt: conversation.updatedAt, message
      }]
    } satisfies ThreadItemsPageDto };
    const listThreadSummaries = vi.fn(async () => summaries);
    const getThreadItemsPage = vi.fn(async () => page);
    Object.assign(window.unicomp!.chatContexts!, {
      listThreadSummaries, getThreadItemsPage, getThread: vi.fn(async () => ({ ok: true, value: summaries.value.items[0] }))
    });
    Object.assign(window.unicomp!.storage!, {
      listProjects: vi.fn(async () => ({ ok: true, value: [{
        ...session, availability: 'available', lastOpenedAt: conversation.updatedAt
      }] }))
    });
    const reply = () => find(tree, item => item.type === 'li' && item.key === message.messageId);
    await settle(24);
    (conversationButton(conversation.title).props.onClick as () => void)();
    await settle(24);
    expect(reply()).toBeDefined();

    // App retains the selected id while ChatPage is unmounted on navigation.
    unmount();
    initialConversationId = conversation.conversationId;
    const delayedSummaries = deferred<typeof summaries>();
    const delayedPage = deferred<typeof page>();
    listThreadSummaries.mockImplementation(() => delayedSummaries.promise);
    getThreadItemsPage.mockImplementation(() => delayedPage.promise);
    await settle();
    if (last === 'summaries') delayedPage.resolve(page);
    else delayedSummaries.resolve(summaries);
    await settle(16);
    if (last === 'summaries') delayedSummaries.resolve(summaries);
    else delayedPage.resolve(page);
    await settle(24);

    expect(reply()).toBeDefined();
    expect(JSON.stringify(reply()?.props.children)).toContain(message.content);
    expect(startResponse).not.toHaveBeenCalled();
  });

  it.each(['enter', 'button'] as const)('%s keeps an unsubmitted draft when no model is selected', async (method) => {
    initialModelSelection = undefined;
    await settle();
    await type('我想制作一个ppt');
    expect(element('发送消息').props.disabled).toBe(true);
    // Exercise the handler too: Enter and stale click callbacks must be guarded.
    await send(method);
    expect(element('对话输入').props.value).toBe('我想制作一个ppt');
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(answerWorkflow).not.toHaveBeenCalled();
    expect(startResponse).not.toHaveBeenCalled();
  });

  it('accepts only one Agent send when Enter and click fire before React renders', async () => {
    const pending = deferred<{ ok: false; error: { code: 'response_start_cancelled'; message: string } }>();
    const startAgentResponse = vi.fn((_request: { clientCommandId: string }) => pending.promise);
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse });
    await settle();
    await type('只发送一次');
    const click = element('发送消息').props.onClick as () => void;
    const enter = element('对话输入').props.onKeyDown as (event: unknown) => void;
    enter({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn() });
    click();
    expect(startAgentResponse).toHaveBeenCalledOnce();
    pending.resolve({ ok: false, error: { code: 'response_start_cancelled', message: 'Stopped' } });
    await settle();
  });

  it('shows the accepted user message and command progress before Agent start returns', async () => {
    const pending = deferred<{ ok: false; error: { code: 'storage_error'; message: string } }>();
    const startAgentResponse = vi.fn((_request: { clientCommandId: string }) => pending.promise);
    const subscribeCommand = vi.fn((_id: string, _event: (event: ProductionTraceEventDto) => void) => vi.fn());
    const getConversation = vi.fn(async () => ({ ok: true, value: conversation }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse, getConversation });
    Object.assign(window.unicomp!, { productionTrace: { subscribeCommand, subscribe: vi.fn(() => vi.fn()) } });
    await settle();
    await type('新请求已接受');
    await send('button');
    expect(subscribeCommand).toHaveBeenCalledOnce();
    const commandId = startAgentResponse.mock.calls[0][0].clientCommandId;
    subscribeCommand.mock.calls[0][1]({ schemaVersion: 1, projectId: session.projectId,
      conversationId: conversation.conversationId, sourceMessageId: 'accepted-user', traceId: 'trace-start',
      clientCommandId: commandId, sequence: 1, code: 'request_received', status: 'started',
      occurredAt: conversation.updatedAt });
    await settle(20);
    const user = find(tree, item => item.type === 'li' && item.key === 'accepted-user');
    expect(JSON.stringify(user?.props.children)).toContain('新请求已接受');
    expect(getConversation).toHaveBeenCalledWith(conversation.conversationId, 'fast');
    expect(element('停止生成')).toBeDefined();
    expect(element('对话输入').props.value).toBe('新请求已接受');
    pending.resolve({ ok: false, error: { code: 'storage_error', message: 'Test stop' } });
    await settle();
    expect(element('对话输入').props.value).toBe('新请求已接受');
    expect(element('发送消息').props.disabled).toBe(false);
  });

  it.each(['waiting_user', 'needs_reconciliation'] as const)('restores %s controls from Runtime alongside Thread messages', async state => {
    initialConversationId = conversation.conversationId;
    const agentSession = { sessionId: 'restored-session', revision: 3, sourceMessageId: 'source-1', state,
      deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 0,
      ...(state === 'waiting_user' ? { waiting: { reason: 'input_required', allowedActions: ['reply'] }, resumeToken: 'resume-restored' } : {}) };
    const summary = { ...conversation, threadId: conversation.conversationId, messageCount: 0, turnCount: 0,
      hasActiveDocumentGeneration: false };
    const startAgentResponse = vi.fn(async () => ({ ok: false, error: { code: 'invalid_request', message: 'Test' } }));
    const getConversation = vi.fn();
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse, getConversation,
      listThreadSummaries: vi.fn(async () => ({ ok: true, value: { items: [summary], hasMore: false, readAtSequence: 0 } })),
      getThreadItemsPage: vi.fn(async () => ({ ok: true, value: { ...summary, items: [], hasMore: false, readAtSequence: 0 } })),
      getThread: vi.fn(async () => ({ ok: true, value: { ...summary, agentSessions: [agentSession], parentRuns: [] } })) });
    await settle(28);
    expect(getConversation).not.toHaveBeenCalled();
    const card = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice');
    expect(card?.props.session).toEqual(agentSession);
    await type('补充需求');
    await send('button');
    if (state === 'waiting_user') expect(startAgentResponse).toHaveBeenCalledWith(expect.objectContaining({ continuation: {
      sessionId: agentSession.sessionId, expectedRevision: 3, resumeToken: 'resume-restored', action: 'reply'
    } }));
    else expect(startAgentResponse).not.toHaveBeenCalled();
  });

  it('restores an active response subscription and stop control after a Thread page remount', async () => {
    initialConversationId = conversation.conversationId;
    const summary = { ...conversation, threadId: conversation.conversationId, messageCount: 0, turnCount: 1,
      hasActiveDocumentGeneration: false };
    const execution = { responseExecutionId: 'restored-execution', conversationId: conversation.conversationId,
      userMessageId: 'source-1', assistantMessageId: 'assistant-1', productFeature: 'text_chat',
      state: 'streaming', streamSequence: 2, reasoningContent: '', content: '',
      createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt };
    const subscribeResponseEvents = vi.fn(() => vi.fn());
    const cancelResponseExecution = vi.fn(async () => ({ ok: true, value: { ...execution, state: 'cancelled' } }));
    Object.assign(window.unicomp!.chatContexts!, { subscribeResponseEvents, cancelResponseExecution,
      listThreadSummaries: vi.fn(async () => ({ ok: true, value: { items: [summary], hasMore: false, readAtSequence: 0 } })),
      getThreadItemsPage: vi.fn(async () => ({ ok: true, value: { ...summary, items: [], hasMore: false, readAtSequence: 0 } })),
      getThread: vi.fn(async () => ({ ok: true, value: { ...summary, agentSessions: [], parentRuns: [{
        responseExecutionId: execution.responseExecutionId, sourceMessageId: 'source-1', state: 'running',
        runRevision: 1, registeredWorkCount: 0, acknowledged: false }] } })),
      getResponseExecution: vi.fn(async () => ({ ok: true, value: execution })) });
    await settle(32);
    expect(subscribeResponseEvents).toHaveBeenCalledWith(execution.responseExecutionId, 2, expect.any(Function));
    unmount();
    await settle(32);
    expect(subscribeResponseEvents).toHaveBeenCalledTimes(2);
    (element('停止生成').props.onClick as () => void)();
    await settle(20);
    expect(cancelResponseExecution).toHaveBeenCalledWith(execution.responseExecutionId);
  });

  it.each([true, false])('keeps a persisted document draft preview after navigation without hiding ordinary JSON (document: %s)', async document => {
    initialConversationId = conversation.conversationId;
    const outline = JSON.stringify({ kind: 'ppt', title: '测试演示文稿', sections: [
      { heading: '演示概述', blocks: [{ type: 'paragraph', text: '仍保留的文档内容' }] }
    ] });
    const messages = [
      { messageId: 'source-1', role: 'user', content: '帮我生成一个测试ppt' },
      ...(document ? [{ messageId: 'disclosure-1', role: 'assistant', content: '本次制作不联网搜索',
        workflowReply: { workflowId: 'sources-workflow-1-0', revision: 0 } }] : []),
      { messageId: 'assistant-1', role: 'assistant', content: outline }
    ].map(message => ({ ...message, conversationId: conversation.conversationId, revision: 1, state: 'completed',
      attachments: [], createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt }));
    const summary = { ...conversation, threadId: conversation.conversationId, messageCount: messages.length,
      turnCount: 1, hasActiveDocumentGeneration: false };
    Object.assign(window.unicomp!.chatContexts!, {
      listThreadSummaries: vi.fn(async () => ({ ok: true, value: { items: [summary], hasMore: false, readAtSequence: 1 } })),
      getThreadItemsPage: vi.fn(async () => ({ ok: true, value: { ...summary, items: messages.map((message, sequence) => ({
        itemId: { namespace: 'message', value: message.messageId }, itemType: `${message.role}_message`, message,
        threadId: conversation.conversationId, status: 'completed', createdAt: conversation.updatedAt, sequence
      })), hasMore: false, readAtSequence: messages.length } })),
      getThread: vi.fn(async () => ({ ok: true, value: { ...summary, parentRuns: [], agentSessions: [] } }))
    });
    for (let visit = 0; visit < 2; visit += 1) {
      await settle(32);
      const reply = find(tree, item => item.type === 'li' && item.key === 'assistant-1');
      const progress = find(reply, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'DocumentProgress');
      const markdown = find(reply, item => item.props.content === outline && 'streaming' in item.props);
      if (document) {
        expect(progress?.props.bodyContent).toBe(outline);
        expect(progress?.props.detail).toBe('文档内容已接收，尚未生成可交付文件。');
        expect(markdown).toBeUndefined();
      } else {
        expect(markdown?.props.content).toBe(outline);
      }
      unmount();
    }
    expect(startResponse).not.toHaveBeenCalled();
  });

  it.each(['word', 'excel', 'ppt'] as const)('restores the local %s file generation owner and stop control from persisted status', async kind => {
    initialConversationId = conversation.conversationId;
    const message = { messageId: 'local-file-assistant', conversationId: conversation.conversationId, revision: 2,
      role: 'assistant', state: 'completed', content: '# 本地文件正文', attachments: [],
      documentGenerationStatus: { state: 'generating_file', kind }, createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt };
    const summary = { ...conversation, revision: 3, threadId: conversation.conversationId, messageCount: 1, turnCount: 1,
      hasActiveDocumentGeneration: true };
    const cancelGeneration = vi.fn(async () => ({ ok: true, value: { cancelled: true } }));
    const generateFromMessage = vi.fn();
    const reconcileGeneration = vi.fn();
    Object.assign(window.unicomp!, { documentGeneration: { cancelGeneration, generateFromMessage, reconcileGeneration } });
    Object.assign(window.unicomp!.chatContexts!, {
      listThreadSummaries: vi.fn(async () => ({ ok: true, value: { items: [summary], hasMore: false, readAtSequence: 1 } })),
      getThreadItemsPage: vi.fn(async () => ({ ok: true, value: { ...summary, items: [{
        itemId: { namespace: 'message', value: message.messageId }, itemType: 'assistant_message', message,
        threadId: conversation.conversationId, status: 'completed', createdAt: conversation.updatedAt, sequence: 1
      }], hasMore: false, readAtSequence: 1 } })),
      getConversation: vi.fn(async () => ({ ok: true, value: { ...conversation, revision: 3, messages: [message] } })),
      getThread: vi.fn(async () => ({ ok: true, value: { ...summary, parentRuns: [], agentSessions: [] } }))
    });
    await settle(32);
    const recovered = find(tree, item => item.type === 'li' && item.key === message.messageId);
    expect(recovered).toBeDefined();
    const draft = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'ChatDraftField');
    expect(draft?.props.documentGenerationActive).toBe(true);
    expect(element('停止文档生成')).toBeDefined();
    unmount();
    await settle(32);
    await type('不要重复发送');
    await send('enter');
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(startResponse).not.toHaveBeenCalled();
    (element('停止文档生成').props.onClick as () => void)();
    await settle(12);
    expect(cancelGeneration).toHaveBeenCalledWith({ conversationId: conversation.conversationId, expectedRevision: 3,
      messageId: message.messageId });
    expect(generateFromMessage).not.toHaveBeenCalled();
    expect(reconcileGeneration).not.toHaveBeenCalled();
    unmount();
  });

  it('does not plan with a selected model that is no longer available', async () => {
    candidateEnabled = false;
    await settle();
    await type('产品介绍 PPT');
    await send('enter');
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('产品介绍 PPT');
  });

  it.each(['enter', 'button'] as const)('%s sends a trimmed draft to the selected conversation agent', async (method) => {
    initialConversationId = conversation.conversationId;
    const startAgentResponse = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'request_rejected' as const, message: 'Test response failure' }
    }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse });
    await settle();
    await type('  简单聊天  ');

    await send(method);

    expect(startAgentResponse).toHaveBeenCalledWith(expect.objectContaining({ content: '简单聊天' }));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('cancels an Agent start immediately by its project command and preserves the draft', async () => {
    initialConversationId = conversation.conversationId;
    const pending = deferred<{ ok: false; error: { code: 'response_start_cancelled'; message: string } }>();
    const startAgentResponse = vi.fn(async (_request: { clientCommandId: string }) => pending.promise);
    const cancelResponseStart = vi.fn(async () => ({ ok: true, value: { cancelled: true } }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse, cancelResponseStart });
    await settle();
    await type('  当前聊天草稿  ');
    await send('button');
    expect(startAgentResponse).toHaveBeenCalledOnce();
    const stop = element('停止生成');
    expect(stop.props.disabled).toBe(false);
    (stop.props.onClick as () => void)();
    (stop.props.onClick as () => void)();
    expect(cancelResponseStart).toHaveBeenCalledOnce();
    expect(cancelResponseStart).toHaveBeenCalledWith({ projectId: session.projectId,
      clientCommandId: startAgentResponse.mock.calls[0][0].clientCommandId });
    pending.resolve({ ok: false, error: { code: 'response_start_cancelled', message: 'Cancelled' } });
    await settle(24);
    expect(element('对话输入').props.value).toBe('  当前聊天草稿  ');
    expect(startAgentResponse).toHaveBeenCalledOnce();
    expect(element('发送消息').props.disabled).toBe(false);
  });

  it('shows a local waiting response without a provider execution and sends the next answer to the same task', async () => {
    initialConversationId = conversation.conversationId;
    const agentSession = { sessionId: 'session-root-1', revision: 2, sourceMessageId: 'source-1', state: 'waiting_user',
      waiting: { reason: 'input_required', allowedActions: ['reply'] }, resumeToken: 'resume-token-1',
      deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 0 };
    const waitingConversation = { ...conversation, revision: 2, agentSessions: [agentSession] };
    const startAgentResponse = vi.fn(async () => ({ ok: true, value: { conversation: waitingConversation, agentSession, waiting: true } }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse });
    await settle();
    await type('帮我做一个 PPT');
    await send('button');
    await settle(16);
    expect(element('对话输入').props.value).toBe('');
    expect(element('发送消息').props.disabled).toBe(true);
    const waitingCard = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice');
    expect(waitingCard?.props.session).toEqual(agentSession);
    await type('主题是产品介绍，给客户看');
    await send('enter');
    expect(startAgentResponse).toHaveBeenCalledTimes(2);
    expect(startAgentResponse).toHaveBeenLastCalledWith(expect.objectContaining({
      content: '主题是产品介绍，给客户看',
      continuation: { sessionId: agentSession.sessionId, expectedRevision: 2, resumeToken: agentSession.resumeToken, action: 'reply' }
    }));
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(answerWorkflow).not.toHaveBeenCalled();
  });

  it('does not turn an unknown task result into a new provider request', async () => {
    initialConversationId = conversation.conversationId;
    const agentSession = { sessionId: 'session-root-unknown', revision: 3, sourceMessageId: 'source-1',
      state: 'needs_reconciliation', deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 1 };
    const startAgentResponse = vi.fn();
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse,
      listConversations: vi.fn(async () => ({ ok: true, value: [{ ...conversation, agentSessions: [agentSession] }] })),
      getConversation: vi.fn(async () => ({ ok: true, value: { ...conversation, agentSessions: [agentSession] } })) });
    await settle();
    await type('继续');
    await send('button');
    expect(startAgentResponse).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('继续');
  });

  it('guards repeated confirmation clicks before React updates and forwards the original task token', async () => {
    initialConversationId = conversation.conversationId;
    const agentSession = { sessionId: 'session-root-authorization', revision: 3, sourceMessageId: 'source-1',
      state: 'waiting_authorization', waiting: { reason: 'authorization_required', allowedActions: ['authorize'] },
      resumeToken: 'single-confirmation-token', deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 0 };
    const pending = deferred<{ ok: false; error: { code: 'continuation_conflict'; message: string } }>();
    const startAgentResponse = vi.fn(async () => pending.promise);
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse,
      listConversations: vi.fn(async () => ({ ok: true, value: [{ ...conversation, agentSessions: [agentSession] }] })),
      getConversation: vi.fn(async () => ({ ok: true, value: { ...conversation, agentSessions: [agentSession] } })) });
    await settle();
    const waitingCard = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')!;
    const confirm = waitingCard.props.onContinue as (action: string) => void;
    confirm('authorize'); confirm('authorize');
    expect(startAgentResponse).toHaveBeenCalledOnce();
    expect(startAgentResponse).toHaveBeenCalledWith(expect.objectContaining({ content: '确认执行', continuation: {
      sessionId: agentSession.sessionId, expectedRevision: 3, resumeToken: 'single-confirmation-token', action: 'authorize'
    } }));
    pending.resolve({ ok: false, error: { code: 'continuation_conflict', message: 'Used' } });
    await settle(20);
  });

  it('requires an explicit new-task action after expiration and never sends the expired resume token', async () => {
    initialConversationId = conversation.conversationId;
    const agentSession = { sessionId: 'expired-session', revision: 4, sourceMessageId: 'source-1', state: 'expired',
      deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 1 };
    const startAgentResponse = vi.fn(async (_request: unknown) => ({ ok: false, error: { code: 'invalid_request', message: 'Test' } }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse,
      listConversations: vi.fn(async () => ({ ok: true, value: [{ ...conversation, agentSessions: [agentSession] }] })),
      getConversation: vi.fn(async () => ({ ok: true, value: { ...conversation, agentSessions: [agentSession] } })) });
    await settle();
    await type('制作一个新的销售汇报 PPT');
    await send('button');
    expect(startAgentResponse).not.toHaveBeenCalled();
    const waitingCard = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')!;
    (waitingCard.props.onNewTask as () => void)();
    await settle();
    await send('button');
    expect(startAgentResponse).toHaveBeenCalledOnce();
    expect(startAgentResponse).toHaveBeenCalledWith(expect.objectContaining({ content: '制作一个新的销售汇报 PPT' }));
    expect(startAgentResponse.mock.calls[0][0]).not.toHaveProperty('continuation');
  });
  it('shows the new waiting task ahead of an older expired record and forwards the new nonce', async () => {
    initialConversationId = conversation.conversationId;
    const expired = { sessionId: 'old-expired', revision: 4, sourceMessageId: 'old-source', state: 'expired',
      deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 0 };
    const waiting = { sessionId: 'new-waiting', revision: 2, sourceMessageId: 'new-source', state: 'waiting_user',
      waiting: { reason: 'input_required', allowedActions: ['reply'] }, resumeToken: 'new-task-resume-token',
      deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 0 };
    const active = { ...conversation, agentSessions: [expired, waiting] };
    const startAgentResponse = vi.fn(async () => ({ ok: true, value: { conversation: active, agentSession: waiting, waiting: true } }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse,
      listConversations: vi.fn(async () => ({ ok: true, value: [active] })), getConversation: vi.fn(async () => ({ ok: true, value: active })) });
    await settle();
    const card = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')!;
    expect(card.props.session).toEqual(waiting);
    await type('主题是新的销售培训'); await send('enter');
    expect(startAgentResponse).toHaveBeenCalledWith(expect.objectContaining({ content: '主题是新的销售培训', continuation: {
      sessionId: 'new-waiting', expectedRevision: 2, resumeToken: 'new-task-resume-token', action: 'reply'
    } }));
  });
  it('keeps an unresolved unknown task ahead of a more recent waiting task', async () => {
    initialConversationId = conversation.conversationId;
    const unknown = { sessionId: 'older-unknown', revision: 4, sourceMessageId: 'old-source', state: 'needs_reconciliation',
      deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 1 };
    const waiting = { sessionId: 'newer-waiting', revision: 2, sourceMessageId: 'new-source', state: 'waiting_user',
      waiting: { reason: 'input_required', allowedActions: ['reply'] }, resumeToken: 'new-task-resume-token',
      deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 0 };
    const active = { ...conversation, agentSessions: [unknown, waiting] }, startAgentResponse = vi.fn();
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse,
      listConversations: vi.fn(async () => ({ ok: true, value: [active] })), getConversation: vi.fn(async () => ({ ok: true, value: active })) });
    await settle();
    const card = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')!;
    expect(card.props.session).toEqual(unknown);
    await type('主题是新的销售培训'); await send('enter');
    expect(startAgentResponse).not.toHaveBeenCalled();
  });
  it('does not revive an older expired task after the newer task was completed', async () => {
    initialConversationId = conversation.conversationId;
    const expired = { sessionId: 'old-expired', revision: 4, sourceMessageId: 'old-source', state: 'expired',
      deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 0 };
    const completed = { sessionId: 'new-completed', revision: 7, sourceMessageId: 'new-source', state: 'completed',
      deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 1 };
    const active = { ...conversation, agentSessions: [expired, completed] };
    const startAgentResponse = vi.fn(async (_request: unknown) => ({ ok: false, error: { code: 'invalid_request', message: 'Synthetic stop before execution' } }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse,
      listConversations: vi.fn(async () => ({ ok: true, value: [active] })), getConversation: vi.fn(async () => ({ ok: true, value: active })) });
    await settle();
    expect(find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')).toBeUndefined();
    await type('继续讨论新的主题'); await send('button');
    expect(startAgentResponse).toHaveBeenCalledOnce();
    expect(startAgentResponse.mock.calls[0][0]).not.toHaveProperty('continuation');
  });
  it('hides an expired session when its own response is already completed', async () => {
    initialConversationId = conversation.conversationId;
    const expired = { sessionId: 'expired-after-response', revision: 4, sourceMessageId: 'source-1', state: 'expired',
      deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 1 };
    const active = {
      ...conversation,
      messages: [
        { messageId: 'source-1', conversationId: conversation.conversationId, revision: 0, role: 'user', state: 'completed', content: '制作 PPT', attachments: [], createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' },
        { messageId: 'assistant-after', conversationId: conversation.conversationId, revision: 1, role: 'assistant', state: 'completed', content: '已完成', attachments: [], createdAt: '2026-10-11T00:00:01Z', updatedAt: '2026-10-11T00:00:02Z' }
      ],
      agentSessions: [expired]
    } as never;
    Object.assign(window.unicomp!.chatContexts!, {
      listConversations: vi.fn(async () => ({ ok: true, value: [active] })),
      getConversation: vi.fn(async () => ({ ok: true, value: active }))
    });
    await settle();
    expect(find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')).toBeUndefined();
  });
  it('explicitly closes an unknown planning task without a response or selected model and refreshes its root state', async () => {
    initialConversationId = conversation.conversationId; candidateEnabled = false;
    const unknown = { sessionId: 'unknown-planning', revision: 4, sourceMessageId: 'old-source', state: 'needs_reconciliation',
      deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 1, canCloseUnknown: true };
    let current = { ...conversation, agentSessions: [unknown] };
    const pending = deferred<{ ok: true; value: typeof unknown }>();
    const cancelAgentSession = vi.fn(async () => pending.promise), startAgentResponse = vi.fn();
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse, cancelAgentSession,
      listConversations: vi.fn(async () => ({ ok: true, value: [current] })), getConversation: vi.fn(async () => ({ ok: true, value: current })) });
    await settle();
    const card = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')!;
    const rendered = (card.type as (props: Record<string, unknown>) => ReactNode)(card.props);
    const close = find(rendered, item => item.props.onClick === card.props.onCloseUnknown)!;
    expect(close.props.disabled).toBe(false);
    (card.props.onCloseUnknown as () => void)(); (card.props.onCloseUnknown as () => void)();
    expect(cancelAgentSession).toHaveBeenCalledOnce();
    expect(cancelAgentSession).toHaveBeenCalledWith({ projectId: session.projectId, sessionId: unknown.sessionId, expectedRevision: 4, closeUnknown: true });
    const closed = { ...unknown, revision: 5, state: 'failed', canCloseUnknown: false };
    current = { ...conversation, revision: 2, agentSessions: [closed] }; pending.resolve({ ok: true, value: closed });
    await settle(24);
    expect(find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')).toBeUndefined();
    expect(startAgentResponse).not.toHaveBeenCalled();
  });
  it('does not offer the planning-close path for an unknown task that already has a response', async () => {
    initialConversationId = conversation.conversationId;
    const unknown = { sessionId: 'unknown-with-response', revision: 4, sourceMessageId: 'old-source', state: 'needs_reconciliation',
      deadlineAt: new Date(Date.now() + 600000).toISOString(), registeredWorkCount: 1 };
    const active = { ...conversation, agentSessions: [unknown] }, cancelAgentSession = vi.fn();
    Object.assign(window.unicomp!.chatContexts!, { cancelAgentSession,
      listConversations: vi.fn(async () => ({ ok: true, value: [active] })), getConversation: vi.fn(async () => ({ ok: true, value: active })) });
    await settle();
    const card = find(tree, item => typeof item.type === 'function' && (item.type as { name?: string }).name === 'AgentSessionNotice')!;
    const rendered = (card.type as (props: Record<string, unknown>) => ReactNode)(card.props);
    expect(find(rendered, item => containsText(item.props.children as ReactNode, '确认关闭本次任务'))).toBeUndefined();
    (card.props.onCloseUnknown as () => void)();
    expect(cancelAgentSession).not.toHaveBeenCalled();
  });

  it('keeps the deferred post-start cancellation fallback when the preload has no start-cancel API', async () => {
    initialConversationId = conversation.conversationId;
    const execution = { responseExecutionId: 'legacy-start-execution', conversationId: conversation.conversationId,
      userMessageId: 'legacy-user', assistantMessageId: 'legacy-assistant', state: 'pending', content: '', streamSequence: 0 };
    const pending = deferred<{ ok: true; value: { conversation: typeof conversation; execution: typeof execution } }>();
    const startAgentResponse = vi.fn(async (_request: { clientCommandId: string }) => pending.promise);
    const cancelResponseExecution = vi.fn(async () => ({ ok: true, value: { ...execution, state: 'cancelled' } }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse, cancelResponseExecution,
      subscribeResponseEvents: vi.fn(() => () => undefined), replayResponseEvents: vi.fn(async () => ({ ok: true, value: [] })) });
    await settle();
    await type('旧环境草稿');
    await send('button');
    (element('停止生成').props.onClick as () => void)();
    expect(cancelResponseExecution).not.toHaveBeenCalled();
    pending.resolve({ ok: true, value: { conversation, execution } });
    await settle(30);
    expect(cancelResponseExecution).toHaveBeenCalledWith(execution.responseExecutionId);
    expect(element('对话输入').props.value).toBe('旧环境草稿');
  });

  it('cancels a document response start before execution identity exists and retains the source request', async () => {
    const requirements = '帮我生成10页PPT';
    const documentConversation = { ...conversation, messages: [{ messageId: 'source-1', role: 'user', state: 'completed',
      content: requirements, attachments: [] }] };
    const ready = { ...workflow, status: 'ready', plan: { ...workflow.plan, action: 'create', documentKind: 'ppt',
      parameters: { topic: '季度经营' } }, pendingQuestions: [] };
    const pending = deferred<{ ok: false; error: { code: 'response_start_cancelled'; message: string } }>();
    startWorkflow.mockResolvedValue({ ok: true, value: { conversation: documentConversation, workflow: ready } });
    getPendingWorkflow.mockResolvedValue({ ok: true, value: ready });
    startResponse.mockImplementation(async () => pending.promise);
    const cancelResponseStart = vi.fn(async () => ({ ok: true, value: { cancelled: true } }));
    Object.assign(window.unicomp!.chatContexts!, { cancelResponseStart });
    const prepareGeneration = vi.fn();
    Object.assign(window.unicomp!, { documentGeneration: { prepareGeneration } });
    try {
      await settle();
      await type(requirements);
      await send('button');
      await settle(24);
      expect(startResponse).toHaveBeenCalledOnce();
      (element('停止生成').props.onClick as () => void)();
      expect(cancelResponseStart).toHaveBeenCalledWith({ projectId: session.projectId,
        clientCommandId: startResponse.mock.calls[0][0].clientCommandId });
      pending.resolve({ ok: false, error: { code: 'response_start_cancelled', message: 'Cancelled' } });
      await settle(30);
      expect(prepareGeneration).not.toHaveBeenCalled();
      expect(element('对话输入').props.value).toBe(requirements);
    } finally { startResponse.mockReset(); }
  });

  it('restores the selected reasoning model and feature together after leaving and reopening chat', async () => {
    await settle();
    const reasoning = find(modelPicker().props.listboxHeader as ReactNode, (item) =>
      item.props.role === 'radio' && item.props['aria-checked'] === false)!;
    (reasoning.props.onClick as () => void)();
    await settle();
    const saved = onModelSelectionChange.mock.calls.at(-1)?.[0] as ChatModelSelection;
    expect(saved).toEqual({ projectId: session.projectId, candidateId: 'candidate-reasoning', productFeature: 'text_reasoning' });
    unmount();
    initialModelSelection = saved;
    await settle();
    expect(modelPicker().props.value).toBe('candidate-reasoning');
    expect(modelPicker().props.options).toEqual([expect.objectContaining({ id: 'candidate-reasoning' })]);
    await type('帮我生成一个ppt');
    expect(element('发送消息').props.disabled).toBe(false);
    await send('button');
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      semanticCandidate: { candidateId: 'candidate-reasoning', productFeature: 'text_reasoning' }
    }));
  });

  it('does not send a restored candidate under a different product feature', async () => {
    initialModelSelection = { projectId: session.projectId, candidateId: 'candidate-reasoning', productFeature: 'text_chat' };
    await settle();
    expect(modelPicker().props.value).toBe('');
    await type('帮我生成一个ppt');
    expect(element('发送消息').props.disabled).toBe(true);
    await send('enter');
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(onModelSelectionChange).toHaveBeenLastCalledWith(undefined);
  });

  it('clears a restored selection when the project changed while chat was hidden', async () => {
    currentSession = { ...session, projectId: 'project-2' };
    await settle();
    expect(modelPicker().props.value).toBe('');
    expect(onModelSelectionChange).toHaveBeenLastCalledWith(undefined);
    await type('产品介绍 PPT');
    await send('enter');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('clears the active model selection when the project changes without choosing a replacement', async () => {
    await settle();
    expect(modelPicker().props.value).toBe('candidate-1');
    currentSession = { ...session, projectId: 'project-2' };
    const refresh = vi.mocked(window.addEventListener).mock.calls.find(([event]) => event === PROJECT_SESSION_CHANGED_EVENT)?.[1];
    expect(refresh).toBeTypeOf('function');
    (refresh as () => void)();
    await settle();
    expect(modelPicker().props.value).toBe('');
    expect(onModelSelectionChange).toHaveBeenLastCalledWith(undefined);
    await type('产品介绍 PPT');
    await send('enter');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ['request_rejected', '', '参数'],
    ['access_denied', '', '权限'],
    ['request_rejected', '已接收到的部分内容', '已保留接收到的内容']
  ] as const)('shows a saved %s failure inside the message after reopening', async (failureReason, content, expected) => {
    initialConversationId = conversation.conversationId;
    const saved = { ...conversation, messages: [{
      messageId: 'failed-assistant', role: 'assistant', state: 'failed', content,
      failureReason, attachments: [], createdAt: conversation.updatedAt
    }] };
    Object.assign(window.unicomp!.chatContexts!, {
      listConversations: vi.fn(async () => ({ ok: true, value: [saved] })),
      getConversation: vi.fn(async () => ({ ok: true, value: saved }))
    });
    await settle();
    expect(element('回复失败原因').props.children).toContain(expected);
    expect(element('回复失败原因').props.children).not.toContain('数据格式异常');
    expect(find(tree, (item) => item.props.content === '尚无内容')).toBeUndefined();
    if (content) expect(find(tree, (item) => item.props.content === content)).toBeDefined();
  });

  it.each(['enter', 'button'] as const)('%s sends natural language through the same workflow without a mode hint', async (method) => {
    await settle();
    expect(find(tree, (item) => item.props.title === '生成 Office 文档（Word/Excel/PPT）')).toBeUndefined();
    await type('这份报告主要讲了什么？');
    await send(method);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({
      content: '这份报告主要讲了什么？'
    });
    expect(startWorkflow.mock.calls[0][0].intentHint).toBeUndefined();
    expect(startResponse).not.toHaveBeenCalled();
  });

  it('imports a dropped attachment without enabling Office mode or inserting its preview into instructions', async () => {
    await settle();
    const page = find(tree, (item) => typeof item.props.onDrop === 'function')!;
    (page.props.onDrop as (event: unknown) => void)({ preventDefault: vi.fn(), dataTransfer: { files: [{}] } });
    await settle();
    await type('总结主要观点，在这里回复就行');
    await send('enter');
    const request = startWorkflow.mock.calls[0][0];
    expect(request.attachmentFileIds).toEqual(['file-1']);
    expect(request.intentHint).toBeUndefined();
    expect(request.content).toBe('总结主要观点，在这里回复就行');
  });

  it('imports a pasted image, previews it, and submits its registered reference', async () => {
    const preview = 'data:image/png;base64,aGVsbG8=';
    vi.stubGlobal('FileReader', class {
      result = preview;
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    });
    const importImage = vi.fn(async () => ({ ok: true, value: { fileId: 'image-1', fileName: 'clipboard.png', sizeBytes: 5,
      extraction: { status: 'unsupported', warnings: [], preview: '' } } }));
    Object.assign(window.unicomp!, { getPathForFile: () => '' });
    Object.assign(window.unicomp!.documentAttachments!, { importAttachment: importImage });
    await settle();
    const preventDefault = vi.fn();
    (element('对话输入').props.onPaste as (event: unknown) => void)({ preventDefault, clipboardData: { files: [{ type: 'image/png', size: 5 }] } });
    await settle();
    expect(preventDefault).toHaveBeenCalled();
    expect(importImage).toHaveBeenCalledWith({ image: { mimeType: 'image/png', base64: 'aGVsbG8=' } });
    expect(find(tree, item => item.type === ChatAttachment)?.props.previewUrl).toBe(preview);
    await type('分析一下图片');
    await send('button');
    expect(startWorkflow.mock.calls[0][0].attachmentFileIds).toEqual(['image-1']);
    expect(startWorkflow.mock.calls[0][0].content).toBe('分析一下图片');
    expect(JSON.stringify(startWorkflow.mock.calls[0][0])).not.toContain('base64');
  });

  it('does not submit when Enter is only committing Chinese input composition', async () => {
    await settle();
    await type('销售分析');
    (element('对话输入').props.onKeyDown as (event: unknown) => void)({
      key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault: vi.fn()
    });
    await settle();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it.each(['new', 'answer'] as const)('synchronizes the saved conversation before a %s follow-up', async (phase) => {
    initialConversationId = conversation.conversationId;
    if (phase === 'answer') getPendingWorkflow.mockResolvedValue({ ok: true, value: workflow });
    Object.assign(window.unicomp!.chatContexts!, {
      getConversation: vi.fn(async () => ({ ok: true, value: { ...conversation, revision: 12 } }))
    });
    await settle();
    await type('生成提示词');
    await send('button');
    const request = (phase === 'new' ? startWorkflow : answerWorkflow).mock.calls[0][0];
    expect(phase === 'new' ? request.conversation.expectedRevision : request.expectedConversationRevision).toBe(12);
    expect(request.content).toBe('生成提示词');
  });

  it('keeps the input and does not submit when synchronizing the conversation fails', async () => {
    initialConversationId = conversation.conversationId;
    Object.assign(window.unicomp!.chatContexts!, {
      getConversation: vi.fn(async () => ({ ok: false, error: { code: 'storage_error' } }))
    });
    await settle();
    await type('生成提示词');
    await send('button');
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('生成提示词');
  });

  it('does not submit after cancellation during conversation synchronization', async () => {
    initialConversationId = conversation.conversationId;
    let resolveRead!: (result: unknown) => void;
    Object.assign(window.unicomp!.chatContexts!, {
      getConversation: vi.fn(() => new Promise(resolve => { resolveRead = resolve; })),
      cancelPlanning: vi.fn(async () => ({ ok: true, value: { cancelled: false } }))
    });
    await settle();
    await type('生成提示词');
    await send('button');
    (element('停止需求理解').props.onClick as () => void)();
    await settle();
    resolveRead({ ok: true, value: { ...conversation, revision: 12 } });
    await settle();
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('生成提示词');
  });

  it('does not let a late workflow or focus snapshot replace a newer saved conversation', async () => {
    initialConversationId = conversation.conversationId;
    const title = '已保存的新会话标题';
    Object.assign(window.unicomp!.chatContexts!, {
      getConversation: vi.fn(async () => ({ ok: true, value: { ...conversation, revision: 12, title } }))
    });
    await settle();
    await type('生成提示词');
    await send('button');
    expect(find(tree, item => item.props.children === title)).toBeDefined();
    const onFocus = vi.mocked(window.addEventListener).mock.calls.find(call => call[0] === 'focus')![1] as () => void;
    onFocus();
    await settle();
    expect(find(tree, item => item.props.children === title)).toBeDefined();
  });

  it('preserves a real write conflict without automatically submitting the same message twice', async () => {
    initialConversationId = conversation.conversationId;
    startWorkflow.mockResolvedValue({ ok: false, error: { code: 'revision_conflict' } });
    await settle();
    await type('生成提示词');
    await send('button');
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(element('对话输入').props.value).toBe('生成提示词');
  });

  it.each(['needs_confirmation', 'ready'] as const)('accepts natural cancellation while %s and leaves no executable workflow', async (status) => {
    initialConversationId = conversation.conversationId;
    getPendingWorkflow.mockResolvedValue({ ok: true, value: { ...workflow, status } });
    await settle();
    await type('不用做 PPT 了，取消');
    await send('button');
    expect(answerWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(startResponse).not.toHaveBeenCalled();
    expect(find(tree, (item) => item.props.children === '取消任务')).toBeUndefined();
  });

  it.each(['new', 'answer'] as const)('stops %s planning and ignores a late ready result after cancellation', async (phase) => {
    candidateEnabled = true;
    if (phase === 'answer') {
      initialConversationId = conversation.conversationId;
      getPendingWorkflow.mockResolvedValue({ ok: true, value: workflow });
    }
    const planningCall = phase === 'new' ? startWorkflow : answerWorkflow;
    let finishPlanning: ((value: unknown) => void) | undefined;
    planningCall.mockReturnValue(new Promise((resolve) => { finishPlanning = resolve; }));
    const cancelPlanning = vi.fn(async () => ({ ok: true, value: { cancelled: true } }));
    const cancelWorkflow = vi.fn(async () => ({ ok: true, value: { ...workflow, status: 'cancelled' } }));
    Object.assign(window.unicomp!.chatContexts!, { cancelPlanning, cancelWorkflow });
    await settle();
    await type('帮我分析这个问题');
    await send('button');
    const stop = element('停止需求理解');
    expect(stop.props.disabled).toBe(false);
    (stop.props.onClick as () => void)();
    await settle();
    expect(cancelPlanning).toHaveBeenCalledWith({ clientCommandId: planningCall.mock.calls[0][0].clientCommandId });
    finishPlanning!({ ok: true, value: {
      conversation, workflow: { ...workflow, status: 'ready', plan: { ...workflow.plan, kind: 'chat' } }
    } });
    await settle();
    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(startResponse).not.toHaveBeenCalled();
  });

  it('sends an explicit empty attachment selection when a pinned attachment is removed during clarification', async () => {
    getPendingWorkflow.mockResolvedValue({ ok: true, value: workflow });
    await settle();
    const page = find(tree, (item) => typeof item.props.onDrop === 'function')!;
    (page.props.onDrop as (event: unknown) => void)({ preventDefault: vi.fn(), dataTransfer: { files: [{}] } });
    await settle();
    await type('做个总结');
    await send('button');
    (find(tree, item => item.type === ChatAttachment && item.props.fileName === 'report.pdf')!.props.onRemove as () => void)();
    await settle();
    await type('不使用附件，在这里回复');
    await send('button');
    expect(answerWorkflow.mock.calls[0][0].attachmentFileIds).toEqual([]);
  });

  it('does not carry an unsent attachment or document request into a new conversation', async () => {
    await settle();
    const page = find(tree, (item) => typeof item.props.onDrop === 'function')!;
    (page.props.onDrop as (event: unknown) => void)({ preventDefault: vi.fn(), dataTransfer: { files: [{}] } });
    await settle();
    await type('制作一份融资 PPT，使用 AI 配图');
    (element('新聊天').props.onClick as () => void)();
    await settle();
    await type('谢谢');
    await send('button');
    expect(startWorkflow.mock.calls[0][0].attachmentFileIds).toBeUndefined();
    expect(startWorkflow.mock.calls[0][0].intentHint).toBeUndefined();
    expect(startWorkflow.mock.calls[0][0].content).toBe('谢谢');
  });

  it('opens chat search across the current project without a file-search action', async () => {
    const listConversations = vi.fn(async () => ({ ok: true, value: [
      conversation,
      { ...conversation, conversationId: 'conversation-2', title: '品牌手册大纲', updatedAt: '2026-09-01T00:00:00Z' }
    ] }));
    Object.assign(window.unicomp!.chatContexts!, { listConversations });
    Object.assign(window.unicomp!.storage!, {
      listProjects: vi.fn(async () => ({ ok: true, value: [
        { projectId: 'project-1', projectName: '测试测试', availability: 'available', lastOpenedAt: '2026-09-30T00:00:00Z' },
        { projectId: 'project-2', projectName: '品牌手册', availability: 'available', lastOpenedAt: '2026-09-01T00:00:00Z' }
      ] }))
    });
    await settle();
    (element('搜索项目或对话').props.onClick as () => void)();
    await settle();
    expect(element('搜索聊天')).toBeTruthy();
    const rendered = JSON.stringify(tree);
    expect(rendered).toContain('资料问答');
    expect(rendered).toContain('品牌手册大纲');
    expect(rendered).toContain('Alt+1');
    expect(rendered).toContain('Ctrl+N');
    expect(rendered).toContain('Ctrl+O');
    expect(rendered).not.toContain('搜索文件');
    expect(rendered).not.toContain('7 天内');
    expect(rendered).not.toContain('30 天内');
  });

  it('expands projects in place and switches only when a chat is chosen', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const projects = [
      { projectId: 'project-1', projectName: 'Alpha', availability: 'available' as const, lastOpenedAt: '2026-09-30T00:00:00Z' },
      { projectId: 'project-2', projectName: 'Beta', availability: 'available' as const, lastOpenedAt: '2026-09-01T00:00:00Z' }
    ];
    const desktop = window.unicomp!;
    Object.assign(desktop.chatContexts!, {
      listConversations: vi.fn(async () => ({
        ok: true,
        value: currentSession.projectId === 'project-2'
          ? [{ ...conversation, conversationId: 'conversation-beta', projectId: 'project-2', title: 'Beta chat' }]
          : [{ ...conversation, title: 'Original chat' }]
      }))
    });
    Object.assign(desktop.storage!, {
      getProjectSession: vi.fn(async () => ({ ok: true, value: currentSession })),
      listProjects: vi.fn(async () => ({
        ok: true,
        value: currentSession.projectId === 'project-2' ? [projects[1], projects[0]] : projects
      })),
      listProjectConversationSummaries: vi.fn(async (projectId: string) => ({
        ok: true,
        value: projectId === 'project-2' ? [{
          conversationId: 'conversation-beta',
          projectId,
          title: 'Beta chat',
          status: 'active' as const,
          updatedAt: '2026-09-01T00:00:00Z'
        }] : []
      })),
      openRecentProject: vi.fn(async (projectId: string) => {
        currentSession = projectId === 'project-2'
          ? { projectId: 'project-2', projectName: 'Beta', projectPath: '/beta' }
          : session;
        return { ok: true, value: { cancelled: false, session: currentSession } };
      })
    });
    window.addEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set<(event: Event) => void>();
      set.add(listener);
      listeners.set(type, set);
    }) as typeof window.addEventListener;
    window.removeEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }) as typeof window.removeEventListener;
    window.dispatchEvent = ((event: Event) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    }) as typeof window.dispatchEvent;
    await settle();

    const projectButtons = () => {
      const found: Element[] = [];
      const walk = (node: ReactNode) => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== 'object' || !('props' in node)) return;
        const element = node as Element;
        if (typeof element.props.className === 'string' && element.props.className.includes('uc-chat-page__project-item')) {
          found.push(element);
        }
        walk(element.props.children as ReactNode);
      };
      walk(tree);
      return found;
    };
    const projectLabel = (button: Element) => {
      const children = button.props.children;
      const span = (Array.isArray(children) ? children : [children]).find((child) =>
        Boolean(child) && typeof child === 'object' && 'type' in child && child.type === 'span'
      ) as Element | undefined;
      return span?.props.children;
    };
    const buttonNamed = (name: string) => {
      const button = projectButtons().find((item) => projectLabel(item) === name);
      if (!button) throw new Error(`Missing project ${name}`);
      return button;
    };

    const sidebarText = () => JSON.stringify(find(tree, (item) => item.props.className === 'uc-chat-page__workspace-sidebar'));
    expect(projectButtons().map(projectLabel)).toEqual(['Alpha', 'Beta']);
    expect(sidebarText()).toContain('Original chat');
    expect(buttonNamed('Alpha').props['aria-expanded']).toBe(true);
    (buttonNamed('Alpha').props.onClick as () => void)();
    await settle();
    expect(buttonNamed('Alpha').props['aria-expanded']).toBe(false);
    expect(sidebarText()).not.toContain('Original chat');
    (buttonNamed('Alpha').props.onClick as () => void)();
    await settle();
    expect(buttonNamed('Alpha').props['aria-expanded']).toBe(true);
    expect(sidebarText()).toContain('Original chat');
    (buttonNamed('Beta').props.onClick as () => void)();
    await settle(12);
    expect(projectButtons().map(projectLabel)).toEqual(['Alpha', 'Beta']);
    expect(buttonNamed('Alpha').props['aria-expanded']).toBe(true);
    expect(buttonNamed('Beta').props['aria-expanded']).toBe(true);
    expect(desktop.storage!.openRecentProject).not.toHaveBeenCalled();
    expect(sidebarText()).toContain('Original chat');
    expect(sidebarText()).toContain('Beta chat');
    const betaChat = find(tree, (item) =>
      item.props.className === 'uc-chat-page__workspace-conversation' &&
      JSON.stringify(item.props.children).includes('Beta chat')
    );
    if (!betaChat) throw new Error('Missing Beta chat');
    (betaChat.props.onClick as () => void)();
    await settle(12);
    expect(desktop.storage!.openRecentProject).toHaveBeenCalledWith('project-2');
    expect(projectButtons().map(projectLabel)).toEqual(['Alpha', 'Beta']);
    expect(buttonNamed('Alpha').props['aria-expanded']).toBe(true);
    expect(buttonNamed('Beta').props['aria-expanded']).toBe(true);
    expect(sidebarText()).toContain('Original chat');
    expect(sidebarText()).toContain('Beta chat');
    const betaRow = find(tree, (item) =>
      item.props.className === 'uc-chat-page__workspace-conversation-row' &&
      JSON.stringify(item.props.children).includes('Beta chat')
    );
    expect(betaRow?.props['aria-current']).toBe('true');
  });

  it('does not let an older project load overwrite the latest session snapshot', async () => {
    const firstSession = deferred<unknown>();
    const firstConversations = deferred<unknown>();
    const betaSession = { projectId: 'project-2', projectName: 'Beta', projectPath: '/beta' };
    const betaConversation = { ...conversation, conversationId: 'conversation-beta', projectId: 'project-2', title: 'Beta chat' };
    const listeners = new Map<string, Set<(event: Event) => void>>();
    let sessionReads = 0;
    let conversationReads = 0;

    Object.assign(window.unicomp!.storage!, {
      getProjectSession: vi.fn(() => ++sessionReads === 1
        ? firstSession.promise
        : Promise.resolve({ ok: true as const, value: betaSession })),
      listProjects: vi.fn(async () => ({ ok: true, value: [
        { projectId: session.projectId, projectName: 'Test', availability: 'available', lastOpenedAt: conversation.updatedAt },
        { projectId: betaSession.projectId, projectName: betaSession.projectName, availability: 'available', lastOpenedAt: conversation.updatedAt }
      ] }))
    });
    Object.assign(window.unicomp!.chatContexts!, {
      listConversations: vi.fn(() => ++conversationReads === 1
        ? firstConversations.promise
        : Promise.resolve({ ok: true as const, value: [betaConversation] }))
    });
    window.addEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set<(event: Event) => void>();
      set.add(listener);
      listeners.set(type, set);
    }) as typeof window.addEventListener;
    window.removeEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }) as typeof window.removeEventListener;

    await settle(1);
    const onFocus = [...(listeners.get('focus') ?? [])][0];
    expect(onFocus).toBeTypeOf('function');
    onFocus!(new Event('focus'));
    await settle(12);
    expect(sessionReads).toBe(2);
    expect(conversationReads).toBe(2);
    expect(find(tree, (item) => item.props.className === 'uc-chat-page__header-project')?.props.children).toBe('Beta');
    const betaProject = () => find(tree, (item) => item.type === 'button'
      && typeof item.props.className === 'string'
      && item.props.className.startsWith('uc-chat-page__project-item')
      && JSON.stringify(item.props.children).includes('Beta'));
    expect(betaProject()?.props['aria-current']).toBe('true');

    firstSession.resolve({ ok: true, value: session });
    firstConversations.resolve({ ok: true, value: [conversation] });
    await settle(16);

    expect(betaProject()?.props['aria-current']).toBe('true');
    expect(find(tree, (item) => item.props.className === 'uc-chat-page__header-project')?.props.children).toBe('Beta');
  });

  it('serializes rapid cross-project conversation opens', async () => {
    const betaSession = { projectId: 'project-2', projectName: 'Beta', projectPath: '/beta' };
    const betaConversation = { ...conversation, conversationId: 'conversation-beta', projectId: 'project-2', title: 'Beta chat' };
    const open = deferred<{ ok: true; value: { cancelled: false; session: typeof betaSession } }>();
    const projects = [
      { projectId: session.projectId, projectName: 'Alpha', availability: 'available' as const, lastOpenedAt: conversation.updatedAt },
      { projectId: betaSession.projectId, projectName: 'Beta', availability: 'available' as const, lastOpenedAt: conversation.updatedAt }
    ];
    const desktop = window.unicomp!;
    Object.assign(desktop.chatContexts!, {
      listConversations: vi.fn(async () => ({
        ok: true,
        value: currentSession.projectId === betaSession.projectId ? [betaConversation] : [conversation]
      }))
    });
    const openRecentProject = vi.fn(() => open.promise);
    Object.assign(desktop.storage!, {
      listProjects: vi.fn(async () => ({ ok: true, value: projects })),
      listProjectConversationSummaries: vi.fn(async (projectId: string) => ({
        ok: true,
        value: projectId === betaSession.projectId ? [{
          conversationId: betaConversation.conversationId,
          projectId,
          title: betaConversation.title,
          status: 'active' as const,
          updatedAt: conversation.updatedAt
        }] : []
      })),
      getProjectSession: vi.fn(async () => ({ ok: true, value: currentSession })),
      openRecentProject
    });
    await settle();

    const betaProject = find(tree, (item) => item.type === 'button'
      && item.props.className === 'uc-chat-page__project-item'
      && JSON.stringify(item.props.children).includes('Beta'))!;
    (betaProject.props.onClick as () => void)();
    await settle();
    const betaChat = conversationButton('Beta chat');
    const onClick = betaChat.props.onClick as () => void;

    onClick();
    onClick();

    expect(openRecentProject).toHaveBeenCalledTimes(1);
    currentSession = betaSession;
    open.resolve({ ok: true, value: { cancelled: false, session: betaSession } });
    await settle(12);
    const betaRow = find(tree, (item) => item.props.className === 'uc-chat-page__workspace-conversation-row'
      && JSON.stringify(item.props.children).includes('Beta chat'));
    expect(betaRow?.props['aria-current']).toBe('true');
  });

  it('delivers Office outputs sequentially and retries local generation without repeating completed model responses', async () => {
    candidateEnabled = true;
    const events: string[] = [];
    const deliveries: {
      kind: 'word' | 'ppt'; status: string; failureReason?: string;
      executionId?: string; resultMessageId?: string
    }[] = [
      { kind: 'word', status: 'pending' }, { kind: 'ppt', status: 'pending' }
    ];
    const current = () => ({
      ...workflow,
      status: deliveries.some((item) => item.status === 'failed') ? 'failed' : 'ready',
      plan: {
        ...workflow.plan, documentKind: deliveries.find((item) => item.status !== 'completed')?.kind ?? 'ppt',
        deliverables: ['word', 'ppt'], parameters: { requirements: '做一份 Word 和 PPT' }
      },
      deliveries: deliveries.map((item) => ({ ...item })), pendingQuestions: []
    });
    const desktop = window.unicomp!;
    const api = desktop.chatContexts!;
    let executionNumber = 0;
    let failPpt = true;
    const execution = () => ({
      responseExecutionId: `execution-${executionNumber}`, conversationId: conversation.conversationId,
      assistantMessageId: `assistant-${executionNumber}`, userMessageId: 'source-1',
      state: 'completed', content: '{"kind":"word","sections":[]}', streamSequence: 0
    });
    startWorkflow.mockImplementation(async () => ({ ok: true, value: { conversation, workflow: current() } }));
    getPendingWorkflow.mockImplementation(async () => ({
      ok: true, value: deliveries.every((item) => item.status === 'completed') ? null : current()
    }));
    startResponse.mockImplementation(async () => {
      executionNumber += 1;
      events.push(`start:${current().plan.documentKind}`);
      return { ok: true, value: { conversation, execution: execution() } };
    });
    Object.assign(api, {
      getConversation: vi.fn(async () => ({ ok: true, value: {
        ...conversation, messages: [{
          messageId: execution().assistantMessageId, role: 'assistant', state: 'completed',
          content: execution().content, attachments: []
        }]
      } })),
      getWorkflow: vi.fn(async () => ({ ok: true, value: { ...current(), status: 'executing' } })),
      getResponseExecution: vi.fn(async () => ({ ok: true, value: execution() })),
      resumeFailedWorkflow: vi.fn(async () => {
        const failed = deliveries.find((item) => item.status === 'failed')!;
        failed.status = 'executing'; failed.failureReason = undefined;
        return { ok: true, value: { ...current(), status: 'executing' } };
      })
    });
    Object.assign(desktop, { documentGeneration: {
      prepareGeneration: vi.fn(async () => ({ ok: true, value: {} })),
      generateFromMessage: vi.fn(async ({ kind }: { kind: 'word' | 'ppt' }) => {
        events.push(`generate:${kind}`);
        const item = deliveries.find((delivery) => delivery.kind === kind)!;
        if (kind === 'ppt' && failPpt) {
          failPpt = false; item.status = 'failed'; item.failureReason = 'execution_failed';
          item.executionId = execution().responseExecutionId;
          item.resultMessageId = execution().assistantMessageId;
          return { ok: false, error: { code: 'generation_failed', message: 'Test failure' } };
        }
        item.status = 'completed';
        return { ok: true, value: { workId: `work-${kind}` } };
      })
    } });
    await settle();
    await type('做一份 Word 和 PPT');
    await send('button');
    await settle(50);
    expect(events).toEqual(['start:word', 'generate:word', 'start:ppt', 'generate:ppt']);
    expect(startResponse.mock.calls[0][0].content).toContain('当前仅生成 Word');
    expect(startResponse.mock.calls[1][0].content).toContain('当前仅生成 PPT');
    const retry = find(tree, (item) => item.props.children === '重试失败文档');
    expect(retry).toBeDefined();
    (retry!.props.onClick as () => void)();
    await settle(50);
    expect(events).toEqual(['start:word', 'generate:word', 'start:ppt', 'generate:ppt', 'generate:ppt']);
    expect(startResponse).toHaveBeenCalledTimes(2);
    expect(deliveries.map((item) => item.status)).toEqual(['completed', 'completed']);
  });

  it('keeps an unsent draft with its own conversation and does not ask to discard it', async () => {
    const other = { ...conversation, conversationId: 'conversation-2', title: '另一条', updatedAt: '2026-09-09T00:00:01Z' };
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    initialConversationId = conversation.conversationId;
    Object.assign(window.unicomp!.chatContexts!, {
      listConversations: vi.fn(async () => ({ ok: true, value: [conversation, other] }))
    });
    Object.assign(window.unicomp!.storage!, {
      listProjects: vi.fn(async () => ({ ok: true, value: [{
        projectId: session.projectId,
        projectName: session.projectName,
        availability: 'available',
        lastOpenedAt: conversation.updatedAt
      }] }))
    });
    await settle();
    await type('第一段');
    (conversationButton('另一条').props.onClick as () => void)();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('');
    (conversationButton('资料问答').props.onClick as () => void)();
    await settle();
    expect(element('对话输入').props.value).toBe('第一段');
    (element('新聊天').props.onClick as () => void)();
    await settle();
    expect(element('对话输入').props.value).toBe('');
    await type('新的内容');
    (conversationButton('资料问答').props.onClick as () => void)();
    await settle();
    expect(element('对话输入').props.value).toBe('第一段');
    (element('新聊天').props.onClick as () => void)();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('新的内容');
    (element('新聊天').props.onClick as () => void)();
    await settle();
    expect(element('对话输入').props.value).toBe('');
  });
});
