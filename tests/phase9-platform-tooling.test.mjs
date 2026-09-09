import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditPlatformAssumptions,
  buildEvidenceManifest,
  collectRuntimeFacts,
  projectRoot,
  readTargetMatrix,
  validateTargetMatrix,
  verifyHandoff,
  writeEvidenceManifest
} from '../scripts/phase9-platform-common.mjs';

test('keeps Windows required and preserves the deferred macOS real-device target', async () => {
  const matrix = await readTargetMatrix();
  assert.deepEqual(matrix.targets.map((target) => target.os), ['win32', 'darwin']);
  assert.equal(matrix.targets[0].required, true);
  assert.equal(matrix.targets[1].required, false);
  assert.equal(matrix.targets.every((target) => target.executionMode === 'real_device'), true);
  assert.equal(
    matrix.targets.every((target) => target.architecturePolicy === 'record_observed_only'),
    true
  );
  assert.throws(
    () => validateTargetMatrix({ schemaVersion: 1, targets: [matrix.targets[0]] }),
    /requires a macOS target/
  );
  assert.throws(
    () => validateTargetMatrix({
      ...matrix,
      targets: matrix.targets.map((target, index) => index === 0
        ? { ...target, requiredSuites: [...target.requiredSuites, 'simulated_success'] }
        : target)
    }),
    /Target suites are invalid/
  );
});

test('collects only non-identifying runtime facts from an approved target', () => {
  const facts = collectRuntimeFacts({
    platform: 'darwin',
    architecture: 'arm64',
    release: '25.0.0',
    nodeVersion: '22.0.0',
    electronVersion: null,
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai',
    pathSeparator: '/'
  });
  assert.deepEqual(facts, {
    schemaVersion: 1,
    os: 'darwin',
    osVersion: '25.0.0',
    architecture: 'arm64',
    nodeVersion: '22.0.0',
    electronVersion: null,
    pathSeparator: '/',
    caseSensitivity: 'unknown',
    unicodeNormalization: 'unknown',
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai'
  });
  assert.equal(JSON.stringify(facts).includes(os.homedir()), false);
  assert.equal('hostname' in facts, false);
  assert.throws(
    () => collectRuntimeFacts({ platform: 'linux', architecture: 'x64' }),
    /outside the approved/
  );
});

test('verifies every frozen handoff checksum and resource byte count', async () => {
  const result = await verifyHandoff();
  assert.equal(result.checksumEntries, 50);
  assert.equal(result.manifestAssets, 27);
  assert.deepEqual(result.failures, []);
});

test('keeps the production platform assumption inventory exact', async () => {
  const result = await auditPlatformAssumptions();
  assert.equal(result.scannedFiles > 0, true);
  assert.deepEqual(result.violations, []);
  assert.equal(
    result.rules.some((rule) => rule.id === 'direct-runtime-platform-access'),
    true
  );
});

test('rejects a new direct platform branch outside the approved inventory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-platform-audit-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'unexpected.ts'), 'export const os = process.platform;\n');
    const result = await auditPlatformAssumptions(root, {
      schemaVersion: 1,
      roots: ['src'],
      extensions: ['.ts'],
      rules: [{
        id: 'direct-runtime-platform-access',
        owner: 'test',
        pattern: 'process\\.(?:platform|arch)',
        allowedFiles: []
      }]
    });
    assert.deepEqual(result.violations, [{
      rule: 'direct-runtime-platform-access',
      kind: 'unapproved_match',
      file: 'src/unexpected.ts'
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writes a path-safe evidence baseline without claiming unrun suites', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-platform-evidence-'));
  try {
    const matrix = await readTargetMatrix(projectRoot);
    const runtime = collectRuntimeFacts({
      platform: 'win32',
      architecture: 'x64',
      release: '10.0.26100',
      nodeVersion: '22.0.0',
      electronVersion: null,
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
      pathSeparator: '\\'
    });
    const manifest = buildEvidenceManifest({
      matrix,
      runtime,
      sourceCommit: 'abcdef1',
      collectedAt: '2026-07-28T00:00:00.000Z',
      statuses: { engineering_integrity: 'passed' }
    });
    assert.equal(manifest.results[0].status, 'passed');
    assert.equal(manifest.results.slice(1).every((result) => result.status === 'not_run'), true);
    const output = await writeEvidenceManifest(root, manifest, 'windows/b1-platform-baseline.json');
    assert.equal(output, 'docs/active/evidence/phase9/windows/b1-platform-baseline.json');
    assert.equal(JSON.parse(await readFile(path.join(root, output), 'utf8')).targetId,
      'windows-x64-primary');
    await assert.rejects(
      writeEvidenceManifest(root, manifest, '../outside.json'),
      /inside the approved root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
