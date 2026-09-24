import { describe, expect, it } from 'vitest';
import { documentBodyPreview, projectDocumentBody } from '../../src/pages/chat/documentBodyPreview';

describe('document body display projection', () => {
  it('streams each character of document title and paragraph without JSON keys or delimiters', () => {
    const prefix = '{"kind":"word","title":"';
    const title = '本周生产报告';
    for (let count = 0; count <= title.length; count += 1) {
      expect(documentBodyPreview(prefix + title.slice(0, count))).toBe(count ? `# ${title.slice(0, count)}` : '');
    }
    const bodyPrefix = `${prefix}${title}","sections":[{"heading":"进展","blocks":[{"type":"paragraph","text":"`;
    const body = '正文正在逐字生成。';
    for (let count = 0; count <= body.length; count += 1) {
      expect(documentBodyPreview(bodyPrefix + body.slice(0, count)))
        .toBe(`# ${title}\n\n## 进展${count ? `\n\n${body.slice(0, count)}` : ''}`);
    }
  });

  it('handles every character prefix of a full outline and hides all unknown paths', () => {
    const raw = JSON.stringify({ kind: 'ppt', prompt: 'SECRET-PROMPT', title: '经营复盘', reasoning: { title: 'SECRET-TITLE' },
      sections: [{ heading: '销售', pageKind: 'data', takeaway: '稳步增长', action: '继续试点',
        credentials: { text: 'SECRET-CREDENTIAL' }, blocks: [{ type: 'paragraph', text: '同比增长。', path: 'SECRET-PATH' },
          { type: 'bullets', items: ['复盘渠道', '改善转化'], secret: { items: ['SECRET-ITEM'] } },
          { type: 'reasoning', text: 'SECRET-THOUGHT' }] }] });
    for (let end = 0; end <= raw.length; end += 1) {
      const shown = documentBodyPreview(raw.slice(0, end));
      expect(shown).not.toMatch(/SECRET|kind|sections|blocks|paragraph|pageKind|takeaway|reasoning|credentials/);
    }
    expect(documentBodyPreview(raw)).toBe('# 经营复盘\n\n## 销售\n\n稳步增长\n\n同比增长。\n\n- 复盘渠道\n- 改善转化\n\n继续试点');
    expect(documentBodyPreview('{"reasoning":{"title":"秘密","sections":[{"heading":"秘密"}]}}')).toBe('');
  });

  it('requires a recognized block type even when text precedes the discriminator', () => {
    const base = '{"sections":[{"blocks":[{"text":"正文';
    expect(documentBodyPreview(base)).toBe('');
    expect(documentBodyPreview(`${base}","type":"parag`)).toBe('');
    expect(documentBodyPreview(`${base}","type":"paragraph"`)).toBe('正文');
    expect(documentBodyPreview(`${base}","type":"unknown"`)).toBe('');
  });

  it('projects table cells, chart labels and numeric values, quotes and numbered items', () => {
    const raw = JSON.stringify({ title: '数据', sections: [{ heading: '明细', level: 2, blocks: [
      { type: 'table', header: ['地区', '金额|元'], rows: [['华东', '20'], ['华南\n市场', '30']], reasoning: { rows: [['SECRET']] } },
      { type: 'chart', title: '收入', chartKind: 'bar', data: [{ label: '华东', value: 20 }, { label: '华南', value: 30 }, { label: '未知', value: 'SECRET' }] },
      { type: 'quote', text: '谨慎判断\n核对来源' }, { type: 'numbered', items: ['整理', '复核'] }
    ] }] });
    expect(documentBodyPreview(raw)).toBe('# 数据\n\n### 明细\n\n| 地区 | 金额\\|元 |\n| --- | --- |\n| 华东 | 20 |\n| 华南 市场 | 30 |\n\n收入\n\n- 华东：20\n- 华南：30\n- 未知\n\n> 谨慎判断\n> 核对来源\n\n1. 整理\n2. 复核');
  });

  it('hides scene layout fragments from a malformed streaming PPT preview', () => {
    const raw = JSON.stringify({
      kind: 'ppt',
      title: '龙：从古老图腾到现代精神符号',
      sections: [{
        heading: '内容概览',
        blocks: [{
          type: 'bullets',
          items: ['龙的文化意义', ':{', 'elementId: 1,t: 12,', 'width: 42,', 'zIndex: 1,']
        }],
        scene: { elements: [] }
      }]
    });

    expect(documentBodyPreview(raw)).toBe(
      '# 龙：从古老图腾到现代精神符号\n\n## 内容概览\n\n- 龙的文化意义'
    );
  });

  it('decodes complete escapes and withholds unfinished Unicode and surrogate pairs', () => {
    expect(documentBodyPreview('{"title":"\\u4')).toBe('');
    expect(documentBodyPreview('{"title":"\\u4e2d\\u65')).toBe('# 中');
    expect(documentBodyPreview('{"title":"\\u4e2d\\u6587')).toBe('# 中文');
    expect(documentBodyPreview('{"title":"A\\ud83d')).toBe('# A');
    expect(documentBodyPreview('{"title":"A\\ud83d\\ude')).toBe('# A');
    expect(documentBodyPreview('{"title":"A\\ud83d\\ude00')).toBe('# A😀');
    expect(documentBodyPreview('{"title":"A\ud83d')).toBe('# A');
    const raw = '{"sections":[{"blocks":[{"type":"paragraph","text":"行一\\n行二\\t\\\"引号\\\"\\\\目录"}]}]}';
    expect(documentBodyPreview(raw)).toBe('行一\n行二\t"引号"\\目录');
  });

  it('supports JSON fences and leaves ordinary Markdown unchanged', () => {
    for (const partialFence of ['`', '``', '```', '```j', '```js', '```jso', '```json', '```json\n']) {
      expect(documentBodyPreview(partialFence)).toBe('');
    }
    expect(documentBodyPreview('```json\n{"title":"中文')).toBe('# 中文');
    expect(documentBodyPreview('```json\n{"title":"中文"}\n```')).toBe('# 中文');
    expect(documentBodyPreview('```\n{"title":"中文"}\n```')).toBe('# 中文');
    for (const markdown of ['# 报告\n\n正文 **加粗**。', '[参考资料](https://example.com)', '- 清单\n- 第二项', '```ts\nconst x = 1;\n```']) {
      expect(documentBodyPreview(markdown)).toBe(markdown);
    }
  });

  it('never falls back to raw JSON on malformed, nested or resource-limited input', () => {
    for (const raw of ['{', '{"title', '{"title":', '{"title": {"text":"SECRET"}}', '{"title":"安全\\xSECRET"}',
      '{"reasoning":' + '['.repeat(10000), '[{"title":"SECRET"}]', '```json\nnot valid SECRET', '{bad SECRET']) {
      expect(() => documentBodyPreview(raw)).not.toThrow();
      expect(documentBodyPreview(raw)).not.toContain('SECRET');
    }
    expect(documentBodyPreview('{"title":"安全","title":"SECRET"}')).toBe('# 安全');
    expect(documentBodyPreview('{"title":"' + '文'.repeat(1_000_010))).toHaveLength(200_000);
    expect(documentBodyPreview('a'.repeat(300_000))).toHaveLength(200_000);
    expect(() => documentBodyPreview(undefined as never)).not.toThrow();
  });

  it('distinguishes a naturally unfinished stream from a bounded preview', () => {
    for (const content of ['{"title":"尚未结束', '{"title":"\\u4e', '{invalid', '```json\n', '# Markdown']) {
      expect(projectDocumentBody(content).truncated).toBe(false);
    }
    expect(projectDocumentBody('正文'.repeat(100_001))).toEqual({ content: '正文'.repeat(100_000), truncated: true });
    expect(projectDocumentBody('文'.repeat(200_000)).truncated).toBe(false);
    expect(projectDocumentBody('{"title":"' + '文'.repeat(200_000)).truncated).toBe(true);
    expect(projectDocumentBody('{"unknown":"' + 'x'.repeat(1_000_001)).truncated).toBe(true);
    expect(projectDocumentBody('{"unknown":' + '['.repeat(100))).toEqual({ content: '', truncated: true });
    expect(projectDocumentBody(JSON.stringify({ title: '安全', unknown: Array.from({ length: 20_000 }, () => null) })))
      .toEqual({ content: '# 安全', truncated: true });
  });
});
