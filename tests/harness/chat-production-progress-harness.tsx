// Full production ChatPage with synthetic IPC responses and no provider access.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatPage } from '../../src/pages/chat/ChatPage';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import type {
  ConversationDto, ConversationResponseCandidateDto, ConversationResponseExecutionDto,
  ConversationResponseStreamEventDto, ConversationWorkflowDto, MessageDto
} from '../../src/shared/chat-context-ipc';
import type { ProductionTraceEventDto, ProductionTraceIssueDto } from '../../src/shared/conversation-production-ipc';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/rsuite-bridge.css';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const timestamp = '2026-09-22T08:00:00.000Z';
const projectId = 'isolated-chat-project';
const conversationId = 'isolated-conversation';
const secret = 'PRIVATE_REASONING_MUST_NOT_APPEAR';
const outline = JSON.stringify({ kind: 'ppt', title: '年度经营报告', sections: [{ heading: '增长概览', level: 1,
  blocks: [{ type: 'paragraph', text: '营收增长来自核心业务的持续改善。![外部图片](https://external.invalid/private.png)' }, { type: 'bullets', items: ['客户留存稳定', '现金流改善'] }] }],
  PRIVATE_REASONING: 'PRIVATE_REASONING_MUST_NOT_APPEAR', path: 'PRIVATE_PATH_MUST_NOT_APPEAR' });
const documentBody = JSON.stringify({ kind: 'ppt', title: '年度经营报告', sections: [{ heading: '增长概览', level: 1,
  blocks: [{ type: 'paragraph', text: '营收增长来自核心业务的持续改善。' }, { type: 'bullets', items: ['客户留存稳定', '现金流改善'] }] }],
  reasoning: 'PRIVATE_REASONING_MUST_NOT_APPEAR', path: 'PRIVATE_PATH_MUST_NOT_APPEAR' });
const documentValidatedBody = JSON.stringify({ kind: 'ppt', title: '年度经营报告（已校验）', sections: [{ heading: '增长概览', level: 1,
  blocks: [{ type: 'paragraph', text: '营收增长来自核心业务的持续改善。' }] }] });
const counters = { starts: 0, workflows: 0, subscriptions: 0 };
let subscriber: ((event: ConversationResponseStreamEventDto) => void) | undefined;
let execution: ConversationResponseExecutionDto | undefined;
let sequence = 0;
let conversation: ConversationDto;
let traces: ProductionTraceEventDto[] = [];
let commandId: string | undefined;
let finishPlanning: (() => void) | undefined;
let documentMode = false;
let documentBodyCursor = 0;
let documentCancelled = false;
let finishLocalDocument: (() => void) | undefined;
type TraceSubscription = { conversationId?: string; commandId?: string; event: (value: ProductionTraceEventDto) => void;
  issue?: (value: ProductionTraceIssueDto) => void };
const traceSubscriptions = new Set<TraceSubscription>();
function emitTrace(code: ProductionTraceEventDto['code'], status: ProductionTraceEventDto['status'],
  facts?: ProductionTraceEventDto['facts'], assistantMessageId?: string) {
  const trace: ProductionTraceEventDto = { schemaVersion: 1, projectId, conversationId, sourceMessageId: 'user',
    traceId: 'isolated-trace', clientCommandId: commandId, sequence: traces.length + 1,
    code, status, facts, assistantMessageId,
    occurredAt: new Date(Date.parse(timestamp) + traces.length * 1000).toISOString() };
  traces.push(trace);
  for (const subscription of traceSubscriptions) {
    if (subscription.conversationId === conversationId || subscription.commandId === commandId) subscription.event(trace);
  }
}

