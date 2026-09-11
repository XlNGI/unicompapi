import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('all picker consumers use the shared overlay owner', async () => {
  async function check(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await check(file);
      else if (file.endsWith('.tsx') && entry.name !== 'Pickers.tsx') {
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:SelectPicker|DateRangePicker)\b[^}]*\}\s*from\s*'rsuite'/, file);
      }
    }
  }
  await check('src');
  const source = await readFile('src/components/Pickers.tsx', 'utf8');
  assert.match(source, /container=\{container\} preventOverflow placement="autoVerticalStart"/);
  assert.match(source, /container=\{container\} preventOverflow placement="autoVerticalEnd"/);
});

test('portal scrolling cannot fold the task charts', async () => {
  const source = await readFile('src/pages/tasks/TasksPage.tsx', 'utf8');
  const guard = source.indexOf('!event.currentTarget.contains(event.target as Node)');
  assert.ok(guard > 0 && guard < source.indexOf('const direction = Math.sign(event.deltaY)'));
  assert.match(source, /document.querySelector\('\.uc-picker-layer \.rs-picker-popup'\)/);
});
