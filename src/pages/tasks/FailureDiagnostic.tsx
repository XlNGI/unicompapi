import { useState } from 'react';
import { Button } from '../../components/Button';
import { ExpandableText } from '../../components/ExpandableText';
import type { StorageCallTimelineEventDto } from '../../shared/storage-ipc';
import { describeGenerationSafeCode } from '../../ui/notifications/generation-failure-reasons';

export function FailureDiagnostic({ event }: { readonly event: StorageCallTimelineEventDto }) {
  const [copyStatus, setCopyStatus] = useState('');
  if (!['failed', 'submission_failed_before_request', 'outcome_unknown'].includes(event.type)) return null;
  const diagnostic = event.failureDiagnostic;
  const reason = describeGenerationSafeCode(event.safeCode);
  const unknown = event.type === 'outcome_unknown';
  const stages: Record<string, string> = {
    before_request: '请求发送前', upstream_response: '上游响应',
    result_receive: '结果接收', local_persist: '本地保存'
  };
  const message = diagnostic?.message ?? reason?.label ?? '本次记录未提供具体失败原因';
  const facts = [
    diagnostic?.stage ? ['发生阶段', stages[diagnostic.stage] ?? '未知阶段'] : undefined,
    diagnostic?.statusCode !== undefined ? ['HTTP 状态码', String(diagnostic.statusCode)] : undefined,
    diagnostic?.code ? ['上游错误码', diagnostic.code] : undefined,
    diagnostic?.requestId ? ['请求 ID', diagnostic.requestId] : undefined,
    event.safeCode ? ['技术代码', event.safeCode] : undefined
  ].filter((fact): fact is string[] => Boolean(fact));
  return <div className={`uc-task-center__timeline-reason uc-task-center__timeline-reason--${unknown ? 'warning' : 'danger'}`}>
    <strong>{unknown ? '结果暂时无法确认' : '失败原因'}</strong>
    <ExpandableText text={message} />
    {unknown ? <p>该错误不能确认远端任务已失败，请勿重复提交。</p> : null}
    {facts.length ? <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
    <Button variant="ghost" size="xs" onClick={async () => {
      try {
        await navigator.clipboard.writeText([message, ...facts.map(([label, value]) => `${label}：${value}`), `时间：${event.occurredAt}`].join('\n'));
        setCopyStatus('已复制');
      } catch { setCopyStatus('复制失败，请选择文字复制'); }
    }}>复制排查信息</Button>
    <span role="status">{copyStatus}</span>
  </div>;
}
