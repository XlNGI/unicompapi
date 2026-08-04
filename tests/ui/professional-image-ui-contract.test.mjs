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
const selectorSource = await readFile(
  'src/pages/creation/WorkspaceContextSelector.tsx',
  'utf8'
);
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const source = `${professionalSource}\n${featurePanelSource}\n${selectorSource}`;

test('professional image requires an explicit text or reference feature', () => {
  assert.match(professionalSource, /aria-label="生图方式"/);
  assert.match(professionalSource, /selectFeature\('text_to_image'\)/);
  assert.match(professionalSource, /selectFeature\('reference_to_image'\)/);
  assert.match(professionalSource, /文生图/);
  assert.match(professionalSource, /图生图/);
  assert.match(professionalSource, /图生图必须选择恰好一张图片/);
  assert.match(professionalSource, /文生图不能包含图片/);
  assert.match(professionalSource, /clearInput\(draft\.draftId\)/);
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
  assert.match(featurePanelSource, /parameterSchema\.fields/);
  assert.match(featurePanelSource, /display\?\.label/);
  assert.match(featurePanelSource, /可选参数/);
  assert.doesNotMatch(featurePanelSource, /ProviderRegistry|CapabilityEvidence/);
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
