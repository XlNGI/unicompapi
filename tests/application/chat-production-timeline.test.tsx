import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentProgress } from '../../src/pages/chat/DocumentProgress';
import { mergeProductionEvents, projectProductionMessages } from '../../src/pages/chat/productionTimeline';
import type { ConversationDto, MessageDto } from '../../src/shared/chat-context-ipc';
import type { ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';

const time = '2026-09-22T08:00:00.000Z';
function event(sequence: number, extra: Partial<ProductionTraceEventDto> = {}): ProductionTraceEventDto {
  return { schemaVersion: 1, projectId: 'project', conversationId: 'conversation', sourceMessageId: 'user',
    traceId: 'trace', clientCommandId: 'command', sequence, code: 'model_request', status: 'started', occurredAt: time, ...extra };
}
function message(messageId: string, role: 'user' | 'assistant', content = ''): MessageDto {
  return { messageId, conversationId: 'conversation', revision: 1, role, state: 'completed', content,
    attachments: [], createdAt: time, updatedAt: time };
}
function conversation(messages: readonly MessageDto[]): ConversationDto {
  return { conversationId: 'conversation', projectId: 'project', revision: 1, title: 'Timeline',
    status: 'active', storageScope: 'current_project', readOnly: false, messages, createdAt: time, updatedAt: time };
}

describe('production timeline projection', () => {
  it('merges a racing history read and live events once in durable sequence order', () => {
    const live = [event(3), event(1)];
    const result = mergeProductionEvents(live, [event(2), event(3)]);
    expect(result.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(mergeProductionEvents(result, [event(1, { conversationId: 'other' })])).toHaveLength(4);
  });

  it('shows the original user input and one assistant timeline while planning is pending', () => {
    const events = [event(1, { code: 'request_received', status: 'completed' }), event(2)];
    const result = projectProductionMessages(undefined, events, {
      clientCommandId: 'command', sourceMessageId: 'user', conversationId: 'conversation', content: '制作年度报告'
    });
    expect(result.messages.map((item) => [item.role, item.content])).toEqual([['user', '制作年度报告'], ['assistant', '']]);
    expect(result.timelineByMessage.get('production-user')).toEqual(events);
  });

  it('moves the existing timeline to the actual assistant once its persisted message arrives', () => {
    const events = [event(1), event(2, { code: 'model_response', assistantMessageId: 'answer' })];
    const before = projectProductionMessages(conversation([message('user', 'user', '制作年度报告')]), events);
    expect(before.messages.map((item) => item.messageId)).toEqual(['user', 'production-user']);
    const after = projectProductionMessages(conversation([message('user', 'user'), message('answer', 'assistant')]), events);
    expect(after.messages.map((item) => item.messageId)).toEqual(['user', 'answer']);
    expect([...after.timelineByMessage.keys()]).toEqual(['answer']);
    expect(after.timelineByMessage.get('answer')).toEqual(events);
  });

  it('attaches a historical planning failure to its saved assistant without synthetic duplication', () => {
    const saved = conversation([message('user', 'user'), message('failure', 'assistant', '模型请求失败')]);
    const events = [event(1), event(2, { code: 'model_response', status: 'failed' })];
    const result = projectProductionMessages(saved, events);
    expect(result.messages).toEqual(saved.messages);
    expect(result.timelineByMessage.get('failure')).toEqual(events);
  });

  it('preserves the source association across multiple user messages', () => {
    const saved = conversation([message('user', 'user'), message('answer', 'assistant'),
      message('user2', 'user'), message('answer2', 'assistant')]);
    const first = event(1, { assistantMessageId: 'answer' });
    const second = event(2, { sourceMessageId: 'user2', traceId: 'trace2', assistantMessageId: 'answer2' });
    const result = projectProductionMessages(saved, [first, second]);
    expect(result.timelineByMessage.get('answer')).toEqual([first]);
    expect(result.timelineByMessage.get('answer2')).toEqual([second]);
  });

  it('orders and deduplicates interleaved clarification and original-source events on the same assistant', () => {
    const saved = conversation([message('user', 'user', '制作报告'), message('question', 'assistant', '请补充主题'),
      message('clarification', 'user', '年度经营'), message('answer', 'assistant')]);
    const initial = event(1, { code: 'request_received', status: 'completed' });
    const clarification = event(2, { sourceMessageId: 'clarification', traceId: 'trace2', code: 'request_received', status: 'completed' });
    const content = event(3, { assistantMessageId: 'answer', code: 'model_response', status: 'completed', facts: { purpose: 'content' } });
    const local = event(4, { sourceMessageId: 'clarification', traceId: 'trace2', assistantMessageId: 'answer', code: 'document_compile' });
    const projected = projectProductionMessages(saved, [initial, clarification, content, local, content, local]);
    expect(projected.timelineByMessage.get('answer')?.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(projected.requestBySource.get('user')).toBe('制作报告');
    expect(projected.requestBySource.get('clarification')).toBe('年度经营');
    expect(projected.requestBySource.has('question')).toBe(false);
    const html = renderToStaticMarkup(<DocumentProgress detail="生成中" events={projected.timelineByMessage.get('answer')}
      requestBySource={projected.requestBySource} />);
    expect(html.indexOf('制作报告')).toBeLessThan(html.indexOf('年度经营'));
    expect(html.match(/制作报告/g)).toHaveLength(1);
    expect(html.match(/年度经营/g)).toHaveLength(1);
  });

  it('does not substitute another request when an event source message is missing', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="生成中" request="另一个请求"
      requestBySource={new Map([['other', '另一个请求']])}
      events={[event(1, { code: 'request_received', status: 'completed' })]} />);
    expect(html).not.toContain('另一个请求');
  });

  it('renders all real statuses without hiding failures or fabricating pending stages', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="legacy terminal" events={[
      event(1, { code: 'request_received', status: 'completed' }), event(2),
      event(3, { code: 'model_response', status: 'progress', facts: { contentCharacters: 42 } }),
      event(4, { code: 'document_render', status: 'failed' })
    ]} request="制作年度报告" />);
    expect(html.match(/<li /g)).toHaveLength(4);
    expect(html).toContain('制作年度报告');
    expect(html).toContain('本地 → 模型');
    expect(html).toContain('模型 → 本地');
    expect(html).toContain('本地工具');
    expect(html).toContain('已接收 42 字符');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('渲染文档 · 失败');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('登记作品');
    expect(html).not.toContain('legacy terminal');
  });

  it('retains independent local events after the response has already ended', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="回复已完成" preferDetail events={[
      event(1, { code: 'model_response', status: 'completed' }),
      event(2, { code: 'document_compile', status: 'started' }),
      event(3, { code: 'document_hash_check', status: 'completed', facts: { bytes: 1024 } }),
      event(4, { code: 'document_register', status: 'completed' })
    ]} incomplete />);
    expect(html).toContain('登记作品 · 已完成');
    expect(html).toContain('校验文件完整性');
    expect(html).toContain('生产记录不完整');
    expect(html).not.toContain('回复已完成');
  });

  it('shows readable document body separately from the execution timeline', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="正在生成文档内容…"
      bodyContent={JSON.stringify({ kind: 'word', title: '年度报告', sections: [{ heading: '结论',
        blocks: [{ type: 'paragraph', text: '收入保持增长。' }] }], reasoning: 'PRIVATE' })}
      events={[event(1, { code: 'model_response', status: 'progress', facts: { purpose: 'content', contentCharacters: 8 } }),
        event(2, { code: 'model_response', status: 'completed', facts: { purpose: 'content', contentCharacters: 20 } }),
        event(3, { code: 'document_compile', status: 'started' })]} />);
    expect(html).toContain('aria-label="生成正文"');
    expect(html).toContain('年度报告');
    expect(html).toContain('收入保持增长。');
    expect(html).not.toContain('PRIVATE');
    expect(html).not.toContain('&quot;sections&quot;');
    expect(html).toContain('已接收 8 字符');
    expect(html.match(/aria-label="生成正文"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="生成正文"')).toBeGreaterThan(html.indexOf('已接收 20 字符'));
    expect(html.indexOf('aria-label="生成正文"')).toBeLessThan(html.indexOf('data-event-code="document_compile"'));
  });

  it('does not create a generated-body panel when no document content is available', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="普通回复" events={[event(1)]} />);
    expect(html).not.toContain('aria-label="生成正文"');
  });

  it('renders body image descriptions without triggering image requests', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="正在生成文档内容…"
      bodyContent={'# 报告\n\n![销售分布](https://example.com/chart.png)'} />);
    expect(html).toContain('销售分布');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
  });

  it('marks a bounded body preview as incomplete', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="文档内容已接收。"
      bodyContent={'文'.repeat(200_010)} />);
    expect(html).toContain('正文预览已截断');
  });

  it.each(['文档已生成并保存。', '文档生成失败。', '任务已中断。'])('preserves persisted document terminal state %s over a stale trace', (terminalDetail) => {
    const html = renderToStaticMarkup(<DocumentProgress detail="正在生成本地文档文件…" terminalDetail={terminalDetail}
      events={[event(1, { code: 'document_compile', status: 'started' })]} />);
    expect(html).toContain(`<span>${terminalDetail}</span>`);
    expect(html).toContain('data-event-code="document_compile"');
    expect(html).toContain('已开始');
    expect(html).not.toContain('生成文档文件 · 已开始');
  });
});
