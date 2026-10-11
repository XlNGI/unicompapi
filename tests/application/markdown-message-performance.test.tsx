import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage, clearCompletedMarkdownCache } from '../../src/components/MarkdownMessage';
import { readMarkdownMetrics, resetMarkdownMetrics } from '../../src/components/markdownMetrics';

describe('Markdown message cache metrics', () => {
  it('reuses completed content while streaming content bypasses the cache', () => {
    resetMarkdownMetrics();
    clearCompletedMarkdownCache();
    const content = '# Stable\n\n```ts\nconst value = 1;\n```';
    renderToStaticMarkup(createElement(MarkdownMessage, { content }));
    renderToStaticMarkup(createElement(MarkdownMessage, { content }));
    expect(readMarkdownMetrics().parseCount).toBe(1);
    renderToStaticMarkup(createElement(MarkdownMessage, { content: `${content}\nnext`, cache: false }));
    expect(readMarkdownMetrics().parseCount).toBe(2);
  });
});
