import { memo } from 'react';
import { MarkdownMessage } from '../../components/MarkdownMessage';

export const StreamingMarkdown = memo(function StreamingMarkdown({ content, streaming, allowImages = true }: {
  readonly content: string;
  readonly streaming: boolean;
  readonly allowImages?: boolean;
}) {
  if (streaming) {
    return <div className="uc-markdown-message uc-chat-stream-plain">{content}</div>;
  }
  return <MarkdownMessage allowImages={allowImages} content={content} />;
});
