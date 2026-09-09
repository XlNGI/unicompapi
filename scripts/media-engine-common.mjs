import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const manifestRelativePath = path.join(
  'config',
  'media-engine-development.json'
);

export async function readMediaEngineManifest(root = projectRoot) {
  const manifestPath = path.join(root, manifestRelativePath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.engine !== 'ffmpeg' ||
    manifest.usage !== 'development-only' ||
    !manifest.platforms ||
    typeof manifest.platforms !== 'object'
  ) {
    throw new Error('The development media engine manifest is invalid');
  }
  return manifest;
}

export function currentPlatformKey(
  platform = process.platform,
  architecture = process.arch
) {
  return `${platform}-${architecture}`;
}

export function resolveMediaEngineInstallation(
  root,
  manifest,
  platform = process.platform,
  architecture = process.arch
) {
  const platformKey = currentPlatformKey(platform, architecture);
  const specification = manifest.platforms[platformKey];
  if (!specification) {
    throw new Error(
      `No approved development media engine is configured for ${platformKey}`
    );
  }

  const toolsRoot = path.resolve(root, '.tools');
  const installationRoot = path.resolve(
    root,
    specification.installationDirectory
  );
  assertInside(toolsRoot, installationRoot);

  return {
    platformKey,
    specification,
    toolsRoot,
    installationRoot,
    ffmpegPath: resolveInside(
      installationRoot,
      specification.ffmpegRelativePath
    ),
    ffprobePath: resolveInside(
      installationRoot,
      specification.ffprobeRelativePath
    ),
    licensePath: resolveInside(
      installationRoot,
      specification.licenseRelativePath
    )
  };
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

export async function verifyMediaEngineInstallation(resolved) {
  await requireRegularFile(resolved.ffmpegPath, 'ffmpeg executable');
  await requireRegularFile(resolved.ffprobePath, 'ffprobe executable');
  await requireRegularFile(resolved.licensePath, 'FFmpeg license');

  const ffmpegVersion = await runCommand(resolved.ffmpegPath, ['-version']);
  const ffprobeVersion = await runCommand(resolved.ffprobePath, ['-version']);
  const encoders = await runCommand(resolved.ffmpegPath, [
    '-hide_banner',
    '-encoders'
  ]);
  validateFfmpegReport(
    resolved.specification,
    ffmpegVersion,
    ffprobeVersion,
    encoders
  );

  return {
    platformKey: resolved.platformKey,
    version: firstLine(ffmpegVersion),
    ffmpegPath: resolved.ffmpegPath,
    ffprobePath: resolved.ffprobePath
  };
}

export function validateFfmpegReport(
  specification,
  ffmpegVersion,
  ffprobeVersion,
  encoders
) {
  if (!ffmpegVersion.includes(specification.requiredVersionText)) {
    throw new Error(
      `FFmpeg does not match ${specification.requiredVersionText}`
    );
  }
  if (!ffprobeVersion.includes(specification.requiredVersionText)) {
    throw new Error(
      `ffprobe does not match ${specification.requiredVersionText}`
    );
  }

  const flags = new Set(
    ffmpegVersion
      .split(/\s+/)
      .filter((value) => value.startsWith('--'))
  );
  for (const required of specification.requiredConfigurationFlags) {
    if (!flags.has(required)) {
      throw new Error(`FFmpeg is missing required flag ${required}`);
    }
  }
  for (const forbidden of specification.forbiddenConfigurationFlags) {
    if (flags.has(forbidden)) {
      throw new Error(`FFmpeg contains forbidden flag ${forbidden}`);
    }
  }
  for (const encoder of specification.requiredEncoders) {
    if (!new RegExp(`(^|\\s)${escapeRegExp(encoder)}(\\s|$)`, 'm').test(encoders)) {
      throw new Error(`FFmpeg is missing required encoder ${encoder}`);
    }
  }
}

export async function runCommand(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const append = (chunk) => {
      if (output.length < 512_000) output += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `${path.basename(command)} failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
        )
      );
    });
  });
}

export function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Media engine path must stay inside the project .tools directory');
  }
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error('Media engine manifest contains an invalid relative path');
  }
  const target = path.resolve(root, relativePath);
  assertInside(root, target);
  return target;
}

async function requireRegularFile(target, label) {
  try {
    const metadata = await stat(target);
    if (metadata.isFile()) return;
  } catch {
    // Report a consistent verification error below.
  }
  throw new Error(`Missing ${label}: ${target}`);
}

function firstLine(value) {
  return value.split(/\r?\n/, 1)[0].trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
