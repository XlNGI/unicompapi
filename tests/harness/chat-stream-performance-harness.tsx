import { createRoot } from 'react-dom/client';
import { ChatPage } from '../../src/pages/chat/ChatPage';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import type { ConversationDto, ConversationResponseCandidateDto, ConversationResponseExecutionDto,
  ConversationResponseStreamEventDto, MessageDto } from '../../src/shared/chat-context-ipc';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/rsuite-bridge.css';

const timestamp = '2026-10-08T00:00:00.000Z';
const projectId = 'performance-project';
const conversationId = 'performance-conversation';
const ok = <Value,>(value: Value) => ({ ok: true as const, value });
const message = (messageId: string, role: 'user' | 'assistant', content: string): MessageDto => ({
  messageId, role, content, conversationId, revision: 1, state: 'completed', attachments: [],
  createdAt: timestamp, updatedAt: timestamp
});
let conversation: ConversationDto = {
  conversationId, projectId, revision: 1, title: '隔离流畅性验收', status: 'active',
  storageScope: 'current_project', readOnly: false, createdAt: timestamp, updatedAt: timestamp,
  messages: Array.from({ length: 24 }, (_, index) => message('history-' + index,
    index % 2 ? 'assistant' : 'user', '# 本地合成历史 ' + index + '\n\n' + '用于测试回看稳定性的本地文本。'.repeat(50)))
};
const candidate: ConversationResponseCandidateDto = {
  schemaVersion: 1, candidateId: 'synthetic-candidate', providerName: '本地合成', connectionName: '禁止联网',
  modelName: '本地流式测试', available: true, unavailableReasons: [], cost: { state: 'not_applicable' },
  parameterSchema: { schemaVersion: 2, schemaId: 'synthetic-schema', revision: 1, productFeature: 'text_chat', fields: [] },
  usageSchema: { schemaVersion: 1, schemaId: 'synthetic-usage', revision: 1 }
};
let execution: ConversationResponseExecutionDto | undefined;
let subscriber: ((event: ConversationResponseStreamEventDto) => void) | undefined;
let sequence = 0;
let copied = '';
function emit(type: ConversationResponseStreamEventDto['type'], contentDelta = '', reasoningDelta = '') {
  if (!execution || !subscriber) throw new Error('Stream is not subscribed');
  const messageState = type === 'stream_completed' ? 'completed' : type === 'stream_cancelled' ? 'cancelled' : 'streaming';
  execution = { ...execution, streamSequence: ++sequence,
    state: messageState,
    content: execution.content + contentDelta, reasoningContent: execution.reasoningContent + reasoningDelta };
  conversation = { ...conversation, messages: conversation.messages.map(item => item.messageId === 'answer'
    ? { ...item, state: messageState, content: execution!.content, reasoningContent: execution!.reasoningContent } : item) };
  subscriber({ schemaVersion: 1, responseExecutionId: execution.responseExecutionId, conversationId,
    assistantMessageId: 'answer', sequence, type, contentDelta, reasoningDelta, occurredAt: timestamp });
}
window.unicomp = {
  clipboard: { writeText: (text: string) => { copied = text; } },
  storage: {
    getProjectSession: async () => ok({ projectId, projectName: '隔离测试项目' }),
    listProjects: async () => ok(Array.from({ length: 45 }, (_, index) => ({
      projectId: index === 0 ? projectId : 'project-' + index, projectName: '本地项目 ' + index,
      availability: 'available', updatedAt: timestamp
    })))
  },
  chatContexts: {
    listConversations: async () => ok([conversation]),
    listProjectContextCandidates: async () => ok([]),
    getPendingWorkflow: async () => ok(null),
    getConversation: async () => ok(conversation),
    listTextCandidates: async (feature: string) => ok(feature === 'text_chat' ? [candidate] : []),
    startAgentResponse: async ({ content }: { content: string }) => {
      conversation = { ...conversation, revision: conversation.revision + 1,
        messages: [...conversation.messages, message('request', 'user', content),
          { ...message('answer', 'assistant', ''), state: 'streaming' }] };
      sequence = 0;
      execution = { responseExecutionId: 'synthetic-response', conversationId, userMessageId: 'request',
        assistantMessageId: 'answer', productFeature: 'text_chat', state: 'streaming', streamSequence: 0,
        content: '', reasoningContent: '', createdAt: timestamp, updatedAt: timestamp };
      return ok({ conversation, execution });
    },
    subscribeResponseEvents: (_executionId: string, _after: number, callback: typeof subscriber) => {
      subscriber = callback;
      return () => { if (subscriber === callback) subscriber = undefined; };
    },
    cancelResponseExecution: async () => {
      emit('stream_cancelled');
      return ok(execution);
    }
  }
} as unknown as NonNullable<typeof window.unicomp>;
const root = createRoot(document.getElementById('root')!);
root.render(<ThemeProvider><RSuiteThemeBridge><ChatPage initialConversationId={conversationId}
  initialModelSelection={{ projectId, candidateId: candidate.candidateId, productFeature: 'text_chat' }} />
</RSuiteThemeBridge></ThemeProvider>);
Object.assign(window, { chatStreamHarness: { emit, state: () => ({ subscribed: Boolean(subscriber), copied,
  content: execution?.content, executionState: execution?.state }), unmount: () => root.unmount() } });
