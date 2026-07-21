declare const projectRelativePathBrand: unique symbol;

export type ProjectRelativePath = string & {
  readonly [projectRelativePathBrand]: 'ProjectRelativePath';
};

export function toProjectRelativePath(value: string): ProjectRelativePath {
  const normalized = value.trim().replace(/\\/g, '/');
  const segments = normalized.split('/');

  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\0') ||
    segments.some(
      (segment: string) =>
        segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new TypeError('Storage path must be a safe project-relative path');
  }

  return normalized as ProjectRelativePath;
}

export const projectStoragePaths = {
  manifest: toProjectRelativePath('project.json'),
  entities: {
    drafts: toProjectRelativePath('entities/drafts.json'),
    assets: toProjectRelativePath('entities/assets.json'),
    tasks: toProjectRelativePath('entities/tasks.json'),
    works: toProjectRelativePath('entities/works.json')
  },
  index: toProjectRelativePath('index/file-index.json'),
  filesDirectory: toProjectRelativePath('files'),
  temporaryDirectory: toProjectRelativePath('tmp')
} as const;
