export const platformOperatingSystems = ['win32', 'darwin'] as const;
export type PlatformOperatingSystem = (typeof platformOperatingSystems)[number];

export const platformArchitectures = ['x64', 'arm64'] as const;
export type PlatformArchitecture = (typeof platformArchitectures)[number];

export const platformAcceptanceStatuses = [
  'passed',
  'failed',
  'blocked',
  'not_run',
  'not_applicable'
] as const;
export type PlatformAcceptanceStatus = (typeof platformAcceptanceStatuses)[number];

export const platformAcceptanceSuites = [
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
export type PlatformAcceptanceSuite = (typeof platformAcceptanceSuites)[number];

export interface PlatformTargetRequirement {
  readonly id: string;
  readonly os: PlatformOperatingSystem;
  readonly allowedArchitectures: readonly PlatformArchitecture[];
  readonly architecturePolicy: 'record_observed_only';
  readonly executionMode: 'real_device';
  readonly required: boolean;
  readonly requiredSuites: readonly PlatformAcceptanceSuite[];
}

export interface PlatformTargetMatrixV1 {
  readonly schemaVersion: 1;
  readonly targets: readonly PlatformTargetRequirement[];
}

export interface PlatformRuntimeFactsV1 {
  readonly schemaVersion: 1;
  readonly os: PlatformOperatingSystem;
  readonly osVersion: string;
  readonly architecture: PlatformArchitecture;
  readonly nodeVersion: string;
  readonly electronVersion: string | null;
  readonly pathSeparator: '/' | '\\';
  readonly caseSensitivity: 'sensitive' | 'insensitive' | 'unknown';
  readonly unicodeNormalization: 'preserved' | 'normalized' | 'unknown';
  readonly locale: string;
  readonly timeZone: string;
}

export interface PlatformRuntimeFactsPort {
  collect(): Promise<PlatformRuntimeFactsV1>;
}

export interface PlatformAcceptanceResult {
  readonly caseId: string;
  readonly suite: PlatformAcceptanceSuite;
  readonly status: PlatformAcceptanceStatus;
  readonly evidenceRefs: readonly string[];
  readonly note?: string;
}

export interface PlatformEvidenceManifestV1 {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly sourceCommit: string;
  readonly collectedAt: string;
  readonly runtime: PlatformRuntimeFactsV1;
  readonly results: readonly PlatformAcceptanceResult[];
}

export function parsePlatformTargetMatrix(value: unknown): PlatformTargetMatrixV1 {
  const item = exactRecord(value, ['schemaVersion', 'targets'], 'platform target matrix');
  if (item.schemaVersion !== 1 || !Array.isArray(item.targets) || item.targets.length === 0) {
    throw new TypeError('Platform target matrix version or targets are invalid');
  }
  const targets = item.targets.map(parseTargetRequirement);
  const ids = new Set(targets.map((target) => target.id));
  if (ids.size !== targets.length) throw new TypeError('Platform target ids must be unique');
  if (!targets.some((target) => target.required && target.os === 'win32')) {
    throw new TypeError('Platform target matrix requires Windows evidence');
  }
  if (!targets.some((target) => target.required && target.os === 'darwin')) {
    throw new TypeError('Platform target matrix requires macOS evidence');
  }
  return { schemaVersion: 1, targets };
}

export function parsePlatformRuntimeFacts(value: unknown): PlatformRuntimeFactsV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'os', 'osVersion', 'architecture', 'nodeVersion',
    'electronVersion', 'pathSeparator', 'caseSensitivity',
    'unicodeNormalization', 'locale', 'timeZone'
  ], 'platform runtime facts');
  if (item.schemaVersion !== 1) throw new TypeError('Platform runtime facts version is invalid');
  return {
    schemaVersion: 1,
    os: member(item.os, platformOperatingSystems, 'runtime.os'),
    osVersion: nonBlank(item.osVersion, 'runtime.osVersion'),
    architecture: member(item.architecture, platformArchitectures, 'runtime.architecture'),
    nodeVersion: nonBlank(item.nodeVersion, 'runtime.nodeVersion'),
    electronVersion: item.electronVersion === null
      ? null
      : nonBlank(item.electronVersion, 'runtime.electronVersion'),
    pathSeparator: member(item.pathSeparator, ['/', '\\'] as const, 'runtime.pathSeparator'),
    caseSensitivity: member(
      item.caseSensitivity,
      ['sensitive', 'insensitive', 'unknown'] as const,
      'runtime.caseSensitivity'
    ),
    unicodeNormalization: member(
      item.unicodeNormalization,
      ['preserved', 'normalized', 'unknown'] as const,
      'runtime.unicodeNormalization'
    ),
    locale: nonBlank(item.locale, 'runtime.locale'),
    timeZone: nonBlank(item.timeZone, 'runtime.timeZone')
  };
}

