import type { DocumentOutlineSection } from './document-outline-parser';
import type { DocumentTheme } from './document-theme';

export type DocumentSlideLayout =
  | 'title'
  | 'section'
  | 'bullets'
  | 'table'
  | 'image_text'
  | 'closing';

export interface DocumentLayoutStyle {
  readonly layout: DocumentSlideLayout;
  readonly accent: string;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
}

export function chooseSectionLayout(
  section: DocumentOutlineSection
): DocumentSlideLayout {
  const hasTable = section.blocks.some((block) => block.type === 'table');
  if (hasTable) return 'table';
  const hasBullets = section.blocks.some(
    (block) => block.type === 'bullets' || block.type === 'numbered'
  );
  if (hasBullets) return 'bullets';
  return 'section';
}

export function resolveLayoutStyle(
  theme: DocumentTheme,
  layout: DocumentSlideLayout
): DocumentLayoutStyle {
  return {
    layout,
    accent: theme.accent,
    background: theme.background,
    text: theme.text,
    muted: theme.muted
  };
}

/**
 * 动画预留：当前 pptxgenjs 4.0.1 不原生支持动画。
 * 后续通过 OOXML 动画注入或升级依赖实现时，统一使用该预设。
 */
export const slideAnimationPreset = 'fade' as const;
