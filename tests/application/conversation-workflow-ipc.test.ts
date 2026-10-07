import { describe, expect, it } from 'vitest';
import { chatContextRequestParsers } from '../../src/shared/chat-context-ipc';

describe('conversation workflow IPC parsers', () => {
  it('accepts only a controlled document intent hint', () => {
    expect(chatContextRequestParsers.startWorkflow({
      clientCommandId: 'workflow-command-1',
      conversation: null,
      title: '季度汇报',
      content: '来一份季度汇报',
      intentHint: { kind: 'document', documentKind: 'ppt' }
    })).toEqual({
      clientCommandId: 'workflow-command-1',
      conversation: null,
      title: '季度汇报',
      content: '来一份季度汇报',
      intentHint: { kind: 'document', documentKind: 'ppt' }
    });
    expect(() => chatContextRequestParsers.startWorkflow({
      clientCommandId: 'workflow-command-unsafe',
      conversation: null,
      title: '季度汇报',
      content: '来一份季度汇报',
      intentHint: {
        kind: 'document',
        documentKind: 'ppt',
        absolutePath: 'C:\\private\\report.pptx'
      }
    })).toThrow('unexpected or missing fields');
  });

  it('binds a response to a versioned workflow without changing the legacy request shape', () => {
    const base = {
      clientCommandId: 'response-command-1',
      conversation: {
        conversationId: 'conversation-1',
        expectedRevision: 2,
        editedMessageId: null
      },
      title: '季度汇报',
      content: '受控内部提示',
      productFeature: 'text_chat' as const,
      candidateId: 'candidate-1',
      contextSelections: [],
      parameterValues: {},
      confirmed: true
    };
    expect(chatContextRequestParsers.startResponse(base)).not.toHaveProperty('workflow');
    expect(chatContextRequestParsers.startResponse({
      ...base,
      workflow: { workflowId: 'workflow-1', expectedRevision: 3 }
    })).toMatchObject({
      workflow: { workflowId: 'workflow-1', expectedRevision: 3 }
    });
    expect(() => chatContextRequestParsers.startResponse({
      ...base,
      workflow: {
        workflowId: 'workflow-1',
        expectedRevision: 3,
        providerId: 'provider-unsafe'
      }
    })).toThrow('unexpected or missing fields');
  });

  it('accepts an Agent-native response without workflow or semantic confirmation fields', () => {
    const request = chatContextRequestParsers.startAgentResponse({
      clientCommandId: 'agent-command-1',
      conversation: null,
      title: 'Agent conversation',
      content: '可以，继续处理刚才的方案',
      productFeature: 'text_chat' as const,
      candidateId: 'candidate-1',
      contextSelections: [],
      parameterValues: {}
    });
    expect(request).not.toHaveProperty('workflow');
    expect(request).not.toHaveProperty('agentNative');
  });

  it('rejects stale-shaped clarification answers and unknown fields', () => {
    expect(chatContextRequestParsers.answerWorkflow({
      workflowId: 'workflow-1',
      expectedWorkflowRevision: 0,
      expectedConversationRevision: 1,
      content: 'PPT，8页'
    })).toMatchObject({
      expectedWorkflowRevision: 0,
      expectedConversationRevision: 1
    });
    expect(() => chatContextRequestParsers.answerWorkflow({
      workflowId: 'workflow-1',
      expectedWorkflowRevision: 0,
      expectedConversationRevision: 1,
      content: 'PPT，8页',
      credential: 'unsafe'
    })).toThrow('unexpected or missing fields');
  });

  it('allows only versioned opaque Agent continuations in an existing conversation', () => {
    const request = { clientCommandId: 'resume-command', conversation: { conversationId: 'conversation-1',
      expectedRevision: 3, editedMessageId: null }, title: '继续', content: '补充的需求', productFeature: 'text_chat',
      candidateId: 'candidate-1', contextSelections: [], parameterValues: {},
      continuation: { sessionId: 'session-1', expectedRevision: 2, resumeToken: 'resume-token-1', action: 'reply' } };
    expect(chatContextRequestParsers.startAgentResponse(request)).toMatchObject({ continuation: request.continuation });
    expect(() => chatContextRequestParsers.startAgentResponse({ ...request, conversation: null })).toThrow();
    expect(() => chatContextRequestParsers.startAgentResponse({ ...request,
      conversation: { ...request.conversation, editedMessageId: 'message-1' } })).toThrow();
    expect(() => chatContextRequestParsers.startResponse({ ...request, confirmed: true })).toThrow();
    for (const extra of [{ budgetUnits: 1000 }, { ownerId: 'other-owner' }, { filePath: 'C:/private/input.json' }]) {
      expect(() => chatContextRequestParsers.startAgentResponse({ ...request,
        continuation: { ...request.continuation, ...extra } })).toThrow();
    }
    expect(() => chatContextRequestParsers.startAgentResponse({ ...request,
      continuation: { ...request.continuation, action: 'restart' } })).toThrow();
    expect(chatContextRequestParsers.cancelAgentSession({ projectId: 'project-1', sessionId: 'session-1', expectedRevision: 2 }))
      .toEqual({ projectId: 'project-1', sessionId: 'session-1', expectedRevision: 2 });
    expect(chatContextRequestParsers.cancelAgentSession({ projectId: 'project-1', sessionId: 'session-1', expectedRevision: 2, closeUnknown: true }))
      .toEqual({ projectId: 'project-1', sessionId: 'session-1', expectedRevision: 2, closeUnknown: true });
    expect(() => chatContextRequestParsers.cancelAgentSession({ projectId: 'project-1', sessionId: 'session-1', expectedRevision: 2, closeUnknown: 'true' })).toThrow();
    expect(() => chatContextRequestParsers.cancelAgentSession({ projectId: 'project-1', sessionId: 'session-1', expectedRevision: 2, closeUnknown: true, budgetUnits: 1000 })).toThrow();
  });
});
