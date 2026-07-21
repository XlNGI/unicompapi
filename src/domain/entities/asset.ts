import type { AssetId, FileReferenceId, ProjectId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'other';
export type AssetOrigin = 'imported' | 'generated' | 'derived';

export interface Asset {
  readonly schemaVersion: 1;
  readonly id: AssetId;
  readonly projectId: ProjectId;
  readonly fileId: FileReferenceId;
  readonly name: string;
  readonly mediaKind: MediaKind;
  readonly origin: AssetOrigin;
  readonly role?: string;
  readonly createdAt: IsoTimestamp;
}

export function createAsset(input: Omit<Asset, 'schemaVersion'>): Asset {
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'asset.name')
  };
}
