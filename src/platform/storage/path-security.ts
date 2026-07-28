import { lstat } from 'node:fs/promises';
import path from 'node:path';

export type StoragePathErrorCode =
  | 'invalid_relative_path'
  | 'path_escape'
  | 'symbolic_link_rejected'
  | 'portable_name_rejected';

export class StoragePathError extends TypeError {
  constructor(readonly code: StoragePathErrorCode, message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

export function normalizePortableRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new StoragePathError('invalid_relative_path', 'Storage path is invalid');
  }
  const normalized = value.replace(/\\/g, '/').normalize('NFC');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new StoragePathError(
      'invalid_relative_path',
      'Storage path must be a safe project-relative path'
    );
  }
  for (const segment of segments) assertPortableSegment(segment);
  return segments.join('/');
}

export function resolveInsideRoot(rootDirectory: string, relativePath: string): string {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new StoragePathError('path_escape', 'Storage path resolves outside project root');
  }
  return target;
}

export async function assertNoSymbolicLinkTraversal(
  rootDirectory: string,
  target: string
): Promise<void> {
  const root = path.resolve(rootDirectory);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(root, resolvedTarget);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new StoragePathError('path_escape', 'Storage path resolves outside project root');
  }

  const segments = relation === '' ? [] : relation.split(path.sep);
  let current = root;
  await assertNotSymbolicLink(current);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new StoragePathError(
          'symbolic_link_rejected',
          'Symbolic links are not allowed inside controlled project paths'
        );
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function assertNotSymbolicLink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new StoragePathError(
        'symbolic_link_rejected',
        'Symbolic links are not allowed for controlled paths'
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function assertPortableSegment(segment: string): void {
  if (
    segment.trim().length === 0 ||
    /[\u0000-\u001f<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
  ) {
    throw new StoragePathError(
      'portable_name_rejected',
      'Storage path contains a name that is not portable across Windows and macOS'
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
