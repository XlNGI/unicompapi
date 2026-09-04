import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_GENERATION_INSTRUCTION,
  buildOutlineFromRequirements,
  composeDocumentRevisionInput,
  documentResponseParameterValues,
  documentKindInstruction,
  extractSectionHeadings,
  inferPresentationTemplate,
  inferDocumentKind,
  resolvePresentationTemplate,
  sha256Hex
} from '../../src/pages/chat/documentDrafting';

describe('document drafting helpers', () => {
  it('infers the document kind from requirements', () => {
    expect(inferDocumentKind('请生成季度销售数据表格')).toBe('excel');
    expect(inferDocumentKind('做一个工作汇报 PPT')).toBe('ppt');
    expect(inferDocumentKind('修改 PPT 中的财务表格数据')).toBe('ppt');
    expect(inferDocumentKind('写一份项目周报')).toBe('word');
  });

  it('builds a deterministic outline from requirements', () => {
    const outline = buildOutlineFromRequirements(
      '项目周报\n完成方案评审\n修复三个缺陷',
      'word'
    );
    expect(outline.kind).toBe('word');
    expect(outline.title).toBe('项目周报');
    expect(outline.sections[0].blocks[0].items).toEqual([
      '完成方案评审',
      '修复三个缺陷'
    ]);
  });

  it('computes a stable SHA-256 fingerprint', async () => {
    const first = await sha256Hex('word:周报');
    const second = await sha256Hex('word:周报');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('composes revision context from the previous document', () => {
    const input = composeDocumentRevisionInput(
      '# 项目周报\n\n- 完成评审',
      '把第二部分改为强调风险'
    );
    expect(input).toContain(DOCUMENT_GENERATION_INSTRUCTION);
    expect(input).toContain('上一版文档内容');
    expect(input).toContain('# 项目周报');
    expect(input).toContain('这是一次局部修改');
    expect(input).toContain('其他内容、顺序、标题和样式保持不变');
    expect(input).toContain('局部修改的语义验收规则');
    expect(input).toContain('面向非技术管理者');
    expect(input).toContain('必须对目标范围做实质性语义改写');
    expect(input).toContain('非目标范围必须逐字保持原内容');
    expect(input).toContain('修改要求');
    expect(input).toContain('强调风险');
    expect(composeDocumentRevisionInput(undefined, '新需求')).toContain(
      DOCUMENT_GENERATION_INSTRUCTION
    );
  });

  it('turns an exact five-page PPT revision into three body sections', () => {
    const input = composeDocumentRevisionInput(
      '{"kind":"ppt","title":"关于龙的PPT","sections":[]}',
      '内容太少了加到5页',
      'ppt'
    );

    expect(input).toContain('PPT 整体页数调整');
    expect(input).toContain('总页数恰好为 5 页');
    expect(input).toContain('sections 必须恰好包含 3 个正文分节');
    expect(input).toContain('1 页封面和 1 页结束页');
    expect(input).not.toContain('这是一次局部修改');
  });

  it('extracts section headings from assistant markdown', () => {
    expect(
      extractSectionHeadings('# 封面\n\n## 本周进展\n\n正文\n\n## 下周计划')
    ).toEqual(['封面', '本周进展', '下周计划']);
    expect(extractSectionHeadings('没有标题的正文')).toEqual(['没有标题的正文']);
  });

  it('returns document-type writing rules', () => {
    const pptInstruction = documentKindInstruction('ppt');
    expect(pptInstruction).toContain('明确结论');
    expect(pptInstruction).toContain('解释');
    expect(pptInstruction).toContain('资料不足');
    expect(pptInstruction).not.toContain('每页最多 3 个要点');
    expect(pptInstruction).toContain('"type":"table"');
    expect(pptInstruction).toContain('"type":"chart"');
    expect(pptInstruction).toContain('必须同时提供 table 和 chart');
    expect(pptInstruction).toContain('pageKind 只能使用以下值');
    expect(pptInstruction).toContain('不要输出 summary、detail、roadmap、risk、action');
    expect(pptInstruction).toContain('封面和结束页由系统统一生成');
    expect(documentKindInstruction('excel')).toContain('列名');
    const wordInstruction = documentKindInstruction('word');
    expect(wordInstruction).toContain('标题层级');
    expect(wordInstruction).toContain('"kind":"word"');
    expect(wordInstruction).toContain('"blocks"');
    expect(wordInstruction).toContain('"header"');
    expect(wordInstruction).toContain('不要使用 content、id、ordered_list、headers 或 subsection');
    expect(DOCUMENT_GENERATION_INSTRUCTION).toContain('kind');
  });

  it('matches a PPT template from explicit style signals with deterministic priority', () => {
    expect(inferPresentationTemplate('制作 AI 融资路演 PPT')).toBe('financing');
    expect(inferPresentationTemplate('制作 AI 技术发布会 PPT')).toBe('technology');
    expect(inferPresentationTemplate('绿色环保主题分享')).toBe('natural_minimal');
    expect(inferPresentationTemplate('极简商务方案')).toBe('business_minimal');
    expect(inferPresentationTemplate('季度工作汇报')).toBe('work_report');
    expect(inferPresentationTemplate('制作校园活动 PPT')).toBe('work_report');
  });

  it('keeps an explicit PPT template above automatic matching', () => {
    expect(resolvePresentationTemplate('natural_minimal', 'AI 融资路演')).toBe(
      'natural_minimal'
    );
    expect(resolvePresentationTemplate('auto', 'AI 融资路演')).toBe('financing');
  });

  it('requests JSON output only from text candidates that declare object response_format', () => {
    expect(
      documentResponseParameterValues({
        parameterSchema: {
          fields: [{ fieldId: 'response_format', valueType: 'object' }]
        }
      })
    ).toEqual({ response_format: { type: 'json_object' } });
    expect(
      documentResponseParameterValues({
        parameterSchema: {
          fields: [{ fieldId: 'response_format', valueType: 'enum' }]
        }
      })
    ).toEqual({});
    expect(
      documentResponseParameterValues({
        parameterSchema: { fields: [] }
      })
    ).toEqual({});
  });

});
