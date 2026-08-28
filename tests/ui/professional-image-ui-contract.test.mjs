import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const professionalSource = await readFile(
  'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
  'utf8'
);
const historySource = await readFile(
  'src/components/GenerationHistory.tsx',
  'utf8'
);
const featurePanelSource = await readFile(
  'src/pages/creation/image/ImageFeatureSubmissionPanel.tsx',
  'utf8'
);
const enhancePanelSource = await readFile(
  'src/pages/creation/image/ImagePromptEnhancePanel.tsx',
  'utf8'
);
const promptEnhanceSource = await readFile(
  'src/components/PromptEnhancePanel.tsx',
  'utf8'
);
const selectorSource = await readFile(
  'src/pages/creation/WorkspaceContextSelector.tsx',
  'utf8'
);
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const enhanceServiceSource = await readFile(
  'src/platform/providers/prompt-enhance-submission.ts',
  'utf8'
);
const enhanceHostSource = await readFile(
  'src/platform/providers/image-prompt-enhance-host.ts',
  'utf8'
);
const pageStyles = await readFile('src/styles/pages.css', 'utf8');
const autosaveSource = await readFile(
  'src/application/latest-snapshot-autosave.ts',
  'utf8'
);
const autosaveStatusSource = await readFile(
  'src/components/AutosaveStatus.tsx',
  'utf8'
);
const source = `${professionalSource}\n${historySource}\n${featurePanelSource}\n${selectorSource}\n${enhancePanelSource}`;

test('professional image requires an explicit text or reference feature', () => {
  assert.match(professionalSource, /aria-label="生图方式"/);
  assert.match(professionalSource, /selectFeature\('text_to_image'\)/);
  assert.match(professionalSource, /selectFeature\('reference_to_image'\)/);
  assert.match(professionalSource, /文生图/);
  assert.match(professionalSource, /图生图/);
  assert.match(professionalSource, /图生图必须选择恰好一张图片/);
  assert.match(professionalSource, /文生图不能包含图片/);
  assert.match(professionalSource, /clearInput\(saved\.draftId\)/);
  assert.doesNotMatch(
    professionalSource,
    /图片用途|changeReferencePurpose|仅参考构图，不复制人物|input\.purpose|候选只在点击后读取/
  );
  assert.match(professionalSource, /uc-image-professional__placeholder/);
  assert.match(professionalSource, /<LuPlus \/>/);
  assert.doesNotMatch(professionalSource, /图片虚位以待/);
  assert.doesNotMatch(professionalSource, /受控本地预览，不代表生成结果/);
  assert.match(professionalSource, /aria-label="添加图片"/);
  assert.match(professionalSource, /onClick=\{\(\) => void selectReference\(\)\}/);
  assert.match(professionalSource, /uc-image-professional__preview-overlay/);
  assert.match(professionalSource, /uc-image-professional__preview-meta/);
  assert.doesNotMatch(professionalSource, /<strong>项目图片<\/strong>/);
  assert.match(professionalSource, /aria-label="删除图片"/);
  assert.match(professionalSource, /onClick=\{\(\) => void clearReference\(\)\}/);
  assert.match(professionalSource, /has-image/);
  assert.match(professionalSource, /is-empty/);
  assert.doesNotMatch(
    professionalSource,
    />\s*(?:选择图片|替换图片|清除图片)\s*</
  );
});

