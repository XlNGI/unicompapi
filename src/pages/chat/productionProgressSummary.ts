import type { ProductionTraceEventDto } from '../../shared/conversation-production-ipc';

type Phase = 'prepare' | 'sources' | 'content' | 'compose' | 'verify';
type PhaseStatus = 'progress' | 'completed' | 'failed' | 'cancelled' | 'ended' | 'recorded';
type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ProductionProgressPhase {
  readonly phase: Phase;
  readonly title: string;
  readonly status: PhaseStatus;
  readonly detail: string;
  readonly metric?: string;
}

export function productionProgressAction(item: ProductionProgressPhase): string {
  const actions: Record<Phase, string> = {
    prepare: '检查任务与执行条件', sources: '整理参考资料', content: '接收生成内容',
    compose: '制作文档', verify: item.title === '检查文件' ? '检查文件' : '检查并保存文件'
  };
  const action = actions[item.phase];
  switch (item.status) {
    case 'completed': return `已${action}`;
    case 'progress': return `正在${action}`;
    case 'failed': return `${action}未完成`;
    case 'cancelled': return `${action}已停止`;
    case 'ended': return `${action}已结束`;
    case 'recorded': return `${action}已有执行记录`;
  }
}

/** Use recorded start/end timestamps; missing or truncated history cannot establish elapsed time. */
export function productionProgressDuration(
  events: readonly ProductionTraceEventDto[], terminalStatus?: TerminalStatus, incomplete = false
): string | undefined {
  const first = events[0], last = events.at(-1);
  if (incomplete || !first || !last || first.code !== 'request_received' ||
      (!terminalStatus && (last.code !== 'task_complete' || !['completed', 'failed', 'cancelled'].includes(last.status)))) return undefined;
  const elapsed = Date.parse(last.occurredAt) - Date.parse(first.occurredAt);
  if (!Number.isFinite(elapsed) || elapsed < 1000) return undefined;
  const seconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60, remainder = seconds % 60;
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${remainder || !minutes && !hours ? `${remainder}秒` : ''}`;
}

const titles: Record<Phase, string> = {
  prepare: '准备任务', sources: '整理参考资料', content: '生成内容', compose: '制作文档', verify: '检查与保存'
};
const descriptions: Record<Phase, string> = {
  prepare: '需求理解与执行条件检查', sources: '处理已授权的参考资料', content: '接收与整理生成内容',
  compose: '本地文件生成与预览渲染', verify: '文件质量与保存状态检查'
};

function eventPhase(event: ProductionTraceEventDto): Phase | undefined {
  switch (event.code) {
    case 'document_compile': case 'document_render': return 'compose';
    case 'document_check': case 'document_structure_check': case 'document_hash_check':
    case 'document_publish': case 'document_register': return 'verify';
    case 'source_context': return 'sources';
    case 'task_complete': return undefined;
  }
  switch (event.facts?.tool) {
    case 'read_sources': case 'search': case 'analyze': return 'sources';
    case 'write_document': case 'render': case 'patch': return 'compose';
    case 'check': case 'publish': return 'verify';
  }
  switch (event.facts?.purpose) {
    case 'source_summary': return 'sources';
    case 'content': case 'repair': case 'tool': return 'content';
    case 'planning': return 'prepare';
  }
  return event.code === 'model_request' || event.code === 'model_response' ? 'content' : 'prepare';
}

/** A display projection only: it never changes persisted events or infers unobserved stages. */
export function summarizeProductionProgress(
  events: readonly ProductionTraceEventDto[], terminalStatus?: TerminalStatus
): readonly ProductionProgressPhase[] {
  const groups = new Map<Phase, { event: ProductionTraceEventDto; characters?: number; pages?: number; saving: boolean }>();
  let lastPhase: Phase | undefined;
  let traceTerminal: TerminalStatus | undefined;
  for (const event of events) {
    if (event.code === 'request_received') traceTerminal = undefined;
    if (event.code === 'task_complete') {
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') traceTerminal = event.status;
      continue;
    }
    const observedPhase = eventPhase(event);
    if (!observedPhase) continue;
    // Successful permission/format checks cannot finish the model or tool they guard.
    const guard = event.code === 'tool_authorization' || event.code === 'plan_validation';
    const phase = guard && event.status === 'completed' && !groups.has(observedPhase) ? 'prepare' : observedPhase;
    const previous = groups.get(phase);
    const retainActivity = previous && guard && event.status === 'completed';
    groups.set(phase, {
      event: retainActivity ? previous.event : event,
      characters: event.facts?.contentCharacters ?? previous?.characters,
      pages: event.facts?.totalPages ?? previous?.pages,
      saving: previous?.saving === true || event.code === 'document_publish' || event.code === 'document_register' || event.facts?.tool === 'publish'
    });
    if (!retainActivity) lastPhase = phase;
  }
  const terminal = terminalStatus ?? traceTerminal;
  return [...groups].map(([phase, { event, characters, pages, saving }]) => {
    // Sending a request is not the same as receiving its completed response.
    let status: PhaseStatus = event.status === 'started' || event.status === 'progress' ||
      (event.code === 'model_request' && event.status === 'completed') ? 'progress' : event.status;
    if (status === 'progress') {
      status = terminal ? terminal === 'cancelled' ? 'cancelled' : 'ended' : phase === lastPhase ? 'progress' : 'recorded';
    }
    // A terminal failure belongs to the last observed activity, unless that activity already succeeded.
    if (phase === lastPhase && status !== 'completed' && terminal === 'failed') status = 'failed';
    const facts: string[] = [];
    if (phase === 'content' && characters !== undefined && characters > 0) facts.push(`已接收 ${characters.toLocaleString('zh-CN')} 字符`);
    if ((phase === 'compose' || phase === 'verify') && pages !== undefined && pages > 0) facts.push(`${pages} 页`);
    const metric = facts.length ? facts.join(' · ') : undefined;
    return { phase, title: phase === 'verify' && !saving ? '检查文件' : titles[phase], status,
      detail: metric ?? descriptions[phase], metric };
  });
}
