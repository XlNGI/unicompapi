import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile('electron/main.ts', 'utf8');
const layout = await readFile('src/ui/layout/AppLayout.tsx', 'utf8');
const titleBar = await readFile('src/ui/layout/TitleBar.tsx', 'utf8');
const windowControls = await readFile('src/ui/layout/WindowControls.tsx', 'utf8');
const themeSwitch = await readFile('src/components/ThemeSwitch.tsx', 'utf8');
const styles = await readFile('src/styles.css', 'utf8');
const tokens = await readFile('src/styles/tokens.css', 'utf8');

test('keeps native macOS chrome and controlled Windows window actions', () => {
  assert.match(main, /frame: isMac/);
  assert.match(main, /titleBarStyle: isMac \? 'hiddenInset' : 'default'/);
  assert.match(titleBar, /platform === 'darwin'/);
  assert.match(titleBar, /platform === 'win32' \? <WindowControls \/> : null/);
  assert.match(styles, /\.title-bar--mac \.title-bar__brand \{[\s\S]*?padding-left: 80px/);
  assert.match(windowControls, /role="group"/);
  assert.match(windowControls, /isMaximized \? '还原窗口' : '最大化窗口'/);
});

test('restores and focuses the existing window on desktop activation', () => {
  assert.match(main, /show: false/);
  assert.match(main, /once\('ready-to-show'/);
  assert.match(main, /if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\)/);
  assert.match(main, /mainWindow\.show\(\);\s+mainWindow\.focus\(\)/);
  assert.match(main, /enter-full-screen/);
  assert.match(main, /leave-full-screen/);
});

test('provides keyboard focus paths for shell and theme controls', () => {
  assert.match(layout, /className="skip-link" href="#main-content"/);
  assert.match(layout, /<main className="workspace" id="main-content" tabIndex=\{-1\}>/);
  assert.match(styles, /\.skip-link:focus/);
  assert.match(styles, /\.workspace:focus-visible/);
  assert.match(themeSwitch, /ArrowDown/);
  assert.match(themeSwitch, /ArrowUp/);
  assert.match(themeSwitch, /triggerRef\.current\?\.focus\(\)/);
});

test('uses native platform font fallbacks and accessibility media preferences', () => {
  assert.match(tokens, /--uc-font-family-ui: -apple-system, BlinkMacSystemFont/);
  assert.match(tokens, /"Segoe UI Variable"/);
  assert.match(tokens, /"PingFang SC"/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
});
