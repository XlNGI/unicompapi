import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import type { DiagnosticSettings } from '../../domain';
import type {
  DiagnosticBundlePreviewDto,
  DiagnosticBundleResultDto,
  DiagnosticLocationTarget,
  SettingsCapabilityDto
} from '../../shared/settings-ipc';

export interface DiagnosticLocationAdapter {
  open(target: DiagnosticLocationTarget, lastBundlePath: string | undefined): Promise<void>;
}

export interface DiagnosticCleanupFile {
  readonly target: string;
  readonly root: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

export interface DiagnosticCleanupPlan {
  readonly scope: 'expired_logs' | 'all_logs' | 'diagnostic_cache';
  readonly files: readonly DiagnosticCleanupFile[];
  readonly fileCount: number;
  readonly bytes: number;
}

export interface DiagnosticCleanupResult {
  readonly deletedFileCount: number;
  readonly deletedBytes: number;
}

export type DiagnosticLogCategory = keyof DiagnosticSettings['categories'];
export type DiagnosticLogLevel = DiagnosticSettings['level'];

export interface DiagnosticLogWriteResult {
  readonly written: boolean;
  readonly rotated: boolean;
}

const categoryFiles: Readonly<Record<string, readonly string[]>> = {
  application: ['application.log', 'app.log'],
  tasks: ['tasks.log', 'task.log'],
  media: ['media.log'],
  networkErrors: ['network.log', 'network-errors.log'],
  connectionValidation: ['connections.log', 'connection-validation.log'],
  crashDiagnostics: ['crash.log', 'crash-diagnostics.log']
};

const excludedReasons = [
  { category: 'credentials', reason: 'credentials_tokens_cookies_and_proxy_secrets_are_never_collected' },
  { category: 'paths', reason: 'absolute_paths_are_redacted' },
  { category: 'user_media', reason: 'raw_user_media_is_never_collected' },
  { category: 'prompts', reason: 'full_prompts_are_never_collected' },
  { category: 'upload', reason: 'automatic_upload_is_disabled' }
] as const;

export class DiagnosticsService {
  private lastBundlePath: string | undefined;
  private logQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly locationAdapter?: DiagnosticLocationAdapter,
    private readonly maximumInputBytes = 25 * 1024 * 1024
  ) {}

  getCapability(): SettingsCapabilityDto {
    return { id: 'diagnostics', state: 'available', reason: 'local_only_no_upload' };
  }

  getLastBundleAvailable(): boolean {
    return this.lastBundlePath !== undefined;
  }

