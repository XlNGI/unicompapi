import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = path.join(root, 'src');

function tsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? tsxFiles(fullPath)
      : entry.isFile() && entry.name.endsWith('.tsx')
        ? [fullPath]
        : [];
  });
}

const sources = tsxFiles(srcRoot).map((file) => ({
  file,
  source: fs.readFileSync(file, 'utf8')
}));

test('RSuite overlay controls are not nested in native labels', () => {
  for (const { file, source } of sources) {
    const labelBlocks = source.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
    for (const block of labelBlocks) {
      assert.doesNotMatch(
        block,
        /<(?:SelectPicker|DatePicker|Checkbox)\b/,
        path.relative(root, file)
      );
    }
  }
});

test('RSuite picker controls retain explicit accessible names', () => {
  for (const { file, source } of sources) {
    const pickerTags = source.match(/<(?:SelectPicker|DatePicker)\b[\s\S]*?\/>/g) ?? [];
    for (const tag of pickerTags) {
      assert.match(tag, /aria-label=/, path.relative(root, file));
    }
  }
});

test('the shared RSuite theme and mature control set stay installed', () => {
  const main = fs.readFileSync(path.join(srcRoot, 'main.tsx'), 'utf8');
  const settings = fs.readFileSync(path.join(srcRoot, 'pages/settings/SettingsPage.tsx'), 'utf8');
  const editor = fs.readFileSync(path.join(srcRoot, 'pages/creation/video/VideoEditingPage.tsx'), 'utf8');

  assert.match(main, /rsuite\/dist\/rsuite-no-reset\.min\.css/);
  assert.match(main, /RSuiteThemeBridge/);
  assert.match(settings, /Toggle as RSuiteToggle/);
  assert.match(settings, /<Slider/);
  assert.match(editor, /<RadioGroup/);
  assert.match(editor, /<Checkbox/);
  assert.match(editor, /<Slider/);
});

test('shared model picker closes its portal when the workspace scrolls', () => {
  const modelSelect = fs.readFileSync(path.join(srcRoot, 'components/ModelSelect.tsx'), 'utf8');

  assert.match(modelSelect, /document\.querySelector<HTMLElement>\('\.workspace'\)/);
  assert.match(modelSelect, /workspace\.addEventListener\('scroll',[\s\S]*?passive: true/);
  assert.match(modelSelect, /workspace\.removeEventListener\('scroll'/);
  assert.match(modelSelect, /open=\{open\}/);
  assert.match(modelSelect, /placement="autoVerticalStart"/);
  assert.match(modelSelect, /preventOverflow/);
  assert.match(modelSelect, /listboxMaxHeight=\{320\}/);
});
