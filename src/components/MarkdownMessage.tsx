import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../styles/components.css';

export interface MarkdownMessageProps {
  readonly content: string;
  readonly className?: string;
}

export function MarkdownMessage({ content, className = '' }: MarkdownMessageProps) {
  const classes = ['uc-markdown-message', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <ReactMarkdown
        components={{
          a({ node: _node, ...props }) {
            return <a {...props} rel="noreferrer" target="_blank" />;
          }
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
