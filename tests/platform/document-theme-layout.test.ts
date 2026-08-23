import { describe, expect, it } from 'vitest';
import {
  chooseSectionLayout,
  documentThemes,
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
