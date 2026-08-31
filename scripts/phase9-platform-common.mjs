import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const acceptanceStatuses = [
  'passed',
  'failed',
  'blocked',
  'not_run',
  'not_applicable'
];

export const acceptanceSuites = [
  'engineering_integrity',
  'electron_lifecycle',
  'filesystem_permissions',
  'secure_storage',
  'system_integrations',
  'power_recovery',
  'media_software',
  'full_product_ui',
  'security_audit'
];

export async function readTargetMatrix(root = projectRoot) {
  const value = await readJson(path.join(root, 'config', 'phase9-target-matrix.json'));
  return validateTargetMatrix(value);
}

export function validateTargetMatrix(value) {
  exactKeys(value, ['schemaVersion', 'targets'], 'target matrix');
  if (value.schemaVersion !== 1 || !Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error('Phase 9 target matrix version or targets are invalid');
  }
  const ids = new Set();
  const targets = value.targets.map((target) => {
    exactKeys(target, [
      'id', 'os', 'allowedArchitectures', 'architecturePolicy', 'executionMode',
      'required', 'requiredSuites'
    ], 'target');
    if (!nonBlank(target.id) || ids.has(target.id)) throw new Error('Target ids must be unique');
    ids.add(target.id);
    if (!['win32', 'darwin'].includes(target.os)) throw new Error('Target OS is invalid');
    if (
      !Array.isArray(target.allowedArchitectures) ||
      target.allowedArchitectures.length === 0 ||
      target.allowedArchitectures.some((item) => !['x64', 'arm64'].includes(item)) ||
      new Set(target.allowedArchitectures).size !== target.allowedArchitectures.length
    ) {
      throw new Error('Target architectures are invalid');
    }
    if (
      target.architecturePolicy !== 'record_observed_only' ||
      target.executionMode !== 'real_device'
    ) {
      throw new Error('Target evidence must be observed on a real device');
    }
    if (typeof target.required !== 'boolean') throw new Error('Target required flag is invalid');
    if (
      !Array.isArray(target.requiredSuites) ||
      target.requiredSuites.length === 0 ||
      target.requiredSuites.some((suite) => !acceptanceSuites.includes(suite)) ||
      new Set(target.requiredSuites).size !== target.requiredSuites.length
    ) {
      throw new Error('Target suites are invalid');
    }
    return { ...target };
  });
  if (!targets.some((target) => target.required && target.os === 'win32')) {
    throw new Error('Target matrix requires Windows evidence');
  }
  if (!targets.some((target) => target.os === 'darwin')) {
    throw new Error('Target matrix requires a macOS target');
  }
  return { schemaVersion: 1, targets };
}

export function collectRuntimeFacts({
  platform = process.platform,
  architecture = process.arch,
  release = os.release(),
  nodeVersion = process.versions.node,
  electronVersion = process.versions.electron ?? null,
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  pathSeparator = path.sep
} = {}) {
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error(`Current platform ${platform} is outside the approved Phase 9 matrix`);
  }
  if (!['x64', 'arm64'].includes(architecture)) {
    throw new Error(`Current architecture ${architecture} is outside the approved Phase 9 matrix`);
  }
  return {
    schemaVersion: 1,
    os: platform,
    osVersion: requiredText(release, 'OS version'),
    architecture,
    nodeVersion: requiredText(nodeVersion, 'Node version'),
    electronVersion: electronVersion === null
      ? null
      : requiredText(electronVersion, 'Electron version'),
    pathSeparator: pathSeparator === '\\' ? '\\' : '/',
    caseSensitivity: 'unknown',
    unicodeNormalization: 'unknown',
    locale: requiredText(locale, 'locale'),
    timeZone: requiredText(timeZone, 'time zone')
  };
}

export function findTargetRequirement(matrix, runtime) {
  const target = matrix.targets.find((candidate) =>
    candidate.os === runtime.os && candidate.allowedArchitectures.includes(runtime.architecture)
  );
  if (!target) throw new Error('Runtime is not part of the approved Phase 9 target matrix');
  return target;
}

