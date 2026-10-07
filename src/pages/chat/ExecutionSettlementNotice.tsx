import { Button } from 'rsuite';
import type { ConversationParentRunDto } from '../../shared/chat-context-ipc';

export function ExecutionSettlementNotice({ parent, responseEnded, busy, onInspect }: {
  readonly parent?: ConversationParentRunDto;
  readonly responseEnded: boolean;
  readonly busy: boolean;
  readonly onInspect: (parent: ConversationParentRunDto) => void;
}) {
  if (!parent) return null;
  if (parent.acknowledged) return <p role="status">本次任务已确认关闭，未知结果记录仍保留，不会自动重试。</p>;
  if (parent.state === 'needs_reconciliation') return <div role="alert" aria-label="任务结果待核对">
    <p>执行结果需要核对，核对前不会重发任务。{parent.registeredWorkCount > 0 ? '已有作品记录保留，请先核对文件。' : ''}</p>
    <Button size="xs" appearance="ghost" disabled={busy} onClick={() => onInspect(parent)}>核对执行结果</Button>
  </div>;
  if (responseEnded && (parent.state === 'running' || parent.state === 'executing_tool')) return <p role="status">正在结算任务结果…</p>;
  if (parent.state === 'failed') return <p role="status">任务未完整完成。{parent.registeredWorkCount > 0 ? '已有作品记录保留。' : ''}</p>;
  return null;
}
