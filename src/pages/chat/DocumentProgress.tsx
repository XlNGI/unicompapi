import { useMemo } from 'react';
import type { ConversationTaskProgressSnapshot } from '../../shared/conversation-task-progress';
import type { ProductionTraceEventDto } from '../../shared/conversation-production-ipc';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { StreamingMarkdown } from './StreamingMarkdown';
import { projectDocumentBody } from './documentBodyPreview';

export interface DocumentProgressProps {
  readonly detail: string;
  readonly taskProgress?: readonly ConversationTaskProgressSnapshot[];
  /** A local terminal state or active file operation takes precedence over earlier model events. */
  readonly preferDetail?: boolean;
  readonly events?: readonly ProductionTraceEventDto[];
  readonly request?: string;
  readonly requestBySource?: ReadonlyMap<string, string>;
  readonly incomplete?: boolean;
  /** A persisted document result/terminal status survives an incomplete historical trace. */
  readonly terminalDetail?: string;
  /** Raw model content is projected to safe, readable document text before display. */
  readonly bodyContent?: string;
  readonly bodyStreaming?: boolean;
  /** When developer mode is enabled, structured facts like docId, nodeId, duration and tool calls can be inspected */
  readonly developerMode?: boolean;
}

const stages: Record<ConversationTaskProgressSnapshot['stage'], string> = {
  planning: '需求规划', retrieval: '资料检索', analysis: '资料分析', design: '页面设计',
  rendering: '页面渲染', checking: '结果检查', publishing: '文件发布', completed: '任务执行'
};

function progressSummary(event: ConversationTaskProgressSnapshot): string {
  const label = stages[event.stage];
  switch (event.progressStatus) {
    case 'completed': return `${label}已完成。`;
    case 'failed': return `${label}未完成。`;
    case 'cancelled': return `${label}已停止。`;
    case 'paused': return `${label}已暂停。`;
    default: return `正在进行${label}…`;
  }
}

/** Only persisted execution facts become steps; reasoning and planned stages are never displayed. */
const eventTitles: Record<ProductionTraceEventDto['code'], string> = {
  request_received: '接收任务', model_request: '发送模型请求', model_response: '接收模型响应',
  plan_decision: '模型任务决策', plan_validation: '校验任务计划', source_context: '准备授权资料',
  tool_authorization: '校验执行权限', tool_call: '执行受控步骤', tool_result: '步骤已完成',
  document_compile: '生成文档文件', document_render: '渲染文档', document_check: '校验文档',
  document_structure_check: '检查文档结构', document_hash_check: '校验文件完整性',
  document_register: '登记作品', document_publish: '发布文档', task_complete: '结束任务'
};
const statusLabels = { started: '已开始', progress: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const toolLabels = { read_sources: '读取授权资料', search: '检索资料', analyze: '分析资料', write_document: '写入文档',
  render: '渲染预览', check: '质量检查', publish: '登记作品', patch: '修订文档' };

interface DisplayProductionEvent {
  readonly event: ProductionTraceEventDto;
  /** The first sequence in a collapsed progress run keeps the React row mounted. */
  readonly key: string;
}

function compactProgressEvents(events: readonly ProductionTraceEventDto[]): readonly DisplayProductionEvent[] {
  const compacted: DisplayProductionEvent[] = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    const sameProgressRun = previous && previous.event.code === event.code &&
      previous.event.facts?.purpose === event.facts?.purpose &&
      (previous.event.status === 'progress' || event.status === 'progress');
    if (sameProgressRun) {
      compacted[compacted.length - 1] = { ...previous, event };
    } else {
      compacted.push({ event, key: `${event.conversationId}:${event.sequence}` });
    }
  }
  return compacted;
}

function eventTitle(event: ProductionTraceEventDto): string {
  const localOperations: Record<string, string> = {
    'document-outline': '校验文档大纲', 'document-layout': '检查 PPT 布局容量',
    'document-output-structure': '检查文件结构与内容', 'document-preview-render': '渲染文件预览',
    'document-render-diagnostics': '检查渲染诊断结果', 'document-temporary-hash': '校验临时文件 Hash',
    'document-published-hash': '校验发布后文件 Hash', 'document-atomic-publish': '原子发布本地文件',
    'document-work-register': '登记正式作品'
  };
  if (event.operationId && localOperations[event.operationId]) return localOperations[event.operationId];
  if (event.code === 'plan_validation' && event.facts?.purpose === 'source_summary') return '校验资料摘要格式';
  return eventTitles[event.code];
}
function eventDirection(event: ProductionTraceEventDto): string {
  if (event.code === 'model_request') return '本地 → 模型';
  if (event.code === 'model_response' || event.code === 'plan_decision') return '模型 → 本地';
  return '本地工具';
}
function eventDetails(event: ProductionTraceEventDto): string[] {
  const facts = event.facts;
  if (!facts) return [];
  const details: string[] = [];
  if (facts.purpose) details.push(({ planning: '理解需求', content: '生成正文', repair: '修正结果', tool: '工具协作', source_summary: '概述授权资料' })[facts.purpose]);
  if (facts.planKind) details.push(({ chat: '直接回复', document: '文档任务', unknown: '需求尚不明确' })[facts.planKind]);
  if (facts.action) details.push(({ answer: '回答问题', create: '创建文档', revise: '修订文档', analyze: '分析资料' })[facts.action]);
  if (facts.documentKind) details.push(({ word: 'Word', excel: 'Excel', ppt: 'PPT' })[facts.documentKind]);
  if (facts.sourcePolicy) details.push(({ none: '无需额外检索', internal: '使用本地资料', web: '请求联网资料，须校验授权', mixed: '使用本地及经授权联网资料' })[facts.sourcePolicy]);
  if (facts.missingCount) details.push(`待补充 ${facts.missingCount} 项信息`);
  if (facts.tool) details.push(toolLabels[facts.tool]);
  if (facts.contentCharacters !== undefined) details.push(`已接收 ${facts.contentCharacters} 字符`);
  if (facts.count !== undefined) details.push(`${facts.count} 项`);
  if (facts.sectionCount !== undefined) details.push(`${facts.sectionCount} 个内容部分`);
  if (facts.pageNumber !== undefined) details.push(`第 ${facts.pageNumber} 页${facts.totalPages !== undefined ? ` / 共 ${facts.totalPages} 页` : ''}`);
  else if (facts.totalPages !== undefined) details.push(`${facts.totalPages} 页`);
  if (facts.bytes !== undefined) details.push(`${facts.bytes} 字节`);
  return details;
}

