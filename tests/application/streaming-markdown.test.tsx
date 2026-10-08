import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StreamingMarkdown } from '../../src/pages/chat/StreamingMarkdown';

describe('progressive Markdown', () => {
  it('renders headings, lists and code while a response is still streaming', () => {
    const markup = renderToStaticMarkup(<StreamingMarkdown streaming content={'# 标题\n\n- 项目\n\n```js\nconst value = 1;\n```'} />);
    expect(markup).toContain('<h1>标题</h1>');
    expect(markup).toContain('<li>项目</li>');
    expect(markup).toContain('language-js');
  });

  it('does not execute raw HTML or load partially streamed image URLs', () => {
    const markup = renderToStaticMarkup(<StreamingMarkdown streaming content={'<script>alert(1)</script>\n\n![参考](https://example.invalid/image.png)'} />);
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('参考');
  });
});
