import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const imagePanel = await readFile(
  'src/pages/creation/image/ImageFeatureSubmissionPanel.tsx',
  'utf8'
);
const videoPanel = await readFile(
  'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
  'utf8'
);

function blockFor(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing block: ${marker}`);
  const openingBrace = source.indexOf('{', markerIndex);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail(`unterminated block: ${marker}`);
}

test('autosave keeps image and video dynamic parameter contracts interactive', () => {
  for (const source of [imagePanel, videoPanel]) {
    const needsSaveBlock = blockFor(source, 'if (needsSave)');
    assert.doesNotMatch(needsSaveBlock, /setLoadState\(/);
    assert.doesNotMatch(needsSaveBlock, /setCandidates\(\[\]\)/);
    assert.match(source, /if \(blockedReason\) \{[\s\S]*?setCandidates\(\[\]\)/);
  }
});
