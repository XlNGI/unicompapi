import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const builderConfig = await readFile('electron-builder.yml', 'utf8');

test('Windows packaging exclusions stay scoped to project-root development artifacts', () => {
  for (const directory of ['tests', 'docs', '.tools', '.cache', 'tmp', 'temp']) {
    assert.match(builderConfig, new RegExp(`- '!${escapeRegExp(directory)}\\{,\\/\\*\\*\\}'`));
    assert.doesNotMatch(
      builderConfig,
      new RegExp(`- '!\\*\\*\\/${escapeRegExp(directory)}\\{,\\/\\*\\*\\}'`),
      `a recursive ${directory} exclusion can remove a production dependency with the same name`
    );
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
