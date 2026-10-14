import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';
import { DocumentProgress } from '../../src/pages/chat/DocumentProgress';
import { presentationDesignNotice } from '../../src/pages/chat/presentationDesignNotice';

const event = (sequence: number, extra: Partial<ProductionTraceEventDto> = {}): ProductionTraceEventDto => ({
  schemaVersion: 1, projectId: 'project', conversationId: 'conversation', sourceMessageId: 'source', traceId: 'trace',
  sequence, code: 'plan_validation', status: 'completed', occurredAt: '2026-10-14T15:00:00.000Z', ...extra
});
describe('visible, factual template fallback notice', () => {
  it('explains timeout outside the collapsed technical records without claiming a saved file', () => {
    const events = [event(1, { facts: { designPath: 'legacy-fallback', fallbackReason: 'art_direction_timeout' } })];
    const html = renderToStaticMarkup(<DocumentProgress detail="正在制作" events={events} />);
    expect(html).toContain('自主设计规划超时，已切换为基础模板兜底。');
    expect(html.indexOf('基础模板兜底')).toBeLessThan(html.indexOf('<details'));
    expect(html).not.toContain('文件已保存');
  });
  it('removes an earlier fallback after a subsequent successful model design', () => {
    expect(presentationDesignNotice([event(1, { facts: { designPath: 'legacy-fallback' } }),
      event(2, { facts: { designPath: 'design-aware' } })])).toBeUndefined();
  });
  it('does not infer fallback from a failed request, stale previous run or arbitrary reason text', () => {
    expect(presentationDesignNotice([event(1, { status: 'failed', facts: { designPath: 'legacy-fallback' } })])).toBeUndefined();
    expect(presentationDesignNotice([event(1, { facts: { designPath: 'legacy-fallback' } }), event(2, { code: 'request_received' })])).toBeUndefined();
    const notice = presentationDesignNotice([event(1, { facts: { designPath: 'legacy-fallback', fallbackReason: 'private-source-path' } })]);
    expect(notice).not.toContain('private-source-path'); expect(notice).toContain('基础模板兜底');
  });
});
