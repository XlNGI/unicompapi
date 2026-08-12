import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const professionalSource = await readFile(
  'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
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
const source = `${professionalSource}\n${featurePanelSource}\n${selectorSource}\n${enhancePanelSource}`;

test('professional image requires an explicit text or reference feature', () => {
  assert.match(professionalSource, /aria-label="生图方式"/);
  assert.match(professionalSource, /selectFeature\('text_to_image'\)/);
  assert.match(professionalSource, /selectFeature\('reference_to_image'\)/);
  assert.match(professionalSource, /文生图/);
  assert.match(professionalSource, /图生图/);
  assert.match(professionalSource, /图生图必须选择恰好一张图片/);
  assert.match(professionalSource, /文生图不能包含图片/);
  assert.match(professionalSource, /clearInput\(saved\.draftId\)/);
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

test('professional image shows in-page four-step submit progress', () => {
  assert.match(professionalSource, /showProgressSteps/);
  assert.match(featurePanelSource, /showProgressSteps = false/);
  assert.match(featurePanelSource, /SubmissionProgressSteps/);
  assert.match(progressStepsSource, /准备/);
  assert.match(progressStepsSource, /提交中/);
  assert.match(progressStepsSource, /生成中/);
  assert.match(progressStepsSource, /完成/);
  assert.match(progressStepsSource, /准备已完成/);
  assert.match(featurePanelSource, /busyRef/);
  assert.match(
    featurePanelSource,
    /Do NOT clear it on draft\.updatedAt \/ autosave/
  );
});

test('professional image preserves prompt layers and dynamic safe parameters', () => {
  for (const text of [
    '用户原始输入',
    '系统补充内容',
    '最终提交提示词',
    '没有真实增强结果',
    '服务、参数与确认'
  ]) {
    assert.match(source, new RegExp(text));
  }
  assert.match(professionalSource, /systemSupplements/);
  assert.match(professionalSource, /finalPrompt/);
  assert.match(
    featurePanelSource,
    /toDynamicParameterFields\(selectedCandidate\.parameterSchema\.fields\)/
  );
  assert.doesNotMatch(featurePanelSource, /ProviderRegistry|CapabilityEvidence/);
});

test('professional image hosts reusable prompt enhance without image Task', () => {
  assert.match(professionalSource, /ImagePromptEnhancePanel/);
  assert.match(enhancePanelSource, /promptEnhance/);
  assert.match(enhancePanelSource, /PromptEnhancePanel/);
  assert.match(promptEnhanceSource, /SubmissionProgressSteps/);
  assert.match(promptEnhanceSource, /必须：提示词增强/);
  assert.match(promptEnhanceSource, /可选：提示词增强/);
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
  assert.match(workbench, /正在自动保存/);
  assert.match(workbench, /已自动保存/);
  assert.match(workbench, /isProfessionalImage/);
  assert.match(workbench, /imageWorkspaces\.update\(/);
});

test('prompt enhance fixes reasoning and non-stream without a mode switch', () => {
  assert.match(promptEnhanceSource, /文本推理 · 非流式/);
  assert.doesNotMatch(promptEnhanceSource, /LuMessageCircle|LuBrainCircuit/);
  assert.doesNotMatch(promptEnhanceSource, /text_chat/);
  assert.doesNotMatch(promptEnhanceSource, /aria-label="文本能力"/);
  assert.match(enhanceServiceSource, /submitPromptOnce/);
  assert.doesNotMatch(enhanceServiceSource, /DeepSeekChatAdapter|NewApiChatAdapter/);
  assert.match(pageStyles, /\.uc-prompt-enhance/);
});

test('image submission keeps internal status codes out of user messages', () => {
  assert.match(featurePanelSource, /submission_outcome_unknown: '提交结果未知/);
  assert.doesNotMatch(featurePanelSource, /提交状态：\$\{result\.value\.status\}/);
  assert.doesNotMatch(featurePanelSource, /\$\{result\.error\.code\}/);
  assert.match(featurePanelSource, /!\/\[A-Za-z_\]\/u\.test\(rawFeedback\)/);
});

test('professional image uses controlled local media and the safe feature API', () => {
  for (const operation of ['selectInput', 'clearInput', 'createInputPreview']) {
    assert.match(professionalSource, new RegExp(`\\.${operation}\\(`));
  }
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
