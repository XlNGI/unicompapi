import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/settings/SettingsPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('A4 renders diagnostics and update panels from B4 facts', () => {
  for (const text of [
    '本地日志设置', '脱敏诊断包', '设置导入导出与恢复默认', '清除本机应用数据',
    '更新策略', '更新阻断与边界', '更新项状态'
  ]) {
    assert.match(page, new RegExp(text));
  }
  assert.match(page, /delivery: '当前已接入'/);
});

test('A4 consumes only controlled B4 IPC and confirmation operations', () => {
  for (const call of [
    'settings.getMaintenanceStatus()',
    'settings.previewDiagnosticBundle()',
    'settings.generateDiagnosticBundle()',
    'settings.openDiagnosticLocation(target)',
    'settings.checkForUpdates()',
    'settings.exportPortable()',
    'settings.prepareImport(snapshot.revision, document)'
  ]) {
    assert.match(page, new RegExp(call.replace(/[().]/g, '\\$&')));
  }
  assert.match(page, /kind: 'restore_all_defaults'/);
  assert.match(page, /kind: 'clear_local_application_data'/);
  assert.match(page, /localApplicationDataScopes/);
});

test('A4 keeps diagnostics local and separates reset from clear-data deletion', () => {
  for (const text of [
    '不会自动上传', '不展示日志原文或本机路径',
    '不包含本机目录授权、凭证、项目、日志或媒体文件',
    '这不是恢复默认设置',
    '项目、作品、任务、外部文件和原始素材始终排除',
    'settingsReset', 'credentialsDeleted', 'projectsExcluded', 'externalFilesExcluded'
  ]) {
    assert.match(page, new RegExp(text));
  }
});

test('A4 does not expose fake update execution controls', () => {
  for (const text of [
    '生产更新源未配置', '签名或完整性失败时只显示失败状态',
    '本阶段不提供下载、安装、修复、回退执行按钮'
  ]) {
    assert.match(page, new RegExp(text));
  }
  assert.doesNotMatch(page, />立即安装<|>修复更新<|>回退版本<|已是最新/);
});

test('A4 keeps maintenance panels responsive and keyboard visible', () => {
  assert.match(styles, /\.uc-settings__list-grid/);
  assert.match(styles, /\.uc-settings__scope-grid/);
  assert.match(styles, /\.uc-settings__update-list/);
  assert.match(styles, /\.uc-settings__text-block textarea:focus-visible/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
