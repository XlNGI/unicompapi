import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VirtualMessageList } from '../../src/pages/chat/VirtualMessageList';

describe('VirtualMessageList', () => {
  it('reserves the visible row gap in absolute offsets and total height', () => {
    const html = renderToStaticMarkup(<VirtualMessageList itemIds={['one', 'two', 'three']}
      containerRef={createRef<HTMLDivElement>()} estimatedItemHeight={100} rowGap={24}
      renderItem={id => <li>{id}</li>} />);
    expect(html).toContain('translateY(124px)');
    expect(html).toContain('translateY(248px)');
    expect(html).toContain('height:348px');
  });
  it('renders only the initial viewport plus overscan for a long history', () => {
    const ids = Array.from({ length: 100_000 }, (_, index) => `message-${index}`);
    const renderItem = vi.fn((id: string) => <li data-message-id={id}>{id}</li>);
    const html = renderToStaticMarkup(<VirtualMessageList itemIds={ids} containerRef={createRef<HTMLDivElement>()} overscan={3} renderItem={renderItem} />);
    expect((html.match(/data-message-id=/g) ?? []).length).toBeLessThan(20);
    expect(renderItem).toHaveBeenCalledTimes((html.match(/data-message-id=/g) ?? []).length);
    expect(html).toContain('message-0');
    expect(html).not.toContain('message-99999');
  });
});