  async writeLog(
    category: DiagnosticLogCategory,
    level: DiagnosticLogLevel,
    message: string,
    settings: DiagnosticSettings
  ): Promise<DiagnosticLogWriteResult> {
    if (!settings.categories[category] || !levelEnabled(level, settings.level)) {
      return { written: false, rotated: false };
    }
    let result: DiagnosticLogWriteResult = { written: false, rotated: false };
    const operation = this.logQueue.then(async () => {
      if (settings.autoCleanup) {
        const cleanup = await this.planCleanup('expired_logs', settings, Date.parse(this.now()));
        await this.executeCleanup(cleanup);
      }
      const root = path.join(this.userDataPath, 'logs');
      await mkdir(root, { recursive: true });
      const target = path.join(root, categoryFiles[category][0]);
      const line = `${JSON.stringify({
        at: this.now(),
        category,
        level,
        message: redact(message).slice(0, settings.maxFileBytes)
      })}\n`;
      const rotated = await rotateIfNeeded(target, Buffer.byteLength(line), settings.maxFileBytes);
      const handle = await open(target, 'a');
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      result = { written: true, rotated };
    });
    this.logQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async preview(settings: DiagnosticSettings): Promise<DiagnosticBundlePreviewDto> {
    const files = await this.collectFiles(settings, false);
    return {
      generatedAt: this.now(),
      included: files.map((file) => ({
        category: file.category,
        displayName: file.displayName,
        bytes: file.bytes
      })),
      excluded: excludedReasons,
      redactions: [
        'authorization_and_cookie_headers',
        'api_keys_tokens_and_proxy_credentials',
        'absolute_local_paths',
        'raw_user_media_and_full_prompts'
      ],
      totalInputBytes: files.reduce((total, file) => total + file.bytes, 0),
      automaticUpload: false,
      pathsRedacted: true,
      containsCredentials: false,
      containsUserMedia: false,
      containsFullPrompts: false
    };
  }

  async generate(
    settings: DiagnosticSettings,
    outputDirectory: string
  ): Promise<DiagnosticBundleResultDto> {
    const directory = await requireDirectory(outputDirectory);
    const files = await this.collectFiles(settings, true);
    const bundleId = randomUUID();
    const fileName = `unicomp-diagnostics-${bundleId}.json.gz`;
    const output = path.join(directory, fileName);
    const temporary = `${output}.${randomUUID()}.tmp`;
    const payload = {
      schemaVersion: 1,
      bundleId,
      generatedAt: this.now(),
      logging: {
        level: settings.level,
        retentionDays: settings.retentionDays,
        automaticCleanup: settings.autoCleanup
      },
      files: await Promise.all(files.map(async (file) => ({
        category: file.category,
        name: file.displayName,
        content: redact(await readFile(file.target, 'utf8'))
      }))),
      exclusions: excludedReasons,
      privacy: {
        automaticUpload: false,
        absolutePaths: false,
        credentials: false,
        userMedia: false,
        fullPrompts: false
      }
    };
    try {
      const compressed = await gzipBuffer(Buffer.from(JSON.stringify(payload), 'utf8'));
      await writeFile(temporary, compressed, { flag: 'wx' });
      const metadata = await stat(temporary);
      await rename(temporary, output);
      this.lastBundlePath = output;
      return {
        bundleId,
        fileName,
        bytes: metadata.size,
        format: 'json_gzip_v1',
        locallyVerified: true,
        automaticUpload: false,
        location: 'user_selected'
      };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async openLocation(target: DiagnosticLocationTarget): Promise<void> {
    if (!this.locationAdapter) throw new Error('Diagnostic location adapter is unavailable');
    await this.locationAdapter.open(target, this.lastBundlePath);
  }

  async planCleanup(
    scope: DiagnosticCleanupPlan['scope'],
    settings: DiagnosticSettings,
    nowMs: number
  ): Promise<DiagnosticCleanupPlan> {
    if (!['expired_logs', 'all_logs', 'diagnostic_cache'].includes(scope)) {
      throw new TypeError('Diagnostic cleanup scope is invalid');
    }
    const root = scope === 'diagnostic_cache'
      ? path.join(this.userDataPath, 'diagnostics')
      : path.join(this.userDataPath, 'logs');
    const cutoff = scope === 'expired_logs'
      ? nowMs - settings.retentionDays * 24 * 60 * 60 * 1000
      : undefined;
    const files = await scanFiles(root, cutoff, 100_000);
    return {
      scope,
      files,
      fileCount: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0)
    };
  }

  async executeCleanup(plan: DiagnosticCleanupPlan): Promise<DiagnosticCleanupResult> {
    let deletedFileCount = 0;
    let deletedBytes = 0;
    for (const file of plan.files) {
      const metadata = await lstat(file.target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes ||
        metadata.mtimeMs !== file.modifiedMs || !isInside(file.root, file.target)) {
        throw new Error('Diagnostic cleanup target changed after planning');
      }
      await rm(file.target, { force: true });
      deletedFileCount += 1;
      deletedBytes += file.bytes;
    }
    return { deletedFileCount, deletedBytes };
  }

  private async collectFiles(
    settings: DiagnosticSettings,
    forGeneration: boolean
  ): Promise<readonly CollectedDiagnosticFile[]> {
    const root = path.join(this.userDataPath, 'logs');
    const files = await scanFiles(root, undefined, 100_000);
    const enabled = new Set(
      Object.entries(settings.categories).filter(([, value]) => value).map(([key]) => key)
    );
    const selected = files
      .map((file) => ({ ...file, category: categoryFor(file.target) }))
      .filter((file) => enabled.has(file.category))
      .filter((file) => forGeneration || file.bytes <= settings.maxFileBytes)
      .filter((file) => file.bytes <= this.maximumInputBytes);
    return selected.map((file) => ({
      ...file,
      displayName: path.relative(root, file.target).split(path.sep).join('/')
    }));
  }
}

interface CollectedDiagnosticFile extends DiagnosticCleanupFile {
  readonly category: string;
  readonly displayName: string;
}

async function scanFiles(
  root: string,
  modifiedBeforeMs: number | undefined,
  maximumFileCount: number
): Promise<readonly DiagnosticCleanupFile[]> {
  const result: DiagnosticCleanupFile[] = [];
  await visit(root, root, result, modifiedBeforeMs, maximumFileCount);
  return result.sort((left, right) => left.target.localeCompare(right.target));
}

async function visit(
  root: string,
  current: string,
  result: DiagnosticCleanupFile[],
  modifiedBeforeMs: number | undefined,
  maximumFileCount: number
): Promise<void> {
  if (result.length >= maximumFileCount) throw new Error('Diagnostic file count exceeds limit');
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (result.length >= maximumFileCount) throw new Error('Diagnostic file count exceeds limit');
    if (entry.isSymbolicLink()) continue;
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await visit(root, target, result, modifiedBeforeMs, maximumFileCount);
      continue;
    }
    if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
    const metadata = await lstat(target);
    if (modifiedBeforeMs !== undefined && metadata.mtimeMs >= modifiedBeforeMs) continue;
    result.push({
      target,
      root,
      bytes: metadata.size,
      modifiedMs: metadata.mtimeMs
    });
  }
}

async function requireDirectory(value: string): Promise<string> {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    throw new TypeError('Diagnostic output directory is invalid');
  }
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError('Diagnostic output directory is invalid');
  }
  return path.resolve(value);
}

function categoryFor(target: string): string {
  const base = path.basename(target).toLowerCase();
  for (const [category, names] of Object.entries(categoryFiles)) {
    if (names.some((name) => base === name || base.startsWith(`${name}.`))) return category;
  }
  return 'application';
}

async function rotateIfNeeded(target: string, incomingBytes: number, maximumBytes: number): Promise<boolean> {
  let currentBytes = 0;
  try {
    currentBytes = (await lstat(target)).size;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= maximumBytes) return false;
  await rename(target, `${target}.${Date.now()}.${randomUUID()}.log`);
  return true;
}

function levelEnabled(level: DiagnosticLogLevel, configured: DiagnosticLogLevel): boolean {
  const priority: Readonly<Record<DiagnosticLogLevel, number>> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  };
  return priority[level] <= priority[configured];
}

function redact(value: string): string {
  return value
    .replace(/(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key)\s*[:=]\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/(token|secret|password|credential)\s*[:=]\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/[A-Za-z]:\\[^\r\n\"']+/g, '[PATH_REDACTED]')
    .replace(/(?:[A-Za-z]:)?\\Users\\[^\r\n\"']+/gi, '[PATH_REDACTED]')
    .replace(/\/Users\/[^\r\n\"']+/g, '[PATH_REDACTED]')
    .replace(/(?:prompt|user[_ -]?content|media[_ -]?path)\s*[:=]\s*[^\r\n]*/gi, '$1: [CONTENT_REDACTED]');
}

function gzipBuffer(value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(value, { level: 6 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
