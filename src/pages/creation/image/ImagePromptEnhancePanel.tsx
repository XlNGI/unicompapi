import { PromptEnhancePanel } from '../../../components/PromptEnhancePanel';
import type { GenerationImageDraftDto } from './ImageGenerationControls';

interface ImagePromptEnhancePanelProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onDraftPersisted: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
}

export function ImagePromptEnhancePanel({
  dirty,
  draft,
  onDraftPersisted,
  onMessage
}: ImagePromptEnhancePanelProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  return (
    <PromptEnhancePanel
      api={window.unicomp?.promptEnhance}
      host={{
        subjectId: draft.draftId,
        subjectRevision: draft.updatedAt,
        originalInput: draft.prompt.originalInput,
        inputSignature: JSON.stringify({
          originalInput: draft.prompt.originalInput,
          contextReferences: draft.contextReferences
        }),
        contextCount: draft.contextReferences.filter(
          (reference) =>
            reference.kind === 'project_context' && reference.includeInPrompt === true
        ).length,
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
          const saved = result.value as GenerationImageDraftDto;
          onDraftPersisted(saved);
          return { subjectId: saved.draftId, subjectRevision: saved.updatedAt };
        },
        async refreshResult(input) {
          const refreshed = await imageWorkspaces?.get(input.subjectId);
          if (refreshed?.ok) {
            onDraftPersisted(refreshed.value as GenerationImageDraftDto);
            return;
          }
          throw new Error('Persisted prompt enhancement could not be refreshed');
        }
      }}
      onMessage={onMessage}
    />
  );
}
