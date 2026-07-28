import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findTargetRequirement,
  isTargetAcceptanceComplete,
  parsePlatformEvidenceManifest,
  parsePlatformRuntimeFacts,
  parsePlatformTargetMatrix,
  type PlatformAcceptanceResult
} from '../../src/platform';

const suites = [
  'engineering_integrity',
  'electron_lifecycle',
  'filesystem_permissions',
  'secure_storage',
  'system_integrations',
  'power_recovery',
  'media_software',
  'full_product_ui',
  'security_audit'
] as const;

const matrix = {
  schemaVersion: 1,
  targets: [
    {
      id: 'windows-x64-primary',
      os: 'win32',
      allowedArchitectures: ['x64'],
      architecturePolicy: 'record_observed_only',
      executionMode: 'real_device',
      required: true,
      requiredSuites: suites
    },
    {
      id: 'macos-primary',
      os: 'darwin',
      allowedArchitectures: ['arm64', 'x64'],
      architecturePolicy: 'record_observed_only',
      executionMode: 'real_device',
      required: true,
      requiredSuites: suites
    }
  ]
};

const runtime = {
  schemaVersion: 1,
  os: 'win32',
  osVersion: '10.0.26100',
  architecture: 'x64',
  nodeVersion: '22.0.0',
  electronVersion: null,
  pathSeparator: '\\',
  caseSensitivity: 'unknown',
  unicodeNormalization: 'unknown',
  locale: 'zh-CN',
  timeZone: 'Asia/Shanghai'
};

describe('Phase 9 platform acceptance contracts', () => {
  it('strictly requires Windows and macOS real-device targets', () => {
    const parsed = parsePlatformTargetMatrix(matrix);
    expect(parsed.targets).toHaveLength(2);
    expect(() => parsePlatformTargetMatrix({
      ...matrix,
      targets: [matrix.targets[0]]
    })).toThrow('requires macOS evidence');
    expect(() => parsePlatformTargetMatrix({
      ...matrix,
      cloudRunnerCountsAsRealDevice: true
    })).toThrow('missing or unknown fields');
  });

  it('matches only the observed operating system and architecture', () => {
    const parsedMatrix = parsePlatformTargetMatrix(matrix);
    const parsedRuntime = parsePlatformRuntimeFacts(runtime);
    expect(findTargetRequirement(parsedMatrix, parsedRuntime).id).toBe('windows-x64-primary');
    expect(() => findTargetRequirement(parsedMatrix, {
      ...parsedRuntime,
      architecture: 'arm64'
    })).toThrow('not part of the approved');
  });

  it('does not treat blocked, not-run or missing suites as complete', () => {
    const target = parsePlatformTargetMatrix(matrix).targets[0];
    const results: PlatformAcceptanceResult[] = suites.map((suite) => ({
      caseId: `case.${suite}`,
      suite,
      status: 'passed',
      evidenceRefs: []
    }));
    expect(isTargetAcceptanceComplete(target, results)).toBe(true);
    expect(isTargetAcceptanceComplete(target, results.map((result) =>
      result.suite === 'media_software' ? { ...result, status: 'blocked' } : result
    ))).toBe(false);
    expect(isTargetAcceptanceComplete(target, results.slice(1))).toBe(false);
  });

  it('keeps evidence refs relative, scoped and free of machine paths', () => {
    const evidence = {
      schemaVersion: 1,
      targetId: 'windows-x64-primary',
      sourceCommit: 'abcdef1',
      collectedAt: '2026-07-28T00:00:00.000Z',
      runtime,
      results: [{
        caseId: 'b1.engineering_integrity',
        suite: 'engineering_integrity',
        status: 'passed',
        evidenceRefs: ['docs/active/evidence/phase9/windows/gate.json']
      }]
    };
    expect(parsePlatformEvidenceManifest(evidence)).toEqual(evidence);
    expect(() => parsePlatformEvidenceManifest({
      ...evidence,
      results: [{ ...evidence.results[0], evidenceRefs: ['C:\\Users\\secret\\gate.json'] }]
    })).toThrow('must stay inside');
    expect(() => parsePlatformEvidenceManifest({
      ...evidence,
      hostname: 'private-device'
    })).toThrow('missing or unknown fields');
  });

  it('validates committed B2 Windows evidence without treating its not-run picker as complete', async () => {
    const evidence = JSON.parse(await readFile(path.resolve(
      'docs/active/evidence/phase9/windows/b2-storage-security.json'
    ), 'utf8'));
    const parsedEvidence = parsePlatformEvidenceManifest(evidence);
    const target = parsePlatformTargetMatrix(matrix).targets[0];
    expect(parsedEvidence.sourceCommit).toBe('5db899f');
    expect(parsedEvidence.results).toContainEqual(expect.objectContaining({
      caseId: 'b2.windows.native_directory_picker_authorization',
      status: 'not_run'
    }));
    expect(isTargetAcceptanceComplete(target, parsedEvidence.results)).toBe(false);
  });
});
