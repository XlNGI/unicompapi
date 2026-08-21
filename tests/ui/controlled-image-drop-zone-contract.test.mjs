import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [dropZone, professionalImage, imageToVideo] = await Promise.all([
  readFile('src/components/ControlledImageDropZone.tsx', 'utf8'),
  readFile('src/pages/creation/image/ImageProfessionalWorkspace.tsx', 'utf8'),
  readFile('src/pages/creation/video/VideoImageWorkspace.tsx', 'utf8')
]);

test('image creation workspaces share a controlled single-image drop zone', () => {
  assert.match(professionalImage, /ControlledImageDropZone/);
  assert.match(professionalImage, /imageWorkspaces\.importInput\(/);
  assert.match(imageToVideo, /ControlledImageDropZone/);
  assert.match(imageToVideo, /videoWorkspaces\.importMaterial\([\s\S]*'image'/);
  assert.match(dropZone, /files\.length !== 1/);
  assert.match(dropZone, /file\.type\.startsWith\('image\/'\)/);
  assert.match(dropZone, /dataset\.unicompDropToken/);
  assert.match(dropZone, /onDropFile\(file, dropToken\)/);
  assert.match(dropZone, /imageWorkDragDataType/);
  assert.match(dropZone, /onDropWork\?\.\(workId\)/);
});
