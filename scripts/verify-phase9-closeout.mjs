import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findTargetRequirement,
  isTargetAcceptanceComplete,
  projectRoot,
  readTargetMatrix,
  validateEvidenceManifest
} from './phase9-platform-common.mjs';
import { runRecoveryAudit } from './verify-phase9-recovery-audit.mjs';

export const closeoutEvidencePath =
  'docs/active/evidence/phase9/windows/phase9-closeout.json';

export async function verifyPhase9Closeout(root = projectRoot) {
  const matrix = await readTargetMatrix(root);
  const evidence = validateEvidenceManifest(JSON.parse(await readFile(
    path.join(root, ...closeoutEvidencePath.split('/')),
    'utf8'
  )));
  const target = findTargetRequirement(matrix, evidence.runtime);
  const violations = [];
  if (target.id !== evidence.targetId) {
    violations.push({ rule: 'target-id-mismatch' });
  }
  if (!target.required) {
    violations.push({ rule: 'closeout-evidence-target-not-required' });
  }
  if (!isTargetAcceptanceComplete(target, evidence.results)) {
    violations.push({ rule: 'required-suites-incomplete' });
  }
  for (const reference of new Set(evidence.results.flatMap((item) => item.evidenceRefs))) {
    if (!(await isRegularFile(path.join(root, ...reference.split('/'))))) {
      violations.push({ rule: 'missing-evidence-reference', file: reference });
    }
  }
  const requiredTargets = matrix.targets.filter((item) => item.required);
  if (requiredTargets.length !== 1 || requiredTargets[0]?.id !== target.id) {
    violations.push({ rule: 'unexpected-required-target-matrix' });
  }
  const macosTarget = matrix.targets.find((item) => item.id === 'macos-primary');
  if (!macosTarget || macosTarget.required) {
    violations.push({ rule: 'macos-deferred-entry-invalid' });
  }
  const recovery = await runRecoveryAudit(root);
  if (recovery.status !== 'passed') {
    violations.push({ rule: 'recovery-audit-failed' });
  }
  return {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    requiredTarget: target.id,
    requiredSuites: target.requiredSuites.length,
    passedResults: evidence.results.filter((item) => item.status === 'passed').length,
    deferredTargets: matrix.targets.filter((item) => !item.required).map((item) => item.id),
    recoveryAudit: recovery.status,
    violations
  };
}

async function isRegularFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  const report = await verifyPhase9Closeout(projectRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
