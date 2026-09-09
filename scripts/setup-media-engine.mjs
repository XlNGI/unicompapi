import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertInside,
  projectRoot,
  readMediaEngineManifest,
  resolveMediaEngineInstallation,
  runCommand,
  sha256File,
  verifyMediaEngineInstallation
} from './media-engine-common.mjs';

const scriptPath = path.resolve(fileURLToPath(import.meta.url));

export function parseArguments(argv) {
  const options = { archive: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--archive') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--archive requires a file path');
      }
      options.archive = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function validateArchiveEntries(output, archiveRoot) {
  const entries = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('The media engine archive is empty');
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`The media engine archive contains an unsafe path: ${entry}`);
    }
    if (normalized !== archiveRoot && !normalized.startsWith(`${archiveRoot}/`)) {
      throw new Error(`The media engine archive contains an unexpected root: ${entry}`);
    }
  }
  return entries;
}

async function downloadArchive(url, destination) {
  if (!url.startsWith('https://')) {
    throw new Error('Media engine download URL must use HTTPS');
  }
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Media engine download failed with HTTP ${response.status}`);
  }
  if (!response.url.startsWith('https://')) {
    throw new Error('Media engine download redirected to a non-HTTPS URL');
  }
  try {
    await pipeline(response.body, createWriteStream(destination, { flags: 'wx' }));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  return destination;
}

async function requireRegularFile(target, label) {
  try {
    const metadata = await stat(target);
    if (metadata.isFile()) return;
  } catch {
    // Normalize the error below.
  }
  throw new Error(`Missing ${label}: ${target}`);
}

async function installMediaEngine({ root = projectRoot, archive = null } = {}) {
  const manifest = await readMediaEngineManifest(root);
  const resolved = resolveMediaEngineInstallation(root, manifest);
  const specification = resolved.specification;
  const toolsRoot = resolved.toolsRoot;
  await mkdir(toolsRoot, { recursive: true });

  let archivePath = archive;
  let downloaded = false;
  if (!archivePath) {
    archivePath = path.join(toolsRoot, specification.archiveName);
    try {
      await requireRegularFile(archivePath, 'media engine archive');
    } catch {
      await downloadArchive(specification.downloadUrl, archivePath);
      downloaded = true;
    }
  }
  await requireRegularFile(archivePath, 'media engine archive');

  const digest = await sha256File(archivePath);
  if (digest.toLowerCase() !== specification.sha256.toLowerCase()) {
    if (downloaded) await rm(archivePath, { force: true });
    throw new Error(
      `Media engine archive SHA-256 mismatch: expected ${specification.sha256}, received ${digest}`
    );
  }

  const archiveListing = await runCommand('tar', ['-tf', archivePath]);
  validateArchiveEntries(archiveListing, specification.archiveRoot);
  const verboseListing = await runCommand('tar', ['-tvf', archivePath]);
  if (verboseListing.split(/\r?\n/).some((entry) => /^[lh]/.test(entry))) {
    throw new Error('The media engine archive contains unsupported links');
  }

  const stagingRoot = path.join(
    toolsRoot,
    `.staging-media-engine-${process.pid}-${Date.now()}`
  );
  const stagingInstallation = path.join(
    stagingRoot,
    specification.archiveRoot
  );
  assertInside(toolsRoot, stagingRoot);
  assertInside(toolsRoot, stagingInstallation);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    await runCommand('tar', ['-xf', archivePath, '-C', stagingRoot]);
    const stagedResolved = resolveMediaEngineInstallation(
      root,
      {
        ...manifest,
        platforms: {
          ...manifest.platforms,
          [resolved.platformKey]: {
            ...specification,
            installationDirectory: path.relative(
              root,
              stagingInstallation
            )
          }
        }
      }
    );
    await verifyMediaEngineInstallation(stagedResolved);

    const backup = path.join(
      toolsRoot,
      `.previous-media-engine-${process.pid}-${Date.now()}`
    );
    assertInside(toolsRoot, backup);
    await rm(backup, { recursive: true, force: true });
    await mkdir(path.dirname(resolved.installationRoot), { recursive: true });
    let previousInstallationMoved = false;
    try {
      await stat(resolved.installationRoot);
      await rename(resolved.installationRoot, backup);
      previousInstallationMoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(stagingInstallation, resolved.installationRoot);
    } catch (error) {
      if (previousInstallationMoved) {
        await rename(backup, resolved.installationRoot);
      }
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    if (downloaded) await rm(archivePath, { force: true });
  }

  return verifyMediaEngineInstallation(resolved);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const verified = await installMediaEngine(options);
    console.log(`Installed ${verified.version}`);
    console.log(`ffmpeg: ${verified.ffmpegPath}`);
    console.log(`ffprobe: ${verified.ffprobePath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { installMediaEngine };
