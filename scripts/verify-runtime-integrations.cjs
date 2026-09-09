const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  app,
  globalShortcut,
  Notification,
  powerMonitor,
  session
} = require('electron');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const manifest = require('../config/media-engine-development.json');

app.whenReady().then(async () => {
  const probeSession = session.fromPartition(
    `unicomp-b3-runtime-${process.pid}`,
    { cache: false }
  );
  let shortcutRegistered = false;
  try {
    shortcutRegistered = globalShortcut.register(
      'CommandOrControl+Shift+F24',
      () => undefined
    );
    if (shortcutRegistered) {
      globalShortcut.unregister('CommandOrControl+Shift+F24');
    }

    await probeSession.setProxy({ mode: 'direct' });
    const directProxy = await probeSession.resolveProxy('https://example.com/');
    await probeSession.setProxy({ mode: 'system' });
    const systemProxy = await probeSession.resolveProxy('https://example.com/');

    const media = await verifyConfiguredMediaEngine();
    const result = {
      schemaVersion: 1,
      runtime: {
        os: process.platform,
        architecture: process.arch,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node
      },
      integrations: {
        notificationSupported: Notification.isSupported(),
        shortcutRegistration: shortcutRegistered ? 'passed' : 'failed',
        directProxyResolution: directProxy.trim().length > 0 ? 'passed' : 'failed',
        systemProxyResolution: systemProxy.trim().length > 0 ? 'passed' : 'failed',
        powerMonitor: {
          idleState: powerMonitor.getSystemIdleState(60),
          onBatteryPower: powerMonitor.isOnBatteryPower()
        }
      },
      media
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = shortcutRegistered &&
      result.integrations.directProxyResolution === 'passed' &&
      result.integrations.systemProxyResolution === 'passed' &&
      media.status !== 'failed'
      ? 0
      : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (shortcutRegistered) {
      globalShortcut.unregister('CommandOrControl+Shift+F24');
    }
    await probeSession.closeAllConnections().catch(() => undefined);
    await probeSession.clearStorageData().catch(() => undefined);
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  app.quit();
});

async function verifyConfiguredMediaEngine() {
  const platformKey = `${process.platform}-${process.arch}`;
  const specification = manifest.platforms[platformKey];
  if (!specification) {
    return {
      status: 'blocked',
      reason: 'development_media_toolchain_not_approved_for_target'
    };
  }
  const ffmpegPath = path.resolve(
    projectRoot,
    specification.installationDirectory,
    specification.ffmpegRelativePath
  );
  const ffprobePath = path.resolve(
    projectRoot,
    specification.installationDirectory,
    specification.ffprobeRelativePath
  );
  if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) {
    return { status: 'failed', reason: 'approved_media_toolchain_missing' };
  }
  const [ffmpeg, ffprobe] = await Promise.all([
    execFileAsync(ffmpegPath, ['-version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 512_000
    }),
    execFileAsync(ffprobePath, ['-version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 512_000
    })
  ]);
  const versionMatched = ffmpeg.stdout.includes(specification.requiredVersionText) &&
    ffprobe.stdout.includes(specification.requiredVersionText);
  return versionMatched
    ? { status: 'passed', version: manifest.version, scope: manifest.usage }
    : { status: 'failed', reason: 'approved_media_toolchain_version_mismatch' };
}