function message(role: 'user' | 'assistant', content: string, extra: Partial<MessageDto> = {}): MessageDto {
  return { messageId: role, conversationId, revision: 1, role, state: 'completed', content,
    attachments: [], createdAt: timestamp, updatedAt: timestamp, ...extra };
}
function makeConversation(messages: readonly MessageDto[]): ConversationDto {
  return { conversationId, revision: 1, projectId, title: '会话生产进度验证', status: 'active',
    storageScope: 'current_project', readOnly: false, messages, createdAt: timestamp, updatedAt: timestamp };
}
const candidate: ConversationResponseCandidateDto = {
  schemaVersion: 1, candidateId: 'isolated-model', providerName: 'Isolated fixture', connectionName: 'No network',
  modelName: '合成模型', available: true, unavailableReasons: [], cost: { state: 'not_applicable' },
  parameterSchema: { schemaVersion: 2, schemaId: 'isolated-schema', revision: 1, productFeature: 'text_reasoning', fields: [] },
  usageSchema: { schemaVersion: 1, schemaId: 'isolated-usage', revision: 1 }
};
const api = {
  storage: { getProjectSession: async () => ok({ projectId, projectName: '隔离 UI 验证' }) },
  productionTrace: {
    list: async () => ok([...traces]),
    subscribe: (id: string, _after: number, event: TraceSubscription['event'], issue?: TraceSubscription['issue']) => {
      const subscription = { conversationId: id, event, issue };
      traceSubscriptions.add(subscription);
      return () => { traceSubscriptions.delete(subscription); };
    },
    subscribeCommand: (id: string, event: TraceSubscription['event'], issue?: TraceSubscription['issue']) => {
      const subscription = { commandId: id, event, issue };
      traceSubscriptions.add(subscription);
      return () => { traceSubscriptions.delete(subscription); };
    }
  },
  chatContexts: {
    listConversations: async () => ok([conversation]),
    listProjectContextCandidates: async () => ok([]),
    listTextCandidates: async (feature: string) => ok(feature === 'text_reasoning' ? [candidate] : []),
    getPendingWorkflow: async () => ok(null),
    getConversation: async () => ok(conversation),
    startWorkflow: async ({ content, clientCommandId }: { content: string; clientCommandId: string }) => {
      counters.workflows++;
      conversation = makeConversation([message('user', content)]);
      commandId = clientCommandId;
      emitTrace('request_received', 'completed');
      emitTrace('model_request', 'started', { purpose: 'planning' });
      await new Promise<void>((resolve) => { finishPlanning = resolve; });
      finishPlanning = undefined;
      emitTrace('model_request', 'completed', { purpose: 'planning' });
      emitTrace('model_response', 'completed', { purpose: 'planning', contentCharacters: 152 });
      emitTrace('plan_validation', 'completed');
      emitTrace('plan_decision', 'completed', { planKind: documentMode ? 'document' : 'chat', action: documentMode ? 'create' : 'answer', sourcePolicy: 'none' });
      const workflow: ConversationWorkflowDto = {
        workflowId: 'isolated-workflow', projectId, conversationId, sourceMessageId: 'user', revision: 1,
        status: 'ready', plan: { schemaVersion: 1, kind: documentMode ? 'document' : 'chat', action: documentMode ? 'create' : 'answer',
          documentKind: documentMode ? 'ppt' : undefined, parameters: documentMode ? { topic: '年度经营报告' } : {}, sourcePolicy: 'none',
          missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false }, pendingQuestions: [],
        createdAt: timestamp, updatedAt: timestamp
      };
      return ok({ conversation, workflow });
    },
    startResponse: async () => {
      counters.starts++;
      conversation = { ...conversation, revision: conversation.revision + 1,
        messages: [...conversation.messages, message('assistant', documentMode ? '' : '这是合成的普通回复正文。', {
          state: 'streaming', reasoningContent: secret,
          ...(documentMode ? { documentGenerationStatus: { kind: 'ppt', state: 'generating_content' } } : {})
        })] };
      execution = { responseExecutionId: 'isolated-response', conversationId, userMessageId: 'user', assistantMessageId: 'assistant',
        productFeature: 'text_reasoning', state: 'streaming', streamSequence: 0, reasoningContent: secret,
        content: documentMode ? '' : '这是合成的普通回复正文。', createdAt: timestamp, updatedAt: timestamp };
      emitTrace('model_request', 'started', { purpose: 'content' }, 'assistant');
      emitTrace('model_response', 'progress', { purpose: 'content', contentCharacters: execution.content.length }, 'assistant');
      return ok({ conversation, execution });
    },
    getResponseExecution: async () => ok(execution),
    subscribeResponseEvents: (_id: string, _after: number, callback: (event: ConversationResponseStreamEventDto) => void) => {
      counters.subscriptions++;
      subscriber = callback;
      return () => { if (subscriber === callback) subscriber = undefined; };
    }
  }
};
const documentGeneration = {
  prepareGeneration: async () => ok({ prepared: true as const }),
  prepareDeterministicRevision: async () => ok({ conversationId, expectedRevision: 1, messageId: 'assistant' }),
  reconcileGeneration: async () => ok({ interrupted: false }),
  generateFromMessage: async () => {
    emitTrace('document_compile', 'started', { documentKind: 'ppt' }, 'assistant');
    await new Promise<void>((resolve) => { finishLocalDocument = resolve; });
    finishLocalDocument = undefined;
    conversation = { ...conversation, messages: conversation.messages.map((item) => item.role === 'assistant'
      ? { ...item, documentGenerationStatus: { kind: 'ppt', state: 'completed' }, documentResult: {
          workId: 'isolated-work', fileName: '年度经营报告.pptx', kind: 'ppt', sizeBytes: 1024, validatedContent: documentValidatedBody
        } } : item) };
    emitTrace('document_compile', 'completed', { documentKind: 'ppt' }, 'assistant');
    emitTrace('document_publish', 'completed', undefined, 'assistant');
    emitTrace('document_register', 'completed', undefined, 'assistant');
    emitTrace('task_complete', 'completed', undefined, 'assistant');
    return ok({ conversationId, messageId: 'assistant', kind: 'ppt', workId: 'isolated-work', fileName: '年度经营报告.pptx',
      sizeBytes: 1024, validatedContent: documentValidatedBody });
  },
  cancelGeneration: async () => ok({ cancelled: true }),
  openDocument: async () => ok({ path: 'C:/isolated/年度经营报告.pptx' })
};
Object.assign(api, { documentGeneration });
window.unicomp = api as unknown as NonNullable<typeof window.unicomp>;
const root = createRoot(document.getElementById('root')!);
let mountKey = 0;
function mount(scenario: 'saved-document' | 'live-chat' | 'new-chat' | 'document' | 'document-cancel' | 'saved-markdown' | 'saved-completed' | 'saved-terminal-stale' | 'reopen' = 'saved-document') {
  subscriber = undefined;
  execution = undefined;
  sequence = 0;
  if (scenario !== 'reopen') {
    documentMode = scenario === 'document' || scenario === 'document-cancel';
    documentBodyCursor = 0;
    documentCancelled = scenario === 'document-cancel';
    traces = [];
    commandId = undefined;
    finishPlanning = undefined;
    finishLocalDocument = undefined;
    const savedMarkdown = '# 年度报告\n\n收入保持增长。';
    conversation = makeConversation(['live-chat', 'new-chat', 'document', 'document-cancel'].includes(scenario) ? [] : [
    message('user', '根据已授权资料制作一份 PPT。'),
    message('assistant', scenario === 'saved-markdown' ? savedMarkdown : outline, { reasoningContent: secret,
      documentGenerationStatus: { kind: 'ppt', state: ['saved-completed', 'saved-terminal-stale'].includes(scenario) ? 'completed' : 'generating_content' } })
    ]);
    if (scenario === 'saved-terminal-stale') {
      traces = [{ schemaVersion: 1, projectId, conversationId, sourceMessageId: 'user', traceId: 'isolated-trace',
        sequence: 1, code: 'document_compile', status: 'started', assistantMessageId: 'assistant', occurredAt: timestamp }];
    }
  }
  flushSync(() => root.render(<ThemeProvider><RSuiteThemeBridge>
    <ChatPage key={++mountKey} initialConversationId={['new-chat', 'document', 'document-cancel'].includes(scenario) ? undefined : conversationId}
      initialModelSelection={{ projectId, candidateId: candidate.candidateId, productFeature: 'text_reasoning' }} />
  </RSuiteThemeBridge></ThemeProvider>));
}
const harness = {
  ready: true, counters, mount, emitTrace,
  finishPlanning: () => finishPlanning?.(),
  emitDocumentChunk: (fragment: 'title' | 'paragraph' | 'rest') => {
    if (!execution || !subscriber || !documentMode) throw new Error('Missing document response');
    const marker = fragment === 'title' ? '年度经营' : '营收增长来自';
    const end = fragment === 'rest' ? documentBody.length : documentBody.indexOf(marker) + marker.length;
    if (end <= documentBodyCursor) throw new Error('Document fragment must advance the content stream');
    const next = documentBody.slice(documentBodyCursor, end);
    documentBodyCursor += next.length;
    execution = { ...execution, content: `${execution.content}${next}`, streamSequence: execution.streamSequence + 1,
      updatedAt: new Date(Date.parse(timestamp) + sequence * 1000).toISOString() };
    subscriber({ schemaVersion: 1, responseExecutionId: execution.responseExecutionId, conversationId,
      assistantMessageId: 'assistant', sequence: ++sequence, type: 'content_delta', contentDelta: next,
      occurredAt: execution.updatedAt });
    emitTrace('model_response', 'progress', { purpose: 'content', contentCharacters: documentBodyCursor }, 'assistant');
  },
  finishDocument: () => {
    if (!execution || !subscriber || !documentMode) throw new Error('Missing document response');
    execution = { ...execution, state: documentCancelled ? 'cancelled' : 'completed', updatedAt: timestamp };
    conversation = { ...conversation, messages: conversation.messages.map((item) => item.role === 'assistant'
      ? { ...item, state: documentCancelled ? 'cancelled' : 'completed', content: documentBody.slice(0, documentBodyCursor),
          documentGenerationStatus: { kind: 'ppt', state: documentCancelled ? 'cancelled' : 'generating_file' } } : item) };
    emitTrace('model_response', documentCancelled ? 'cancelled' : 'completed', { purpose: 'content', contentCharacters: documentBodyCursor }, 'assistant');
    subscriber({ schemaVersion: 1, responseExecutionId: execution.responseExecutionId, conversationId,
      assistantMessageId: 'assistant', sequence: ++sequence,
      type: documentCancelled ? 'stream_cancelled' : 'stream_completed', occurredAt: timestamp });
  },
  finishLocalDocument: () => finishLocalDocument?.(),
  cancelDocument: () => { documentCancelled = true; },
  completeResponse: () => {
    if (!execution || !subscriber) throw new Error('Missing active synthetic response');
    conversation = { ...conversation, messages: conversation.messages.map((item) => item.role === 'assistant'
      ? { ...item, state: 'completed' } : item) };
    emitTrace('model_response', 'completed', { purpose: 'content', contentCharacters: 16 }, 'assistant');
    subscriber({ schemaVersion: 1, responseExecutionId: execution.responseExecutionId, conversationId,
      assistantMessageId: 'assistant', sequence: ++sequence, type: 'stream_completed', occurredAt: timestamp });
  },
  replay: () => { for (const subscription of traceSubscriptions) for (const trace of [...traces].reverse()) subscription.event(trace); },
  issue: () => { for (const subscription of traceSubscriptions) subscription.issue?.({ projectId, conversationId,
    sourceMessageId: 'user', traceId: 'isolated-trace', clientCommandId: commandId, code: 'recording_unavailable' }); },
  emit(stage: NonNullable<ConversationResponseStreamEventDto['stage']>, progressStatus: NonNullable<ConversationResponseStreamEventDto['progressStatus']>) {
    if (!execution || !subscriber) throw new Error('The synthetic response has no active subscriber');
    subscriber({ schemaVersion: 1, responseExecutionId: execution.responseExecutionId, conversationId,
      assistantMessageId: 'assistant', sequence: ++sequence, type: 'task_progress', stage, progressStatus,
      taskRevision: 1, occurredAt: new Date(Date.parse(timestamp) + sequence * 1000).toISOString() });
  },
  state: () => ({ counters, subscribed: Boolean(subscriber), planningPending: Boolean(finishPlanning), traceCount: traces.length,
    localGenerationPending: Boolean(finishLocalDocument),
    commandSubscriptions: [...traceSubscriptions].filter((item) => item.commandId).length,
    conversationSubscriptions: [...traceSubscriptions].filter((item) => item.conversationId).length }),
  unmount: () => flushSync(() => root.render(null))
};
Object.assign(window, { chatProgressHarness: harness });
mount();
