import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type * as ReactModule from 'react';

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
  },
  useLayoutEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
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

  it('does not plan with a selected model that is no longer available', async () => {
    candidateEnabled = false;
    await settle();
    await type('产品介绍 PPT');
    await send('enter');
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('产品介绍 PPT');
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

  it.each(['enter', 'button'] as const)('%s sends a normal chat through the agent response', async (method) => {
    const startAgentResponse = vi.fn(async (_request: { readonly content: string }) => ({
      ok: true,
      value: {
        conversation,
        execution: {
          responseExecutionId: 'execution-1',
          conversationId: conversation.conversationId,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
          productFeature: 'text_chat' as const,
          state: 'completed' as const,
          streamSequence: 1,
          reasoningContent: '',
          content: '可以回答问题。',
          createdAt: conversation.updatedAt,
          updatedAt: conversation.updatedAt
        }
      }
    }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse });
    await settle();
    await type('你好，你能做什么');
    expect(element('发送消息').props.disabled).toBe(false);
    await send(method);
    expect(startAgentResponse).toHaveBeenCalledTimes(1);
    expect(startAgentResponse.mock.calls[0][0]).toMatchObject({ content: '你好，你能做什么' });
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(element('对话输入').props.value).toBe('');
  });

  it('shows the outgoing text before the agent response returns and restores it on failure', async () => {
    let finish: (value: unknown) => void = () => {};
    const startAgentResponse = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse });
    await settle();
    await type('你好，你能做什么');
    await send('button');
    expect(startAgentResponse).toHaveBeenCalledTimes(1);
    expect(element('对话输入').props.value).toBe('');
    expect(containsText(tree, '你好，你能做什么')).toBe(true);
    expect(containsText(tree, '正在组织回答')).toBe(true);
    expect(containsText(tree, '正在准备回复…')).toBe(false);

    finish({ ok: false, error: { code: 'storage_error', message: '保存失败' } });
    await settle();
    expect(element('对话输入').props.value).toBe('你好，你能做什么');
    expect(containsText(tree, '正在组织回答')).toBe(false);
    expect(containsText(tree, '本地保存失败，请检查存储状态后重试。')).toBe(true);
  });

  it('shows real thinking only for reasoning mode before the answer exists', async () => {
    let finish: (value: unknown) => void = () => {};
    initialModelSelection = { projectId: session.projectId, candidateId: 'candidate-reasoning', productFeature: 'text_reasoning' };
    const startAgentResponse = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    Object.assign(window.unicomp!.chatContexts!, { startAgentResponse });
    await settle();
    await type('你好，你能做什么');
    await send('button');
    expect(containsText(tree, '你好，你能做什么')).toBe(true);
    expect(containsText(tree, '正在思考')).toBe(true);
    expect(containsText(tree, '正在组织回答')).toBe(false);
    finish({ ok: false, error: { code: 'storage_error', message: '保存失败' } });
    await settle();
  });
});
