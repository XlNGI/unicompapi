import type { Conversation, ConversationWorkflowV1 } from '../domain';

/** Only persisted workflow facts can produce these replies; no model prose is trusted as progress. */
export function conversationWorkflowReply(workflow: ConversationWorkflowV1, conversation: Conversation): string | undefined {
  if (workflow.status === 'needs_clarification') {
    return workflow.pendingQuestions.slice(0, 2).map((item) => item.question).join('\n\n') ||
      '你希望我帮你完成什么？可以直接描述主题和用途，也可以添加参考资料。';
  }
  if (workflow.status === 'needs_confirmation') {
    const selection = workflow.resolvedTarget?.presentation;
    const document = conversation.messages.find((message) => message.id === workflow.resolvedTarget?.artifactRef)?.documentResult;
    const target = workflow.plan.targetHint;
    const details = [workflow.plan.action === 'revise' ? '我将按你的要求生成修改后的新版本。' : '我已整理好本次任务计划。'];
    if (document) details.push(`文件：${document.fileName}`);
    if (selection) {
      details.push(`目标：第 ${selection.ordinal} ${selection.unit === 'page' ? '页' : '章'}，${selection.heading}。实际页码：第 ${selection.pages.join('、')} 页（含封面与隐藏页）。`);
    } else if (target?.ordinal !== undefined) {
      details.push(`目标：第 ${target.ordinal} ${target.unit === 'page' ? '页' : target.unit === 'section' ? '章' : '项'}。`);
    } else if (target?.name) details.push(`目标：${target.name}`);
    const requirements = workflow.plan.parameters.requirements;
    if (typeof requirements === 'string') details.push(`操作要求：${requirements.slice(-1_000)}`);
    if (workflow.plan.action === 'revise') details.push('成功后交付新版文件，原作品保留。');
    details.push('请回复“确认执行”继续，或告诉我需要调整的地方。联网和付费配图需要分别授权。');
    return details.join('\n\n');
  }
  if (workflow.status === 'cancelled') return '当前任务已取消，已保存的作品会保留。你可以直接告诉我新的需求。';
  return undefined;
}
