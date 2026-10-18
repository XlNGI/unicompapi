export function documentClarificationQuestion(field: string, fallback: string): string {
  if (field === 'document_topic') return '你想做什么主题的 PPT？可以告诉我用途，比如工作汇报、产品介绍或教学，也可以先添加参考资料。';
  if (field === 'document_kind') return '你希望做成 Word 文档、Excel 表格，还是 PPT 演示？';
  if (field === 'document_target') return '你想修改哪一份文档？请告诉我文件名，或先添加这份文档。';
  return `请告诉我${fallback}，我再继续。`;
}
