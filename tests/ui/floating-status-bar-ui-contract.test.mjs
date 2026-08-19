import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentSource = await readFile('src/components/FloatingStatusBar.tsx', 'utf8');
const componentStyles = await readFile('src/styles/components.css', 'utf8');
const imageWorkbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const videoWorkbenchSource = await readFile(
  'src/pages/creation/video/VideoWorkbenchPage.tsx',
  'utf8'
);

test('workspace feedback uses one reusable floating status bar', () => {
  assert.match(componentSource, /export function FloatingStatusBar/);
  assert.match(componentSource, /role = 'status'/);
  assert.match(componentStyles, /\.uc-floating-status-bar \{[\s\S]*position: fixed;/);
  assert.match(componentStyles, /bottom: var\(--uc-space-4\);/);
  assert.match(componentStyles, /left: calc\(200px \+ var\(--uc-space-4\)\);/);
  assert.match(componentStyles, /\.uc-floating-status-bar__content/);
});

test('image and video workbenches route live messages through the shared status bar', () => {
  assert.match(imageWorkbenchSource, /<FloatingStatusBar>[\s\S]*uc-image-workbench__message/);
  assert.match(videoWorkbenchSource, /<FloatingStatusBar>[\s\S]*uc-image-workbench__message/);
  assert.doesNotMatch(imageWorkbenchSource, /uc-image-workbench__message-card/);
  assert.doesNotMatch(imageWorkbenchSource, /\{message \? \([\s\S]*<FloatingStatusBar>/);
  assert.match(imageWorkbenchSource, /const floatingStatusMessage = message \|\|/);
});
