import { describe, expect, it } from 'vitest';
import {
  addUserMessage, attachRetainedDocumentResultToMessage, beginAssistantMessage, cancelAssistantMessage,
  completeAssistantMessage, createProjectConversation, failAssistantMessage, parseConversation,
  parseRetainedDocumentMessageResult, appendAssistantMessageChunk, startAssistantMessageStreaming,
  toConversationId, toIsoTimestamp, toMessageId, toProjectId, toWorkId
} from '../../src/domain';
import { toConversationDto } from '../../src/platform/ipc/conversation-controller';

const t0 = toIsoTimestamp('2026-10-04T10:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-04T10:01:00.000Z');
const t2 = toIsoTimestamp('2026-10-04T10:02:00.000Z');
const assistantId = toMessageId('retained-assistant');
const receipt = { workId: toWorkId('retained-work'), fileName: '已保留.pptx', kind: 'ppt' as const,
  sizeBytes: 1024, actualPageCount: 6, planningTargetTotalPages: 12 };
function streaming() {
  const user = addUserMessage(createProjectConversation({ id: toConversationId('retained-conversation'),
    projectId: toProjectId('retained-project'), title: '保留作品', createdAt: t0 }), {
    id: toMessageId('retained-user'), content: '制作12页PPT', createdAt: t0 });
  return appendAssistantMessageChunk(startAssistantMessageStreaming(beginAssistantMessage(user, {
    id: assistantId, createdAt: t0 }), assistantId, t0), assistantId, '已接收到的正文', t0);
}

describe('retained document display receipts', () => {
  it.each(['failed', 'cancelled'] as const)('round-trips a %s response without changing its outcome or terminal time', state => {
    const before = state === 'failed' ? failAssistantMessage(streaming(), assistantId, 'interrupted', t1)
      : cancelAssistantMessage(streaming(), assistantId, t1);
    const after = attachRetainedDocumentResultToMessage(before, assistantId, receipt, t2);
    const saved = parseConversation(JSON.parse(JSON.stringify(after)));
    expect(saved.messages[1]).toMatchObject({ state, content: '已接收到的正文', retainedDocumentResult: receipt, updatedAt: t2 });
    expect(saved.messages[1]).toHaveProperty(state === 'failed' ? 'failedAt' : 'cancelledAt', t1);
    expect(saved.messages[1].documentResult).toBeUndefined();
    expect(toConversationDto(saved).messages[1]).toMatchObject({ state, retainedDocumentResult: receipt });
  });

  it('cannot turn a streaming/completed/user message into a retained artifact or replace a receipt', () => {
    const live = streaming();
    expect(() => attachRetainedDocumentResultToMessage(live, assistantId, receipt, t1)).toThrow();
    const completed = completeAssistantMessage(live, assistantId, t1);
    expect(() => attachRetainedDocumentResultToMessage(completed, assistantId, receipt, t2)).toThrow();
    expect(() => attachRetainedDocumentResultToMessage(live, toMessageId('retained-user'), receipt, t1)).toThrow();
    const retained = attachRetainedDocumentResultToMessage(failAssistantMessage(live, assistantId, 'unknown', t1), assistantId, receipt, t2);
    expect(() => attachRetainedDocumentResultToMessage(retained, assistantId, { ...receipt, workId: toWorkId('replacement-work') }, t2)).toThrow();
    expect(() => parseConversation({ ...completed, messages: completed.messages.map(message =>
      message.id === assistantId ? { ...message, retainedDocumentResult: receipt } : message) })).toThrow();
  });

  it.each([
    { actualPageCount: 0 }, { actualPageCount: 41 }, { planningTargetTotalPages: -1 },
    { fileName: '../private.pptx' }, { fileName: 'C:\\private.pptx' }, { kind: 'word' }, { sizeBytes: 0 },
    { rawPrompt: 'must not persist' }, { planningTargetTotalPages: '12' }
  ])('rejects unsafe or invalid receipt facts %j', change => {
    expect(() => parseRetainedDocumentMessageResult({ ...receipt, ...change })).toThrow();
  });

  it('does not invent a planning goal when the old publication receipt lacks it', () => {
    const { planningTargetTotalPages: _goal, ...oldReceipt } = receipt;
    void _goal;
    expect(parseRetainedDocumentMessageResult(oldReceipt)).not.toHaveProperty('planningTargetTotalPages');
  });
});
