import { normalizePortableRelativePath } from './path-security';

declare const projectRelativePathBrand: unique symbol;

export type ProjectRelativePath = string & {
  readonly [projectRelativePathBrand]: 'ProjectRelativePath';
};

export function toProjectRelativePath(value: string): ProjectRelativePath {
  return normalizePortableRelativePath(value) as ProjectRelativePath;
}

export const projectStoragePaths = {
  manifest: toProjectRelativePath('project.json'),
  entities: {
    drafts: toProjectRelativePath('entities/drafts.json'),
    imageWorkspaceDrafts: toProjectRelativePath(
      'entities/image-workspace-drafts.json'
    ),
    videoWorkspaceDrafts: toProjectRelativePath(
      'entities/video-workspace-drafts.json'
    ),
    videoEditDrafts: toProjectRelativePath(
      'entities/video-edit-drafts.json'
    ),
    videoExportPlans: toProjectRelativePath(
      'entities/video-export-plans.json'
    ),
    assets: toProjectRelativePath('entities/assets.json'),
    fileReferences: toProjectRelativePath('entities/file-references.json'),
    tasks: toProjectRelativePath('entities/tasks.json'),
    executions: toProjectRelativePath('entities/executions.json'),
    providerOperations: toProjectRelativePath(
      'entities/provider-operations.json'
    ),
    works: toProjectRelativePath('entities/works.json'),
    metadataUnit: toProjectRelativePath('entities/project-metadata.json'),
    projectContexts: toProjectRelativePath('entities/project-contexts.json'),
    projectContextsBackup: toProjectRelativePath(
      'entities/project-contexts.json.bak'
    ),
    conversations: toProjectRelativePath('entities/conversations.json'),
    conversationResponseDrafts: toProjectRelativePath(
      'entities/conversation-response-drafts.json'
    )
  },
  journals: {
    submissionIntents: toProjectRelativePath(
      'journals/submission-intents.json'
    )
  },
  journalsDirectory: toProjectRelativePath('journals'),
  index: toProjectRelativePath('index/file-index.json'),
  filesDirectory: toProjectRelativePath('files'),
  temporaryDirectory: toProjectRelativePath('tmp')
} as const;