export function parsePlatformEvidenceManifest(value: unknown): PlatformEvidenceManifestV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'targetId', 'sourceCommit', 'collectedAt', 'runtime', 'results'
  ], 'platform evidence manifest');
  if (item.schemaVersion !== 1 || !Array.isArray(item.results)) {
    throw new TypeError('Platform evidence manifest version or results are invalid');
  }
  const sourceCommit = nonBlank(item.sourceCommit, 'evidence.sourceCommit').toLowerCase();
  if (!/^[a-f0-9]{7,40}$/.test(sourceCommit)) {
    throw new TypeError('Evidence source commit is invalid');
  }
  return {
    schemaVersion: 1,
    targetId: nonBlank(item.targetId, 'evidence.targetId'),
    sourceCommit,
    collectedAt: isoTimestamp(item.collectedAt, 'evidence.collectedAt'),
    runtime: parsePlatformRuntimeFacts(item.runtime),
    results: item.results.map(parseAcceptanceResult)
  };
}

export function findTargetRequirement(
  matrix: PlatformTargetMatrixV1,
  runtime: PlatformRuntimeFactsV1
): PlatformTargetRequirement {
  const match = matrix.targets.find((target) =>
    target.os === runtime.os && target.allowedArchitectures.includes(runtime.architecture)
  );
  if (!match) throw new TypeError('Runtime is not part of the approved platform target matrix');
  return match;
}

export function isTargetAcceptanceComplete(
  target: PlatformTargetRequirement,
  results: readonly PlatformAcceptanceResult[]
): boolean {
  return target.requiredSuites.every((suite) => {
    const suiteResults = results.filter((result) => result.suite === suite);
    return suiteResults.length > 0 && suiteResults.every((result) => result.status === 'passed');
  });
}

function parseTargetRequirement(value: unknown): PlatformTargetRequirement {
  const item = exactRecord(value, [
    'id', 'os', 'allowedArchitectures', 'architecturePolicy', 'executionMode',
    'required', 'requiredSuites'
  ], 'platform target');
  if (!Array.isArray(item.allowedArchitectures) || item.allowedArchitectures.length === 0) {
    throw new TypeError('Platform target architectures are invalid');
  }
  if (!Array.isArray(item.requiredSuites) || item.requiredSuites.length === 0) {
    throw new TypeError('Platform target suites are invalid');
  }
  const allowedArchitectures = item.allowedArchitectures.map((architecture) =>
    member(architecture, platformArchitectures, 'target.allowedArchitectures')
  );
  const requiredSuites = item.requiredSuites.map((suite) =>
    member(suite, platformAcceptanceSuites, 'target.requiredSuites')
  );
  if (new Set(allowedArchitectures).size !== allowedArchitectures.length) {
    throw new TypeError('Platform target architectures must be unique');
  }
  if (new Set(requiredSuites).size !== requiredSuites.length) {
    throw new TypeError('Platform target suites must be unique');
  }
  if (item.architecturePolicy !== 'record_observed_only' || item.executionMode !== 'real_device') {
    throw new TypeError('Platform targets must use observed real-device evidence');
  }
  if (typeof item.required !== 'boolean') throw new TypeError('Platform target required is invalid');
  return {
    id: nonBlank(item.id, 'target.id'),
    os: member(item.os, platformOperatingSystems, 'target.os'),
    allowedArchitectures,
    architecturePolicy: 'record_observed_only',
    executionMode: 'real_device',
    required: item.required,
    requiredSuites
  };
}

function parseAcceptanceResult(value: unknown): PlatformAcceptanceResult {
  const item = exactRecord(value, ['caseId', 'suite', 'status', 'evidenceRefs', 'note'], 'result');
  if (!Array.isArray(item.evidenceRefs)) throw new TypeError('Result evidence refs are invalid');
  const evidenceRefs = item.evidenceRefs.map((reference) => safeEvidenceRef(reference));
  return {
    caseId: nonBlank(item.caseId, 'result.caseId'),
    suite: member(item.suite, platformAcceptanceSuites, 'result.suite'),
    status: member(item.status, platformAcceptanceStatuses, 'result.status'),
    evidenceRefs,
    ...(item.note === undefined ? {} : { note: nonBlank(item.note, 'result.note') })
  };
}

function safeEvidenceRef(value: unknown): string {
  const reference = nonBlank(value, 'result.evidenceRef').replace(/\\/g, '/');
  if (
    reference.startsWith('/') ||
    /^[a-z]:\//i.test(reference) ||
    reference.split('/').includes('..') ||
    !reference.startsWith('docs/active/evidence/phase9/')
  ) {
    throw new TypeError('Evidence refs must stay inside docs/active/evidence/phase9');
  }
  return reference;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const actual = Object.keys(item).sort();
  const expected = [...keys].filter((key) => key !== 'note' || key in item).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
  return item;
}

function member<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as T[number];
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return value.trim();
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = nonBlank(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${field} is invalid`);
  return timestamp;
}
