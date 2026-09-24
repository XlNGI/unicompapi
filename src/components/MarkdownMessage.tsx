import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../styles/components.css';

export interface MarkdownMessageProps {
  readonly content: string;
  readonly className?: string;
  readonly allowImages?: boolean;
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

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  className = '',
  allowImages = true
}: MarkdownMessageProps) {
  const classes = ['uc-markdown-message', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <ReactMarkdown components={allowImages ? markdownComponents : textImageComponents} remarkPlugins={markdownRemarkPlugins}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
