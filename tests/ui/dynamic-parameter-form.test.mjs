import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/components/DynamicParameterForm.tsx', 'utf8');

test('dynamic parameter labels use Chinese display names without changing field ids', () => {
  assert.match(source, /displayParameterKey/);
  assert.match(source, /replace\(\/\^provider\\.parameter\\.\/,/);
  assert.match(source, /uc-dynamic-parameters__key/);
  assert.match(source, /background: '背景'/);
  assert.match(source, /output_compression: '输出压缩率'/);
  assert.match(source, /output_format: '输出格式'/);
  assert.match(source, /quality: '画面质量'/);
  assert.match(source, /response_format: '返回格式'/);
  assert.match(source, /size: '输出尺寸'/);
  assert.match(source, /onChange\(field\.fieldId, value\)/);
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
  const labels = {
    max_tokens: '最大生成长度',
    aspect_ratio: '画面比例',
    duration: '视频时长'
  };
  const displayParameterKey = (value) => {
    const key = value
      .replace(/^provider\.parameter\./, '')
      .replace(/^provider\./, '');
    return labels[key] ?? (/[\u3400-\u9fff]/.test(key) ? key : '其他参数');
  };
  assert.equal(displayParameterKey('provider.parameter.max_tokens'), '最大生成长度');
  assert.equal(displayParameterKey('provider.parameter.aspect_ratio'), '画面比例');
  assert.equal(displayParameterKey('duration'), '视频时长');
  assert.equal(displayParameterKey('future_provider_key'), '其他参数');
});

test('dynamic enum values use Chinese labels while preserving submitted values', () => {
  assert.match(source, /value: String\(option\)/);
  assert.match(source, /label: displayParameterOption\(option, index\)/);
  assert.match(source, /disabled: '关闭'/);
  assert.match(source, /high: '高'/);
  assert.match(source, /return `其他选项 \$\{index \+ 1\}`/);
});
