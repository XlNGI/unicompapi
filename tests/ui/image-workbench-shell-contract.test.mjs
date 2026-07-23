import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const modesSource = await readFile(
  'src/pages/creation/creationModes.ts',
  'utf8'
);
const imagePages = await Promise.all(
  [
    'ImageQuickPage.tsx',
    'ImageProfessionalPage.tsx',
    'ImageUnderstandingPage.tsx',
    'ImageEditingPage.tsx',
    'ImageToPromptPage.tsx'
  ].map((name) =>
    readFile(`src/pages/creation/image/${name}`, 'utf8')
  )
);

test('image workbench uses only the real B1 local draft operations', () => {
  assert.match(workbenchSource, /storage\.getProjectSession\(\)/);
  assert.match(workbenchSource, /imageWorkspaces\.list\(\)/);
  assert.match(workbenchSource, /imageWorkspaces\.create\(mode\.workspaceMode\)/);
  assert.match(workbenchSource, /imageWorkspaces\.update\(/);
  assert.match(workbenchSource, /providers[\s\S]{0,40}\.getRegistry\(\)/);
  assert.doesNotMatch(
    workbenchSource,
    /fetch\(|upload|generateImage|analyzeImage|submitTask|createTask|localStorage/
  );
});

test('image workbench keeps blocked and unknown states honest', () => {
  for (const text of [
    '需要先打开项目',
    '正在读取图片工作区',
    '当前没有图片输入',
    '本地草稿保存失败',
    '未发现',
    '未知，等待 B3 预检',
    '不可用',
    '尚未提供 Schema',
    '不会显示示例图或伪造结果',
    '能力预检未接入，无法提交'
  ]) {
    assert.match(workbenchSource, new RegExp(text));
  }
  assert.doesNotMatch(
    workbenchSource,
    /OpenAI|Anthropic|Midjourney|Stable Diffusion|1024x1024|45%|¥\d|\$\d/
  );
});

test('all five image pages reuse the shared shell and single mode source', () => {
  for (const pageSource of imagePages) {
    assert.match(pageSource, /ImageWorkbenchPage/);
    assert.match(pageSource, /imageCreationModes/);
    assert.doesNotMatch(pageSource, /CreationModePage/);
  }

  for (const mode of [
    'quick_image',
    'professional_image',
    'image_understanding',
    'image_editing',
    'image_to_prompt'
  ]) {
    assert.match(modesSource, new RegExp(`workspaceMode: '${mode}'`));
  }
});

test('saving a draft stays separate from task submission', () => {
  assert.match(workbenchSource, /'新建本地草稿'/);
  assert.match(workbenchSource, />\s*保存本地草稿\s*</);
  assert.match(workbenchSource, /没有创建或提交任务/);
  assert.match(workbenchSource, /没有上传图片，也没有创建任务/);
});
