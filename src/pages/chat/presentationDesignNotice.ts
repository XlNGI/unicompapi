import type { ProductionTraceEventDto } from '../../shared/conversation-production-ipc';

/** Last observed design choice wins, so an old fallback never masks a later successful design. */
export function presentationDesignNotice(events: readonly ProductionTraceEventDto[]): string | undefined {
  let path: 'design-aware' | 'legacy-fallback' | undefined;
  let reason: string | undefined;
  for (const event of events) {
    if (event.code === 'request_received') { path = undefined; reason = undefined; }
    if (event.status !== 'completed' || !event.facts?.designPath) continue;
    path = event.facts.designPath; reason = event.facts.fallbackReason;
  }
  if (path !== 'legacy-fallback') return undefined;
  const explanations: Record<string, string> = {
    art_direction_timeout: '自主设计规划超时', art_direction_unavailable: '自主设计规划暂不可用',
    art_direction_invalid: '自主设计方案未通过校验', design_layout_failed: '自主设计未能满足布局要求',
    design_render_failed: '自主设计未通过渲染检查'
  };
  return `${reason && Object.prototype.hasOwnProperty.call(explanations, reason) ? explanations[reason] : '自主设计未能完成'}，已切换为基础模板兜底。`;
}
