import {
  buildEvidenceManifest,
  collectRuntimeFacts,
  projectRoot,
  readTargetMatrix,
  writeEvidenceManifest
} from './phase9-platform-common.mjs';

const options = parseArguments(process.argv.slice(2));
const matrix = await readTargetMatrix(projectRoot);
const runtime = collectRuntimeFacts();
const manifest = buildEvidenceManifest({
  matrix,
  runtime,
  sourceCommit: options.sourceCommit,
  collectedAt: new Date().toISOString(),
  statuses: options.statuses
});
const platformDirectory = runtime.os === 'darwin' ? 'macos' : 'windows';
const output = await writeEvidenceManifest(
  projectRoot,
  manifest,
  options.output ?? `${platformDirectory}/b1-platform-baseline.json`
);
console.log(JSON.stringify({ output, targetId: manifest.targetId, runtime }, null, 2));

function parseArguments(args) {
  const parsed = { sourceCommit: '', output: null, statuses: {} };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--source-commit') {
      parsed.sourceCommit = args[++index] ?? '';
      continue;
    }
    if (argument === '--output') {
      parsed.output = args[++index] ?? '';
      continue;
    }
    if (argument === '--result') {
      const entry = args[++index] ?? '';
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('--result requires suite=status');
      parsed.statuses[entry.slice(0, separator)] = entry.slice(separator + 1);
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }
  if (!parsed.sourceCommit) throw new Error('--source-commit is required');
  return parsed;
}
