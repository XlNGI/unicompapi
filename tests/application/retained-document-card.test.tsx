import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RetainedDocumentCard } from '../../src/pages/chat/RetainedDocumentCard';
import { DocumentProgress } from '../../src/pages/chat/DocumentProgress';
import { failedResponseNotice, retainedDocumentSummary } from '../../src/ui/chat-response-failure-notice';
import type { MessageDto } from '../../src/shared/chat-context-ipc';

const result = { workId: 'retained-work', fileName: '已保存.pptx', kind: 'ppt' as const,
  sizeBytes: 1024, actualPageCount: 6, planningTargetTotalPages: 12 };
describe('retained PPT display', () => {
  it('keeps a saved file visible and distinguishes physical pages from the planning goal', () => {
    const html = renderToStaticMarkup(<RetainedDocumentCard result={result} onOpen={() => undefined} />);
    expect(html).toContain('已保留的 PPT 文件');
    expect(html).toContain('已保留 6 页 PPT，12 页规划目标尚未达到。');
    expect(html).toContain('本次任务的停止状态保留');
    expect(html).toContain('打开');
    expect(html).not.toMatch(/生成成功|作品已完成|retained-work|重试|重新生成/);
  });
  it.each(['failed', 'cancelled', 'interrupted'] as const)('retains the %s progress state with a saved artifact', status => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧记录未交付" terminalStatus={status}
      retainedDocumentResult={result} events={[]} />);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('已保留 6 页 PPT');
    expect(html).not.toContain('data-status="completed"');
    if (status === 'interrupted') expect(html).toContain('执行结果仍需核对');
  });
  it('uses only the actual pages for an old receipt and describes other deviations truthfully', () => {
    expect(retainedDocumentSummary({ ...result, planningTargetTotalPages: undefined })).toBe('已保留 6 页 PPT。');
    expect(retainedDocumentSummary({ ...result, actualPageCount: 12 })).toContain('达到 12 页规划目标');
    expect(retainedDocumentSummary({ ...result, actualPageCount: 14 })).toContain('与 12 页规划目标有偏差');
  });
  it('does not ask for automatic regeneration after a response failure with a verified file', () => {
    const message: MessageDto = { messageId: 'assistant', conversationId: 'conversation', revision: 2, role: 'assistant',
      state: 'failed', failureReason: 'unavailable', content: '', attachments: [], retainedDocumentResult: result,
      createdAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:01:00.000Z' };
    const notice = failedResponseNotice(message);
    expect(notice).toContain('已校验并保存的 PPT 保留');
    expect(notice).not.toMatch(/请重试|网络|模型连接超时/);
    expect(failedResponseNotice(message, 'newapi.tool_loop_budget_exceeded')).toContain('执行调度预算已耗尽');
    expect(failedResponseNotice(message, 'newapi.tool_loop_unknown_result')).toContain('核对前不要重复生成');
  });
});
