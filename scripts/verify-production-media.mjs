import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  lstat,
  readFile,
  realpath,
  readdir
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestName = 'media-engine.json';
const sourceInfoName = 'source-information.json';
const maxManifestBytes = 64 * 1024;
const maxSourceInfoBytes = 256 * 1024;
const maxOutputBytes = 512 * 1024;
const commandTimeoutMs = 15_000;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const binaryPathPattern = /^bin\/(?:ffmpeg\.exe|ffprobe\.exe|[A-Za-z0-9][A-Za-z0-9._-]*\.dll)$/;
const sourcePathPattern = /^sources\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.xz|zip)$/i;

/**
 * Verify the immutable media component that will be copied into a production package.
 * This is a provenance and packaging check; it is not a legal compliance opinion.
 */
export async function verifyProductionMedia(directory, expectedVersion) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('Production media directory must be an absolute path');
  }
  const componentRoot = path.resolve(directory);
  await requireExternalComponentRoot(componentRoot);
  await requireDirectory(componentRoot, 'production media directory');

  const manifest = await readJson(componentRoot, manifestName, maxManifestBytes);
  validateRuntimeManifest(manifest);
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(`Production media version does not match expected ${expectedVersion}`);
  }

  const sourceInfo = await readJson(componentRoot, sourceInfoName, maxSourceInfoBytes);
  await validateSourceInformation(componentRoot, sourceInfo);
  await validateLicenses(componentRoot);
  await validateDeclaredFiles(componentRoot, manifest.files);

  const ffmpeg = path.join(componentRoot, 'bin', 'ffmpeg.exe');
  const ffprobe = path.join(componentRoot, 'bin', 'ffprobe.exe');
  // Both options exit immediately; combining them would never print the license.
  const ffmpegReport = `${await runTool(ffmpeg, ['-version'])}\n${await runTool(ffmpeg, ['-L'])}`;
  const ffprobeReport = `${await runTool(ffprobe, ['-version'])}\n${await runTool(ffprobe, ['-L'])}`;
  validateToolReports(manifest.version, ffmpegReport, ffprobeReport);

  return {
    directory: componentRoot,
    version: manifest.version,
    files: manifest.files.map((file) => file.path),
    sourceArchives: sourceInfo.sourceArchives.map((archive) => archive.path),
    manualReviewRequired: true
  };
}

export function validateRuntimeManifest(value) {
  if (!isRecord(value) || !sameKeys(value, ['schemaVersion', 'usage', 'engine', 'platform', 'architecture', 'version', 'files'])) {
    throw new Error('Production media manifest has an invalid schema');
  }
  if (value.schemaVersion !== 1 || value.usage !== 'production' || value.engine !== 'ffmpeg' ||
      value.platform !== 'win32' || value.architecture !== 'x64' ||
      typeof value.version !== 'string' || !versionPattern.test(value.version) ||
      !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 128) {
    throw new Error('Production media manifest has invalid metadata');
  }
  const paths = new Set();
  for (const file of value.files) {
    if (!isRecord(file) || !sameKeys(file, ['path', 'sha256']) ||
        typeof file.path !== 'string' || !binaryPathPattern.test(file.path) ||
        typeof file.sha256 !== 'string' || !sha256Pattern.test(file.sha256) ||
        paths.has(file.path.toLowerCase())) {
      throw new Error('Production media manifest contains an invalid file entry');
    }
    paths.add(file.path.toLowerCase());
  }
  if (!paths.has('bin/ffmpeg.exe') || !paths.has('bin/ffprobe.exe')) {
    throw new Error('Production media manifest must declare ffmpeg.exe and ffprobe.exe');
  }
}

