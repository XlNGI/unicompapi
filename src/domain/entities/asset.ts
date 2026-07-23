import type { AssetId, FileReferenceId, ProjectId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';

export const mediaKinds = ['image', 'video', 'audio', 'document', 'other'] as const;
export type MediaKind = (typeof mediaKinds)[number];

export const assetOrigins = ['imported', 'generated', 'derived'] as const;
export type AssetOrigin = (typeof assetOrigins)[number];

export interface ImageAssetMetadata {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

export interface Asset {
  readonly schemaVersion: 1;
  readonly id: AssetId;
  readonly projectId: ProjectId;
  readonly fileId: FileReferenceId;
  readonly name: string;
  readonly mediaKind: MediaKind;
  readonly origin: AssetOrigin;
  readonly role?: string;
  readonly imageMetadata?: ImageAssetMetadata;
  readonly createdAt: IsoTimestamp;
}

export function createAsset(input: Omit<Asset, 'schemaVersion'>): Asset {
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'asset.name')
  };
}
