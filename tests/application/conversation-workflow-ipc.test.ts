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
});
