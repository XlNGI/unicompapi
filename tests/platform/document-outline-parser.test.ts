import { describe, expect, it } from 'vitest';
import {
  DocumentOutlineError,
  isDocumentOutline,
  parseDocumentOutline,
  parseMarkdownToOutline,
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
});
