import { PromptEnhancePanel } from '../../../components/PromptEnhancePanel';
import { composeImagePromptEnhancementInput } from '../../../shared/prompt-enhancement-input';
import type { ImageWorkspaceDraftDto } from '../../../shared/image-workspace-ipc';

interface ImagePromptEnhancePanelProps {
  readonly dirty: boolean;
  readonly draft: ImageWorkspaceDraftDto;
  readonly onDraftPersisted: (draft: ImageWorkspaceDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

export function ImagePromptEnhancePanel({
  dirty,
  draft,
  onDraftPersisted,
  onMessage
}: ImagePromptEnhancePanelProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const content = composeImagePromptEnhancementInput(draft);
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
          if (!imageWorkspaces) return undefined;
          if (!dirty && draft.state === 'saved') {
            return { subjectId: draft.draftId, subjectRevision: draft.updatedAt };
          }
          const result = await imageWorkspaces.update({ ...draft, state: 'saved' });
          if (!result.ok) {
            onMessage('保存图片草稿失败，请重试。');
            return undefined;
          }
          const saved = result.value;
          onDraftPersisted(saved);
          return { subjectId: saved.draftId, subjectRevision: saved.updatedAt };
        },
        async refreshResult(input) {
          const refreshed = await imageWorkspaces?.get(input.subjectId);
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
