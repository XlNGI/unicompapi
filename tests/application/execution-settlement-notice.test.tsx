import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExecutionSettlementNotice } from '../../src/pages/chat/ExecutionSettlementNotice';
import type { ConversationParentRunDto } from '../../src/shared/chat-context-ipc';

const parent: ConversationParentRunDto = { responseExecutionId: 'response-test', sourceMessageId: 'message-test',
  state: 'needs_reconciliation', runRevision: 1, reconciliationReason: 'unknown_result', registeredWorkCount: 1, acknowledged: false };
describe('safe execution settlement notice', () => {
  it('makes unknown results visible while retaining the existing artifact record', () => {
    const html = renderToStaticMarkup(<ExecutionSettlementNotice parent={parent} responseEnded busy={false} onInspect={() => undefined} />);
    expect(html).toContain('执行结果需要核对');
    expect(html).toContain('已有作品记录保留');
    expect(html).toContain('核对执行结果');
    expect(html).not.toMatch(/生成成功|response-test|message-test|unknown_result/);
  });
  it('distinguishes local settlement from completed delivery', () => {
    const html = renderToStaticMarkup(<ExecutionSettlementNotice parent={{ ...parent, state: 'executing_tool' }} responseEnded busy={false} onInspect={() => undefined} />);
    expect(html).toContain('正在结算任务结果');
    expect(html).not.toContain('已完成');
  });
  it('records an explicit close without claiming an unknown effect was absent', () => {
    const html = renderToStaticMarkup(<ExecutionSettlementNotice parent={{ ...parent, state: 'cancelled', acknowledged: true }} responseEnded busy={false} onInspect={() => undefined} />);
    expect(html).toContain('未知结果记录仍保留');
    expect(html).toContain('不会自动重试');
    expect(html).not.toMatch(/没有生成|没有费用|无需核对/);
  });
});
