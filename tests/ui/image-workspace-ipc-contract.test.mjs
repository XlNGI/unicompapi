import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preloadSource = await readFile('electron/preload.ts', 'utf8');
const handlerSource = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const mainSource = await readFile('electron/main.ts', 'utf8');
const localMediaResponseSource = await readFile(
  'electron/ipc/local-media-response.ts',
  'utf8'
);
const sharedSource = await readFile(
  'src/shared/image-workspace-ipc.ts',
  'utf8'
);

test('exposes only the controlled local image workspace operations', () => {
  for (const operation of [
    'create',
    'get',
    'update',
    'list',
    'derive',
    'selectInput',
    'clearInput',
    'getInput',
    'createInputPreview'
  ]) {
    assert.match(preloadSource, new RegExp(`${operation}:`));
    assert.match(handlerSource, new RegExp(`imageWorkspaceIpcChannels\\.${operation}`));
  }

  for (const mode of [
    'quick_image',
    'professional_image',
    'image_understanding',
    'image_editing',
    'image_to_prompt'
  ]) {
    assert.match(sharedSource, new RegExp(mode));
  }

  assert.doesNotMatch(sharedSource, /batch_image|multi_reference/);
  assert.doesNotMatch(
    sharedSource,
    /rootDirectory|absolutePath|checksumSha256|credentialReference|errorStack/
  );
  assert.match(sharedSource, /featureSelection/);
  assert.match(sharedSource, /contextRevision/);
  assert.match(sharedSource, /includeInPrompt/);
  assert.doesNotMatch(
    sharedSource,
    /upload|generateImage|analyzeImage|submitTask|createTask|rendererPath/
  );
  assert.match(mainSource, /resolveEntry\(token\)/);
  assert.match(mainSource, /createLocalMediaResponse\(/);
  assert.doesNotMatch(mainSource, /net\.fetch\(pathToFileURL/);
  assert.match(localMediaResponseSource, /createReadStream\(target/);
  assert.match(localMediaResponseSource, /headers\.set\('content-type', mimeType\)/);
  assert.doesNotMatch(localMediaResponseSource, /content-disposition|pathToFileURL|net\.fetch/);
});
