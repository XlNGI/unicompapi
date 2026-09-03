import { describe, expect, it } from 'vitest';
import {
  ConversationIntentOrchestrationError,
  ConversationIntentOrchestrator,
  analyzeLocalConversationIntent
} from '../../src/application';

describe('Conversation intent orchestrator', () => {
  it('keeps ambiguous problem reports out of automatic document creation', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '这个报告出了问题'
    });
    expect(decision.plan.kind).toBe('unknown');
    expect(decision.assessment.readiness).toBe('needs_clarification');
  });

  it('recognizes omitted but clear table creation and incomplete summary delivery', () => {
    expect(analyzeLocalConversationIntent({ rawText: '给我一个表格' }).plan).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'excel',
      confidence: 'high'
    });
    const summary = analyzeLocalConversationIntent({ rawText: '帮我做个总结' });
    expect(summary.plan).toMatchObject({
      kind: 'document',
      action: 'create',
      documentKind: 'auto',
      confidence: 'low'
    });
    expect(summary.assessment.readiness).toBe('needs_clarification');
  });

  it('does not guess among multiple document targets for an underspecified edit', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '再加一个例子',
      context: {
        documents: [
          { messageId: 'ppt-1', kind: 'ppt', fileName: '汇报.pptx' },
          { messageId: 'word-1', kind: 'word', fileName: '方案.docx' }
        ]
      }
    });
    expect(decision.plan).toMatchObject({
      kind: 'document',
      action: 'revise',
      confidence: 'low'
    });
    expect(decision.resolvedTarget).toBeUndefined();
  });

  it('uses a bounded structured classifier only for unknown local decisions', async () => {
    let calls = 0;
    const orchestrator = new ConversationIntentOrchestrator({
      classifier: {
        async classify() {
          calls += 1;
          return {
            schemaVersion: 1,
            kind: 'chat',
            parameters: {},
            sourcePolicy: 'none',
            missing: [],
            ambiguities: [],
            confidence: 'high',
            needsConfirmation: false
          };
        }
      }
    });
    const result = await orchestrator.analyze({ rawText: '这个报告出了问题' });
    expect(result.route).toBe('classifier');
    expect(result.plan.kind).toBe('chat');
    expect(calls).toBe(1);
  });

  it('fails closed when the structured classifier returns an invalid plan', async () => {
    const orchestrator = new ConversationIntentOrchestrator({
      classifier: { async classify() { return { kind: 'document', path: 'C:/unsafe' }; } }
    });
    const result = await orchestrator.analyze({ rawText: '这个报告出了问题' });
    expect(result.route).toBe('fallback');
    expect(result.plan.kind).toBe('unknown');
    expect(result.failureCode).toBe('invalid_intent_plan');
  });

  it('distinguishes a bounded classifier timeout from caller cancellation', async () => {
    const classifier = {
      classify({ signal }: { readonly signal: AbortSignal }) {
        return new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    };
    const timedOut = await new ConversationIntentOrchestrator({
      classifier,
      classifierTimeoutMs: 5
    }).analyze({ rawText: '这个报告出了问题' });
    expect(timedOut).toMatchObject({
      route: 'fallback',
      failureCode: 'classification_timeout',
      plan: { kind: 'unknown' }
    });

    const controller = new AbortController();
    const cancelled = new ConversationIntentOrchestrator({
      classifier,
      classifierTimeoutMs: 1_000
    }).analyze({ rawText: '这个报告出了问题', signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ConversationIntentOrchestrationError);
  });

  it('uses an explicit document-mode hint as semantic input instead of a renderer-side route', () => {
    const decision = analyzeLocalConversationIntent({
      rawText: '季度经营情况，8页，面向管理层',
      context: {
        requestedIntentKind: 'document',
        requestedDocumentKind: 'ppt'
      }
    });
    expect(decision).toMatchObject({
      plan: {
        kind: 'document',
        action: 'create',
        documentKind: 'ppt',
        confidence: 'high'
      },
      assessment: { readiness: 'ready' }
    });
  });
});
