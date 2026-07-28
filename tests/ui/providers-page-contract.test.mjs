import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/providers/ProvidersPage.tsx', 'utf8');

test('provider page consumes the controlled local registry without preset vendors', () => {
  assert.match(source, /providersApi\.getRegistry\(\)/);
  assert.match(source, /当前没有服务商或模型数据/);
  assert.match(source, /由你填写，不预置厂商/);
  assert.doesNotMatch(source, /OpenAI|Anthropic|Google AI|Midjourney|Stable Diffusion/);
});

test('provider page exposes the required controlled management actions', () => {
  for (const action of [
    'createProvider',
    'createConnection',
    'updateConnection',
    'setConnectionEnabled',
    'deleteConnection',
    'registerManualModel',
    'setModelEnabled'
  ]) assert.match(source, new RegExp(`providersApi\\.${action}`));
  assert.match(source, /添加服务/);
  assert.match(source, /自定义兼容接口/);
  assert.match(source, /连接状态筛选/);
});

test('provider page keeps connection, catalog, model and capability facts separate', () => {
  assert.match(source, /连接和能力仍需分别验证/);
  assert.match(source, /目录同步、模型启用和具体能力验证是三个独立状态/);
  assert.match(source, /validateConnection/);
  assert.match(source, /syncModelCatalog/);
  assert.match(source, /validateCapability/);
  assert.match(source, /verified_supported: '已验证支持'/);
  assert.match(source, /declared_supported: '服务声明支持'/);
});

test('provider credentials stay write-only and report the secure-storage status', () => {
  assert.match(source, /type="password"/);
  assert.match(source, /saveCredential/);
  assert.match(source, /getCredentialStatus/);
  assert.match(source, /checkCredentialStorage/);
  assert.match(source, /deleteLocalCredential/);
  assert.match(source, /已安全保存（不回显）/);
  assert.match(source, /安全存储暂不可验证/);
  assert.match(source, /本地凭证已删除/);
  assert.match(source, /不等于撤销服务商侧/);
  assert.doesNotMatch(source, /readCredential|copyCredential/);
});

test('provider page reports unavailable online adapters and unknown costs honestly', () => {
  assert.match(source, /adapter_unavailable/);
  assert.match(source, /不会伪造成功/);
  assert.match(source, /费用：未知/);
  assert.match(source, /隐私：未知/);
  assert.match(source, /提交任务前仍需确认费用与外发范围/);
});
