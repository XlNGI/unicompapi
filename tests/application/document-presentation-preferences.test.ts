import { describe, expect, it } from 'vitest';
import { documentPresentationPreferences } from '../../src/application/document-presentation-preferences';

describe('document preferences from the current request', () => {
  it.each([
    ['做一个环保主题 PPT，使用 AI 配图', 'forest', true],
    ['生成黑白极简 Word 报告', 'ink', false],
    ['帮我做融资路演 PPT', 'financing', false],
    ['做一份周报', 'blueprint', false],
    ['做 PPT，请添加 AI 插图', 'blueprint', true],
    ['做 PPT，不要 AI 配图', 'blueprint', false],
    ['做 PPT，AI 配图是什么？', 'blueprint', false],
    ['做 PPT，使用附件里的图片', 'blueprint', false],
    ['做 PPT，不使用 AI 配图，只用已有图片', 'blueprint', false],
    ['Create a PPT without AI images', 'blueprint', false]
  ])('%s', (text, theme, aiImagesRequested) => {
    expect(documentPresentationPreferences(text)).toEqual({ theme, aiImagesRequested });
  });

  it('does not carry a paid image or style choice into the following request', () => {
    expect(documentPresentationPreferences('用 AI 配图制作绿色 PPT').aiImagesRequested).toBe(true);
    expect(documentPresentationPreferences('再做一份周报')).toEqual({ theme: 'blueprint', aiImagesRequested: false });
  });
});
