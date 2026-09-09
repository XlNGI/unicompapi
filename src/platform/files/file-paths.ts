import path from 'node:path';
import type { FileReference } from '../../domain';
import {
  assertNoSymbolicLinkTraversal,
  assertNotSymbolicLink,
  resolveInsideRoot,
  toProjectRelativePath
} from '../storage';

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
  return resolveInsideRoot(root, relative);
}

export async function resolveFileReferencePathSafely(
  projectRoot: string,
  file: FileReference
): Promise<string> {
  const target = resolveFileReferencePath(projectRoot, file);
  if (file.locator.kind === 'project') {
    await assertNoSymbolicLinkTraversal(projectRoot, target);
  } else {
    await assertNotSymbolicLink(target);
  }
  return target;
}
