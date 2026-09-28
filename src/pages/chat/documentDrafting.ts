import type { PresentationTemplateId } from '../../shared/document-generation-ipc';
import {
  isSupportedPresentationTotalPages,
  parseRequestedPresentationTotalPages,
  presentationBodySectionCount
} from '../../application/presentation-page-count';
import {
  buildDocumentOutlinePrompt,
  type OutlineDocumentKind
} from '../../shared/document-outline-contract';

export type PresentationTemplateSelection = 'auto' | PresentationTemplateId;

export const DOCUMENT_GENERATION_INSTRUCTION =
  '请直接输出文档正文（优先按 Outline Contract 输出严格 JSON 大纲，无法结构化时使用 Markdown），不要寒暄、不要解释、不要任何前后缀。JSON 大纲必须包含 kind、title、sections、heading、level、blocks 字段。内容必须基于用户提供的附件与资料撰写，优先引用资料中的事实、数据和结论，不得编造；资料不足以支撑的部分要明确省略或说明。';

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
  if (/龙|神话|文化|历史|传统|文物|博物馆|非遗|民俗|节庆|自然|清新|绿色|环保|健康|教育|生活方式/.test(text)) {
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
  requirements: string,
  kind?: 'word' | 'excel' | 'ppt'
): string {
  const requestedTotalPages =
    kind === 'ppt'
      ? parseRequestedPresentationTotalPages(requirements)
      : undefined;
  const pageCountConstraint =
    requestedTotalPages !== undefined &&
    isSupportedPresentationTotalPages(requestedTotalPages)
      ? `\n\nPPT 总页数硬性约束：\n- 用户要求总页数恰好为 ${requestedTotalPages} 页，包含系统另行生成的 1 页封面和 1 页结束页。\n- sections 必须恰好包含 ${presentationBodySectionCount(requestedTotalPages)} 个正文分节，不得输出封面、结束页或致谢 section。\n- 每个 section 必须控制为 1 页：正文最多 4 个内容组，takeaway 和 action 各不超过 90 字；表格最多 5 列、7 行。不要用重复页或碎片页凑页数。`
      : '';
  const isFullPresentationRevision =
    previousContent !== undefined &&
    requestedTotalPages !== undefined &&
    isSupportedPresentationTotalPages(requestedTotalPages);
  const autonomousPresentationDesign =
    kind === 'ppt' && /自主设计|重新设计|重做版式|重新排版|摆脱模板|不要模板|视觉重构|版式重构/u.test(requirements)
      ? '\n\n这是一次 PPT 视觉重构请求：保留事实、数字和语义内容，重新规划每页构图。必须为 coverScene、closingScene 和每个正文 section 输出独立 scene，允许改变页面结构、留白、对齐和视觉层级；不要沿用旧版模板或旧页面骨架。'
      : '';
  const body =
    previousContent && previousContent.trim().length > 0
      ? isFullPresentationRevision
        ? `上一版文档内容：\n${previousContent}\n\n这是一次用户明确授权的 PPT 整体页数调整：可以重组正文分节以达到总页数要求，但必须保留上一版中有依据的事实、数字和结论，不得编造数据；标题保持不变。输出完整文档大纲，以便生成新版文件。\n\n修改要求：\n${requirements}`
        : `上一版文档内容：\n${previousContent}\n\n这是一次局部修改：只修改用户明确指出的页面、分节、表格、图表或单元格，其他内容、顺序、标题和样式保持不变。输出时仍需返回完整文档大纲，以便生成新版文件。\n\n局部修改的语义验收规则：\n- 如果用户指定了受众（例如“面向非技术管理者”），必须对目标范围做实质性语义改写，而不是只改标题、同义替换或重新排版。\n- 面向非技术管理者时，优先使用业务目标、经营影响、决策依据、风险和下一步行动来表达；首次出现的技术术语要用一句白话解释，删除不影响决策的 API、模型、协议和实现细节。\n- 保留上一版中有依据的事实、数字和结论；不得为了改写而编造数据。目标范围至少应有一处完整句式、解释或行动建议发生变化，且要能看出受众变化。\n- 非目标范围必须逐字保持原内容、顺序、标题、页面类型和数据不变。\n\n修改要求：\n${requirements}`
      : requirements;
  return `${DOCUMENT_GENERATION_INSTRUCTION}\n\n${body}${pageCountConstraint}${autonomousPresentationDesign}`;
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

export function documentKindInstruction(kind: OutlineDocumentKind): string {
  if (kind === 'ppt') {
    return [
      '这是 PPT 文档：每页表达一个明确结论，并用 3 至 5 个内容组支撑。每个内容组必须包含短标题和解释文字；不要用只有几个词的空泛要点。用户明确要求总页数时，必须服从前文的精确页数与单页容量约束。',
      '封面和结束页由系统统一生成；sections 只填写正文内容。不要把“封面”“谢谢”“谢谢观看”“感谢观看”作为正文 section，也不要把表格或图表挂在致谢页下。用户明确要求页数时，按总页数预算组织内容，避免通过重复页或碎片页凑页数。',
      '页面的构图、留白、信息层级和视觉节奏由你自主设计，不要套用固定模板。text 元素的 content 必须来自同一页的标题、takeaway、action 或 blocks 原文；用 shape 和 line 组织视觉层级，不要把所有内容排成相同的卡片网格。',
      buildDocumentOutlinePrompt('ppt'),
      '只在资料中有足够数据时输出 table 或 chart；需要比较数值时必须同时提供 table 和 chart；没有可靠数据时不要编造。资料不足时写明建议、假设或待确认项，不能虚构业绩、客户、预算或收益。'
    ].join('\n');
  }
  if (kind === 'excel') {
    return [
      '这是 Excel 表格：以清晰的列名与数据行为主，避免大段文字，需要汇总时给出合计行。',
      buildDocumentOutlinePrompt('excel'),
      '用户没有提供真实数据时，生成可直接填写的通用模板；数值字段必须留空或输出纯数字，不能虚构真实员工、金额或经营数据。'
    ].join('\n');
  }
  return [
    '这是 Word 文档：标题层级清晰，段落完整，关键数据用表格呈现。',
    buildDocumentOutlinePrompt('word'),
    '只有无法结构化时才使用 Markdown 标题、段落、列表和标准管线表格。'
  ].join('\n');
}
