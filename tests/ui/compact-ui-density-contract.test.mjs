import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const layout = await readFile('src/ui/layout/AppLayout.tsx', 'utf8');
const pages = await readFile('src/styles/pages.css', 'utf8');
const components = await readFile('src/styles/components.css', 'utf8');

test('the application enables the compact UI density shell by default', () => {
  assert.match(layout, /app-shell app-shell--compact/);
});

test('compact density hides repeated orientation copy but preserves state descriptions', () => {
  const compactRules = pages.slice(
    pages.indexOf('/* Default to a work-focused density'),
    pages.indexOf('.uc-image-workbench {')
  );
  assert.match(compactRules, /\.uc-page-skeleton__description,/);
  assert.match(compactRules, /\.uc-image-workbench__panel-heading p,/);
  assert.match(compactRules, /\.uc-image-professional__pane-heading p,/);
  assert.match(compactRules, /\.uc-image-workbench__notice > p,/);
  assert.doesNotMatch(compactRules, /\.uc-settings__notice/);
  assert.doesNotMatch(compactRules, /\.uc-chat-page__notice/);
  assert.match(components, /\.app-shell--compact \.uc-empty-state__description/);
});
