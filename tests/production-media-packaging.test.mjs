import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateRuntimeManifest, validateToolReports, verifyProductionMedia } from '../scripts/verify-production-media.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function componentFixture(root) {
  for (const name of ['bin', 'licenses', 'sources']) await mkdir(path.join(root, name));
  const files = [];
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const bytes = `synthetic test bytes for ${name}`;
    await writeFile(path.join(root, 'bin', name), bytes);
    files.push({path: `bin/${name}`, sha256: sha256(bytes)});
  }
  await writeFile(path.join(root, 'media-engine.json'), JSON.stringify({schemaVersion: 1, usage: 'production', engine: 'ffmpeg', platform: 'win32', architecture: 'x64', version: '8.1.2-test', files}));
  const sourceBytes = 'synthetic source fixture; not an actual source archive';
  await writeFile(path.join(root, 'sources', 'fixture.zip'), sourceBytes);
  await writeFile(path.join(root, 'source-information.json'), JSON.stringify({ffmpegRevision: 'a'.repeat(40), buildRecipeUrl: 'https://example.invalid/recipe', sourceArchives: [{path: 'sources/fixture.zip', sha256: sha256(sourceBytes)}]}));
  for (const name of ['LGPL-3.0.txt', 'GPL-3.0.txt', 'SOURCE.md', 'THIRD_PARTY_NOTICES.txt']) {
    await writeFile(path.join(root, 'licenses', name), 'Synthetic licensing fixture, not a legal document. '.repeat(4));
  }
}

test('rejects traversal and malformed production manifests before executing tools', () => {
  assert.throws(() => validateRuntimeManifest({
    schemaVersion: 1, usage: 'production', engine: 'ffmpeg', platform: 'win32', architecture: 'x64',
    version: '1.0.0', files: [{ path: 'bin/ffmpeg.exe', sha256: '0'.repeat(64) }, { path: 'bin/../ffprobe.exe', sha256: '0'.repeat(64) }]
  }), /invalid file entry/);
  assert.throws(() => validateRuntimeManifest({
    schemaVersion: 1, usage: 'production', engine: 'ffmpeg', platform: 'win32', architecture: 'x64',
    version: '1.0.0', files: [{ path: 'bin/ffmpeg.exe', sha256: '0'.repeat(64) }, { path: 'bin/ffprobe.exe', sha256: '0'.repeat(64) }, { path: '../outside.dll', sha256: '0'.repeat(64) }]
  }), /invalid file entry/);
});

test('rejects a tampered or incomplete component without running synthetic binaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-production-media-'));
  try {
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'media-engine.json'), JSON.stringify({
      schemaVersion: 1, usage: 'production', engine: 'ffmpeg', platform: 'win32', architecture: 'x64', version: '1.0.0',
      files: [{ path: 'bin/ffmpeg.exe', sha256: '0'.repeat(64) }, { path: 'bin/ffprobe.exe', sha256: '0'.repeat(64) }]
    }));
    await assert.rejects(() => verifyProductionMedia(root), /Missing source-information.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a component located inside repository .tools, including a symlink to it', async () => {
  const toolsRoot = path.resolve('.tools');
  const target = path.join(toolsRoot, 'production-media-test');
  const link = path.join(os.tmpdir(), `unicomp-tools-link-${process.pid}`);
  await mkdir(target, { recursive: true });
  try {
    await assert.rejects(() => verifyProductionMedia(target), /\.tools directory/);
    await symlink(toolsRoot, link, 'junction');
    await assert.rejects(() => verifyProductionMedia(path.join(link, 'production-media-test')), /\.tools directory/);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(link, { recursive: true, force: true });
  }
});

test('rejects tampered binaries, undeclared DLLs and changed source bytes before execution', async () => {
  for (const [relative, expected] of [
    ['bin/ffmpeg.exe', /hash mismatch/],
    ['bin/ffprobe.exe', /hash mismatch/],
    ['bin/unlisted.dll', /exactly match/],
    ['sources/fixture.zip', /Source archive hash mismatch/]
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-tamper-'));
    try {
      await componentFixture(root);
      await writeFile(path.join(root, relative), 'changed');
      await assert.rejects(() => verifyProductionMedia(root), expected);
    } finally { await rm(root, {recursive: true, force: true}); }
  }
});

test('rejects source and license directories redirected outside the component', async () => {
  for (const name of ['sources', 'licenses']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-junction-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-external-'));
    try {
      await componentFixture(root);
      await rm(path.join(root, name), {recursive: true});
      await symlink(outside, path.join(root, name), 'junction');
      await assert.rejects(() => verifyProductionMedia(root), /Missing production media (sources|licenses) directory/);
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  }
});

test('requires dependency notices and source instructions before running binaries', async () => {
  for (const name of ['SOURCE.md', 'THIRD_PARTY_NOTICES.txt']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-notices-'));
    try {
      await componentFixture(root);
      await rm(path.join(root, 'licenses', name));
      await assert.rejects(() => verifyProductionMedia(root), new RegExp(`Missing ${name}`));
    } finally { await rm(root, {recursive: true, force: true}); }
  }
});

test('accepts real-style LGPL reports and rejects prefix-only versions or forbidden build flags', () => {
  const report = (name, version = '8.1.2-test', flags = '--enable-version3') => `${name} version ${version} Copyright FFmpeg\nconfiguration: ${flags}\nThis program is free software under the GNU Lesser General Public License version 3 or later.`;
  assert.doesNotThrow(() => validateToolReports('8.1.2-test', report('ffmpeg'), report('ffprobe')));
  assert.throws(() => validateToolReports('8.1.2', report('ffmpeg'), report('ffprobe')), /version does not match/);
  for (const flag of ['--enable-gpl', '--enable-nonfree', "'--enable-gpl'"]) {
    assert.throws(() => validateToolReports('8.1.2-test', report('ffmpeg', undefined, flag), report('ffprobe')), /forbidden/);
  }
  assert.throws(() => validateToolReports('8.1.2-test', report('ffmpeg').replace('GNU Lesser General Public License', 'GNU General Public License'), report('ffprobe')), /does not declare LGPL/);
});
