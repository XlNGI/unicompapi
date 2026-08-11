import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile('electron/main.ts', 'utf8');
const layout = await readFile('src/ui/layout/AppLayout.tsx', 'utf8');
const titleBar = await readFile('src/ui/layout/TitleBar.tsx', 'utf8');
const windowControls = await readFile('src/ui/layout/WindowControls.tsx', 'utf8');
const themeSwitch = await readFile('src/components/ThemeSwitch.tsx', 'utf8');
const styles = await readFile('src/styles.css', 'utf8');
const pageStyles = await readFile('src/styles/pages.css', 'utf8');
const tokens = await readFile('src/styles/tokens.css', 'utf8');
const brandMark = await readFile('src/assets/brand/unicomp-mark.png');

test('keeps native macOS chrome and controlled Windows window actions', () => {
  assert.match(main, /frame: isMac/);
  assert.match(main, /titleBarStyle: isMac \? 'hiddenInset' : 'default'/);
  assert.match(titleBar, /platform === 'darwin'/);
  assert.match(titleBar, /platform === 'win32' \? <WindowControls \/> : null/);
  assert.match(titleBar, /PROJECT_SESSION_CHANGED_EVENT/);
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

test('uses the approved product mark in the title bar across both themes', () => {
  assert.match(titleBar, /assets\/brand\/unicomp-mark\.png/);
  assert.match(titleBar, /<img alt="" src=\{unicompMark\} \/>/);
  assert.doesNotMatch(titleBar, /正式品牌标志待接入|>\s*U\s*</);
  assert.deepEqual([...brandMark.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(styles, /\.title-bar__brand-mark img \{[\s\S]*?filter: invert\(1\)/);
  assert.match(styles, /:root\[data-theme="light"\] \.title-bar__brand-mark img \{[\s\S]*?filter: none/);
});

test('development window does not force open the viewport inspection overlay', () => {
  assert.match(main, /VITE_DEV_SERVER_URL/);
  assert.doesNotMatch(main, /openDevTools/);
});

test('provides keyboard focus paths for shell and theme controls', () => {
  assert.match(layout, /className="skip-link" href="#main-content"/);
  assert.match(layout, /<main[\s\S]{0,240}id="main-content"[\s\S]{0,80}tabIndex=\{-1\}/);
  assert.match(styles, /\.skip-link:focus/);
  assert.match(styles, /\.workspace:focus-visible/);
  assert.match(themeSwitch, /ArrowDown/);
  assert.match(themeSwitch, /ArrowUp/);
  assert.match(themeSwitch, /triggerRef\.current\?\.focus\(\)/);
});

test('keeps the approved 800 by 720 compact desktop minimum usable', () => {
  assert.match(main, /minWidth: 800/);
  assert.match(main, /minHeight: 720/);
  assert.match(styles, /#root \{[\s\S]*?min-width: 800px;[\s\S]*?min-height: 720px;/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /grid-template-columns: 200px minmax\(0, 1fr\)/);
  assert.match(styles, /\.nav-subitem > span:last-child \{[\s\S]*?white-space: nowrap/);
  assert.match(pageStyles, /@media \(max-width: 1180px\)[\s\S]*?\.uc-image-workbench__project-strip \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(pageStyles, /\.uc-image-workbench__project-strip > p \{[\s\S]*?grid-column: 1 \/ -1/);
});

test('uses native platform font fallbacks and accessibility media preferences', () => {
  assert.match(tokens, /--uc-font-family-ui: -apple-system, BlinkMacSystemFont/);
  assert.match(tokens, /"Segoe UI Variable"/);
  assert.match(tokens, /"PingFang SC"/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
});
