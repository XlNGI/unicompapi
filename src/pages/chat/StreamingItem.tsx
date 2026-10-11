import { memo } from 'react';
import { StreamingMarkdown } from './StreamingMarkdown';

export interface StreamingItemProps {
  readonly content: string;
  readonly streaming: boolean;
}

/** The only assistant Item that subscribes to the live response overlay. */
export const StreamingItem = memo(function StreamingItem({ content, streaming }: StreamingItemProps) {
  return <StreamingMarkdown content={content} streaming={streaming} />;
});
