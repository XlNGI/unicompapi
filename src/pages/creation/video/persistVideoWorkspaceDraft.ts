import type {
  VideoWorkspaceDraftDto,
  VideoWorkspaceIpcResult
} from '../../../shared/video-workspace-ipc';

interface VideoWorkspaceDraftPersistenceApi {
  update(
    draft: VideoWorkspaceDraftDto
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>>;
  get(
    draftId: string
  ): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto | undefined>>;
}

/**
 * Persist a video workspace draft. On optimistic-lock conflict, adopt the
 * latest stored revision when another writer already saved it, instead of
 * surfacing a hard failure for the common dual-autosave race.
 */
export async function persistVideoWorkspaceDraft(
  api: VideoWorkspaceDraftPersistenceApi,
  draft: VideoWorkspaceDraftDto,
  state: 'saved' | 'stale' = 'saved'
): Promise<VideoWorkspaceIpcResult<VideoWorkspaceDraftDto>> {
  const first = await api.update({
    ...draft,
    state
  });
  if (first.ok || first.error.code !== 'draft_conflict') {
    return first;
  }

  const latest = await api.get(draft.draftId);
  if (!latest.ok) {
    return { ok: false, error: latest.error };
  }
  if (!latest.value) {
    return first;
  }

  if (latest.value.state === 'saved' || latest.value.state === 'stale') {
    return { ok: true, value: latest.value };
  }

  // Another writer left an editing revision (e.g. just attached image-to-video
  // source). Persist THAT content instead of replaying the stale caller snapshot,
  // which would wipe materials/source and break preview + submit.
  return api.update({
    ...latest.value,
    state
  });
}
