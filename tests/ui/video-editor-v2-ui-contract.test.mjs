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
    /function selectClip\([^)]*\)[^{]*\{[\s\S]{0,700}?void ensurePreview\([\s\S]{0,140}?clipId,[\s\S]{0,140}?nextPlayheadUs,[\s\S]{0,80}?resumePlayback/
  );
  // 竞态防护：请求 token 自增，过期响应丢弃
  assert.match(editorSource, /previewRequestRef/);
  // 分割等草稿更新后，预览必须保留分割前的时间线播放头，
  // 并由新草稿的当前状态换算到源视频时间，不能再保存第二份待 seek 草稿。
  assert.match(
    editorSource,
    /command\.kind === 'split_clip' \? playheadUs : undefined/
  );
  assert.match(editorSource, /preferredSegment\?\.clipId/);
  assert.match(editorSource, /timelineToSourceUs\(/);
  assert.match(editorSource, /timelineToSourceUs\(draft, clipId, timelineUs\)/);
  // 预览只读取真实源媒体，不向用户暴露半成品画质切换。
  assert.match(editorSource, /createSourcePreview\(draft\.draftId, clipId\)/);
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

test('V2-S5 uses one draggable main-track playhead without a duplicate slider row', () => {
  assert.doesNotMatch(editorSource, /className="uc-video-editor__playhead"/);
  assert.doesNotMatch(stylesSource, /\.uc-video-editor__playhead::-(?:webkit|moz)-/);
  assert.match(editorSource, /role="slider"/);
  assert.match(editorSource, /aria-label="主轨播放头"/);
  assert.match(editorSource, /onMouseDown=/);
  assert.match(editorSource, /window\.requestAnimationFrame\(/);
  assert.match(editorSource, /window\.cancelAnimationFrame\(/);
  assert.equal(
    editorSource.match(/className="uc-video-editor__playhead-line"/g)?.length,
    1
  );
  assert.match(editorSource, /className="uc-video-editor__timeline-grid"/);
  assert.match(editorSource, /className="uc-video-editor__timeline-primary"/);
  assert.match(editorSource, /className="uc-video-editor__playhead-layer"/);
  // ruler 时间戳等宽字体
  assert.match(
    stylesSource,
    /\.uc-video-editor__ruler \{[^}]*font-family: var\(--uc-font-family-mono/
  );
  // 主轨内只保留一条可操作竖线，并以扩大命中区 + 伪元素绘制细线
  assert.match(editorSource, /uc-video-editor__playhead-line/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__playhead-line \{[^}]*width: 16px[^}]*cursor: ew-resize/
  );
  assert.match(stylesSource, /\.uc-video-editor__playhead-line::after/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__playhead-layer \{[^}]*position: absolute;[^}]*inset: 0;[^}]*pointer-events: none/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__timeline-primary \{[^}]*position: relative;/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__timeline-primary \{[^}]*isolation: isolate;/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__playhead-layer \{[^}]*z-index: 20;/
  );
});

test('V2-S6 defines the three-tier responsive system with a collapsed inspector drawer', () => {
  assert.match(
    stylesSource,
    /\.uc-video-editor \{[^}]*width: 100%/
  );
  assert.doesNotMatch(
    stylesSource.match(/\.uc-video-editor \{[^}]*\}/)?.[0] ?? '',
    /max-width|margin-inline/
  );
  // W1 基础栅格加宽项目素材列，时间线横跨完整工作区。
  assert.match(
    stylesSource,
    /\.uc-video-editor__workspace \{[^}]*grid-template-columns: 380px minmax\(0, 1fr\) 320px[^}]*grid-template-rows: minmax\(260px, 1fr\) minmax\(160px, 38%\)/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__media-bin,\s*\.uc-video-editor__preview,\s*\.uc-video-editor__inspector \{[^}]*gap: 0;[^}]*padding: 0/
  );
  // W2：外层窗口缩小时仍保持三栏，素材条目同步收紧。
  assert.match(stylesSource, /@media \(max-width: 1412px\)/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__timeline-primary\s*> \.uc-video-editor__track--video,\s*\.uc-video-editor__timeline-primary\s*> \.uc-video-editor__track--video\s*\.uc-video-editor__lane \{\s*min-height: 76px/
  );
  const w2Block = stylesSource.match(/@media \(max-width: 1412px\) \{[\s\S]*?\n\}/);
  assert.ok(w2Block);
  assert.match(w2Block[0], /grid-template-columns: 250px minmax\(400px, 1fr\) 280px/);
  assert.match(w2Block[0], /72px minmax\(0, 1fr\)/);
  // W3 断点 <1024：单列 + 折叠抽屉
  assert.match(stylesSource, /@media \(max-width: 1023px\)/);
  const w3Block = stylesSource.match(/@media \(max-width: 1023px\) \{[\s\S]*?\n\}/);
  assert.ok(w3Block);
  assert.match(w3Block[0], /max-height: 0/);
  assert.match(
    stylesSource,
    /@media \(max-width: 1023px\)[\s\S]*?\.uc-video-editor__center > \.uc-video-editor__preview \{\s*min-height: 280px/
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 1023px\)[\s\S]*?\.uc-video-editor__media-bin \{[^}]*min-height: 320px/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__inspector-body \{[^}]*flex: 0 0 auto;[^}]*max-height: 0;[^}]*overflow: hidden;[^}]*padding-block: 0/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__inspector--expanded \.uc-video-editor__inspector-body \{[^}]*max-height: 80vh/
  );
  // 抽屉按钮 aria-expanded 联动 + 仅窄屏显示
  assert.match(editorSource, /aria-expanded=\{inspectorExpanded\}/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__inspector-toggle \{[^}]*display: none/
  );
  assert.match(stylesSource, /\.uc-video-editor \{[^}]*container-type: inline-size/);
  assert.match(stylesSource, /@container \(max-width: 944px\)/);
  assert.match(
    stylesSource,
    /@media \(max-width: 1176px\)[\s\S]*?\.workspace\.workspace--video-editing \{\s*overflow: auto/
  );
  assert.match(stylesSource, /\.uc-video-editor__header \{[^}]*position: sticky/);
  assert.match(stylesSource, /\.uc-video-editor__save-state-dot/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__inspector-body > \.uc-video-editor__tabs \{[^}]*position: sticky;[^}]*top: 0;[^}]*z-index: 3;[^}]*margin: 0 -14px;[^}]*padding: 10px 14px;[^}]*background: var\(--uc-color-surface-panel\)/
  );
  assert.match(editorSource, /uc-video-editor__track uc-video-editor__track--video/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__timeline-primary > \.uc-video-editor__track--video \.uc-video-editor__lane \{[^}]*gap: 0/
  );
  assert.doesNotMatch(stylesSource, /uc-video-editor__track:first-of-type/);
  assert.doesNotMatch(stylesSource, /uc-video-editor__track:not\(:first-of-type\)/);
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

