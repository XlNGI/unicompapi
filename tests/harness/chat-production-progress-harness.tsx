// Full production ChatPage with synthetic IPC responses and no provider access.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatPage } from '../../src/pages/chat/ChatPage';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import type {
  ConversationDto, ConversationResponseCandidateDto, ConversationResponseExecutionDto,
  ConversationResponseStreamEventDto, ConversationWorkflowDto, MessageDto,
  ConversationAgentSessionDto, StartAgentResponseRequest, CancelAgentSessionRequest
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
const conversationMarkdown = [
  '# 世界各地关于龙的传说',
  '',
  '为什么几乎每个文明都有龙？不同地区的故事反映了人们对自然、秩序和未知事物的想象。以下内容是本地合成的界面验证资料。',
  '',
  '## 从三个角度理解',
  '',
  '- 自然观察：蛇、鳄鱼和化石可能影响形象。',
  '- 文化表达：不同文明赋予龙不同的象征。',
  '- 叙事需要：故事用鲜明形象解释世界。',
  '',
  '> 各地故事存在相似之处，也保留着各自的文化背景。',
  '',
  `长文本换行验证：${'LongUnbrokenReference'.repeat(18)}`,
  '',
  '## 对照资料',
  '',
  '| 地区 | 形象特点 | 象征含义 | 传说背景 | 资料类型 | 主题词 | 内容摘要 | 核对备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 东亚地区 | 长身、鳞片、角 | 自然与秩序 | 河流和天气的叙事 | 合成本地资料 | 文化象征 | 不同故事体现不同的文化习惯 | 仅用于验证表格在自己的区域横向滚动 |',
  '| 欧洲地区 | 翅膀、鳞片、火焰 | 力量与考验 | 英雄与冒险的叙事 | 合成本地资料 | 英雄故事 | 形象和含义因地区而异 | 窄窗口中正文与输入框保持原有宽度 |',
  '',
  '## 整理示例',
  '',
  '```typescript',
  `const localReference = "${'fixture-only-wide-code-'.repeat(16)}";`,
  'const conclusion = "所有资料都来自本地合成夹具，不发送网络请求。";',
  '```',
  '',
  '后续可以按地区整理成 PPT。最终文件仍需经过本地生成、校验和登记。'
].join('\n');
const previewMarkdown = [
  '# 世界各地关于龙的传说',
  '',
  '从东方的龙到欧洲的巨龙，许多文明都创造了这类神秘生物。它们的形象相似，承载的文化含义却各不相同。',
  '',
  '## 为什么很多文明都有龙？',
  '',
  '蛇、鳄鱼与大型动物化石，可能为这些传说提供了最初的灵感。人们也借助龙的形象，解释雷雨、洪水和其他难以理解的自然现象。',
  '',
  '## 各地赋予龙不同的含义',
  '',
  '- **中国**：龙常与雨水、祥瑞和力量联系在一起。',
  '- **欧洲**：巨龙经常成为英雄冒险中必须面对的考验。',
  '- **美洲**：羽蛇等形象体现了当地独特的信仰与宇宙观。',
  '',
  '这些故事共同反映了人们对自然的观察，以及对未知世界的想象。'
].join('\n');
const counters = { starts: 0, workflows: 0, subscriptions: 0, inspections: 0, acknowledgements: 0, agentStarts: 0, sessionCloses: 0 };
const continuationRequests: StartAgentResponseRequest[] = [], sessionCloseRequests: CancelAgentSessionRequest[] = [];
let continuationChallenge = 0;
let closedPlanningEvidence = false;
let subscriber: ((event: ConversationResponseStreamEventDto) => void) | undefined;
let execution: ConversationResponseExecutionDto | undefined;
let sequence = 0;
let conversation: ConversationDto;
let traces: ProductionTraceEventDto[] = [];
let canonicalTrace = false;
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
    ...(canonicalTrace ? { runId: 'private-canonical-run', runEventId: `private-run-event-${traces.length + 1}`, runSequence: traces.length + 1 } : {}),
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
    reconcileReconciliation: async () => {
      counters.inspections++;
      return ok({ parentRun: conversation.parentRuns![0], inspectToken: 'inspect-ui-fixture', expiresAt: new Date(Date.now() + 120000).toISOString() });
    },
    acknowledgeReconciliation: async () => {
      counters.acknowledgements++;
      const parent = { ...conversation.parentRuns![0], state: 'cancelled' as const, acknowledged: true, runRevision: 3 };
      conversation = { ...conversation, parentRuns: [parent], ...(conversation.agentSessions ? {
        agentSessions: conversation.agentSessions.map(task => task.state === 'needs_reconciliation' ? { ...task, state: 'cancelled' as const } : task)
      } : {}) };
      return ok(parent);
    },
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
function mount(scenario: 'saved-document' | 'live-chat' | 'new-chat' | 'document' | 'document-cancel' | 'saved-markdown' | 'saved-completed' | 'saved-terminal-stale' | 'codex-conversation' | 'codex-document' | 'codex-preview' | 'frozen-parent' | 'saved-retained-failed' | 'saved-retained-cancelled' | 'saved-retained-unknown' | 'saved-retained-legacy' | 'r45-waiting' | 'r45-authorization' | 'r45-expired-and-waiting' | 'r45-unknown-planning' | 'r45-unknown-expired' | 'r45-unknown-response' | 'reopen' = 'saved-document', theme?: 'light' | 'dark') {
  if (theme) window.localStorage.setItem('unicomp.theme', theme);
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
    if (scenario === 'frozen-parent') conversation = { ...conversation, parentRuns: [{ responseExecutionId: 'response-ui-frozen',
      sourceMessageId: 'user', state: 'needs_reconciliation', reconciliationReason: 'unknown_result', runRevision: 2,
      registeredWorkCount: 1, acknowledged: false }] };
    if (scenario.startsWith('r45-')) {
      continuationRequests.length = 0; sessionCloseRequests.length = 0; closedPlanningEvidence = false;
      const unknown = scenario.startsWith('r45-unknown');
      const authorization = scenario === 'r45-authorization';
      const expired = scenario === 'r45-unknown-expired';
      const current: ConversationAgentSessionDto = { sessionId: 'isolated-stable-parent', revision: 2,
        sourceMessageId: 'user', state: unknown ? 'needs_reconciliation' : authorization ? 'waiting_authorization' : 'waiting_user',
        deadlineAt: expired ? '2020-01-01T00:00:00.000Z' : new Date(Date.now() + 600000).toISOString(), registeredWorkCount: unknown ? 1 : 0,
        ...(unknown ? { canCloseUnknown: scenario === 'r45-unknown-planning' } : {
          waiting: { reason: authorization ? 'authorization_required' : 'input_required', allowedActions: [authorization ? 'authorize' : 'reply'] },
          resumeToken: `isolated-resume-challenge-${++continuationChallenge}` }) };
      const old: ConversationAgentSessionDto = { sessionId: 'isolated-old-expired', revision: 4,
        sourceMessageId: 'old-user', state: 'expired', deadlineAt: '2020-01-01T00:00:00.000Z', registeredWorkCount: 0 };
      conversation = { ...makeConversation([message('user', '制作一个PPT。'), message('assistant', unknown
        ? '规划请求结果需要核对。' : authorization ? '请确认原任务需求。' : '你想做什么主题的 PPT？')]),
        agentSessions: scenario === 'r45-expired-and-waiting' ? [old, current] : [current] };
      if (scenario === 'r45-unknown-response') conversation = { ...conversation, parentRuns: [{ responseExecutionId: 'response-ui-frozen',
        sourceMessageId: 'user', state: 'needs_reconciliation', reconciliationReason: 'unknown_result', runRevision: 2,
        registeredWorkCount: 1, acknowledged: false }] };
    }
    if (scenario.startsWith('saved-retained-')) {
      const cancelled = scenario === 'saved-retained-cancelled';
      const unknown = scenario === 'saved-retained-unknown';
      conversation = makeConversation([
        message('user', '制作12页的年度经营汇报PPT。'),
        message('assistant', '', { state: cancelled ? 'cancelled' : 'failed', failureReason: unknown ? 'unknown' : 'unavailable',
          retainedDocumentResult: { workId: 'isolated-retained-work', fileName: '已保留的汇报.pptx', kind: 'ppt',
            sizeBytes: 1024, actualPageCount: 6, ...(scenario === 'saved-retained-legacy' ? {} : { planningTargetTotalPages: 12 }) } })
      ]);
      conversation = { ...conversation, parentRuns: [{ responseExecutionId: 'response-ui-retained', sourceMessageId: 'user',
        state: unknown ? 'needs_reconciliation' : cancelled ? 'cancelled' : 'failed',
        ...(unknown ? { reconciliationReason: 'unknown_result' as const } : {}), runRevision: 3, registeredWorkCount: 1, acknowledged: false }] };
      traces = [{ schemaVersion: 1, projectId, conversationId, sourceMessageId: 'user', assistantMessageId: 'assistant',
        traceId: 'isolated-retained-trace', sequence: 1, code: 'document_register', status: 'completed', occurredAt: timestamp },
      { schemaVersion: 1, projectId, conversationId, sourceMessageId: 'user', assistantMessageId: 'assistant',
        traceId: 'isolated-retained-trace', sequence: 2, code: 'model_response', status: cancelled ? 'cancelled' : 'failed',
        occurredAt: timestamp, facts: { purpose: 'content', stopReason: unknown ? 'unknown_result' : cancelled ? 'cancelled' : 'budget_exceeded' } }];
    }
    if (scenario === 'saved-terminal-stale') {
      traces = [{ schemaVersion: 1, projectId, conversationId, sourceMessageId: 'user', traceId: 'isolated-trace',
        sequence: 1, code: 'document_compile', status: 'started', assistantMessageId: 'assistant', occurredAt: timestamp }];
    }
    if (scenario === 'codex-conversation' || scenario === 'codex-document' || scenario === 'codex-preview') {
      const fixtureMarkdown = scenario === 'codex-preview' ? previewMarkdown : conversationMarkdown;
      conversation = makeConversation([
        message('user', scenario === 'codex-preview' ? '帮我整理世界各地关于龙的传说。' : '帮我整理世界各地关于龙的传说，先解释共通点，再用表格对比，并提供一段整理示例。'),
        message('assistant', fixtureMarkdown, scenario === 'codex-document' ? {
          documentGenerationStatus: { kind: 'ppt', state: 'completed' },
          documentResult: { workId: 'isolated-work', fileName: '龙的传说.pptx', kind: 'ppt', sizeBytes: 1024,
            validatedContent: conversationMarkdown }
        } : {})
      ]);
      const fixtures: Array<Pick<ProductionTraceEventDto, 'code' | 'status' | 'facts'>> = [
        { code: 'request_received', status: 'completed' },
        { code: 'model_request', status: 'completed', facts: { purpose: 'planning' } },
        { code: 'plan_validation', status: 'completed' },
        { code: 'model_response', status: 'completed', facts: { purpose: 'content', contentCharacters: fixtureMarkdown.length } },
        { code: 'task_complete', status: 'completed' }
      ];
      traces = fixtures.map((fixture, index) => ({ schemaVersion: 1, projectId, conversationId,
        sourceMessageId: 'user', assistantMessageId: 'assistant', traceId: 'isolated-trace',
        sequence: index + 1, occurredAt: new Date(Date.parse(timestamp) + index * 1000).toISOString(), ...fixture }));
    }
  }
  flushSync(() => root.render(<StrictMode><ThemeProvider key={++mountKey}><RSuiteThemeBridge>
    <ChatPage key={mountKey} initialConversationId={['new-chat', 'document', 'document-cancel'].includes(scenario) ? undefined : conversationId}
      initialModelSelection={{ projectId, candidateId: candidate.candidateId, productFeature: 'text_reasoning' }} />
  </RSuiteThemeBridge></ThemeProvider></StrictMode>));
}
const harness = {
  ready: true, counters, mount, emitTrace,
  enableContinuations: () => {
    Object.assign(api.chatContexts, {
      startAgentResponse: async (request: StartAgentResponseRequest) => {
        const task = [...(conversation.agentSessions ?? [])].reverse().find(item => ['waiting_user', 'waiting_authorization', 'needs_reconciliation'].includes(item.state));
        if (!task || !request.continuation || task.state === 'needs_reconciliation' || request.continuation.sessionId !== task.sessionId ||
          request.continuation.expectedRevision !== task.revision || request.continuation.resumeToken !== task.resumeToken ||
          !task.waiting?.allowedActions.includes(request.continuation.action)) return { ok: false, error: { code: 'continuation_conflict', message: 'Synthetic continuation mismatch' } };
        continuationRequests.push(request); counters.agentStarts++;
        // The bounded delay exposes a second click before the first IPC reply.
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        const agentSession: ConversationAgentSessionDto = { ...task, revision: task.revision + 1, state: 'waiting_user',
          waiting: { reason: 'input_required', allowedActions: ['reply'] }, resumeToken: `isolated-resume-challenge-${++continuationChallenge}` };
        conversation = { ...conversation, revision: conversation.revision + 1,
          messages: [...conversation.messages, message('user', request.content, { messageId: `continuation-user-${continuationRequests.length}` })],
          agentSessions: conversation.agentSessions!.map(item => item.sessionId === task.sessionId ? agentSession : item) };
        return ok({ conversation, agentSession, waiting: true as const });
      },
      cancelAgentSession: async (request: CancelAgentSessionRequest) => {
        const task = conversation.agentSessions?.find(item => item.sessionId === request.sessionId);
        if (!task || task.revision !== request.expectedRevision || request.projectId !== projectId ||
          task.state === 'needs_reconciliation' && (!request.closeUnknown || !task.canCloseUnknown)) return { ok: false, error: { code: 'continuation_conflict', message: 'Synthetic close mismatch' } };
        sessionCloseRequests.push(request); counters.sessionCloses++;
        const next: ConversationAgentSessionDto = { ...task, revision: task.revision + 1, state: 'cancelled', canCloseUnknown: false, waiting: undefined, resumeToken: undefined };
        closedPlanningEvidence = Boolean(request.closeUnknown);
        conversation = { ...conversation, revision: conversation.revision + 1,
          agentSessions: conversation.agentSessions!.map(item => item.sessionId === task.sessionId ? next : item) };
        return ok(next);
      }
    });
  },
  rotateContinuationChallenge: () => {
    conversation = { ...conversation, agentSessions: conversation.agentSessions?.map(item => ['waiting_user', 'waiting_authorization'].includes(item.state)
      ? { ...item, revision: item.revision + 1, resumeToken: `isolated-resume-challenge-${++continuationChallenge}` } : item) };
  },
  enableCanonicalTrace: () => { canonicalTrace = true; },
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
  replay: (differentProjectionSequence = false) => {
    for (const subscription of traceSubscriptions) for (const trace of [...traces].reverse())
      subscription.event(differentProjectionSequence ? { ...trace, sequence: trace.sequence + 1000 } : trace);
  },
  issue: () => { for (const subscription of traceSubscriptions) subscription.issue?.({ projectId, conversationId,
    sourceMessageId: 'user', traceId: 'isolated-trace', clientCommandId: commandId, code: 'recording_unavailable' }); },
  emit(stage: NonNullable<ConversationResponseStreamEventDto['stage']>, progressStatus: NonNullable<ConversationResponseStreamEventDto['progressStatus']>) {
    if (!execution || !subscriber) throw new Error('The synthetic response has no active subscriber');
    subscriber({ schemaVersion: 1, responseExecutionId: execution.responseExecutionId, conversationId,
      assistantMessageId: 'assistant', sequence: ++sequence, type: 'task_progress', stage, progressStatus,
      taskRevision: 1, occurredAt: new Date(Date.parse(timestamp) + sequence * 1000).toISOString() });
  },
  state: () => ({ counters, subscribed: Boolean(subscriber), planningPending: Boolean(finishPlanning), traceCount: traces.length,
    continuationRequests, sessionCloseRequests, agentSessions: conversation.agentSessions, closedPlanningEvidence,
    canonicalTraceCount: traces.filter(event => event.runId && event.runEventId && event.runSequence).length,
    localGenerationPending: Boolean(finishLocalDocument),
    commandSubscriptions: [...traceSubscriptions].filter((item) => item.commandId).length,
    conversationSubscriptions: [...traceSubscriptions].filter((item) => item.conversationId).length }),
  unmount: () => flushSync(() => root.render(null))
};
Object.assign(window, { chatProgressHarness: harness });
mount();
