/** Stable keys keep persisted clarification state independent of translated copy. */
const labels: Readonly<Record<string, string>> = {
  document_topic: 'PPT 的主题或具体内容',
  document_kind: '文档类型（Word、Excel 或 PPT）',
  single_deliverable: '当前先完成哪一种文档',
  document_target: '要修改的文档',
  multiple_document_targets: '当前会话中有多份候选文档',
  multiple_deliverable_kinds: '请明确当前先完成的文档类型',
  page_count: '页数',
  audience: '受众',
  style: '风格',
  intent_operation: '希望咨询问题，还是创建或修改文档',
  create_instruction: '希望创建的文档和内容',
  empty_input: '具体需求',
  single_copy_per_kind: '当前每个任务支持每种格式各一份文档，请指定这次先做哪一份',
  single_revision_target: '当前修订需要逐份确认，请指定这次先修改的文档',
  semantic_operation: '希望交付什么结果，以及需要创建还是修改文件'
};

const legacyKeys: Readonly<Record<string, string>> = {
  '文档类型（Word、Excel 或 PPT）': 'document_kind',
  '单一交付类型': 'single_deliverable',
  '要修改的文档': 'document_target',
  '当前会话中有多份候选文档': 'multiple_document_targets',
  '页数': 'page_count',
  '受众': 'audience',
  '风格': 'style'
};

export function conversationClarificationKey(reason: string): string {
  if (reason.startsWith('同时识别到 ')) return 'multiple_deliverable_kinds';
  if (reason.startsWith('可修改的上一版 ')) return 'document_target';
  return legacyKeys[reason] ?? reason;
}

export function conversationClarificationLabel(reason: string): string {
  return labels[conversationClarificationKey(reason)] ?? reason;
}
