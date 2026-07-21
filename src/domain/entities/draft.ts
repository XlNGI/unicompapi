import type { AssetId, DraftId, ProjectId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import type { PromptSnapshot } from './prompt';

export type CreationKind =
  | 'image_generation'
  | 'image_analysis'
  | 'image_editing'
  | 'image_to_prompt'
  | 'video_generation'
  | 'video_editing';

export type DraftState =
  | 'editing'
  | 'saving'
  | 'saved'
  | 'save_failed'
  | 'stale'
  | 'archived';

export interface Draft {
  readonly schemaVersion: 1;
  readonly id: DraftId;
  readonly projectId: ProjectId;
  readonly kind: CreationKind;
  readonly state: DraftState;
  readonly prompt: PromptSnapshot;
  readonly selectedAssetIds: readonly AssetId[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createDraft(input: Omit<Draft, 'schemaVersion'>): Draft {
  return {
    ...input,
    schemaVersion: 1,
    prompt: {
      ...input.prompt,
      systemSupplements: [...input.prompt.systemSupplements]
    },
    selectedAssetIds: [...input.selectedAssetIds]
  };
}
