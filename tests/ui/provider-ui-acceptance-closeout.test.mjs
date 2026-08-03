import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const providers = await readFile('src/pages/providers/ProvidersPage.tsx', 'utf8');
const chat = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const imageShell = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const videoEditor = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const modes = await readFile('src/pages/creation/creationModes.ts', 'utf8');

test('secondary setup actions do not compete with the provider and chat main actions', () => {
  assert.match(
    providers,
    /action=\{<Button disabled=\{!providersApi\} onClick=\{\(\) => openCreate\('official'\)\} variant="secondary">/
  );
  assert.match(
    chat,
    /<Button[^>]+type="submit"[^>]+variant="secondary">创建项目对话<\/Button>/
  );
});

test('draft persistence stays secondary to image submission and video export', () => {
  assert.match(
    imageShell,
    /onClick=\{\(\) => void saveDraft\(\)\}[\s\S]{0,80}variant="secondary"/
  );
  assert.match(
    videoEditor,
    /onClick=\{\(\) => void commitTitle\(\)\}[\s\S]{0,80}variant="secondary"/
  );
});

test('quick creation mode copy remains pure text without reference material guidance', () => {
  const quickImage = modes.slice(
    modes.indexOf("id: 'quick-image'"),
    modes.indexOf("id: 'professional-image'")
  );
  const quickVideo = modes.slice(
    modes.indexOf("id: 'quick-video'"),
    modes.indexOf("id: 'text-to-video'")
  );

  for (const source of [quickImage, quickVideo]) {
    assert.match(source, /只接收文字需求/);
    assert.doesNotMatch(source, /参考图|参考视频|参考素材|选择素材/);
  }
});