test('V2-S7 aligns the timeline scale and wires drag reorder to move_clip', () => {
  assert.match(
    stylesSource,
    /\.uc-video-editor__timeline \{[^}]*--uc-video-editor-track-label-width: 90px;[^}]*grid-template-columns:\s*var\(--uc-video-editor-track-label-width\) minmax\(0, 1fr\)/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__ruler \{[^}]*grid-column: 2/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__track \{[^}]*grid-template-columns:\s*var\(--uc-video-editor-track-label-width, 90px\) minmax\(0, 1fr\)/
  );
  assert.match(editorSource, /draggable=\{canReorder\}/);
  assert.match(editorSource, /onDragStart=/);
  assert.match(editorSource, /onDragOver=/);
  assert.match(editorSource, /onDrop=/);
  assert.match(editorSource, /dataTransfer\.setData\('text\/plain', segment\.clipId\)/);
  assert.match(editorSource, /kind: 'move_clip',[\s\S]{0,120}?clipId,[\s\S]{0,120}?toIndex/);
});

test('V2-S8 switches preview ownership when a timeline seek crosses clips', () => {
  assert.match(
    editorSource,
    /function seekTimeline\([^)]*\)[^{]*\{[\s\S]{0,500}?resolveTimelineSegmentAt\(segments, boundedUs\)/
  );
  assert.match(
    editorSource,
    /function seekTimeline\([^)]*\)[^{]*\{[\s\S]{0,700}?setSelectedClipId\(targetSegment\.clipId\)/
  );
  assert.match(
    editorSource,
    /function seekTimeline\([^)]*\)[^{]*\{[\s\S]{0,1100}?ensurePreview\([\s\S]{0,120}?targetSegment\.clipId,[\s\S]{0,120}?boundedUs/
  );
  const ensurePreviewSource = editorSource.match(
    /async function ensurePreview\([\s\S]*?\n  }\n\n  async function requestProxy/
  )?.[0] ?? '';
  assert.doesNotMatch(
    ensurePreviewSource,
    /existing\?\.clipId !== clipId[\s\S]{0,160}?setPreview\(undefined\)/
  );
});

test('V2-S9 keeps timeline seeks authoritative until the target frame is rendered', () => {
  assert.match(editorSource, /pendingPreviewSeekRef/);
  assert.match(editorSource, /onSeeked=\{completePreviewSeek\}/);
  assert.match(editorSource, /aria-busy=\{previewSeeking\}/);
  assert.match(
    editorSource,
    /function syncPlayheadFromPreview\(\)[^{]*\{[\s\S]{0,180}?if \(pendingPreviewSeekRef\.current\) return;/
  );
  assert.match(
    editorSource,
    /videoRef\.current\.currentTime = pending\.sourceUs \/ 1_000_000/
  );
  assert.match(
    editorSource,
    /function applyPendingPreviewSeek\(\)[\s\S]{0,260}?videoRef\.current\.seeking/
  );
  assert.match(
    editorSource,
    /Math\.abs\(sourceUs - pending\.sourceUs\) > 50_000[\s\S]{0,100}?applyPendingPreviewSeek\(\)/
  );
  assert.doesNotMatch(editorSource, /videoRef\.current\.fastSeek\(/);
  assert.doesNotMatch(editorSource, /正在切换片段/);
  assert.doesNotMatch(stylesSource, /\.uc-video-editor__preview-switching/);
  assert.doesNotMatch(editorSource, /uc-video-editor__preview-playhead/);
  assert.doesNotMatch(stylesSource, /webkit-media-controls-current-time-display/);
});

test('V2-S10 plays the timeline continuously with source audio, music and text overlays', () => {
  assert.match(editorSource, /function toggleTimelinePlayback\(/);
  assert.match(editorSource, /function advanceTimelinePlayback\(/);
  assert.match(
    editorSource,
    /function advanceTimelinePlayback\(\)[\s\S]{0,260}?previewHandleRef\.current\?\.clipId/
  );
  assert.match(editorSource, /onEnded=\{advanceTimelinePlayback\}/);
  assert.match(editorSource, /timelinePlayingRef/);
  assert.match(editorSource, /createBackgroundMusicPreview\(/);
  assert.match(editorSource, /<audio/);
  assert.match(editorSource, /className="uc-video-editor__preview-text"/);
  assert.match(editorSource, /clip\.sourceAudio\.volumePermille/);
  assert.match(editorSource, /clip\.speed\.numerator/);
  assert.match(editorSource, /\{timelinePlaying \? '暂停' : '播放'\}/);
  assert.match(stylesSource, /\.uc-video-editor__preview-stage \{[^}]*position: relative/);
});

test('V2-S11 mirrors the mature preview transport with real viewing controls', () => {
  assert.match(editorSource, /className="uc-video-editor__transport-time"/);
  assert.match(editorSource, /className="uc-video-editor__transport-play"/);
  assert.doesNotMatch(editorSource, /aria-label="预览画质"/);
  assert.match(editorSource, /aria-label="预览缩放"/);
  assert.match(editorSource, /aria-label="画布比例"/);
  assert.match(editorSource, /placement="bottomEnd"/);
  assert.match(editorSource, /适应（原始）/);
  assert.match(editorSource, /自定义/);
  assert.match(editorSource, /16:9（西瓜视频）/);
  assert.match(editorSource, /label: '4:3'/);
  assert.match(editorSource, /label: '2\.35:1'/);
  assert.match(editorSource, /label: '2:1'/);
  assert.match(editorSource, /label: '1\.85:1'/);
  assert.match(editorSource, /9:16（抖音）/);
  assert.match(editorSource, /label: '3:4'/);
  assert.match(editorSource, /label: '5\.8寸'/);
  assert.match(editorSource, /label: '1:1'/);
  assert.match(editorSource, /label: '1:2'/);
  assert.match(editorSource, /function selectCanvasRatio/);
  assert.match(editorSource, /kind: 'set_canvas'/);
  assert.match(editorSource, /className="uc-video-editor__preview-canvas"/);
  assert.match(editorSource, /aspectRatio: currentDraft \? canvasPreviewAspectRatio\(currentDraft\)/);
  assert.match(stylesSource, /\.uc-video-editor__preview-canvas/);
  assert.match(editorSource, /LuZoomIn/);
  assert.match(editorSource, /LuChevronDown/);
  assert.match(editorSource, /LuCheck/);
  assert.match(editorSource, /全屏预览|退出全屏预览/);
  assert.match(editorSource, /LuMaximize2/);
  assert.match(editorSource, /LuMinimize2/);
  assert.doesNotMatch(editorSource, /requestFullscreen\(\)/);
  assert.doesNotMatch(editorSource, /document\.exitFullscreen\(\)/);
  assert.match(editorSource, /uc-video-editor__center--expanded/);
  assert.match(stylesSource, /\.uc-video-editor__transport-tools/);
  assert.match(stylesSource, /\.uc-video-editor__center--expanded/);
  assert.doesNotMatch(stylesSource, /\.uc-video-editor__center:fullscreen/);
});

test('V2-S12 exposes zoom and the selected canvas ratio without a quality button', () => {
  assert.doesNotMatch(editorSource, /requestPreviewArtifact\(/);
  assert.doesNotMatch(editorSource, /type PreviewQuality =/);
  assert.match(editorSource, /type PreviewZoom =/);
  assert.match(editorSource, /适应/);
  assert.match(editorSource, /50%/);
  assert.match(editorSource, /100%/);
  assert.match(editorSource, /200%/);
  assert.match(editorSource, /transform: previewZoom === 'fit'/);
  assert.match(editorSource, /menuStyle=\{\{ minWidth: 184, maxHeight: 356/);
  assert.equal(editorSource.match(/placement="bottomEnd"/g)?.length, 2);
  assert.match(editorSource, /function selectedCanvasRatioLabel\(/);
  assert.match(editorSource, /selectedCanvasRatioLabel\(currentDraft\)/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__center \{[^}]*grid-column: 2;[^}]*overflow: visible/
  );
  assert.match(editorSource, /className="uc-video-editor__ratio-item"/);
  assert.match(
    editorSource,
    /label: '5\.8寸', numerator: 6, denominator: 13/
  );
  assert.doesNotMatch(editorSource, /const \[previewFit,/);
  assert.doesNotMatch(editorSource, /uc-video-editor__video--cover/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__preview-stage \{[^}]*background: var\(--uc-color-surface-subtle\)/
  );
  assert.doesNotMatch(stylesSource, /\.uc-video-editor__quality-option/);
  assert.match(stylesSource, /\.uc-video-editor__ratio-item/);
});

test('V2-S13 implements the approved editor layout and compact-window behavior', () => {
  assert.doesNotMatch(editorSource, /<span>编辑草稿<\/span>/);
  assert.match(editorSource, /className="uc-video-editor__save-state/);
  assert.equal(editorSource.match(/<StatusPill tone=\{saveStateTones\[saveState\]\}>/g)?.length ?? 0, 0);

  assert.match(editorSource, /storage=\{storage\}/);
  assert.match(editorSource, /function ProjectVideoThumbnail\(/);
  assert.match(editorSource, /createWorkMediaHandle\(work\.workId, work\.projectId\)/);
  assert.match(editorSource, /className="uc-video-editor__project-work-preview"/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__project-works \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*grid-auto-rows: max-content;/
  );
  assert.match(editorSource, /className="uc-video-editor__project-works uc-scrollbar"/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__media-bin > \.uc-video-editor__project-works \{[^}]*overflow-y: scroll;[^}]*scrollbar-gutter: stable;/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__media-list \{[^}]*align-content: start;[^}]*grid-auto-rows: max-content;/
  );

  assert.match(editorSource, /const \[timelineCollapsed, setTimelineCollapsed\]/);
  assert.match(editorSource, /aria-controls="uc-video-editor-timeline-content"/);
  assert.match(editorSource, /aria-expanded=\{!timelineCollapsed\}/);
  assert.match(editorSource, /className="uc-video-editor__timeline-summary"/);
  assert.match(stylesSource, /\.uc-video-editor__timeline \{[^}]*grid-column: 1 \/ -1/);
  assert.match(stylesSource, /\.uc-video-editor__inspector \{[^}]*grid-row: 1/);

  const mediumContainer = stylesSource.match(/@container \(max-width: 1180px\)[\s\S]*?@container \(max-width: 944px\)/)?.[0] ?? '';
  assert.match(mediumContainer, /grid-template-columns: 250px minmax\(400px, 1fr\) 280px/);
  assert.doesNotMatch(mediumContainer, /grid-template-columns: minmax\(0, 1fr\)/);
});