export function DocumentProgress({ detail, taskProgress = [], preferDetail = false, events = [], request, requestBySource, incomplete, terminalDetail, bodyContent, bodyStreaming = false, developerMode = false }: DocumentProgressProps) {
  const latest = taskProgress.reduce<ConversationTaskProgressSnapshot | undefined>(
    (previous, event) => !previous || event.sequence > previous.sequence ? event : previous,
    undefined
  );
  const completedSteps = taskProgress.filter((event) => event.progressStatus === 'completed');
  const displayEvents = useMemo(() => compactProgressEvents(events), [events]);
  const lastEvent = displayEvents[displayEvents.length - 1]?.event;
  const bodyEventIndex = displayEvents.reduce((found, item, index) =>
    item.event.code === 'model_response' && item.event.facts?.purpose === 'content' ? index : found, -1);
  const summary = terminalDetail ?? (lastEvent ? `${eventTitle(lastEvent)} · ${statusLabels[lastEvent.status]}`
    : latest && !preferDetail ? progressSummary(latest) : detail);
  const preview = useMemo(() => projectDocumentBody(bodyContent ?? ''), [bodyContent]);
  const body = preview.content;
  const bodyPreview = body || preview.truncated ? (
    <section className="uc-chat-generated-body" aria-label="生成正文">
      <div className="uc-chat-generated-body__heading">生成正文</div>
      {bodyStreaming ? <StreamingMarkdown content={body} streaming allowImages={false} /> : <MarkdownMessage content={body} allowImages={false} />}
      {preview.truncated ? <p>正文预览已截断，完整内容请在生成的文档中查看。</p> : null}
    </section>
  ) : null;
  return (
    <section className="uc-chat-document-progress" aria-label="生产进度" data-developer-mode={developerMode ? 'true' : 'false'}>
      <p className="uc-chat-document-progress__summary" role="status" aria-live="polite">
        <span className="uc-chat-document-progress__label">生产进度</span>
        <span>{summary}</span>
      </p>
      {incomplete ? <p className="uc-chat-production-trace__issue" role="status">生产记录不完整，以下仅展示已保存的执行事实。</p> : null}
      {displayEvents.length > 0 ? (
        <ol className="uc-chat-production-trace" aria-label="完整生产链路">
          {displayEvents.map(({ event, key }, displayIndex) => {
            const eventRequest = requestBySource ? requestBySource.get(event.sourceMessageId) : request;
            const eventIndex = events.indexOf(event);
            const prevEvent = eventIndex > 0 ? events[eventIndex - 1] : undefined;
            const durationMs = prevEvent ? Math.max(0, new Date(event.occurredAt).getTime() - new Date(prevEvent.occurredAt).getTime()) : undefined;
            const naturalDetails = eventDetails(event);
            return (
            <li key={key} data-status={event.status} data-event-code={event.code}>
              <div className="uc-chat-production-trace__heading">
                <span className="uc-chat-production-trace__direction">{eventDirection(event)}</span>
                <strong>{eventTitle(event)}</strong>
                <span className="uc-chat-production-trace__status">{statusLabels[event.status]}</span>
                {durationMs !== undefined && developerMode ? (
                  <span className="uc-chat-production-trace__duration" title="与前一步间隔耗时">
                    {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(2)}s`}
                  </span>
                ) : null}
                <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
              </div>
              {event.code === 'request_received' && eventRequest ? <p className="uc-chat-production-trace__request">{eventRequest}</p> : null}
              {naturalDetails.length ? <p className="uc-chat-production-trace__details">{naturalDetails.join(' · ')}</p> : null}
              {developerMode ? (
                <details className="uc-chat-production-trace__devtools">
                  <summary>查看执行事实 (docId / 工具调用)</summary>
                  <dl className="uc-chat-production-trace__facts-grid">
                    <div><dt>docId</dt><dd>{event.conversationId}</dd></div>
                    <div><dt>nodeId</dt><dd>{event.traceId}:{event.sequence}</dd></div>
                    {event.operationId ? <div><dt>operationId</dt><dd>{event.operationId}</dd></div> : null}
                    {event.facts?.tool ? <div><dt>tool</dt><dd>{event.facts.tool}</dd></div> : null}
                    {event.facts ? (
                      <div className="uc-chat-production-trace__facts-raw">
                        <dt>facts</dt>
                        <dd><code>{JSON.stringify(event.facts, null, 2)}</code></dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
              ) : null}
              {displayIndex === bodyEventIndex ? bodyPreview : null}
            </li>
            );
          })}
        </ol>
      ) : completedSteps.length > 0 ? (
        <details className="uc-chat-document-progress__details">
          <summary>查看已完成步骤</summary>
          <ul className="uc-chat-document-progress__step-list">
            {completedSteps.map((step) => <li key={step.sequence}>{progressSummary(step)}</li>)}
          </ul>
        </details>
      ) : null}
      {bodyEventIndex < 0 ? bodyPreview : null}
    </section>
  );
}
