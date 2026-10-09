import { memo, useMemo } from 'react';
import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../styles/components.css';
import { recordMarkdownParse } from './markdownMetrics';

export interface MarkdownMessageProps {
  readonly content: string;
  readonly className?: string;
  readonly allowImages?: boolean;
  readonly cache?: boolean;
}

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} rel="noreferrer" target="_blank" />;
  }
};

const markdownRemarkPlugins = [remarkGfm];
const textImageComponents: Components = {
  ...markdownComponents,
  img({ alt }) { return <span>{alt || '图片'}</span>; }
};
const completedMarkdownCache = new Map<string, ReactElement>();
const completedMarkdownCacheLimit = 128;

export function clearCompletedMarkdownCache(): void {
  completedMarkdownCache.clear();
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  className = '',
  allowImages = true,
  cache = true
}: MarkdownMessageProps) {
  const classes = ['uc-markdown-message', className].filter(Boolean).join(' ');
  // Keep the parsed child element stable when only the surrounding row's
  // class or layout state changes. Content changes still parse fully.
  const renderedMarkdown = useMemo(() => {
    const cacheKey = `${allowImages ? 'images' : 'text'}:${content}`;
    if (cache && content.length <= 200_000) {
      const cached = completedMarkdownCache.get(cacheKey);
      if (cached) return cached;
    }
    const startedAt = performance.now();
    const element = <ReactMarkdown components={allowImages ? markdownComponents : textImageComponents} remarkPlugins={markdownRemarkPlugins}>
      {content}
    </ReactMarkdown>;
    recordMarkdownParse(performance.now() - startedAt);
    if (cache && content.length <= 200_000) {
      completedMarkdownCache.set(cacheKey, element);
      while (completedMarkdownCache.size > completedMarkdownCacheLimit) completedMarkdownCache.delete(completedMarkdownCache.keys().next().value!);
    }
    return element;
  }, [allowImages, cache, content]);

  return (
    <div className={classes}>
      {renderedMarkdown}
    </div>
  );
});
