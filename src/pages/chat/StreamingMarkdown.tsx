import { memo } from 'react';
import { MarkdownMessage } from '../../components/MarkdownMessage';

export const StreamingMarkdown = memo(function StreamingMarkdown({ content, streaming, allowImages = true }: {
  readonly content: string;
  readonly streaming: boolean;
  readonly allowImages?: boolean;
}) {
  return <div data-streaming={streaming ? 'true' : undefined}>
    <MarkdownMessage allowImages={allowImages && !streaming} content={content} />
  </div>;
});