export function validateEvidenceManifest(value) {
  exactKeys(value, [
    'schemaVersion', 'targetId', 'sourceCommit', 'collectedAt', 'runtime', 'results'
  ], 'evidence manifest');
  if (value.schemaVersion !== 1 || !Array.isArray(value.results)) {
    throw new Error('Evidence manifest version or results are invalid');
  }
  if (!nonBlank(value.targetId)) throw new Error('Evidence target id is invalid');
  if (!/^[a-f0-9]{7,40}$/i.test(value.sourceCommit)) throw new Error('Evidence source commit is invalid');
  if (!Number.isFinite(Date.parse(value.collectedAt))) throw new Error('Evidence collection time is invalid');
  const runtime = validateRuntimeFacts(value.runtime);
  const caseIds = new Set();
  const results = value.results.map((result) => {
    const allowedKeys = result && typeof result === 'object' && 'note' in result
      ? ['caseId', 'suite', 'status', 'evidenceRefs', 'note']
      : ['caseId', 'suite', 'status', 'evidenceRefs'];
    exactKeys(result, allowedKeys, 'evidence result');
    if (!nonBlank(result.caseId) || caseIds.has(result.caseId)) {
      throw new Error('Evidence case ids must be unique and non-empty');
    }
    caseIds.add(result.caseId);
    if (!acceptanceSuites.includes(result.suite)) throw new Error('Evidence suite is invalid');
    if (!acceptanceStatuses.includes(result.status)) throw new Error('Evidence status is invalid');
    if (!Array.isArray(result.evidenceRefs)) throw new Error('Evidence references are invalid');
    const evidenceRefs = result.evidenceRefs.map((reference) => {
      const normalized = safeRelativePath(reference);
      if (!normalized.startsWith('docs/active/evidence/phase9/')) {
        throw new Error('Evidence references must stay inside the Phase 9 evidence root');
      }
      return normalized;
    });
    return {
      caseId: result.caseId,
      suite: result.suite,
      status: result.status,
      evidenceRefs,
      ...(result.note === undefined ? {} : { note: requiredText(result.note, 'evidence note') })
    };
  });
  return {
    schemaVersion: 1,
    targetId: value.targetId,
    sourceCommit: value.sourceCommit.toLowerCase(),
    collectedAt: new Date(value.collectedAt).toISOString(),
    runtime,
    results
  };
}

export function isTargetAcceptanceComplete(target, results) {
  return target.requiredSuites.every((suite) => {
    const suiteResults = results.filter((result) => result.suite === suite);
    return suiteResults.length > 0 && suiteResults.every((result) => result.status === 'passed');
  });
}

function validateRuntimeFacts(value) {
  exactKeys(value, [
    'schemaVersion', 'os', 'osVersion', 'architecture', 'nodeVersion',
    'electronVersion', 'pathSeparator', 'caseSensitivity',
    'unicodeNormalization', 'locale', 'timeZone'
  ], 'runtime facts');
  if (value.schemaVersion !== 1 || !['win32', 'darwin'].includes(value.os)) {
    throw new Error('Runtime facts version or OS is invalid');
  }
  if (!['x64', 'arm64'].includes(value.architecture)) throw new Error('Runtime architecture is invalid');
  if (!['\\', '/'].includes(value.pathSeparator)) throw new Error('Runtime path separator is invalid');
  if (!['sensitive', 'insensitive', 'unknown'].includes(value.caseSensitivity)) {
    throw new Error('Runtime case sensitivity is invalid');
  }
  if (!['preserved', 'normalized', 'unknown'].includes(value.unicodeNormalization)) {
    throw new Error('Runtime Unicode normalization is invalid');
  }
  return {
    schemaVersion: 1,
    os: value.os,
    osVersion: requiredText(value.osVersion, 'OS version'),
    architecture: value.architecture,
    nodeVersion: requiredText(value.nodeVersion, 'Node version'),
    electronVersion: value.electronVersion === null
      ? null
      : requiredText(value.electronVersion, 'Electron version'),
    pathSeparator: value.pathSeparator,
    caseSensitivity: value.caseSensitivity,
    unicodeNormalization: value.unicodeNormalization,
    locale: requiredText(value.locale, 'locale'),
    timeZone: requiredText(value.timeZone, 'time zone')
  };
}

