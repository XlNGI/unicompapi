import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/components/DynamicParameterForm.tsx', 'utf8');

test('dynamic parameter labels strip provider.parameter prefix', () => {
  assert.match(source, /displayParameterKey/);
  assert.match(source, /replace\(\/\^provider\\.parameter\\.\/,/);
  assert.match(source, /uc-dynamic-parameters__key/);
  assert.doesNotMatch(
    source,
    /\$\{field\.labelId\}\$\{field\.required \? '（必填）' : ''\}/
  );
});

test('dynamic parameter form marks required fields visibly', () => {
  assert.match(source, /uc-dynamic-parameters__required/);
  assert.match(source, /必填/);
  assert.match(source, /exposure === 'user_required'/);
  assert.match(source, /required=\{field\.required\}/);
});

test('displayParameterKey behavior matches the component helper', () => {
  const displayParameterKey = (value) =>
    value
      .replace(/^provider\.parameter\./, '')
      .replace(/^provider\./, '');
  assert.equal(displayParameterKey('provider.parameter.max_tokens'), 'max_tokens');
  assert.equal(displayParameterKey('provider.parameter.aspect_ratio'), 'aspect_ratio');
  assert.equal(displayParameterKey('duration'), 'duration');
});
