import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  isTargetAcceptanceComplete,
  projectRoot,
  readTargetMatrix,
  validateEvidenceManifest
} from '../scripts/phase9-platform-common.mjs';
import {
  closeoutEvidencePath,
  verifyPhase9Closeout
} from '../scripts/verify-phase9-closeout.mjs';

test('phase 9 closeout evidence completes every required Windows suite', async () => {
  const matrix = await readTargetMatrix();
  const evidence = validateEvidenceManifest(JSON.parse(await readFile(
    path.join(projectRoot, ...closeoutEvidencePath.split('/')),
    'utf8'
  )));
  const windows = matrix.targets.find((item) => item.id === 'windows-x64-primary');
  const macos = matrix.targets.find((item) => item.id === 'macos-primary');
  assert.ok(windows?.required);
  assert.equal(macos?.required, false);
  assert.equal(isTargetAcceptanceComplete(windows, evidence.results), true);
  assert.equal(new Set(evidence.results.map((item) => item.suite)).size, 9);
  assert.ok(evidence.results.every((item) => item.status === 'passed'));
});

test('phase 9 closeout verifier preserves macOS deferred entry and passes recovery audit', async () => {
  const report = await verifyPhase9Closeout();
  assert.deepEqual(report, {
    schemaVersion: 1,
    status: 'passed',
    requiredTarget: 'windows-x64-primary',
    requiredSuites: 9,
    passedResults: 10,
    deferredTargets: ['macos-primary'],
    recoveryAudit: 'passed',
    violations: []
  });
});

test('closeout completion rejects any required-suite regression', async () => {
  const matrix = await readTargetMatrix();
  const evidence = validateEvidenceManifest(JSON.parse(await readFile(
    path.join(projectRoot, ...closeoutEvidencePath.split('/')),
    'utf8'
  )));
  const windows = matrix.targets.find((item) => item.id === 'windows-x64-primary');
  const regressed = evidence.results.map((item) =>
    item.caseId === 'a4.windows.real_suspend_lock_resume'
      ? { ...item, status: 'not_run' }
      : item
  );
  assert.equal(isTargetAcceptanceComplete(windows, regressed), false);
});
