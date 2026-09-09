import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps the phase 2 UI state contract', async () => {
  const preview = await readFile('src/pages/settings/StateSystemPreview.tsx', 'utf8');
  const emptyState = await readFile('src/components/EmptyState.tsx', 'utf8');
  const settings = await readFile('src/pages/settings/SettingsPage.tsx', 'utf8');
  const styles = await readFile('src/styles/components.css', 'utf8');
  const shellStyles = await readFile('src/styles.css', 'utf8');
  const tokens = await readFile('src/styles/tokens.css', 'utf8');

  let previousIndex = -1;
  for (const id of [
    'empty',
    'loading',
    'failure',
    'expired',
    'service-unavailable',
    'file-missing',
    'read-only',
    'recovery'
  ]) {
    const index = preview.indexOf(`id: '${id}'`);
    assert.ok(index > previousIndex, `UI state missing or out of order: ${id}`);
    previousIndex = index;
  }

  assert.match(preview, /domainState: 'processing'/);
  assert.match(preview, /domainState: 'failed'/);
  assert.match(preview, /domainState: 'expired'/);
  assert.match(preview, /domainState: 'missing'/);
  assert.match(preview, /domainState: 'read_only'/);
  assert.match(preview, /domainState: 'disconnected'/);
  assert.match(emptyState, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(preview, /actionDisabled: true/);
  assert.match(preview, /role: 'alert'/);
  assert.match(preview, /readOnly: true/);
  assert.doesNotMatch(settings, /<StateSystemPreview \/>/);
  assert.match(styles, /summary:focus-visible/);
  assert.match(shellStyles, /\.app-shell \{[\s\S]*?height: 100vh;/);
  assert.match(shellStyles, /\.workspace \{[\s\S]*?overflow: auto;/);
  assert.match(tokens, /:root\[data-theme="light"\] \{[\s\S]*?--uc-color-status-warning: #7a4b00;[\s\S]*?--uc-color-status-warning-bg: #fff7e6;[\s\S]*?--uc-color-status-warning-border: #d6a23a;/);
  assert.doesNotMatch(preview, /API Key|Token|价格|分辨率/);
});
