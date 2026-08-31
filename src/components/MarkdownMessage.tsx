import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../styles/components.css';

export interface MarkdownMessageProps {
  readonly content: string;
  readonly className?: string;
}

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} rel="noreferrer" target="_blank" />;
  }
};

const markdownRemarkPlugins = [remarkGfm];

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  className = ''
}: MarkdownMessageProps) {
  const classes = ['uc-markdown-message', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={markdownRemarkPlugins}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
