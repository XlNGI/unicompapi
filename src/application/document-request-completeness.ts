/** Checks only user-authored requirements; never invents a subject from an output format. */
export function hasDocumentSubject(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  const remainder = text
    .replace(/(?:后续要求（与此前冲突时以此为准）：)/gu, '')
    .replace(/(?:我想要?|我要|我需要|想要?|需要|帮我|给我|麻烦你?|请你?|可以|能不能|可不可以|能否)/gu, '')
    .replace(/(?:制作|生成|创建|新建|导出|输出|做成|做|写|整理成)/gu, '')
    .replace(/(?:powerpoint|pptx?|word|docx?|excel|xlsx?|演示文稿|幻灯片|演示|文档|文件)/giu, '')
    .replace(/(?:\d+|[一二两三四五六七八九十百]+)\s*(?:页|张|份|个|套)/gu, '')
    .replace(/(?:面向|给)(?:管理层|领导|客户|学生|同事)(?:看)?/gu, '')
    .replace(/(?:商务|简洁|简约|科技|正式|专业)(?:风格|风|一点|一些)?/gu, '')
    .replace(/(?:随便|你来安排|你安排|其他你安排|其他你来安排|都行|都可以|继续|好的|好|谢谢|先|只|再|直接|一个|一份|个|份|吧|吗|呢)/gu, '')
    .replace(/[\s的，。！？、：；,.!?;:（）()“”"']/gu, '');
  return remainder.length > 0;
}

export function documentClarificationQuestion(field: string, fallback: string): string {
  if (field === 'document_topic') return '你想做什么主题的 PPT？可以告诉我用途，比如工作汇报、产品介绍或教学，也可以先添加参考资料。';
  if (field === 'document_kind') return '你希望做成 Word 文档、Excel 表格，还是 PPT 演示？';
  if (field === 'document_target') return '你想修改哪一份文档？请告诉我文件名，或先添加这份文档。';
  return `请告诉我${fallback}，我再继续。`;
}