test('professional image embeds a compact reference control in the enlarged prompt input', () => {
  assert.match(
    professionalSource,
    /uc-image-professional__prompt-input[\s\S]*rows=\{8\}[\s\S]*ControlledImageDropZone/
  );
  assert.match(
    pageStyles,
    /\.uc-image-professional__prompt-input\s+\.uc-image-professional__prompt-textarea\s*\{[\s\S]*min-height:\s*220px;/
  );
  assert.match(
    pageStyles,
    /\.uc-image-professional__prompt-input\s*>\s*\.uc-controlled-image-drop-zone\s*\{[\s\S]*right:\s*var\(--uc-space-3\);[\s\S]*bottom:\s*var\(--uc-space-3\);[\s\S]*width:\s*132px;[\s\S]*height:\s*88px;/
  );
  assert.match(
    pageStyles,
    /\.uc-image-professional__prompt-input\.has-reference[\s\S]*\.uc-image-professional__prompt-textarea\s*\{[\s\S]*padding-bottom:\s*112px;/
  );
});

test('professional image can drag a verified result into the reference slot', () => {
  assert.match(historySource, /imageWorkDragDataType/);
  assert.match(historySource, /handleWorkDragStart/);
  assert.match(historySource, /draggable=\{Boolean\(selectedWorkId\)\}/);
  assert.match(professionalSource, /onDropWork=\{\(workId\)/);
  assert.match(professionalSource, /imageWorkspaces\.useWorkAsInput\(/);
  assert.doesNotMatch(professionalSource, /uc-image-professional__after-drop-zone/);
});

test('professional image consumes only revision-pinned ProjectContext', () => {
  assert.match(professionalSource, /projectContextsOnly/);
  assert.match(professionalSource, /reference\.kind !== 'project_context'/);
  assert.match(professionalSource, /reference\.contextRevision === undefined/);
  assert.match(selectorSource, /contextRevision,/);
  assert.match(selectorSource, /candidate\.revision\s*\n\s*\)}/);
  assert.match(selectorSource, /includeInPrompt: true/);
  assert.match(selectorSource, /projectContextsOnly[\s\S]*visibleSections/);
  assert.match(professionalSource, /清理旧上下文/);
});

test('professional image gates models until an explicit feature is chosen', () => {
  assert.match(professionalSource, /requireExplicitFeature/);
  assert.match(featurePanelSource, /requireExplicitFeature = false/);
  assert.match(featurePanelSource, /awaitingFeatureChoice/);
  assert.match(
    featurePanelSource,
    /请先在上方选择文生图或图生图；选定功能后才会显示可用模型与参数/
  );
  assert.match(
    professionalSource,
    /请先选择文生图或图生图，再显示可用模型与参数/
  );
  assert.match(featurePanelSource, /\{awaitingFeatureChoice \? \(/);
});

const progressStepsSource = await readFile(
  'src/components/SubmissionProgressSteps.tsx',
  'utf8'
);
const resultPreviewSource = await readFile(
  'src/components/GenerationResultPreview.tsx',
  'utf8'
);

test('professional image tracks submit progress for the result preview loading state', () => {
  assert.match(professionalSource, /onProgressChange={handleProgressChange}/);
  assert.doesNotMatch(professionalSource, /<SubmissionProgressSteps/);
  assert.doesNotMatch(professionalSource, /uc-image-professional__generation-state/);
  assert.match(featurePanelSource, /showProgressSteps = false/);
  assert.match(featurePanelSource, /trackProgress = showProgressSteps \|\| Boolean\(onProgressChange\)/);
  assert.match(featurePanelSource, /onProgressChange\?\.\(progressPhase, progressFailure\)/);
  assert.match(featurePanelSource, /SubmissionProgressSteps/);
  assert.match(progressStepsSource, /准备/);
  assert.match(progressStepsSource, /提交中/);
  assert.match(progressStepsSource, /生成中/);
  assert.match(progressStepsSource, /完成/);
  assert.match(progressStepsSource, /准备已完成/);
  assert.match(featurePanelSource, /busyRef/);
  assert.match(featurePanelSource, /await submitPrepared\(saved, result\.value\)/);
});

test('professional image uses a scrollable preparation pane and stable result pane', () => {
  assert.match(professionalSource, /aria-label="提交前准备区域"/);
  assert.match(professionalSource, /第一步 · 提交前准备/);
  assert.match(professionalSource, /uc-image-professional__before-scroll/);
  assert.doesNotMatch(professionalSource, /uc-image-professional__submit-bar/);
  assert.doesNotMatch(professionalSource, /actionHost={actionHost}/);
  assert.match(professionalSource, /className="uc-image-feature-panel--compact"/);
  assert.match(professionalSource, /collapseParameters/);
  assert.match(featurePanelSource, /createPortal\(primaryAction, actionHost\)/);
  assert.doesNotMatch(pageStyles, /\.uc-creation-simple \.uc-image-professional__submit-bar/);
  assert.match(pageStyles, /\.uc-image-feature-panel--compact \.uc-image-feature-panel__primary \{[\s\S]*min-height: 44px;/);
  assert.match(professionalSource, /aria-label="生成过程与作品区域"/);
  assert.match(professionalSource, /<GenerationHistory/);
  assert.doesNotMatch(professionalSource, /第二步 · 生成过程与作品/);
  assert.match(pageStyles, /\.uc-image-professional__workspace\s*{[\s\S]*grid-template-columns:[^;]+;/);
  assert.match(pageStyles, /\.uc-image-professional__before-scroll\s*{[\s\S]*overflow-y: auto;/);
  assert.match(pageStyles, /\.uc-image-professional__before-pane\s*{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(pageStyles, /\.uc-image-professional__workspace\s*{\s*height: auto;/);

  const inputStep = professionalSource.indexOf('<h2>创作方式与输入</h2>');
  const enhanceEntry = professionalSource.indexOf('<ImagePromptEnhancePanel');
  const promptStep = professionalSource.indexOf('<h2>最终提示词</h2>');
  const serviceStep = professionalSource.indexOf('<h2>服务与参数</h2>');
  assert.match(professionalSource, /enhancementContent \? \(/);
  assert.match(professionalSource, /enhancementContent \? '3' : '2'/);
  assert.ok(inputStep >= 0 && inputStep < enhanceEntry);
  assert.ok(enhanceEntry < promptStep);
  assert.ok(promptStep < serviceStep);
});

test('professional image shows an honest animated loading state inside the result preview', () => {
  assert.match(historySource, /loading={showLoadingPreview}/);
  assert.match(historySource, /const showLoadingPreview = generationInFlight && !selectedWorkId/);
  assert.match(historySource, /mediaKind === 'image' \? '图片' : '视频'/);
  assert.match(historySource, /完成后将校验并登记到本地/);
  assert.match(resultPreviewSource, /uc-generation-result-preview__loading/);
  assert.match(resultPreviewSource, /role="status"/);
  assert.match(resultPreviewSource, /uc-generation-result-preview__ring/);
  assert.match(resultPreviewSource, /LuSparkles/);
  assert.match(pageStyles, /\.uc-generation-result-preview__loading\s*{[\s\S]*min-height: 320px;/);
  assert.match(pageStyles, /\.uc-generation-result-preview__indicator\s*{[\s\S]*width: 76px;/);
  assert.match(pageStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.uc-generation-result-preview__ring/);
  assert.doesNotMatch(resultPreviewSource, /\d+%/);
});

test('professional image preserves the current result after submission', () => {
  assert.doesNotMatch(professionalSource, /onClearUi/);
  assert.doesNotMatch(
    professionalSource,
    /if \(phase === 'preparing'\)[\s\S]{0,160}setResultWorkId\(undefined\)/
  );
  assert.doesNotMatch(professionalSource, /resultSelection|setResultWorkId/);
  assert.match(professionalSource, /key={draft\.draftId}/);
  assert.match(historySource, /if \(!historyLoaded\) return/);
  assert.match(historySource, /works\.some\(\(work\) => work\.workId === selectedWorkId\)/);
  const start = workbenchSource.indexOf('<ImageProfessionalWorkspace');
  const end = workbenchSource.indexOf('/>', start);
  const invocation = workbenchSource.slice(start, end);
  assert.doesNotMatch(invocation, /onClearUi=/);
});

test('professional image history uses current-draft verified local works only', () => {
  for (const operation of ['listGenerationHistory', 'createWorkMediaHandle']) {
    assert.match(historySource, new RegExp(`storage\\.${operation}\\(`));
  }
  assert.doesNotMatch(historySource, /storage\.listTasks|storage\.listWorks|storage\.getTaskDetails|storage\.getWorkDetails/);
  assert.match(historySource, /projectId,/);
  assert.match(historySource, /draftId,/);
  assert.match(historySource, /mediaKind,/);
  assert.match(historySource, /limit: 20/);
  assert.match(historySource, /a\.createdAt\.localeCompare\(b\.createdAt\)/);
  assert.match(historySource, /aria-pressed={node\.work\.workId === selectedWorkId}/);
  assert.match(historySource, /setSelectedWorkId\(node\.work\.workId\)/);
  assert.doesNotMatch(historySource, /remoteUrls|resultImageUrl|fetch\(|localStorage/);
});

test('professional image history keeps concise truthful timeline states', () => {
  for (const text of [
    '生成历史',
    '张作品',
    '最新在右侧',
    '生成中',
    '结果待接收',
    '正在接收',
    '失败'
  ]) {
    assert.match(historySource, new RegExp(text));
  }
  assert.match(historySource, /const awaitingReceiptExecutionStates = new Set\(\[[\s\S]*'remote_completed'/);
  assert.match(historySource, /const receivingExecutionStates = new Set\(\[[\s\S]*'downloading'[\s\S]*'writing'[\s\S]*'verifying'/);
  const pendingStates = historySource.match(
    /const pendingExecutionStates = new Set\(\[([\s\S]*?)\]\);/
  )?.[1] ?? '';
  assert.doesNotMatch(pendingStates, /remote_completed|downloading|writing|verifying/);
  assert.match(pageStyles, /\.uc-generation-history__status--awaiting-receipt\s*{[\s\S]*status-warning/);
  assert.match(pageStyles, /\.uc-generation-history__status--receiving\s*{[\s\S]*status-info/);
  assert.match(pageStyles, /\.uc-generation-history__marker--awaiting_receipt\s*{/);
  assert.match(pageStyles, /\.uc-generation-history__marker--receiving\s*{/);
  assert.doesNotMatch(historySource, /当前草稿的生成历史|按生成时间排列/);
  assert.match(historySource, /latestExecutionUpdatedAt \?\? task\.createdAt/);
  assert.match(historySource, /startedAt \?\? new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(historySource, /onLocalStorageChanged/);
  assert.match(historySource, /timeline\.scrollLeft = timeline\.scrollWidth/);
  assert.match(historySource, /onWheel={handleTimelineWheel}/);
  assert.match(historySource, /event\.deltaX/);
  assert.match(historySource, /event\.deltaY/);
  assert.match(historySource, /event\.preventDefault\(\)/);
  assert.match(historySource, /timeline\.scrollWidth <= timeline\.clientWidth/);
  assert.match(historySource, /nextScrollLeft === timeline\.scrollLeft/);
  assert.match(pageStyles, /\.uc-generation-history\s*{[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.match(pageStyles, /\.uc-generation-history__timeline-scroll\s*{[\s\S]*overflow-x: auto;/);
  assert.match(pageStyles, /\.uc-generation-history__node\s*{[\s\S]*grid-template-rows: 86px 8px 18px;/);
  assert.match(pageStyles, /\.uc-generation-history__work img,[\s\S]*\.uc-generation-history__work video\s*{[\s\S]*object-fit: contain;/);
  assert.match(
    pageStyles,
    /\.uc-generation-history__preview \.uc-generation-result-preview img,[\s\S]*\.uc-generation-history__preview \.uc-generation-result-preview video\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*max-width: 100%;[\s\S]*max-height: 100%;[\s\S]*object-fit: contain;/
  );
});

test('professional image shows only the final prompt and dynamic safe parameters', () => {
  for (const text of ['最终提交提示词', '服务与参数']) {
    assert.match(source, new RegExp(text));
  }
  assert.doesNotMatch(professionalSource, /用户原始输入/);
  assert.doesNotMatch(professionalSource, /系统补充内容/);
  assert.doesNotMatch(professionalSource, /没有真实增强结果/);
  assert.match(professionalSource, /systemSupplements/);
  assert.match(professionalSource, /finalPrompt/);
  assert.match(
    featurePanelSource,
    /toDynamicParameterFields\(selectedCandidate\.parameterSchema\.fields\)/
  );
  assert.doesNotMatch(featurePanelSource, /ProviderRegistry|CapabilityEvidence/);
  assert.match(professionalSource, /showCandidateFacts=\{false\}/);
  assert.match(featurePanelSource, /showCandidateFacts = true/);
  assert.match(featurePanelSource, /\{showCandidateFacts \? \(/);
});

test('professional image hosts reusable prompt enhance without image Task', () => {
  assert.match(professionalSource, /ImagePromptEnhancePanel/);
  assert.match(professionalSource, /uc-image-professional__prompt-tools/);
  assert.match(professionalSource, /<WorkspaceContextSelector\s+compact/);
  assert.match(professionalSource, /<ImagePromptEnhancePanel\s+compact/);
  assert.match(enhancePanelSource, /promptEnhance/);
  assert.match(enhancePanelSource, /compact=\{compact\}/);
  assert.match(enhancePanelSource, /PromptEnhancePanel/);
  assert.match(promptEnhanceSource, /<ModelSelect/);
  assert.match(promptEnhanceSource, /aria-expanded=\{compact \? open : undefined\}/);
  assert.match(promptEnhanceSource, /uc-prompt-enhance--compact/);
  assert.match(promptEnhanceSource, /label=\{compact \? '增强模型' : undefined\}/);
  assert.match(promptEnhanceSource, /showEmptyState=\{!compact\}/);
  assert.match(promptEnhanceSource, /compact \|\| selectedCandidate/);
  assert.match(promptEnhanceSource, /确认增强/);
  assert.match(promptEnhanceSource, /host\.originalInput\.trim\(\)/);
  assert.doesNotMatch(promptEnhanceSource, /在线运行未授权|在线文本运行尚未获准/);
  assert.match(promptEnhanceSource, /submission\.error\.code === 'runtime_not_allowed'/);
  assert.match(promptEnhanceSource, /setOpen\(false\)/);
  assert.doesNotMatch(promptEnhanceSource, /SubmissionProgressSteps|DynamicParameterForm|Checkbox/);
  assert.doesNotMatch(promptEnhanceSource, /准备增强|确认本次提示词增强外发/);
  assert.doesNotMatch(professionalSource, /合并增强到最终提示词/);
  assert.match(enhanceHostSource, /source: 'enhancement'/);
  assert.match(enhanceServiceSource, /PromptEnhanceSubjectPort/);
  assert.doesNotMatch(
    enhanceServiceSource + enhanceHostSource,
    /createImageTask|ImageDraftArtifactFactory/
  );
  assert.doesNotMatch(
    enhancePanelSource,
    /createTask\(|createExecution\(|submitDraft\(/
  );
  assert.doesNotMatch(professionalSource, /ImageToPromptWorkspace/);
  assert.doesNotMatch(
    featurePanelSource,
    /请先保存本地草稿，再读取候选或准备生成/
  );
  assert.doesNotMatch(
    enhancePanelSource,
    /请先保存本地草稿，再准备提示词增强/
  );
});

test('professional image autosaves drafts without a manual save gate', async () => {
  const workbench = await readFile(
    'src/pages/creation/image/ImageWorkbenchPage.tsx',
    'utf8'
  );
  assert.match(workbench, /useLatestSnapshotAutosave/);
  assert.match(workbench, /debounceMs: 1_000/);
  assert.match(workbench, /imageWorkspaces\.update\(/);
  assert.match(workbench, /onFlushDraft=\{\(\) => autosave\.flush\(\)\}/);
  assert.match(autosaveSource, /private inFlight\?/);
  assert.match(autosaveSource, /private pending\?/);
  assert.match(autosaveSource, /this\.pending = \{ sequence: \+\+this\.sequence, snapshot \}/);
  assert.match(autosaveStatusSource, /有未保存修改/);
  assert.match(autosaveStatusSource, /正在保存/);
  assert.match(autosaveStatusSource, /保存失败，修改已保留/);
  assert.doesNotMatch(featurePanelSource, /if \(needsSave && imageWorkspaces\)/);
  assert.match(featurePanelSource, /onMessageRef\.current/);
  assert.match(featurePanelSource, /showBlockedReason = true/);
  assert.match(featurePanelSource, /showBlockedReason && blockedReason/);
  assert.match(professionalSource, /onBlockingReasonChange/);
  assert.match(professionalSource, /showBlockedReason=\{false\}/);
  assert.doesNotMatch(professionalSource, /<strong>当前不能生成<\/strong>/);
});

test('prompt enhance keeps model selection and one-click confirmation', () => {
  assert.match(promptEnhanceSource, /api\.listCandidates\(\)/);
  assert.match(promptEnhanceSource, /api\.prepare\(/);
  assert.match(promptEnhanceSource, /api\.submit\(/);
  assert.match(promptEnhanceSource, /result\.value\.confirmation\.confirmationId/);
  assert.match(promptEnhanceSource, /true\s*\n\s*\)/);
  assert.doesNotMatch(promptEnhanceSource, /LuMessageCircle|LuBrainCircuit/);
  assert.doesNotMatch(promptEnhanceSource, /text_chat/);
  assert.doesNotMatch(promptEnhanceSource, /aria-label="文本能力"/);
  assert.match(enhanceServiceSource, /拼接好的结构化文案/);
  assert.match(enhanceServiceSource, /根据语义进行优化/);
  assert.match(enhanceServiceSource, /submitPromptOnce/);
  assert.doesNotMatch(enhanceServiceSource, /DeepSeekChatAdapter|NewApiChatAdapter/);
  assert.match(pageStyles, /\.uc-prompt-enhance/);
});

test('image submission keeps internal status codes out of user messages', () => {
  assert.match(featurePanelSource, /submission_outcome_unknown: '提交结果未知/);
  assert.doesNotMatch(featurePanelSource, /提交状态：\$\{result\.value\.status\}/);
  assert.doesNotMatch(featurePanelSource, /\$\{result\.error\.code\}/);
  assert.match(featurePanelSource, /!\/\[A-Za-z_\]\/u\.test\(rawFeedback\)/);
  assert.doesNotMatch(professionalSource, /在线运行未授权/);
});

test('professional image uses controlled local media and the safe feature API', () => {
  for (const operation of ['selectInput', 'clearInput', 'createInputPreview']) {
    assert.match(professionalSource, new RegExp(`\\.${operation}\\(`));
  }
  assert.match(
    professionalSource,
    /selectInput\([\s\S]*?onDraftPersisted\(result\.value\.draft/
  );
  assert.match(
    professionalSource,
    /importInput\([\s\S]*?onDraftPersisted\(result\.value\.draft/
  );
  assert.match(
    professionalSource,
    /useWorkAsInput\([\s\S]*?onDraftPersisted\(result\.value\.draft/
  );
  assert.match(
    professionalSource,
    /clearInput\([\s\S]*?onDraftPersisted\(result\.value/
  );
  for (const operation of ['listCandidates', 'prepareSubmission', 'submitDraft']) {
    assert.match(featurePanelSource, new RegExp(`api\\.${operation}\\(`));
  }
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|absolutePath|upload|apiKey|credential|endpoint|RouteSnapshot/
  );
  assert.doesNotMatch(
    professionalSource,
    /创建图片任务|创建执行记录|createTask\(|createExecution\(|invokeExecution\(/
  );
});

test('workbench does not pass the old provider registry into professional image', () => {
  const start = workbenchSource.indexOf('<ImageProfessionalWorkspace');
  const end = workbenchSource.indexOf('/>', start);
  const invocation = workbenchSource.slice(start, end);
  assert.doesNotMatch(invocation, /registry=|onVideoDraftCreated/);
});
