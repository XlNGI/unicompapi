import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  projectRoot,
  readRecoveryMatrix,
  requiredDomains,
  requiredFaultTypes,
  requiredInvariants,
  runRecoveryAudit,
  scanSecuritySurfaces,
  validateRecoveryMatrix,
  verifyEvidenceReferences
} from '../scripts/verify-phase9-recovery-audit.mjs';

test('phase 9 recovery matrix covers every required B4 category with existing tests', async () => {
  const matrix = await readRecoveryMatrix();
  assert.equal(matrix.cases.length, 16);
  assert.deepEqual(new Set(matrix.requiredFaultTypes), new Set(requiredFaultTypes));
  assert.deepEqual(new Set(matrix.requiredDomains), new Set(requiredDomains));
  assert.deepEqual(new Set(matrix.requiredInvariants), new Set(requiredInvariants));
  assert.deepEqual(await verifyEvidenceReferences(matrix), {
    referenceCount: 17,
    violations: []
  });
});

test('phase 9 recovery audit passes security, evidence and tracked-artifact checks', async () => {
  const report = await runRecoveryAudit();
  assert.equal(report.status, 'passed', JSON.stringify(report.violations));
  assert.equal(report.targetId, 'windows-x64-primary');
  assert.match(report.sourceCommit, /^[a-f0-9]+$/);
  assert.ok(Number.isFinite(Date.parse(report.collectedAt)));
  assert.equal(report.matrix.faultTypes, 9);
  assert.equal(report.matrix.domains, 7);
  assert.equal(report.matrix.invariants, 5);
  assert.equal(report.security.violations, 0);
  assert.equal(report.artifacts.prohibited, 0);
});

test('recovery matrix rejects removed fault coverage and unsafe evidence paths', async () => {
  const source = JSON.parse(
    await readFile(path.join(projectRoot, 'config', 'phase9-recovery-matrix.json'), 'utf8')
  );
  const missingDiskFull = structuredClone(source);
  missingDiskFull.cases = missingDiskFull.cases.filter(
    (item) => !item.faultTypes.includes('disk_full')
  );
  assert.throws(() => validateRecoveryMatrix(missingDiskFull), /missing fault type coverage: disk_full/);

  const unsafePath = structuredClone(source);
  unsafePath.cases[0].evidence[0].file = '../outside.test.ts';
  assert.throws(
    () => validateRecoveryMatrix(unsafePath),
    /relative POSIX paths|escapes the repository|outside test sources/
  );
});

test('security audit detects sensitive public fields and evidence secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-recovery-audit-'));
  try {
    await mkdir(path.join(root, 'electron'), { recursive: true });
    await mkdir(path.join(root, 'docs', 'active', 'evidence', 'phase9'), { recursive: true });
    await writeFile(
      path.join(root, 'electron', 'preload.ts'),
      'export interface UnsafeDto { readonly accessToken: string; }\n',
      'utf8'
    );
    await writeFile(
      path.join(root, 'docs', 'active', 'evidence', 'phase9', 'unsafe.json'),
      '{"apiKey":"sk-examplecredential123456789"}\n',
      'utf8'
    );
    const result = await scanSecuritySurfaces(root);
    assert.deepEqual(
      new Set(result.violations.map((item) => item.rule)),
      new Set(['forbidden-public-sensitive-field', 'evidence-provider-key', 'evidence-assigned-secret'])
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
