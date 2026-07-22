import path from 'node:path';
import type { FileReference } from '../../domain';
import { toProjectRelativePath } from '../storage';

export function resolveFileReferencePath(
  projectRoot: string,
  file: FileReference
): string {
  if (file.locator.kind === 'external') {
    if (!path.isAbsolute(file.locator.absolutePath)) {
      throw new TypeError('External file path must be absolute');
    }

    return path.resolve(file.locator.absolutePath);
  }

  const root = path.resolve(projectRoot);
  const relative = toProjectRelativePath(file.locator.relativePath);
  const target = path.resolve(root, relative);
  const rootPrefix = `${root}${path.sep}`;

  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new TypeError('File path resolves outside project root');
  }

  return target;
}
