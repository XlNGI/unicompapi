import { describe, expect, it } from 'vitest';
import {
  choosePresentationComposition,
  choosePresentationLayout,
  chooseSectionLayout,
  documentThemes,
  presentationTemplateIds,
  resolvePresentationTemplate,
  resolveDocumentTheme,
  resolveLayoutStyle
} from '../../src/platform';

describe('document themes', () => {
  it('resolves known themes and falls back to the default', () => {
    expect(resolveDocumentTheme('forest').id).toBe('forest');
    expect(resolveDocumentTheme('financing')).toMatchObject({
      id: 'financing',
      name: '融资演讲稿',
      accent: '078AA3',
      presentationStyle: 'financing'
    });
    expect(resolveDocumentTheme('university')).toMatchObject({
      id: 'university',
      name: '大学课堂汇报',
      accent: '109B91',
      presentationStyle: 'university'
    });
    expect(resolveDocumentTheme('unknown').id).toBe('blueprint');
    expect(documentThemes.blueprint.accent).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe('document layout selection', () => {
  it('picks table, bullets and section layouts from blocks', () => {
    expect(
      chooseSectionLayout({
        heading: '数据',
        level: 1,
        blocks: [{ type: 'table', header: ['a'], rows: [['b']] }]
      })
    ).toBe('table');
    expect(
      chooseSectionLayout({
        heading: '要点',
        level: 1,
        blocks: [{ type: 'bullets', items: ['a'] }]
      })
    ).toBe('bullets');
    expect(
      chooseSectionLayout({
        heading: '说明',
        level: 1,
        blocks: [{ type: 'paragraph', text: '正文' }]
      })
    ).toBe('section');
  });

  it('resolves layout style from the theme', () => {
    const style = resolveLayoutStyle(documentThemes.ink, 'bullets');
    expect(style.layout).toBe('bullets');
    expect(style.accent).toBe(documentThemes.ink.accent);
  });
});

describe('presentation templates', () => {
  it('registers the five local PPT templates with complete layout coverage', () => {
    expect(presentationTemplateIds).toEqual([
      'work_report',
      'natural_minimal',
      'business_minimal',
      'technology',
      'financing'
    ]);

    const templates = presentationTemplateIds.map((id) =>
      resolvePresentationTemplate(id)
    );
    for (const template of templates) {
      expect(template.layouts.cover).toBeDefined();
      expect(template.layouts.insight).toBeDefined();
      expect(template.layouts.data).toBeDefined();
      expect(template.layouts.closing).toBeDefined();
      expect(template.layouts.insight.minBodyFontSize).toBeGreaterThanOrEqual(16);
      expect(template.layouts.insight.maxContentGroups).toBeGreaterThan(0);
    }
    expect(
      new Set(
        templates.map(
          (template) => `${template.tokens.background}:${template.tokens.accent}`
        )
      ).size
    ).toBe(5);
  });

  it('selects semantic and data layouts with continuation capacity', () => {
    const template = resolvePresentationTemplate('technology');
    expect(
      choosePresentationLayout(template, {
        heading: '交付节奏',
        level: 1,
        pageKind: 'process',
        blocks: [{ type: 'numbered', items: ['定义范围', '开发验证'] }]
      }).kind
    ).toBe('process');
    expect(
      choosePresentationLayout(template, {
        heading: '投入结构',
        level: 1,
        blocks: [
          {
            type: 'chart',
            chartKind: 'bar',
            data: [{ label: '研发', value: 40 }]
          }
        ]
      }).kind
    ).toBe('data');
    expect(
      choosePresentationLayout(template, {
        heading: '关键举措',
        level: 1,
        blocks: [
          {
            type: 'bullets',
            items: Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 项说明`)
          }
        ]
      })
    ).toMatchObject({ kind: 'insight', supportsContinuation: true });
  });

  it('plans deterministic but non-repeating structures for similar insight pages', () => {
    const sequences = presentationTemplateIds.map((id) => {
      const template = resolvePresentationTemplate(id);
      let previous: ReturnType<typeof choosePresentationComposition> | undefined;
      const sequence = Array.from({ length: 4 }, (_, pageIndex) => {
        const composition = choosePresentationComposition(template, {
          layoutKind: 'insight',
          textGroupCount: 4,
          totalCharacters: 360,
          pageIndex,
          previous
        });
        previous = composition;
        return composition;
      });
      expect(new Set(sequence).size).toBeGreaterThanOrEqual(3);
      sequence.slice(1).forEach((composition, index) => {
        expect(composition).not.toBe(sequence[index]);
      });
      return sequence.join('>');
    });

    expect(new Set(sequences).size).toBe(presentationTemplateIds.length);
    const technology = resolvePresentationTemplate('technology');
    expect(
      choosePresentationComposition(technology, {
        layoutKind: 'process',
        textGroupCount: 4,
        totalCharacters: 260,
        pageIndex: 0
      })
    ).toBe('timeline');
    expect(
      choosePresentationComposition(technology, {
        layoutKind: 'comparison',
        textGroupCount: 4,
        totalCharacters: 320,
        pageIndex: 1
      })
    ).toBe('split');
  });
});
