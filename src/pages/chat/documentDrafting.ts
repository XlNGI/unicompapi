export type DocumentKindOption = 'auto' | 'word' | 'excel' | 'ppt';

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
      '这是 PPT 文档：一页只讲一个观点，每页最多 3 个要点、每个要点不超过 15 个字，观点先行，禁止大段文字。',
      '优先只输出一个 JSON 对象，不要 Markdown 代码围栏或解释，格式为：',
      '{"kind":"ppt","title":"标题","sections":[{"heading":"分节标题","level":1,"blocks":[{"type":"bullets","items":["要点"]},{"type":"table","header":["列名"],"rows":[["数据"]]},{"type":"chart","chartKind":"bar","title":"图表标题","data":[{"label":"分类","value":1}]}]}]}。',
      '只在资料中有足够数据时输出 table 或 chart；需要比较数值时必须同时提供 table 和 chart，chartKind 使用 bar 或 pie，value 必须是数字。没有可靠数据时不要编造。',
      '如果无法输出 JSON，才使用 Markdown 标题、短要点和标准管线表格。'
    ].join('\n');
  }
  if (kind === 'excel') {
    return '这是 Excel 表格：以清晰的列名与数据行为主，避免大段文字，需要汇总时给出合计行。';
  }
  return [
    '这是 Word 文档：标题层级清晰，段落完整，关键数据用表格呈现。',
    '优先只输出一个 JSON 对象，不要 Markdown 代码围栏或解释，格式为：',
    '{"kind":"word","title":"标题","sections":[{"heading":"分节标题","level":1,"blocks":[{"type":"paragraph","text":"正文"},{"type":"numbered","items":["步骤"]},{"type":"table","header":["列名"],"rows":[["数据"]]}]}]}。',
    '不要使用 content、id、ordered_list、headers 或 subsection；只有无法结构化时才使用 Markdown 标题、段落、列表和标准管线表格。'
  ].join('\n');
}

export interface DocumentIntent {
  readonly kind: 'document' | 'chat';
  readonly documentKind?: 'word' | 'excel' | 'ppt';
  readonly missing: readonly string[];
}

const documentActionPattern = /(做|生成|制作|创建|写|出一份|帮我)/;
const typePatterns: readonly {
  readonly kind: 'word' | 'excel' | 'ppt';
  readonly pattern: RegExp;
}[] = [
  {
    kind: 'ppt',
    pattern: /(ppt|pptx|幻灯片|演示|汇报|宣讲|课件|路演|答辩)/
  },
  {
    kind: 'excel',
    pattern: /(excel|xlsx|表格|数据表|台账|清单|统计表)/
  },
  {
    kind: 'word',
    pattern: /(word|docx|文档|周报|总结|纪要|方案|报告|简历|计划|说明|介绍)/
  }
];
const audiencePattern = /(领导|老板|客户|同事|团队|学生|管理层|董事会|甲方)/;
const contentPattern = /(包含|包括|涉及|需要|要求|要有|重点|内容|数据)/;

export function detectDocumentIntent(text: string): DocumentIntent {
  const matched = typePatterns.find((item) => item.pattern.test(text));
  if (!matched || !documentActionPattern.test(text)) {
    return { kind: 'chat', missing: [] };
  }
  const missing: string[] = [];
  if (!audiencePattern.test(text) && !contentPattern.test(text)) {
    missing.push('受众或需要包含的内容点');
  }
  return {
    kind: 'document',
    documentKind: matched.kind,
    missing
  };
}