export async function verifyHandoff(root = projectRoot) {
  const handoffRoot = path.join(
    root,
    'handoff',
    'UniComp-技术开发启动包-V1.0.0',
    '03-最终UI交接包-已解压',
    'UniComp-AI-最终UI与开发交接包-V1.2.1'
  );
  const failures = [];
  let checksumEntries = 0;
  const checksumText = await readFile(
    path.join(handoffRoot, 'manifests', 'SHA256SUMS.txt'),
    'utf8'
  );
  for (const line of checksumText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
    if (!match) {
      failures.push({ kind: 'invalid_checksum_entry', path: line });
      continue;
    }
    const relative = safeRelativePath(match[2]);
    const target = resolveInside(handoffRoot, relative);
    checksumEntries += 1;
    if (!(await isRegularFile(target))) {
      failures.push({ kind: 'missing', path: relative });
      continue;
    }
    if (!(await matchesHandoffHash(target, match[1].toLowerCase()))) {
      failures.push({ kind: 'hash_mismatch', path: relative });
    }
  }

  const manifest = await readJson(path.join(handoffRoot, 'manifests', 'resource-manifest.json'));
  if (!Array.isArray(manifest.assets)) throw new Error('Resource manifest assets are invalid');
  let manifestAssets = 0;
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== 'object') throw new Error('Resource manifest asset is invalid');
    const relative = safeRelativePath(asset.path);
    const target = resolveInside(handoffRoot, relative);
    manifestAssets += 1;
    if (!(await isRegularFile(target))) {
      failures.push({ kind: 'asset_missing', path: relative });
      continue;
    }
    const metadata = await stat(target);
    if ((await sha256File(target)) !== String(asset.sha256).toLowerCase()) {
      failures.push({ kind: 'asset_hash_mismatch', path: relative });
    }
    if (metadata.size !== asset.bytes) {
      failures.push({ kind: 'asset_size_mismatch', path: relative });
    }
  }
  return { checksumEntries, manifestAssets, failures };
}

export async function readPlatformAudit(root = projectRoot) {
  const config = await readJson(path.join(root, 'config', 'phase9-platform-audit.json'));
  exactKeys(config, ['schemaVersion', 'roots', 'extensions', 'rules'], 'platform audit');
  if (
    config.schemaVersion !== 1 ||
    !Array.isArray(config.roots) ||
    !Array.isArray(config.extensions) ||
    !Array.isArray(config.rules)
  ) {
    throw new Error('Platform audit configuration is invalid');
  }
  return config;
}

