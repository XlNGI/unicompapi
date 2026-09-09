import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const source = path.join(
  projectRoot,
  'src',
  'platform',
  'documents',
  'templates',
  'university-classroom.pptx'
);
const target = path.join(
  projectRoot,
  'dist-electron',
  'src',
  'platform',
  'documents',
  'templates',
  'university-classroom.pptx'
);

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Copied document template: ${path.relative(projectRoot, target)}`);
