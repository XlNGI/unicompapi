export type DocumentKindOption = 'auto' | 'word' | 'excel' | 'ppt';

export const DOCUMENT_GENERATION_INSTRUCTION =
  '请直接输出文档正文（Markdown 格式），不要寒暄、不要解释、不要任何前后缀，直接从文档标题开始。内容必须基于用户提供的附件与资料撰写，优先引用资料中的事实、数据和结论，不得编造；资料不足以支撑的部分要明确省略或说明。';

export function inferDocumentKind(requirements: string): 'word' | 'excel' | 'ppt' {
  const text = requirements.toLowerCase();
  if (/表格|数据|统计|excel|xlsx|sheet|清单|台账/.test(text)) {
    return 'excel';
  }
  if (/汇报|演示|ppt|pptx|幻灯片|课件|路演|宣讲/.test(text)) {
    return 'ppt';
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
      ? `上一版文档内容：\n${previousContent}\n\n修改要求：\n${requirements}`
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
