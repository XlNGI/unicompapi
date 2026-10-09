import { describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VirtualMessageList } from '../../src/pages/chat/VirtualMessageList';

describe('VirtualMessageList', () => {
  it('renders only the initial viewport plus overscan for a long history', () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => `message-${index}`);
    const html = renderToStaticMarkup(<VirtualMessageList itemIds={ids} containerRef={createRef<HTMLDivElement>()} overscan={3} renderItem={id => <li data-message-id={id}>{id}</li>} />);
    expect((html.match(/data-message-id=/g) ?? []).length).toBeLessThan(20);
    expect(html).toContain('message-0');
    expect(html).not.toContain('message-4999');
  });
});
