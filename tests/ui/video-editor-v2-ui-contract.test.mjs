import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSource = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const stylesSource = await readFile('src/styles/pages.css', 'utf8');

test('V2-S2 renders real video frames with degraded placeholders', () => {
  // 渲染进程内提帧（隐藏 video + canvas），且任何失败都降级不阻塞
  assert.match(editorSource, /function extractVideoFrame\(/);
  assert.match(editorSource, /crossOrigin = 'anonymous'/);
  assert.match(editorSource, /toDataURL\('image\/jpeg', 0\.72\)/);
  assert.match(editorSource, /frameCacheRef/);
  // 真实帧/黑底序号占位/时长角标在 JSX 与 CSS 中成对出现
  for (const className of [
    'uc-video-editor__media-frame',
    'uc-video-editor__frame-fallback',
    'uc-video-editor__frame-dur'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className}`));
  }
  // 禁止彩色渐变假海报（上轮失败戒律 2）：占位只允许黑底序号
  assert.doesNotMatch(
    stylesSource,
    /\.uc-video-editor__frame-fallback \{[^}]*linear-gradient/
  );
});

test('V2-S3 select automatically loads preview with stale-response protection', () => {
  // selectClip 不再清空预览，而是自动 ensurePreview
  assert.match(editorSource, /function ensurePreview\(/);
  assert.match(
    editorSource,
    /function selectClip\([^)]*\)[^{]*\{[\s\S]{0,400}?void ensurePreview\(clipId\);/
  );
  // 竞态防护：请求 token 自增，过期响应丢弃
  assert.match(editorSource, /previewRequestRef/);
  // 手动入口语义降级为“刷新原片”
  assert.match(editorSource, /刷新原片/);
  // 失败空态文案
  assert.match(editorSource, /源文件不可用/);
});

test('V2-S4 keeps clip context stable with readable naming', () => {
  // 三分支命名解析：作品名 / 片段 N · 短码 / 片段 N
  assert.match(editorSource, /export function resolveClipDisplayName\(/);
  // mediaTab 只切换左栏渲染分支（tab 切换不触碰播放头/预览/选中）
  const tabBlock = editorSource.match(
    /mediaTab === 'timeline' \?[\s\S]{0,1200}?ProjectVideoList/
  );
  assert.ok(tabBlock);
  // tab 切换只调用 setMediaTab（不触碰 setPlayheadUs/setPreview/setSelectedClipId）
  const tabHandlers = editorSource.match(
    /onClick=\{\(\) => setMediaTab\('(timeline|project)'\)\}/g
  );
  assert.ok(tabHandlers && tabHandlers.length >= 2);
  // 摘要卡：帧 + 名称 + chips 常驻属性面板顶部
  for (const className of [
    'uc-video-editor__clip-summary',
    'uc-video-editor__clip-summary-name',
    'uc-video-editor__chip2'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className}`));
  }
  // 卡内删除：hover × → armed 确认（3 秒）
  assert.match(editorSource, /uc-video-editor__media-delete/);
  assert.match(editorSource, /'确认'/);
  assert.match(editorSource, /3_000/);
});

test('V2-S5 strengthens playhead visibility', () => {
  assert.match(editorSource, /uc-video-editor__playhead/);
  // thumb 16px webkit/moz 双写
  assert.match(stylesSource, /\.uc-video-editor__playhead::-webkit-slider-thumb[^}]*width: 16px/);
  assert.match(stylesSource, /\.uc-video-editor__playhead::-moz-range-thumb[^}]*width: 16px/);
  // 播放头高度 >= 24px
  assert.match(stylesSource, /\.uc-video-editor__playhead \{[^}]*height: 24px/);
  // ruler 时间戳等宽字体
  assert.match(
    stylesSource,
    /\.uc-video-editor__ruler \{[^}]*font-family: var\(--uc-font-family-mono/
  );
  // 主轨 lane 内播放头竖线
  assert.match(editorSource, /uc-video-editor__playhead-line/);
  assert.match(stylesSource, /\.uc-video-editor__playhead-line/);
});

test('V2-S6 defines the three-tier responsive system with a collapsed inspector drawer', () => {
  // W1 基础栅格 300px/1fr/320px
  assert.match(
    stylesSource,
    /\.uc-video-editor__workspace \{[^}]*grid-template-columns: 300px minmax\(0, 1fr\) 320px/
  );
  // W2 断点 1024-1339：250px 列 + 帧宽 72px
  assert.match(stylesSource, /@media \(max-width: 1339px\)/);
  const w2Block = stylesSource.match(/@media \(max-width: 1339px\) \{[\s\S]*?\n\}/);
  assert.ok(w2Block);
  assert.match(w2Block[0], /grid-template-columns: 250px minmax\(0, 1fr\) 300px/);
  assert.match(w2Block[0], /72px minmax\(0, 1fr\)/);
  // W3 断点 <1024：单列 + 折叠抽屉
  assert.match(stylesSource, /@media \(max-width: 1023px\)/);
  const w3Block = stylesSource.match(/@media \(max-width: 1023px\) \{[\s\S]*?\n\}/);
  assert.ok(w3Block);
  assert.match(w3Block[0], /max-height: 0/);
  assert.match(stylesSource, /\.uc-video-editor__inspector--expanded \{[^}]*max-height: 80vh/);
  // 抽屉按钮 aria-expanded 联动 + 仅窄屏显示
  assert.match(editorSource, /aria-expanded=\{inspectorExpanded\}/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__inspector-toggle \{[^}]*display: none/
  );
  // 旧 1280px 断点已收编：不再对编辑页栅格二次作用
  const legacyBlock = stylesSource.match(
    /@media \(max-width: 1280px\) \{[\s\S]*?\n\}/
  );
  assert.ok(legacyBlock);
  assert.doesNotMatch(legacyBlock[0], /uc-video-editor__workspace/);
  // 主轨帧条与 chip 化辅轨
  for (const className of [
    'uc-video-editor__lane',
    'uc-video-editor__lane--slim',
    'uc-video-editor__seg',
    'uc-video-editor__seg--selected',
    'uc-video-editor__seg-label',
    'uc-video-editor__chip'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className.replace(/--.*/, '')}`));
  }
});
