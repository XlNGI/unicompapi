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
  it('uses canonical event identity to keep replayed rows stable across history and live delivery', () => {
    const canonical = { runId: 'run-one', runEventId: 'event-one', runSequence: 4 };
    const original = event(2, canonical);
    const replay = event(7, canonical);
    const merged = mergeProductionEvents([original], [replay, event(8, { ...canonical, runEventId: 'event-two', runSequence: 7 })]);
    expect(merged.map(item => item.sequence)).toEqual([2, 8]);
    const html = renderToStaticMarkup(<DocumentProgress detail="执行中" events={[original, replay]} />);
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).not.toContain('run-one');
    const developer = renderToStaticMarkup(<DocumentProgress detail="执行中" developerMode events={[original, replay]} />);
    expect(developer.match(/<li /g)).toHaveLength(1);
    expect(developer).toContain('<dt>runId</dt><dd>run-one</dd>');
    expect(developer).toContain('<dt>runEventId</dt><dd>event-one</dd>');
    expect(developer).toContain('<dt>runSequence</dt><dd>4</dd>');
  });

  it('does not collapse model progress from different runs or source traces', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="执行中" events={[
      event(1, { code: 'model_response', status: 'progress', runId: 'run-one', runEventId: 'event-one', runSequence: 1 }),
      event(2, { code: 'model_response', status: 'progress', traceId: 'other-trace', runId: 'run-two', runEventId: 'event-two', runSequence: 1 })
    ]} />);
    expect(html.match(/<li /g)).toHaveLength(2);
  });

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

  it('keeps a failed status visible while real execution events start collapsed', () => {
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
    expect(html).toContain('<details class="uc-chat-document-progress__details"><summary>');
    expect(html).not.toContain(' open=""');
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('渲染文档 · 失败');
    expect(summary).toContain('role="status" aria-live="polite"');
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

  it('shows readable document body after and outside the collapsed execution timeline', () => {
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
    expect(html).toContain('已接收 20 字符');
    expect(html).not.toContain('已接收 8 字符');
    expect(html.match(/aria-label="生成正文"/g)).toHaveLength(1);
    expect(html).toContain('</ol></details><section class="uc-chat-generated-body" aria-label="生成正文">');
    expect(html.indexOf('aria-label="生成正文"')).toBeGreaterThan(html.indexOf('data-event-code="document_compile"'));
    expect(html).not.toContain('uc-chat-generated-body__heading');
  });

  it('does not create a generated-body panel when no document content is available', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="普通回复" events={[event(1)]} />);
    expect(html).not.toContain('aria-label="生成正文"');
  });

  it('explains a measured page target deviation as a completed check rather than a failure', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="生成中" events={[
      event(1, { code: 'document_check', status: 'completed', operationId: 'presentation-page-count',
        facts: { requestedPages: 10, totalPages: 12, pageCountMode: 'target', pageCountBasis: 'total',
          diagnosticCode: 'page_count_deviation' } })
    ]} />);
    expect(html).toContain('核对 PPT 页数');
    expect(html).toContain('总页数规划目标 10 页 · 文件实际 12 页');
    expect(html).toContain('按内容与排版调整，未作为失败项');
    expect(html).not.toContain('data-status="failed"');
  });

  it('does not offer an empty execution disclosure or invent a completed state', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="正在准备文档内容…" />);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).not.toContain('data-status="completed"');
    expect(html).toContain('正在准备文档内容…');
  });

  it('keeps a persisted execution timeout visible without exposing timing facts in ordinary conversation', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" events={[
      event(1, { code: 'task_complete', status: 'failed', operationId: 'execution_budget', facts: {
        stopReason: 'timeout', timeoutScope: 'execution', parentElapsedMs: 360_000, parentRemainingMs: 0,
        childElapsedMs: 91_000, childRemainingMs: 0, toolCallsUsed: 2, costUnitsUsed: 16
      } }), event(2, { code: 'model_response', status: 'failed', facts: { purpose: 'content' } })
    ]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('任务执行达到总时限');
    expect(html).toContain('调用预算已用 2 次');
    expect(html).toContain('调度预算已用 16 单位');
    expect(html).not.toMatch(/360000|91000|金额|费用|连接超时|docId/);
  });

  it('explains a generic terminal failure with this execution stop while retaining explicit file failures', () => {
    const events = [event(1, { code: 'request_received', status: 'started' }),
      event(2, { code: 'model_response', status: 'failed', facts: { stopReason: 'timeout', timeoutScope: 'execution' } })];
    const generic = renderToStaticMarkup(<DocumentProgress detail="旧进度" terminalDetail="本次文档未交付。" terminalStatus="failed"
      genericTerminalFailure events={events} />);
    expect(generic.slice(generic.indexOf('<summary>'), generic.indexOf('</summary>'))).toContain('任务执行达到总时限');
    const explicit = renderToStaticMarkup(<DocumentProgress detail="旧进度" terminalDetail="发布失败。" terminalStatus="failed" events={events} />);
    expect(explicit.slice(explicit.indexOf('<summary>'), explicit.indexOf('</summary>'))).toContain('发布失败。');
    const retry = renderToStaticMarkup(<DocumentProgress detail="旧进度" terminalDetail="本次文档未交付。" terminalStatus="failed"
      genericTerminalFailure events={[...events, event(3, { code: 'request_received', status: 'started' }),
        event(4, { code: 'task_complete', status: 'failed' })]} />);
    const retrySummary = retry.slice(retry.indexOf('<summary>'), retry.indexOf('</summary>'));
    expect(retrySummary).toContain('本次文档未交付。');
    expect(retrySummary).not.toContain('达到总时限');
  });

  it.each([1, 3])('preserves a document registered at sequence %s on either side of execution Stop', sequence => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" events={[
      event(2, { code: 'task_complete', status: 'failed', operationId: 'execution_budget', facts: {
        stopReason: 'timeout', timeoutScope: 'execution' } }),
      event(sequence, { code: 'document_register', status: 'completed' })
    ]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('文档已保存，后续回复已停止');
    expect(summary).not.toMatch(/失败|未生成/);
  });

  it('retains an unknown-result warning without suggesting a generated artifact', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" events={[
      event(1, { code: 'task_complete', status: 'failed', operationId: 'execution_budget', facts: {
        stopReason: 'unknown_result', timeoutScope: 'tool' } })
    ]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('执行结果需要核对');
    expect(html).not.toMatch(/文档已保存|已生成|请重试/);
  });

  it('lets the actual document terminal state override a pre-commit execution Stop', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" terminalDetail="文档已生成并保存。" terminalStatus="completed"
      events={[event(1, { code: 'task_complete', status: 'failed', operationId: 'execution_budget', facts: {
        stopReason: 'timeout', timeoutScope: 'execution' } })]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('文档已生成并保存。');
    expect(summary).not.toContain('达到总时限');
    expect(html).toContain('aria-label="生产进度" data-status="completed"');
  });

  it('preserves legacy completed steps in a collapsed disclosure with the latest real status', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧版进度" taskProgress={[
      { sequence: 1, stage: 'planning', progressStatus: 'completed', taskRevision: 1, occurredAt: time },
      { sequence: 2, stage: 'rendering', progressStatus: 'running', taskRevision: 1, occurredAt: time }
    ]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('正在进行页面渲染…');
    expect(summary).not.toContain('已完成');
    expect(html).toContain('aria-label="已完成步骤"');
    expect(html).toContain('需求规划已完成。');
    expect(html).not.toContain(' open=""');
  });

  it('keeps cancellation and an incomplete-history notice outside the hidden events', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" incomplete events={[
      event(1, { code: 'tool_call', status: 'cancelled' })
    ]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain('执行受控步骤 · 已取消');
    expect(html).toContain('aria-label="生产进度" data-status="cancelled"');
    expect(html.indexOf('生产记录不完整')).toBeGreaterThan(html.indexOf('</details>'));
    expect(html).not.toContain(' open=""');
    expect(html).not.toContain('uc-chat-production-trace__devtools');
  });

  it.each(['正在生成本地文档文件…', '已请求停止，正在确认任务状态…'])('prefers active local state %s over earlier model events', (activeDetail) => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" activeDetail={activeDetail} events={[
      event(1, { code: 'model_response', status: 'completed', facts: { purpose: 'content' } })
    ]} />);
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    expect(summary).toContain(activeDetail);
    expect(summary).not.toContain('接收模型响应 · 已完成');
    expect(html).toContain('aria-label="生产进度" data-status="started"');
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

  it.each([
    { terminalDetail: '文档已生成并保存。', terminalStatus: 'completed' as const },
    { terminalDetail: '文档生成失败。', terminalStatus: 'failed' as const },
    { terminalDetail: '任务已中断。', terminalStatus: 'interrupted' as const },
    { terminalDetail: '文档生成已取消。', terminalStatus: 'cancelled' as const }
  ])('preserves persisted document terminal state $terminalStatus over an active operation and stale trace', ({ terminalDetail, terminalStatus }) => {
    const html = renderToStaticMarkup(<DocumentProgress detail="旧进度" terminalDetail={terminalDetail} terminalStatus={terminalStatus}
      activeDetail="正在生成本地文档文件…"
      events={[event(1, { code: 'document_compile', status: 'started' })]} />);
    expect(html).toContain(`<span>${terminalDetail}</span>`);
    expect(html).toContain(`aria-label="生产进度" data-status="${terminalStatus}"`);
    expect(html).toContain('data-event-code="document_compile"');
    expect(html).toContain('已开始');
    expect(html).not.toContain('生成文档文件 · 已开始');
    expect(html).not.toContain('正在生成本地文档文件…');
  });
  it('renders developer mode facts including docId, nodeId and duration when developerMode is enabled', () => {
    const html = renderToStaticMarkup(<DocumentProgress detail="生成中" developerMode events={[
      event(1, { code: 'request_received', status: 'completed' }),
      event(2, { code: 'tool_call', status: 'progress', facts: { tool: 'search' }, occurredAt: '2026-09-22T08:00:01.500Z' })
    ]} />);
    expect(html).toContain('查看执行事实 (docId / 工具调用)');
    expect(html).toContain('docId');
    expect(html).toContain('conversation');
    expect(html).toContain('nodeId');
    expect(html).toContain('search');
    expect(html).toContain('1.50s');
  });
});
