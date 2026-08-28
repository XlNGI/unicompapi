import { describe, expect, it } from 'vitest';
import {
  DocumentOutlineError,
  isDocumentOutline,
  parseDocumentContent,
  parseDocumentOutline,
  parseMarkdownToOutline,
  recoverPresentationContent,
  stripPreamble,
  unwrapJsonFence
} from '../../src/platform';

function validOutline() {
  return JSON.stringify({
    kind: 'ppt',
    title: '季度销售复盘',
    sections: [
      {
        heading: '业绩概览',
        level: 1,
        blocks: [
          { type: 'bullets', items: ['营收 1200 万', '同比增长 18%'] },
          {
            type: 'table',
            header: ['目标', '负责团队'],
            rows: [['3000 万', '华东']]
          }
        ]
      },
      {
        heading: '下季度计划',
        level: 2,
        blocks: [{ type: 'paragraph', text: '聚焦重点市场。' }]
      }
    ]
  });
}

describe('document outline parser', () => {
  it('parses a valid outline', () => {
    const outline = parseDocumentOutline(validOutline());
    expect(outline.kind).toBe('ppt');
    expect(outline.title).toBe('季度销售复盘');
    expect(outline.sections).toHaveLength(2);
    expect(outline.sections[0].blocks[0]).toEqual({
      type: 'bullets',
      items: ['营收 1200 万', '同比增长 18%']
    });
    expect(isDocumentOutline(outline)).toBe(true);
  });

  it('keeps PPT page semantics for layout planning', () => {
    const value = JSON.parse(validOutline());
    value.sections[0].pageKind = 'insight';
    value.sections[0].takeaway = '本季度增长主要来自重点行业客户。';
    value.sections[0].action = '下季度优先复制高转化行业方案。';

    expect(parseDocumentOutline(JSON.stringify(value)).sections[0]).toMatchObject({
      pageKind: 'insight',
      takeaway: '本季度增长主要来自重点行业客户。',
      action: '下季度优先复制高转化行业方案。'
    });
  });

  it('accepts normal long PPT text for layout-time wrapping and pagination', () => {
    const longTitle = JSON.parse(validOutline());
    longTitle.title = '人工智能智能体从对话到行动的企业级能力革命';

    const longHeading = JSON.parse(validOutline());
    longHeading.sections[0].heading = '智能体正在从辅助问答工具升级为企业数字执行者';

    const longTakeaway = JSON.parse(validOutline());
    longTakeaway.sections[0].takeaway =
      '企业需要的已经不只是回答问题的模型，而是能够理解目标、调用工具并交付结果的数字执行者。';

    const longAction = JSON.parse(validOutline());
    longAction.sections[0].action =
      '选择一个高频、规则明确、结果可度量的业务场景启动试点，并在四周内评估效率和质量。';

    expect(parseDocumentOutline(JSON.stringify(longTitle)).title).toBe(
      longTitle.title
    );
    expect(parseDocumentOutline(JSON.stringify(longHeading)).sections[0].heading)
      .toBe(longHeading.sections[0].heading);
    expect(parseDocumentOutline(JSON.stringify(longTakeaway)).sections[0].takeaway)
      .toBe(longTakeaway.sections[0].takeaway);
    expect(parseDocumentOutline(JSON.stringify(longAction)).sections[0].action)
      .toBe(longAction.sections[0].action);
  });

  it('keeps a long Markdown PPT title for the layout layer', () => {
    const title = '人工智能智能体从对话到行动的企业级能力革命';
    expect(parseDocumentContent(`# ${title}\n\n## 结论\n\n- 要点`, 'ppt').title)
      .toBe(title);
  });

  it('recovers useful PPT content from malformed JSON without another model call', () => {
    const malformed = [
      '{',
      '  "kind": "ppt",',
      '  "title": "人工智能智能体从对话到行动的革命"',
      '  "sections": [',
      '    {',
      '      "heading": "智能体正在改变企业软件的使用方式",',
      '      "takeaway": "企业需要的已经不只是回答问题的模型，而是能够理解目标、调用工具并交付结果的数字执行者。",',
      '      "blocks": [{"type":"bullets","items":[',
      '        "能力变化：从单轮问答升级为多步骤任务执行。",',
      '        "业务变化：从提供建议升级为直接推动流程完成。",',
      '        "组织变化：人负责目标和判断，智能体负责重复执行。"',
      '      ]}],',
      '      "action": "选择一个高频、规则明确、结果可度量的业务场景启动试点。"',
      '    }',
      '  ]',
      '}'
    ].join('\n');

    const recovered = recoverPresentationContent(malformed);
    expect(recovered.title).toBe('人工智能智能体从对话到行动的革命');
    expect(recovered.sections[0]).toMatchObject({
      heading: '智能体正在改变企业软件的使用方式',
      takeaway:
        '企业需要的已经不只是回答问题的模型，而是能够理解目标、调用工具并交付结果的数字执行者。',
      action: '选择一个高频、规则明确、结果可度量的业务场景启动试点。'
    });
    expect(recovered.sections[0].blocks).toContainEqual({
      type: 'bullets',
      items: [
        '能力变化：从单轮问答升级为多步骤任务执行。',
        '业务变化：从提供建议升级为直接推动流程完成。',
        '组织变化：人负责目标和判断，智能体负责重复执行。'
      ]
    });
  });

  it('rejects an unsupported PPT page kind', () => {
    const value = JSON.parse(validOutline());
    value.sections[0].pageKind = 'graphic';

    expect(() => parseDocumentOutline(JSON.stringify(value))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects PPT outlines that exceed the total text budget', () => {
    const value = JSON.parse(validOutline());
    value.sections = [
      {
        heading: '详细说明',
        level: 1,
        blocks: Array.from({ length: 30 }, () => ({
          type: 'paragraph',
          text: '内容'.repeat(1000)
        }))
      }
    ];

    expect(() => parseDocumentOutline(JSON.stringify(value))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects PPT outlines that exceed the content-group budget', () => {
    const value = JSON.parse(validOutline());
    value.sections = [
      {
        heading: '内容分组',
        level: 1,
        blocks: Array.from({ length: 81 }, (_, index) => ({
          type: 'paragraph',
          text: `第 ${index + 1} 组说明`
        }))
      }
    ];

    expect(() => parseDocumentOutline(JSON.stringify(value))).toThrow(
      DocumentOutlineError
    );
  });

  it('counts every list item toward the PPT content-group budget', () => {
    const value = JSON.parse(validOutline());
    value.sections = [
      {
        heading: '内容分组',
        level: 1,
        blocks: [
          {
            type: 'bullets',
            items: Array.from({ length: 50 }, (_, index) => `第一组 ${index + 1}`)
          },
          {
            type: 'numbered',
            items: Array.from({ length: 31 }, (_, index) => `第二组 ${index + 1}`)
          }
        ]
      }
    ];

    expect(() => parseDocumentOutline(JSON.stringify(value))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects PPT outlines that exceed the estimated page budget', () => {
    const value = JSON.parse(validOutline());
    value.sections = Array.from({ length: 41 }, (_, index) => ({
      heading: `第 ${index + 1} 页主题`,
      level: 1,
      blocks: [{ type: 'paragraph', text: '用于验证页面预算。' }]
    }));

    expect(() => parseDocumentOutline(JSON.stringify(value))).toThrow(
      DocumentOutlineError
    );
  });

  it('applies the PPT page budget to Markdown fallback content', () => {
    const markdown = [
      '# 项目方案',
      ...Array.from(
        { length: 41 },
        (_, index) => `## 第 ${index + 1} 个主题\n\n说明内容。`
      )
    ].join('\n\n');

    expect(() => parseMarkdownToOutline(markdown, 'ppt')).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => parseDocumentOutline('{bad json')).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects unsupported kind', () => {
    const value = JSON.parse(validOutline());
    value.kind = 'pdf';
    expect(() => parseDocumentOutline(JSON.stringify(value))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects missing title and oversized sections', () => {
    const noTitle = JSON.parse(validOutline());
    noTitle.title = ' ';
    expect(() => parseDocumentOutline(JSON.stringify(noTitle))).toThrow(
      DocumentOutlineError
    );
    const oversized = JSON.parse(validOutline());
    oversized.sections = Array.from({ length: 101 }, () => ({
      heading: '节',
      level: 1,
      blocks: []
    }));
    expect(() => parseDocumentOutline(JSON.stringify(oversized))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects invalid blocks and table shapes', () => {
    const badBlock = JSON.parse(validOutline());
    badBlock.sections[0].blocks.push({ type: 'image', src: 'x' });
    expect(() => parseDocumentOutline(JSON.stringify(badBlock))).toThrow(
      DocumentOutlineError
    );
    const badTable = JSON.parse(validOutline());
    badTable.sections[0].blocks[1].rows = [[1, 2]];
    expect(() => parseDocumentOutline(JSON.stringify(badTable))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects table rows whose column count differs from the header', () => {
    const missingCell = JSON.parse(validOutline());
    missingCell.sections[0].blocks[1].rows = [['only-one-cell']];
    expect(() => parseDocumentOutline(JSON.stringify(missingCell))).toThrow(
      DocumentOutlineError
    );

    const extraCell = JSON.parse(validOutline());
    extraCell.sections[0].blocks[1].rows = [
      ['first-cell', 'second-cell', 'silent-extra-cell']
    ];
    expect(() => parseDocumentOutline(JSON.stringify(extraCell))).toThrow(
      DocumentOutlineError
    );
  });

  it('rejects out-of-range levels and oversized items', () => {
    const badLevel = JSON.parse(validOutline());
    badLevel.sections[0].level = 4;
    expect(() => parseDocumentOutline(JSON.stringify(badLevel))).toThrow(
      DocumentOutlineError
    );
    const badItems = JSON.parse(validOutline());
    badItems.sections[0].blocks[0].items = Array.from(
      { length: 51 },
      (_, index) => `项目 ${index}`
    );
    expect(() => parseDocumentOutline(JSON.stringify(badItems))).toThrow(
      DocumentOutlineError
    );
  });

  it('accepts chart blocks and rejects invalid chart data', () => {
    const withChart = JSON.parse(validOutline());
    withChart.sections[0].blocks.push({
      type: 'chart',
      chartKind: 'bar',
      title: '月度趋势',
      data: [
        { label: '一月', value: 10 },
        { label: '二月', value: 22 }
      ]
    });
    const outline = parseDocumentOutline(JSON.stringify(withChart));
    expect(outline.sections[0].blocks[2]).toMatchObject({
      type: 'chart',
      chartKind: 'bar'
    });
    const badKind = JSON.parse(validOutline());
    badKind.sections[0].blocks.push({
      type: 'chart',
      chartKind: 'line',
      data: []
    });
    expect(() => parseDocumentOutline(JSON.stringify(badKind))).toThrow(
      DocumentOutlineError
    );
    const badValue = JSON.parse(validOutline());
    badValue.sections[0].blocks.push({
      type: 'chart',
      chartKind: 'pie',
      data: [{ label: 'a', value: 'x' }]
    });
    expect(() => parseDocumentOutline(JSON.stringify(badValue))).toThrow(
      DocumentOutlineError
    );
  });
});

describe('markdown to outline parser', () => {
  it('converts headings, bullets and tables into outline blocks', () => {
    const outline = parseMarkdownToOutline(
      [
        '# 项目周报',
        '',
        '## 本周进展',
        '',
        '- 完成方案评审',
        '- 修复三个缺陷',
        '',
        '## 下周计划',
        '',
        '| 目标 | 负责人 |',
        '| --- | --- |',
        '| 上线 | 张三 |'
      ].join('\n'),
      'word'
    );
    expect(outline.title).toBe('项目周报');
    expect(outline.sections).toHaveLength(2);
    expect(outline.sections[0].blocks[0]).toEqual({
      type: 'bullets',
      items: ['完成方案评审', '修复三个缺陷']
    });
    expect(outline.sections[1].blocks[0]).toEqual({
      type: 'table',
      header: ['目标', '负责人'],
      rows: [['上线', '张三']]
    });
  });

  it('falls back to a single section for plain text', () => {
    const outline = parseMarkdownToOutline('这是没有标题的正文内容。', 'ppt');
    expect(outline.kind).toBe('ppt');
    expect(outline.sections[0].blocks[0].type).toBe('paragraph');
  });

  it('strips inline markdown markers from document text', () => {
    const outline = parseMarkdownToOutline(
      '# 汇报\n\n## 签约流程\n\n- **客户确认**、`编号` 与 [详情](https://example.com)',
      'word'
    );
    const bullet = outline.sections[0].blocks[0];
    expect(bullet.type).toBe('bullets');
    if (bullet.type !== 'bullets') throw new Error('unexpected block');
    expect(bullet.items[0]).toBe('客户确认、编号 与 详情');
    expect(bullet.items[0]).not.toContain('*');
    expect(bullet.items[0]).not.toContain('`');
  });

  it('rejects oversized Markdown lists instead of silently dropping items', () => {
    const markdown = [
      '# 汇报',
      '## 全部事项',
      ...Array.from({ length: 51 }, (_, index) => `- 唯一标记 ${index + 1}`)
    ].join('\n');

    expect(() => parseMarkdownToOutline(markdown, 'ppt')).toThrow(
      DocumentOutlineError
    );
  });
});

describe('content contract helpers', () => {
  it('strips chatty preamble before parsing', () => {
    expect(
      stripPreamble(
        '好的，我理解您希望得到一个版本。\n\n# 项目周报\n\n- 完成评审'
      )
    ).toBe('# 项目周报\n\n- 完成评审');
    expect(stripPreamble('直接开始的正文内容')).toBe('直接开始的正文内容');
  });

  it('unwraps fenced JSON and accepts it as a structured contract', () => {
    const content = '```json\n{"kind":"word","title":"周报","sections":[]}\n```';
    const outline = parseDocumentOutline(unwrapJsonFence(content));
    expect(outline.kind).toBe('word');
    expect(outline.title).toBe('周报');
  });

  it('normalizes the observed section-content JSON shape into a Word outline', () => {
    const source = JSON.stringify({
      title: '智能客服 Agent 系统设计文档',
      sections: [
        {
          id: '1',
          heading: '一、系统概述',
          content: [
            { type: 'paragraph', text: '系统说明。' },
            {
              type: 'table',
              caption: '表 1-1 系统核心能力',
              headers: ['能力', '说明'],
              rows: [['意图识别', '识别用户咨询']]
            }
          ]
        },
        {
          id: '2',
          heading: '二、核心流程',
          content: [
            {
              type: 'ordered_list',
              items: ['接收请求', '检索资料', '输出答案']
            },
            {
              type: 'subsection',
              heading: '2.1 低置信度处理',
              content: [{ type: 'paragraph', text: '转人工。' }]
            }
          ]
        }
      ]
    });

    expect(parseDocumentContent(source, 'word')).toEqual({
      kind: 'word',
      title: '智能客服 Agent 系统设计文档',
      sections: [
        {
          heading: '一、系统概述',
          level: 1,
          blocks: [
            { type: 'paragraph', text: '系统说明。' },
            { type: 'paragraph', text: '表 1-1 系统核心能力' },
            {
              type: 'table',
              header: ['能力', '说明'],
              rows: [['意图识别', '识别用户咨询']]
            }
          ]
        },
        {
          heading: '二、核心流程',
          level: 1,
          blocks: [
            {
              type: 'numbered',
              items: ['接收请求', '检索资料', '输出答案']
            },
            { type: 'paragraph', text: '2.1 低置信度处理' },
            { type: 'paragraph', text: '转人工。' }
          ]
        }
      ]
    });
  });

  it('normalizes common Excel columns/data and headers/rows shapes', () => {
    expect(
      parseDocumentContent(
        JSON.stringify({
          title: '员工表',
          columns: [
            { key: 'name', title: '姓名' },
            { key: 'department', title: '部门' }
          ],
          data: [{ name: '示例员工', department: '待填写' }]
        }),
        'excel'
      ).sections[0].blocks[0]
    ).toEqual({
      type: 'table',
      header: ['姓名', '部门'],
      rows: [['示例员工', '待填写']]
    });
    expect(
      parseDocumentContent(
        JSON.stringify({
          title: '项目清单',
          sheets: [
            {
              name: '清单',
              headers: ['项目', '状态'],
              rows: [['示例项目', '待确认']]
            }
          ]
        }),
        'excel'
      ).sections[0]
    ).toMatchObject({
      heading: '清单',
      blocks: [
        {
          type: 'table',
          header: ['项目', '状态'],
          rows: [['示例项目', '待确认']]
        }
      ]
    });
  });

  it('fails closed for unsupported JSON-shaped content', () => {
    expect(() =>
      parseDocumentContent(
        '{"title":"文档","sections":[{"heading":"正文","content":[{"type":"unknown"}]}]}',
        'word'
      )
    ).toThrow(DocumentOutlineError);
  });

  it('rejects a canonical outline for a different document kind', () => {
    expect(() =>
      parseDocumentContent(
        '{"kind":"ppt","title":"汇报","sections":[]}',
        'word'
      )
    ).toThrow(DocumentOutlineError);
  });

  it('keeps Markdown fallback for non-JSON content', () => {
    expect(parseDocumentContent('# 周报\n\n正文。', 'word').title).toBe('周报');
  });

  it('fails closed for JSON arrays instead of rendering them as Markdown', () => {
    expect(() => parseDocumentContent('[]', 'word')).toThrow(DocumentOutlineError);
    expect(() => parseDocumentContent('```json\n[]\n```', 'word')).toThrow(
      DocumentOutlineError
    );
  });
});