export function validateToolReports(version, ffmpegReport, ffprobeReport) {
  for (const [name, report] of [['ffmpeg', ffmpegReport], ['ffprobe', ffprobeReport]]) {
    const reportedVersion = new RegExp(`^${name} version (\\S+)(?:\\s|$)`, 'm').exec(report)?.[1];
    if (reportedVersion !== version) {
      throw new Error(`${name} version does not match production media manifest`);
    }
    if (!/GNU Lesser General Public License|\bLGPL\b/i.test(report)) {
      throw new Error(`${name} does not declare LGPL licensing`);
    }
    if (/--enable-(?:gpl|nonfree)(?:[\s'"=]|$)/i.test(report)) {
      throw new Error(`${name} contains a forbidden GPL or nonfree configuration`);
    }
  }
}

async function validateDeclaredFiles(root, files) {
  const binRoot = path.join(root, 'bin');
  await requireDirectory(root, 'production media bin directory', binRoot);
  const entries = await readdir(binRoot, { withFileTypes: true });
  const declared = new Set(files.map((file) => file.path));
  if (entries.length !== declared.size || entries.some((entry) => !entry.isFile() || !declared.has(`bin/${entry.name}`))) {
    throw new Error('Production media bin contents do not exactly match its manifest');
  }
  for (const file of files) {
    const target = resolveContained(root, file.path);
    await requireRegularFile(target, `production media file ${file.path}`);
    const hash = await sha256File(target);
    if (hash !== file.sha256.toLowerCase()) {
      throw new Error(`Production media hash mismatch for ${file.path}`);
    }
  }
}

async function validateLicenses(root) {
  await requireDirectory(root, 'production media licenses directory', path.join(root, 'licenses'));
  for (const name of ['LGPL-3.0.txt', 'GPL-3.0.txt']) {
    const target = resolveContained(root, `licenses/${name}`);
    await requireRegularFile(target, `license ${name}`);
    if ((await lstat(target)).size > maxSourceInfoBytes) throw new Error(`License ${name} is too large`);
    const content = await readFile(target, 'utf8');
    if (content.trim().length < 100) throw new Error(`License ${name} is empty or truncated`);
  }
  for (const name of ['SOURCE.md', 'THIRD_PARTY_NOTICES.txt']) {
    const target = resolveContained(root, `licenses/${name}`);
    await requireRegularFile(target, name);
    const details = await lstat(target);
    if (details.size > maxSourceInfoBytes) throw new Error(`${name} is too large`);
    if ((await readFile(target, 'utf8')).trim().length < 100) throw new Error(`${name} is empty or incomplete`);
  }
}

async function validateSourceInformation(root, value) {
  if (!isRecord(value) || !Array.isArray(value.sourceArchives) || value.sourceArchives.length > 128 ||
      typeof value.buildRecipeUrl !== 'string' || value.buildRecipeUrl.length === 0 ||
      typeof value.ffmpegRevision !== 'string' || !/^[a-f0-9]{40}$/i.test(value.ffmpegRevision)) {
    throw new Error('Source information is incomplete');
  }
  const recipe = URL.parse(value.buildRecipeUrl);
  if (!recipe || recipe.protocol !== 'https:' || recipe.username || recipe.password) {
    throw new Error('Build recipe must use a public HTTPS URL without credentials');
  }
  let count = 0;
  const archivePaths = new Set();
  await requireDirectory(root, 'production media sources directory', path.join(root, 'sources'));
  for (const archive of value.sourceArchives) {
    if (!isRecord(archive) || typeof archive.path !== 'string' || !sourcePathPattern.test(archive.path) ||
        typeof archive.sha256 !== 'string' || !sha256Pattern.test(archive.sha256) ||
        archivePaths.has(archive.path.toLowerCase())) {
      throw new Error('Source information contains an invalid source archive');
    }
    const target = resolveContained(root, archive.path);
    archivePaths.add(archive.path.toLowerCase());
    await requireRegularFile(target, `source archive ${archive.path}`);
    if ((await lstat(target)).size === 0) throw new Error(`Source archive is empty: ${archive.path}`);
    if (await sha256File(target) !== archive.sha256.toLowerCase()) {
      throw new Error(`Source archive hash mismatch for ${archive.path}`);
    }
    count += 1;
  }
  if (count === 0) throw new Error('Source information must declare at least one source archive');
}

async function requireExternalComponentRoot(root) {
  const realRoot = await realpath(root).catch(() => root);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const toolsRoot = path.resolve(repoRoot, '.tools');
  const realTools = await realpath(toolsRoot).catch(() => toolsRoot);
  if (isInsideOrEqual(realTools, realRoot)) {
    throw new Error('Production media directory cannot be inside the repository .tools directory');
  }
}

async function readJson(root, name, maxBytes) {
  const target = resolveContained(root, name);
  await requireRegularFile(target, name);
  const details = await lstat(target);
  if (details.size > maxBytes) throw new Error(`${name} is too large`);
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

async function requireDirectory(root, label, target = root) {
  const details = await lstat(target).catch(() => null);
  if (!details || !details.isDirectory() || details.isSymbolicLink()) throw new Error(`Missing ${label}`);
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  if (!isInsideOrEqual(realRoot, realTarget)) throw new Error(`${label} escapes its component directory`);
}

async function requireRegularFile(target, label) {
  const details = await lstat(target).catch(() => null);
  if (!details || !details.isFile() || details.isSymbolicLink()) throw new Error(`Missing ${label}`);
  const realTarget = await realpath(target);
  const realParent = await realpath(path.dirname(target));
  if (!isInside(realParent, realTarget)) throw new Error(`${label} is outside its parent directory`);
}

function resolveContained(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error('Production media paths must be relative POSIX paths');
  }
  const target = path.resolve(root, ...relativePath.split('/'));
  if (!isInside(root, target)) throw new Error(`Production media path escapes component: ${relativePath}`);
  return target;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isInsideOrEqual(root, target) {
  return path.resolve(root) === path.resolve(target) || isInside(root, target);
}

function sameKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256File(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function runTool(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => {
      if (output.length < maxOutputBytes) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(command)} timed out`)); }, commandTimeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
    });
  });
}
