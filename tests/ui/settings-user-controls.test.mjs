import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/settings/SettingsPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('A3 renders the four B3-backed user control panels', () => {
  for (const text of [
    '最小授权边界', '系统权限状态', '外发与费用确认', '数据保护',
    '当前代理事实', '代理模式', '自定义代理', '连接结果与超时',
    '通知渠道', '通知规则', '合并与关键提醒',
    '平台与注册状态', '编辑快捷键', '冲突规则'
  ]) {
    assert.match(page, new RegExp(text));
  }
});

test('A3 consumes controlled B3 ports without bypassing confirmation', () => {
  for (const kind of [
    'update_privacy_permissions',
    'update_proxy',
    'update_shortcuts',
    'restore_shortcut_defaults'
  ]) {
    assert.match(page, new RegExp(`kind: '${kind}'`));
  }
  assert.match(page, /settings\.stageProxyCredential\(credential\.username, credential\.secret\)/);
  assert.match(page, /settings\.openSystemSettings\(target\)/);
  assert.match(page, /settings\.sendTestNotification\(system, sound\)/);
  assert.match(page, /settings\.planOperation\(snapshot\.revision, operation\)/);
});

test('A3 keeps proxy secrets and fake success out of the renderer surface', () => {
  assert.match(page, /type="password"/);
  assert.match(page, /代理测试使用隔离请求，不发送项目内容、提示词、请求正文或服务商凭证/);
  assert.match(page, /活动请求没有被重试或改写/);
  assert.match(page, /不被通知结果改变/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|fetch\(|process\.platform|navigator\.platform/);
});

test('A3 keeps the panels accessible and responsive', () => {
  assert.match(page, /role="radiogroup" aria-label="网络代理模式"/);
  assert.match(page, /aria-label="快捷键平台"/);
  assert.match(page, /aria-label="代理认证值"/);
  assert.match(styles, /\.uc-settings__proxy-form/);
  assert.match(styles, /\.uc-settings__shortcut-list/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
