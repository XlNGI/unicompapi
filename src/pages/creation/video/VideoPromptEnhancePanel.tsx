import { PromptEnhancePanel } from '../../../components/PromptEnhancePanel';
import { composeVideoPromptEnhancementInput } from '../../../shared/prompt-enhancement-input';
import type { VideoWorkspaceDraftDto } from '../../../shared/video-workspace-ipc';
import { persistVideoWorkspaceDraft } from './persistVideoWorkspaceDraft';

interface VideoPromptEnhancePanelProps {
  readonly dirty: boolean;
  readonly draft: VideoWorkspaceDraftDto;
  readonly onDraftPersisted: (draft: VideoWorkspaceDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onMessage: (message: string) => void;
}

export function VideoPromptEnhancePanel({
  dirty,
  draft,
  onDraftPersisted,
  onFlushDraft,
  onMessage
}: VideoPromptEnhancePanelProps) {
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const content = composeVideoPromptEnhancementInput(draft);
  return (
    <PromptEnhancePanel
      api={window.unicomp?.promptEnhance}
      host={{
        subjectId: draft.draftId,
        subjectRevision: draft.updatedAt,
        originalInput: draft.prompt.originalInput,
        inputSignature: JSON.stringify({
          originalInput: draft.prompt.originalInput,
          structuredInput: content.text,
          contextReferences: draft.contextReferences
        }),
        dirty,
        async ensureSaved() {
          if (!videoWorkspaces) return undefined;
          if (!dirty && draft.state === 'saved') {
            return { subjectId: draft.draftId, subjectRevision: draft.updatedAt };
          }
          if (onFlushDraft) {
            if (!(await onFlushDraft())) return undefined;
            const refreshed = await videoWorkspaces.get(draft.draftId);
            if (!refreshed.ok || !refreshed.value) {
              onMessage('无法读取刚刚保存的视频草稿，请重试。');
              return undefined;
            }
            return {
              subjectId: refreshed.value.draftId,
              subjectRevision: refreshed.value.updatedAt
            };
          }
          const result = await persistVideoWorkspaceDraft(
            videoWorkspaces,
            draft,
            'saved'
          );
          if (!result.ok) {
            onMessage('保存视频草稿失败，请重试。');
            return undefined;
          }
          const saved = result.value;
          onDraftPersisted(saved);
          return { subjectId: saved.draftId, subjectRevision: saved.updatedAt };
        },
        async refreshResult(input) {
          const refreshed = await videoWorkspaces?.get(input.subjectId);
          if (refreshed?.ok && refreshed.value) {
            onDraftPersisted(refreshed.value);
            return;
          }
          throw new Error('Persisted prompt enhancement could not be refreshed');
        }
      }}
      onMessage={onMessage}
    />
  );
}
