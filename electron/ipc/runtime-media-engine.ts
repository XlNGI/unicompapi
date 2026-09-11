import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync
} from 'node:fs';
import path from 'node:path';
import {
  FfmpegMediaEngineAdapter,
  createFfmpegMediaEngineAdapterFromEnvironment,
  type FfmpegMediaEngineAdapterOptions,
  type FfmpegMediaEngineEnvironment
} from '../../src/platform/videos/media-engine-adapter';

interface RuntimeMediaEngineOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly environment?: FfmpegMediaEngineEnvironment;
}

interface ProductionMediaEngineManifest {
  readonly schemaVersion: 1;
  readonly usage: 'production';
  readonly engine: 'ffmpeg';
  readonly platform: 'win32';
  readonly architecture: 'x64';
  readonly version: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

const manifestSizeLimit = 64 * 1024;
const componentFileLimit = 128;

/** Installed apps only execute media tools that belong to the verified package. */
export function createRuntimeMediaEngine(
  options: RuntimeMediaEngineOptions
): FfmpegMediaEngineAdapter | undefined {
  if (!options.isPackaged) {
    return createFfmpegMediaEngineAdapterFromEnvironment(options.environment);
  }
  const resolved = resolvePackagedMediaEngine(options);
  return resolved ? new FfmpegMediaEngineAdapter(resolved) : undefined;
}

export function resolvePackagedMediaEngine(
  options: Pick<RuntimeMediaEngineOptions, 'resourcesPath' | 'platform' | 'architecture'>
): FfmpegMediaEngineAdapterOptions | undefined {
  try {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    if (platform !== 'win32' || architecture !== 'x64') return undefined;
    if (!path.isAbsolute(options.resourcesPath)) return undefined;
    const resourcesRoot = realpathSync(options.resourcesPath);
    const componentRoot = path.join(resourcesRoot, 'media-engine');
    requireContainedDirectory(resourcesRoot, componentRoot);
    const manifestPath = path.join(componentRoot, 'media-engine.json');
    requireContainedFile(componentRoot, manifestPath);
    if (lstatSync(manifestPath).size > manifestSizeLimit) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isProductionManifest(manifest)) return undefined;
    if (manifest.platform !== platform || manifest.architecture !== architecture) return undefined;

    const binRoot = path.join(componentRoot, 'bin');
    requireContainedDirectory(componentRoot, binRoot);
    const declaredFiles = new Set(manifest.files.map((file) => file.path));
    // An undeclared sibling DLL could be loaded by Windows before an intended DLL.
    const binEntries = readdirSync(binRoot, { withFileTypes: true });
    if (binEntries.length !== declaredFiles.size || binEntries.some((entry) =>
      !entry.isFile() || !declaredFiles.has(`bin/${entry.name}`)
    )) return undefined;
    for (const file of manifest.files) {
      const target = path.join(componentRoot, ...file.path.split('/'));
      requireContainedFile(componentRoot, target);
      if (sha256File(target) !== file.sha256.toLowerCase()) return undefined;
    }
    return {
      ffmpegPath: path.join(binRoot, 'ffmpeg.exe'),
      ffprobePath: path.join(binRoot, 'ffprobe.exe'),
      adapterVersion: manifest.version
    };
  } catch {
    // Missing or damaged components must not prevent the rest of the app opening.
    return undefined;
  }
}

function isProductionManifest(value: unknown): value is ProductionMediaEngineManifest {
  if (!isRecord(value) || !hasKeys(value, [
    'schemaVersion', 'usage', 'engine', 'platform', 'architecture', 'version', 'files'
  ])) return false;
  if (value.schemaVersion !== 1 || value.usage !== 'production' || value.engine !== 'ffmpeg' ||
    value.platform !== 'win32' || value.architecture !== 'x64' ||
    typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(value.version) ||
    !Array.isArray(value.files) || value.files.length < 2 || value.files.length > componentFileLimit
  ) return false;
  const paths = new Set<string>();
  for (const entry of value.files) {
    if (!isRecord(entry) || !hasKeys(entry, ['path', 'sha256']) ||
      typeof entry.path !== 'string' ||
      !/^bin\/(?:ffmpeg\.exe|ffprobe\.exe|[A-Za-z0-9][A-Za-z0-9._-]*\.dll)$/.test(entry.path) ||
      typeof entry.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256) ||
      paths.has(entry.path.toLowerCase())
    ) return false;
    paths.add(entry.path.toLowerCase());
  }
  return paths.has('bin/ffmpeg.exe') && paths.has('bin/ffprobe.exe');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function requireContainedDirectory(root: string, target: string): void {
  const details = lstatSync(target);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Invalid media directory');
  requireContainedPath(root, realpathSync(target));
}

function requireContainedFile(root: string, target: string): void {
  const details = lstatSync(target);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Invalid media file');
  requireContainedPath(root, realpathSync(target));
}

function requireContainedPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Media path is outside its package');
  }
}

function sha256File(target: string): string {
  const descriptor = openSync(target, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length: number;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}
