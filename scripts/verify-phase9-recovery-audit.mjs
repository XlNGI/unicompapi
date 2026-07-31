import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const requiredFaultTypes = [
  'execution_file_corruption',
  'storage_disconnected',
  'permission_revoked',
  'disk_full',
  'process_failure',
  'network_failure',
  'cancellation_interruption',
  'suspend_interruption',
  'application_restart'
];

export const requiredDomains = [
  'project',
  'image_result',
  'video_result',
  'video_export',
  'task_work',
  'settings',
  'diagnostics'
];

export const requiredInvariants = [
  'verified_local_file_before_completion',
  'failed_attempt_history_preserved',
  'temporary_artifact_not_completion',
  'no_directory_escape_or_overwrite',
  'no_sensitive_data_exposure'
];

const publicContractPaths = [
  'electron/preload.ts',
  'src/shared'
];

const sourceSurfacePaths = [
  ...publicContractPaths,
  'electron/ipc',
  'src/platform/ipc',
  'src/platform/settings',
  'src/pages/settings'
];

const evidenceSurfacePaths = ['docs/active/evidence/phase9'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js']);
const evidenceExtensions = new Set(['.json', '.md']);

const forbiddenPublicField = /\b(?:readonly\s+)?(?:apiKey|accessToken|refreshToken|credentialValue|passwordValue|proxyPassword|authorizationHeader|cookieHeader|absolutePath|rawLog|rawPrompt|deviceId|privatePath|fileHash)\??\s*:/gi;
const sensitiveLogSink = /(?:console|logger)\.(?:log|info|warn|error|debug)\s*\([^;\n]*(?:api[-_]?key|token|secret|password|credential|authorization|cookie)/gi;
const evidenceSecretPatterns = [
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi },
  { id: 'provider-key', pattern: /\b(?:sk|ak)-[A-Za-z0-9_-]{16,}/gi },
  {
    id: 'assigned-secret',
    pattern: /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9+\/_=-]{16,}/gi
  },
  { id: 'windows-user-path', pattern: /\b[A-Za-z]:\\Users\\[^\\\s"']+/gi },
  { id: 'macos-user-path', pattern: /\/Users\/[^/\s"']+/g },
  { id: 'linux-user-path', pattern: /\/home\/[^/\s"']+/g }
];

export async function readRecoveryMatrix(root = projectRoot) {
  const text = await readFile(path.join(root, 'config', 'phase9-recovery-matrix.json'), 'utf8');
  return validateRecoveryMatrix(JSON.parse(text));
}

export function validateRecoveryMatrix(value) {
  exactKeys(
    value,
    ['schemaVersion', 'requiredFaultTypes', 'requiredDomains', 'requiredInvariants', 'cases'],
    'recovery matrix'
  );
  if (value.schemaVersion !== 1 || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('Phase 9 recovery matrix version or cases are invalid');
  }
  requireExactSet(value.requiredFaultTypes, requiredFaultTypes, 'fault types');
  requireExactSet(value.requiredDomains, requiredDomains, 'domains');
  requireExactSet(value.requiredInvariants, requiredInvariants, 'invariants');

  const caseIds = new Set();
  const cases = value.cases.map((item) => {
    exactKeys(item, ['id', 'domain', 'faultTypes', 'invariants', 'evidence'], 'recovery case');
    if (!/^P9-B4-\d{3}$/.test(item.id) || caseIds.has(item.id)) {
      throw new Error('Recovery case ids must be unique P9-B4 identifiers');
    }
    caseIds.add(item.id);
    if (!requiredDomains.includes(item.domain)) throw new Error(`Invalid domain in ${item.id}`);
    requireSubset(item.faultTypes, requiredFaultTypes, `fault types in ${item.id}`);
    requireSubset(item.invariants, requiredInvariants, `invariants in ${item.id}`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      throw new Error(`Evidence is required in ${item.id}`);
    }
    const evidence = item.evidence.map((reference) => {
      exactKeys(reference, ['file', 'testName'], `evidence in ${item.id}`);
      const file = safeRelativePath(reference.file);
      if (!file.startsWith('tests/') || !/\.test\.(?:ts|mjs)$/.test(file)) {
        throw new Error(`Evidence file is outside test sources in ${item.id}`);
      }
      if (!nonBlank(reference.testName)) throw new Error(`Evidence test name is invalid in ${item.id}`);
      return { file, testName: reference.testName };
    });
    return {
      id: item.id,
      domain: item.domain,
      faultTypes: [...item.faultTypes],
      invariants: [...item.invariants],
      evidence
    };
  });

  requireCoverage(cases, 'faultTypes', requiredFaultTypes, 'fault type');
  requireCoverage(cases, 'domain', requiredDomains, 'domain');
  requireCoverage(cases, 'invariants', requiredInvariants, 'invariant');
  return {
    schemaVersion: 1,
    requiredFaultTypes: [...requiredFaultTypes],
    requiredDomains: [...requiredDomains],
    requiredInvariants: [...requiredInvariants],
    cases
  };
}

export async function verifyEvidenceReferences(matrix, root = projectRoot) {
  const violations = [];
  let referenceCount = 0;
  for (const item of matrix.cases) {
    for (const reference of item.evidence) {
      referenceCount += 1;
      const target = resolveInside(root, reference.file);
      let source;
      try {
        source = await readFile(target, 'utf8');
      } catch {
        violations.push({ rule: 'missing-test-evidence', caseId: item.id, file: reference.file });
        continue;
      }
      if (!source.includes(reference.testName)) {
        violations.push({
          rule: 'missing-test-title',
          caseId: item.id,
          file: reference.file,
          testName: reference.testName
        });
      }
    }
  }
  return { referenceCount, violations };
}

export async function scanSecuritySurfaces(root = projectRoot) {
  const publicContractFiles = await collectFiles(root, publicContractPaths, sourceExtensions);
  const sourceFiles = await collectFiles(root, sourceSurfacePaths, sourceExtensions);
  const evidenceFiles = await collectFiles(root, evidenceSurfacePaths, evidenceExtensions);
  const violations = [];

  for (const file of publicContractFiles) {
    const source = await readFile(resolveInside(root, file), 'utf8');
    for (const match of source.matchAll(forbiddenPublicField)) {
      violations.push({ rule: 'forbidden-public-sensitive-field', file, line: lineAt(source, match.index) });
    }
  }

  for (const file of sourceFiles) {
    const source = await readFile(resolveInside(root, file), 'utf8');
    for (const match of source.matchAll(sensitiveLogSink)) {
      violations.push({ rule: 'sensitive-log-sink', file, line: lineAt(source, match.index) });
    }
  }

  for (const file of evidenceFiles) {
    const source = await readFile(resolveInside(root, file), 'utf8');
    for (const rule of evidenceSecretPatterns) {
      for (const match of source.matchAll(rule.pattern)) {
        violations.push({ rule: `evidence-${rule.id}`, file, line: lineAt(source, match.index) });
      }
    }
  }
  return {
    publicContractFiles: publicContractFiles.length,
    sourceFiles: sourceFiles.length,
    evidenceFiles: evidenceFiles.length,
    violations
  };
}

export function scanTrackedArtifacts(root = projectRoot) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  const tracked = output.split('\0').filter(Boolean).map((item) => item.replaceAll('\\', '/'));
  const prohibited = tracked.filter((file) =>
    file === '.tools' ||
    file.startsWith('.tools/') ||
    /(?:^|\/)(?:ffmpeg|ffprobe)(?:\.exe)?$/i.test(file)
  );
  return { trackedFiles: tracked.length, prohibited };
}

export async function runRecoveryAudit(root = projectRoot) {
  const matrix = await readRecoveryMatrix(root);
  const evidence = await verifyEvidenceReferences(matrix, root);
  const security = await scanSecuritySurfaces(root);
  const artifacts = scanTrackedArtifacts(root);
  const violations = [
    ...evidence.violations,
    ...security.violations,
    ...artifacts.prohibited.map((file) => ({ rule: 'prohibited-tracked-artifact', file }))
  ];
  return {
    schemaVersion: 1,
    targetId: 'windows-x64-primary',
    sourceCommit: readSourceCommit(root),
    collectedAt: new Date().toISOString(),
    status: violations.length === 0 ? 'passed' : 'failed',
    matrix: {
      cases: matrix.cases.length,
      faultTypes: matrix.requiredFaultTypes.length,
      domains: matrix.requiredDomains.length,
      invariants: matrix.requiredInvariants.length,
      evidenceReferences: evidence.referenceCount
    },
    security: {
      publicContractFiles: security.publicContractFiles,
      sourceFiles: security.sourceFiles,
      evidenceFiles: security.evidenceFiles,
      violations: security.violations.length
    },
    artifacts: {
      trackedFiles: artifacts.trackedFiles,
      prohibited: artifacts.prohibited.length
    },
    violations
  };
}

function readSourceCommit(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
}

async function collectFiles(root, relatives, extensions) {
  const files = [];
  for (const relative of relatives) {
    const safe = safeRelativePath(relative);
    const target = resolveInside(root, safe);
    let info;
    try {
      info = await stat(target);
    } catch {
      continue;
    }
    if (info.isFile()) {
      if (extensions.has(path.extname(target))) files.push(safe);
      continue;
    }
    if (!info.isDirectory()) continue;
    await walk(root, target, safe, files, extensions);
  }
  return [...new Set(files)].sort();
}

async function walk(root, absolute, relative, files, extensions) {
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    const childAbsolute = resolveInside(root, childRelative);
    if (entry.isDirectory()) await walk(root, childAbsolute, childRelative, files, extensions);
    if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(childRelative);
  }
}

function requireExactSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual).size !== actual.length) {
    throw new Error(`Recovery matrix ${label} are invalid`);
  }
  if (expected.some((item) => !actual.includes(item))) throw new Error(`Recovery matrix ${label} are incomplete`);
}

function requireSubset(actual, allowed, label) {
  if (!Array.isArray(actual) || actual.length === 0 || new Set(actual).size !== actual.length) {
    throw new Error(`Recovery case ${label} are invalid`);
  }
  if (actual.some((item) => !allowed.includes(item))) throw new Error(`Recovery case ${label} contain an unknown value`);
}

function requireCoverage(cases, key, required, label) {
  const covered = new Set(cases.flatMap((item) => Array.isArray(item[key]) ? item[key] : [item[key]]));
  const missing = required.filter((item) => !covered.has(item));
  if (missing.length > 0) throw new Error(`Recovery matrix is missing ${label} coverage: ${missing.join(', ')}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} keys are invalid`);
  }
}

function safeRelativePath(value) {
  if (!nonBlank(value) || path.isAbsolute(value) || value.includes('\\')) {
    throw new Error('Recovery audit paths must be relative POSIX paths');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== value) {
    throw new Error('Recovery audit path escapes the repository');
  }
  return normalized;
}

function resolveInside(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split('/'));
  const prefix = `${resolvedRoot}${path.sep}`;
  if (target !== resolvedRoot && !target.startsWith(prefix)) throw new Error('Resolved path escapes the repository');
  return target;
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function lineAt(source, index = 0) {
  return source.slice(0, index).split(/\r?\n/).length;
}

async function main() {
  const args = process.argv.slice(2);
  let output;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: verify-phase9-recovery-audit.mjs [--output relative/path.json]');
    output = safeRelativePath(args[1]);
  }
  const report = await runRecoveryAudit(projectRoot);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(resolveInside(projectRoot, output), json, 'utf8');
  process.stdout.write(json);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
