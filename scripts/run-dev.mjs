import { spawn } from 'node:child_process';
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
  const npmExecutable = process.env.npm_execpath;
  if (!npmExecutable) {
    throw new Error('npm executable metadata is unavailable');
  }

  console.log(`Using ${verified.version}`);
  const child = spawn(
    process.execPath,
    [npmExecutable, 'run', 'dev:app'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        UNICOMP_ENABLE_LOCAL_FFMPEG: '1',
        UNICOMP_FFMPEG_PATH: verified.ffmpegPath,
        UNICOMP_FFPROBE_PATH: verified.ffprobePath
      },
      shell: false,
      stdio: 'inherit'
    }
  );
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    if (signal) {
      console.error(`Development process stopped by signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    'Run npm run setup:media-engine before starting the development app.'
  );
  process.exitCode = 1;
}
