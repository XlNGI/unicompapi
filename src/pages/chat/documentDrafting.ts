import type { PresentationTemplateId } from '../../shared/document-generation-ipc';

export type DocumentKindOption = 'auto' | 'word' | 'excel' | 'ppt';
export type PresentationTemplateSelection = 'auto' | PresentationTemplateId;

export const DOCUMENT_GENERATION_INSTRUCTION =
  '请直接输出文档正文（优先按文档类型规则输出严格 JSON 大纲，无法结构化时使用 Markdown），不要寒暄、不要解释、不要任何前后缀。JSON 大纲必须使用 kind、title、sections、heading、level、blocks 字段；正文块只能使用 paragraph、bullets、numbered、quote、table、chart 及其规范字段，不要使用 content、id、ordered_list、headers 或 subsection。内容必须基于用户提供的附件与资料撰写，优先引用资料中的事实、数据和结论，不得编造；资料不足以支撑的部分要明确省略或说明。';

export function inferDocumentKind(requirements: string): 'word' | 'excel' | 'ppt' {
  const text = requirements.toLowerCase();
  if (/汇报|演示|ppt|pptx|幻灯片|课件|路演|宣讲/.test(text)) {
    return 'ppt';
  }
  if (/表格|数据|统计|excel|xlsx|sheet|清单|台账/.test(text)) {
    return 'excel';
  }
  return 'word';
}

export function inferPresentationTemplate(
  requirements: string
): PresentationTemplateId {
  const text = requirements.toLowerCase();
  if (/融资|路演|投资人|商业计划|\bbp\b|\bpitch\b/.test(text)) {
    return 'financing';
  }
  if (/科技|\bai\b|人工智能|数字化|互联网|未来感|深色/.test(text)) {
    return 'technology';
  }
  if (/自然|清新|绿色|环保|健康|教育|生活方式/.test(text)) {
    return 'natural_minimal';
  }
  if (/极简|简约|黑白|高端|专业|商务/.test(text)) {
    return 'business_minimal';
  }
  if (/工作汇报|周报|月报|季报|总结|复盘|项目进展/.test(text)) {
    return 'work_report';
  }
  return 'work_report';
}

export function resolvePresentationTemplate(
  selection: PresentationTemplateSelection,
  requirements: string
): PresentationTemplateId {
  return selection === 'auto'
    ? inferPresentationTemplate(requirements)
    : selection;
}

export function documentResponseParameterValues(candidate: {
  readonly parameterSchema: {
    readonly fields: readonly {
      readonly fieldId: string;
      readonly valueType: string;
    }[];
  };
}): Readonly<Record<string, { readonly type: 'json_object' }>> {
  const supportsJsonObject = candidate.parameterSchema.fields.some(
    (field) =>
      field.fieldId === 'response_format' && field.valueType === 'object'
  );
  return supportsJsonObject
    ? { response_format: { type: 'json_object' } }
    : {};
}

export function buildOutlineFromRequirements(
  requirements: string,
  kind: 'word' | 'excel' | 'ppt',
  title?: string
): {
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly title: string;
  readonly sections: readonly {
    readonly heading: string;
    readonly level: 1;
    readonly blocks: readonly { readonly type: 'bullets'; readonly items: readonly string[] }[];
  }[];
} {
  const lines = requirements
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const resolvedTitle = (title ?? lines[0] ?? '文档').slice(0, 40);
  const body = lines.length > 1 ? lines.slice(1) : lines;
  return {
    kind,
    title: resolvedTitle,
    sections: [
      {
        heading: '内容',
        level: 1,
        blocks: [{ type: 'bullets', items: body.slice(0, 100) }]
      }
    ]
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function composeDocumentRevisionInput(
  previousContent: string | undefined,
  requirements: string
): string {
  const body =
    previousContent && previousContent.trim().length > 0
      ? `上一版文档内容：\n${previousContent}\n\n这是一次局部修改：只修改用户明确指出的页面、分节、表格、图表或单元格，其他内容、顺序、标题和样式保持不变。输出时仍需返回完整文档大纲，以便生成新版文件。\n\n修改要求：\n${requirements}`
      : requirements;
  return `${DOCUMENT_GENERATION_INSTRUCTION}\n\n${body}`;
}

export function extractSectionHeadings(
  markdown: string,
  limit = 6
): readonly string[] {
  const headings: string[] = [];
  const regex = /^#{1,3}\s+(.+)$/gm;
  let match = regex.exec(markdown);
  while (match && headings.length < limit) {
    const text = match[1].trim();
    if (text) headings.push(text.slice(0, 60));
    match = regex.exec(markdown);
  }
  if (headings.length === 0) {
    const firstLine = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) headings.push(firstLine.slice(0, 60));
  }
  return headings;
}

export function documentKindInstruction(
  kind: 'word' | 'excel' | 'ppt'
): string {
  if (kind === 'ppt') {
    return [
      '这是 PPT 文档：每页表达一个明确结论，并用 3 至 5 个内容组支撑。每个内容组必须包含短标题和解释文字；不要用只有几个词的空泛要点。',
      '优先只输出一个 JSON 对象，不要 Markdown 代码围栏或解释，格式为：',
      '{"kind":"ppt","title":"标题","sections":[{"heading":"分节标题","level":1,"pageKind":"insight","takeaway":"明确结论","action":"下一步行动","blocks":[{"type":"bullets","items":["短标题：解释文字"]},{"type":"table","header":["列名"],"rows":[["数据"]]},{"type":"chart","chartKind":"bar","title":"图表标题","data":[{"label":"分类","value":1}]}]}]}。',
      '只在资料中有足够数据时输出 table 或 chart；需要比较数值时必须同时提供 table 和 chart，chartKind 使用 bar 或 pie，value 必须是数字。没有可靠数据时不要编造。资料不足时写明建议、假设或待确认项，不能虚构业绩、客户、预算或收益。',
      '如果无法输出 JSON，才使用 Markdown 标题、带解释的完整要点和标准管线表格。'
    ].join('\n');
  }
  if (kind === 'excel') {
    return [
      '这是 Excel 表格：以清晰的列名与数据行为主，避免大段文字，需要汇总时给出合计行。',
      '优先只输出一个 JSON 对象，不要 Markdown 代码围栏或解释，格式为：',
      '{"kind":"excel","title":"表格标题","sections":[{"heading":"工作表名称","level":1,"blocks":[{"type":"table","header":["姓名","部门","状态"],"rows":[["示例姓名","示例部门","待确认"]]}]}]}。',
      '用户没有提供真实数据时，生成可直接填写的通用模板；示例值必须明确是示例或待确认，不能虚构真实员工、金额或经营数据。不要使用 columns、data、headers 或 content 字段。'
    ].join('\n');
  }
  return [
    '这是 Word 文档：标题层级清晰，段落完整，关键数据用表格呈现。',
    '优先只输出一个 JSON 对象，不要 Markdown 代码围栏或解释，格式为：',
    '{"kind":"word","title":"标题","sections":[{"heading":"分节标题","level":1,"blocks":[{"type":"paragraph","text":"正文"},{"type":"numbered","items":["步骤"]},{"type":"table","header":["列名"],"rows":[["数据"]]}]}]}。',
    '不要使用 content、id、ordered_list、headers 或 subsection；只有无法结构化时才使用 Markdown 标题、段落、列表和标准管线表格。'
  ].join('\n');
}
