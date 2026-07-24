import {
  projectRoot,
  readMediaEngineManifest,
  resolveMediaEngineInstallation,
  verifyMediaEngineInstallation
} from './media-engine-common.mjs';

try {
  const manifest = await readMediaEngineManifest();
  const resolved = resolveMediaEngineInstallation(projectRoot, manifest);
  const verified = await verifyMediaEngineInstallation(resolved);
  console.log(`Verified ${verified.version}`);
  console.log(`ffmpeg: ${verified.ffmpegPath}`);
  console.log(`ffprobe: ${verified.ffprobePath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
