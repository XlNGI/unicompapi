import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/components/MarkdownMessage.tsx', 'utf8');
const styles = await readFile('src/styles/components.css', 'utf8');

test('shared markdown messages render GFM without injecting raw HTML', () => {
  assert.match(source, /react-markdown/);
  assert.match(source, /remark-gfm/);
  assert.match(source, /rel="noreferrer"/);
  assert.match(source, /target="_blank"/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|rehypeRaw/);
});

test('shared markdown messages use theme tokens for rich text', () => {
  for (const selector of [
    '.uc-markdown-message h1',
    '.uc-markdown-message blockquote',
    '.uc-markdown-message pre',
    '.uc-markdown-message table'
  ]) {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(styles, /var\(--uc-color-surface-panel\)/);
  assert.match(styles, /var\(--uc-color-text-primary\)/);
});
