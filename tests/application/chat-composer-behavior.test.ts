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
  }
}));

import { ChatPage } from '../../src/pages/chat/ChatPage';

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children as ReactNode, predicate);
}

describe('chat composer event behavior', () => {
  let tree: ReactElement;
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
  let candidateEnabled = false;
  async function settle(rounds = 8) {
    for (let turn = 0; turn < rounds; turn += 1) {
      hooks.cursor = 0;
      tree = ChatPage({ initialConversationId, initialCandidateId: 'candidate-1' });
      hooks.effects.splice(0).forEach((effect) => effect());
      await Promise.resolve();
    }
  }
  function element(label: string) {
    const found = find(tree, (item) => item.props['aria-label'] === label);
    if (!found) throw new Error(`Missing ${label}`);
    return found;
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
    candidateEnabled = false;
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
          listTextCandidates: vi.fn(async () => ({ ok: true, value: candidateEnabled ? [{
            candidateId: 'candidate-1', available: true, providerName: 'Test', modelName: 'Test',
            parameterSchema: { productFeature: 'text_chat', fields: [] }
          }] : [] })),
          getPendingWorkflow, startWorkflow, answerWorkflow, startResponse
        },
        storage: { getProjectSession: vi.fn(async () => ({ ok: true, value: session })) },
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

  it('does not submit when Enter is only committing Chinese input composition', async () => {
    await settle();
    await type('销售分析');
    (element('对话输入').props.onKeyDown as (event: unknown) => void)({
      key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault: vi.fn()
    });
    await settle();
    expect(startWorkflow).not.toHaveBeenCalled();
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
    (element('移除附件 report.pdf').props.onClick as () => void)();
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
    (element('新建对话').props.onClick as () => void)();
    await settle();
    await type('谢谢');
    await send('button');
    expect(startWorkflow.mock.calls[0][0].attachmentFileIds).toBeUndefined();
    expect(startWorkflow.mock.calls[0][0].intentHint).toBeUndefined();
    expect(startWorkflow.mock.calls[0][0].content).toBe('谢谢');
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
});
