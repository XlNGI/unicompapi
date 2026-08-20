import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/components/DynamicParameterForm.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('dynamic parameter labels use Chinese display names without changing field ids', () => {
  assert.match(source, /displayParameterKey/);
  assert.match(source, /displayParameterDescription/);
  assert.match(source, /replace\(\/\^provider\\.parameter\\.\/,/);
  assert.match(source, /uc-dynamic-parameters__key/);
  assert.match(source, /LuInfo/);
  assert.match(source, /uc-dynamic-parameters__info/);
  assert.match(source, /aria-describedby=\{descriptionId\}/);
  assert.match(source, /role="tooltip"/);
  assert.match(source, /background: '背景'/);
  assert.match(source, /output_compression: '输出压缩率'/);
  assert.match(source, /output_format: '输出格式'/);
  assert.match(source, /quality: '画面质量'/);
  assert.match(source, /response_format: '返回格式'/);
  assert.match(source, /size: '输出尺寸'/);
  assert.match(source, /输出宽×高/);
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
  assert.match(source, /\\d\+x\\d\+/);
  assert.match(source, /return `其他选项 \$\{index \+ 1\}`/);
});

test('dynamic parameter controls omit persistent state and move constraints into details', () => {
  assert.doesNotMatch(source, /uc-dynamic-parameters__value-state/);
  assert.doesNotMatch(source, /使用默认值|已设置/);
  assert.match(source, /placeholder={field\.required \? '请输入（必填）' : '可留空'}/);
  assert.match(source, /uc-dynamic-parameters__constraint/);
  assert.match(source, /填写要求/);
  assert.match(source, /description \|\| constraint/);
  assert.doesNotMatch(source, /function ParameterMeta/);
  assert.match(source, /不小于/);
  assert.match(source, /不大于/);
  assert.match(source, /仅限整数/);
  assert.match(source, /join\(' · '\)/);
  assert.match(source, /步长/);
  assert.match(source, /使用 JSON 对象格式/);
});

test('dynamic parameters use accessible controls and responsive stable layout', () => {
  assert.match(source, /<Toggle/);
  assert.match(source, /checkedChildren="开启"/);
  assert.match(source, /unCheckedChildren="关闭"/);
  assert.match(source, /label=\{displayParameterKey/);
  assert.match(source, /aria-label=\{displayParameterKey/);
  assert.match(styles, /\.uc-dynamic-parameters__control/);
  assert.match(source, /data-value-type=\{field\.valueType\}/);
  assert.match(source, /uc-dynamic-parameters-container/);
  assert.match(styles, /\.uc-dynamic-parameters-container\s*{[\s\S]*container-type: inline-size;/);
  assert.match(styles, /\.uc-dynamic-parameters\s*{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /@container \(min-width: 620px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(styles, /grid-template-columns: 7rem minmax\(0, 1fr\)/);
  assert.match(styles, /grid-template-areas: "label control"/);
  assert.match(styles, /\.uc-dynamic-parameters__control\s*{[\s\S]*grid-area: control;[\s\S]*width: 100%;/);
  assert.match(styles, /data-value-type='object'[\s\S]*?width: 100%/);
  assert.match(styles, /data-value-type='object'[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(styles, /min-height: 3\.25rem/);
  assert.match(styles, /min-height: 2\.25rem/);
  assert.match(styles, /data-invalid='true'/);
  assert.match(styles, /\.uc-dynamic-parameters__info-wrap:focus-within/);
  assert.match(styles, /\.uc-dynamic-parameters__tooltip/);
});
