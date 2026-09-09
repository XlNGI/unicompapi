import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  currentPlatformKey,
  readMediaEngineManifest,
  resolveMediaEngineInstallation,
  validateFfmpegReport
} from '../scripts/media-engine-common.mjs';
import {
  installMediaEngine,
  parseArguments,
  validateArchiveEntries
} from '../scripts/setup-media-engine.mjs';

const platformKey = currentPlatformKey();

function specification(overrides = {}) {
  return {
    archiveName: 'ffmpeg.zip',
    downloadUrl: 'https://example.test/ffmpeg.zip',
    sha256: '0'.repeat(64),
    archiveRoot: 'ffmpeg-approved',
    installationDirectory: `.tools/media-engine/ffmpeg/8.1.2/${platformKey}`,
    ffmpegRelativePath: 'bin/ffmpeg.exe',
    ffprobeRelativePath: 'bin/ffprobe.exe',
    licenseRelativePath: 'LICENSE.txt',
    requiredVersionText: 'n8.1.2',
    requiredConfigurationFlags: [
      '--disable-libfdk-aac',
      '--disable-libx264',
      '--disable-libx265',
      '--enable-libopus',
      '--enable-libvpx'
    ],
    forbiddenConfigurationFlags: ['--enable-gpl', '--enable-nonfree'],
    requiredEncoders: ['libopus', 'libvpx-vp9'],
    ...overrides
  };
}

function manifest(platformSpecification = specification()) {
  return {
    schemaVersion: 1,
    engine: 'ffmpeg',
    version: '8.1.2',
    usage: 'development-only',
    platforms: { [platformKey]: platformSpecification }
  };
}

function validReports() {
  const flags = specification().requiredConfigurationFlags.join(' ');
  return {
    ffmpegVersion: `ffmpeg version n8.1.2 ${flags}`,
    ffprobeVersion: 'ffprobe version n8.1.2',
    encoders: ' A....D libopus Opus\n V....D libvpx-vp9 VP9'
  };
}

test('parses only the supported media engine setup argument', () => {
  assert.deepEqual(parseArguments([]), { archive: null });
  assert.equal(
    parseArguments(['--archive', './ffmpeg.zip']).archive,
    path.resolve('./ffmpeg.zip')
  );
  assert.throws(() => parseArguments(['--download']), /Unknown argument/);
  assert.throws(() => parseArguments(['--archive']), /requires a file path/);
});

test('keeps manifest installation and binary paths inside project .tools', () => {
  const root = path.resolve('test-project');
  const resolved = resolveMediaEngineInstallation(root, manifest());
  assert.equal(resolved.installationRoot.startsWith(resolved.toolsRoot), true);
  assert.throws(
    () =>
      resolveMediaEngineInstallation(
        root,
        manifest(specification({ installationDirectory: '../outside' }))
      ),
    /must stay inside/
  );
  assert.throws(
    () =>
      resolveMediaEngineInstallation(
        root,
        manifest(specification({ ffmpegRelativePath: '../../outside.exe' }))
      ),
    /must stay inside/
  );
});

test('rejects unsafe or unexpected archive entries', () => {
  assert.deepEqual(
    validateArchiveEntries(
      'ffmpeg-approved/bin/ffmpeg.exe\nffmpeg-approved/LICENSE.txt\n',
      'ffmpeg-approved'
    ),
    ['ffmpeg-approved/bin/ffmpeg.exe', 'ffmpeg-approved/LICENSE.txt']
  );
  assert.throws(
    () => validateArchiveEntries('../outside.exe', 'ffmpeg-approved'),
    /unsafe path/
  );
  assert.throws(
    () => validateArchiveEntries('other-root/file', 'ffmpeg-approved'),
    /unexpected root/
  );
  assert.throws(
    () => validateArchiveEntries('C:/outside.exe', 'ffmpeg-approved'),
    /unsafe path/
  );
});

test('accepts the approved version, LGPL-only flags and encoders', () => {
  const reports = validReports();
  assert.doesNotThrow(() =>
    validateFfmpegReport(
      specification(),
      reports.ffmpegVersion,
      reports.ffprobeVersion,
      reports.encoders
    )
  );
});

test('rejects forbidden GPL and nonfree FFmpeg configurations', () => {
  const reports = validReports();
  for (const forbidden of ['--enable-gpl', '--enable-nonfree']) {
    assert.throws(
      () =>
        validateFfmpegReport(
          specification(),
          `${reports.ffmpegVersion} ${forbidden}`,
          reports.ffprobeVersion,
          reports.encoders
        ),
      new RegExp(`forbidden flag ${forbidden}`)
    );
  }
});

test('rejects missing required FFmpeg version, flags and encoders', () => {
  const reports = validReports();
  assert.throws(
    () =>
      validateFfmpegReport(
        specification(),
        reports.ffmpegVersion.replace('--enable-libopus', ''),
        reports.ffprobeVersion,
        reports.encoders
      ),
    /missing required flag --enable-libopus/
  );
  assert.throws(
    () =>
      validateFfmpegReport(
        specification(),
        reports.ffmpegVersion,
        reports.ffprobeVersion,
        reports.encoders.replace('libvpx-vp9', 'vp9')
      ),
    /missing required encoder libvpx-vp9/
  );
  assert.throws(
    () =>
      validateFfmpegReport(
        specification(),
        reports.ffmpegVersion,
        'ffprobe version n7.0',
        reports.encoders
      ),
    /ffprobe does not match/
  );
});

test('fails closed on archive hash mismatch before extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-engine-'));
  try {
    await mkdir(path.join(root, 'config'), { recursive: true });
    await writeFile(
      path.join(root, 'config', 'media-engine-development.json'),
      JSON.stringify(manifest(), null, 2)
    );
    const archive = path.join(root, 'wrong.zip');
    await writeFile(archive, 'not the approved archive');

    await assert.rejects(
      installMediaEngine({ root, archive }),
      /archive SHA-256 mismatch/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads the committed manifest as a development-only FFmpeg policy', async () => {
  const loaded = await readMediaEngineManifest();
  assert.equal(loaded.engine, 'ffmpeg');
  assert.equal(loaded.usage, 'development-only');
  assert.equal(loaded.platforms[platformKey].sha256.length, 64);
});
