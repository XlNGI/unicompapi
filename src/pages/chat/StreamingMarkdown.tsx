import { memo, useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { StreamingTextBuffer } from './streamingText';

export const StreamingMarkdown = memo(function StreamingMarkdown({ content, streaming, allowImages = true }: {
  readonly content: string;
  readonly streaming: boolean;
  readonly allowImages?: boolean;
}) {
  const buffer = useRef(new StreamingTextBuffer());
  const [display, setDisplay] = useState(streaming ? '' : content);
  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setDisplay(buffer.current.update(content, streaming && !reducedMotion, performance.now()));
    if (!buffer.current.pending) return;
    let frame: number;
    let lastPaint = 0;
    const paint = (now: number) => {
      if (now - lastPaint >= 30) {
        setDisplay(buffer.current.advance(now));
        lastPaint = now;
      }
      if (buffer.current.pending) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [content, streaming]);
  return <MarkdownMessage content={streaming ? display : content} allowImages={allowImages} />;
});
