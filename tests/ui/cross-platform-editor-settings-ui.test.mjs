import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editor = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const settings = await readFile('src/pages/settings/SettingsPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('A3 keeps video editing on shared DTOs and cross-platform font facts', () => {
  assert.match(editor, /const defaultTextFontFamily = 'Arial'/);
  assert.match(editor, /document\.fonts\.check/);
  assert.match(editor, /selected\?\.style\.requestedFontFamily \?\? defaultTextFontFamily/);
  assert.doesNotMatch(
    editor,
    /Segoe UI|process\.platform|navigator\.platform|navigator\.userAgent/
  );
});

test('A3 keeps editor failures, recovery and registered-work success explicit', () => {
  for (const text of [
    '文件丢失',
    '存储已断开',
    '草稿使用的字体当前不可用',
    '目标磁盘空间不足',
    '正在请求取消',
    '执行已中断',
    '需要恢复',
    '作品已登记'
  ]) {
    assert.match(editor, new RegExp(text));
  }
  assert.match(editor, /task\?\.state === 'completed' && Boolean\(task\.workId\)/);
  assert.match(editor, /exportTask\?\.state !== 'completed'/);
  assert.match(editor, /storage\.createWorkMediaHandle\(exportTask\.workId\)/);
});

test('A3 maps shortcuts from controlled platform status without renderer detection', () => {
  assert.match(settings, /useState<ShortcutPlatform>\(status\.platform\)/);
  assert.match(settings, /binding\[platform\]/);
  assert.match(settings, /action\?\.defaults\[platform\]/);
  assert.match(settings, /platform === 'windows' \? binding\.windows : binding\.macos/);
  assert.doesNotMatch(
    settings,
    /process\.platform|navigator\.platform|navigator\.userAgent/
  );
});

test('A3 keeps editor and all ten settings categories responsive', () => {
  for (const label of [
    '常规',
    '存储与文件',
    '任务与性能',
    '本地媒体处理',
    '隐私与权限',
    '网络与代理',
    '通知',
    '快捷键',
    '日志与诊断',
    '应用更新'
  ]) {
    assert.match(settings, new RegExp(`label: '${label}'`));
  }
  assert.match(styles, /@media \(max-width: 1500px\)/);
  assert.match(styles, /@media \(max-width: 1180px\)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.uc-video-editor__workspace/);
  assert.match(styles, /\.uc-settings__workspace/);
});