export async function auditPlatformAssumptions(root = projectRoot, config) {
  const audit = config ?? await readPlatformAudit(root);
  const files = [];
  for (const relativeRoot of audit.roots) {
    await walkProductionFiles(root, relativeRoot, new Set(audit.extensions), files);
  }
  const violations = [];
  const rules = [];
  for (const rule of audit.rules) {
    exactKeys(rule, ['id', 'owner', 'pattern', 'allowedFiles'], 'audit rule');
    const expression = new RegExp(rule.pattern, 'g');
    const matchedFiles = [];
    let occurrences = 0;
    for (const relative of files) {
      const content = await readFile(path.join(root, ...relative.split('/')), 'utf8');
      const matches = content.match(expression) ?? [];
      if (matches.length === 0) continue;
      matchedFiles.push(relative);
      occurrences += matches.length;
    }
    matchedFiles.sort();
    const allowed = [...rule.allowedFiles].map(normalizeRelative).sort();
    for (const relative of matchedFiles.filter((file) => !allowed.includes(file))) {
      violations.push({ rule: rule.id, kind: 'unapproved_match', file: relative });
    }
    for (const relative of allowed.filter((file) => !matchedFiles.includes(file))) {
      violations.push({ rule: rule.id, kind: 'stale_allowlist', file: relative });
    }
    rules.push({ id: rule.id, owner: rule.owner, occurrences, matchedFiles });
  }

  const forbidden = [
    { id: 'hardcoded-windows-absolute-path', expression: /[a-z]:\\(?:Users|home)\\/gi },
    { id: 'hardcoded-posix-home-path', expression: /\/(?:Users|home)\/[^\s'"`]+/g },
    { id: 'shell-enabled-child-process', expression: /shell\s*:\s*true/g }
  ];
  for (const rule of forbidden) {
    for (const relative of files) {
      if (relative === 'scripts/phase9-platform-common.mjs') continue;
      const content = await readFile(path.join(root, ...relative.split('/')), 'utf8');
      if (rule.expression.test(content)) {
        violations.push({ rule: rule.id, kind: 'forbidden_match', file: relative });
      }
      rule.expression.lastIndex = 0;
    }
  }
  return { scannedFiles: files.length, rules, violations };
}

export function buildEvidenceManifest({ matrix, runtime, sourceCommit, collectedAt, statuses = {} }) {
  if (!/^[a-f0-9]{7,40}$/i.test(sourceCommit)) throw new Error('Source commit is invalid');
  const target = findTargetRequirement(matrix, runtime);
  for (const [suite, status] of Object.entries(statuses)) {
    if (!target.requiredSuites.includes(suite)) throw new Error(`Unknown suite ${suite}`);
    if (!acceptanceStatuses.includes(status)) throw new Error(`Invalid status ${status}`);
  }
  const results = target.requiredSuites.map((suite) => ({
    caseId: `b1.${suite}`,
    suite,
    status: statuses[suite] ?? 'not_run',
    evidenceRefs: [],
    ...(statuses[suite] === 'passed'
      ? { note: 'B1 platform contract baseline verified on the recorded runtime' }
      : {})
  }));
  return {
    schemaVersion: 1,
    targetId: target.id,
    sourceCommit: sourceCommit.toLowerCase(),
    collectedAt: new Date(collectedAt).toISOString(),
    runtime,
    results
  };
}

export async function writeEvidenceManifest(root, manifest, outputRelative) {
  const evidenceRoot = path.resolve(root, 'docs', 'active', 'evidence', 'phase9');
  const output = resolveInside(evidenceRoot, safeRelativePath(outputRelative));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return normalizeRelative(path.relative(root, output));
}

export async function sha256File(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const source = createReadStream(target);
    source.on('error', reject);
    source.on('data', (chunk) => hash.update(chunk));
    source.on('end', () => resolve(hash.digest('hex')));
  });
}

async function matchesHandoffHash(target, expected) {
  const content = await readFile(target);
  if (sha256Bytes(content) === expected) return true;
  if (!['.json', '.md', '.txt'].includes(path.extname(target).toLowerCase())) return false;
  const normalized = Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return sha256Bytes(normalized) === expected;
}

function sha256Bytes(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function walkProductionFiles(root, relativeRoot, extensions, output) {
  const normalizedRoot = normalizeRelative(relativeRoot);
  const absoluteRoot = path.join(root, ...normalizedRoot.split('/'));
  for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
    const relative = normalizeRelative(path.posix.join(normalizedRoot, entry.name));
    if (entry.isDirectory()) {
      await walkProductionFiles(root, relative, extensions, output);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      output.push(relative);
    }
  }
  output.sort();
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function safeRelativePath(value) {
  if (!nonBlank(value)) throw new Error('Relative path is invalid');
  const normalized = normalizeRelative(value);
  if (
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Path must stay inside the approved root');
  }
  return normalized;
}

function resolveInside(root, relative) {
  const target = path.resolve(root, ...normalizeRelative(relative).split('/'));
  const relation = path.relative(path.resolve(root), target);
  if (
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error('Path must stay inside the approved root');
  }
  return target;
}

function normalizeRelative(value) {
  return String(value).replaceAll('\\', '/');
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredText(value, label) {
  if (!nonBlank(value)) throw new Error(`${label} is invalid`);
  return value.trim();
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

async function isRegularFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
