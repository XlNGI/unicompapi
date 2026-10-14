import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectImageBuffer } from '../files/node-image-inspector';

export interface PresentationRenderAsset {
  readonly assetKey: string;
  readonly digest: string;
  readonly aspectRatio: number;
  readonly data: string;
}
/** Paths are supplied only by the existing Host file authorization boundary. */
export async function loadPresentationRenderAssets(images: readonly { readonly absolutePath: string }[]): Promise<readonly PresentationRenderAsset[]> {
  if (images.length > 24) throw new TypeError('presentation_asset_budget_exceeded');
  const assets: PresentationRenderAsset[] = [];
  let total = 0;
  for (const [index, image] of images.entries()) {
    const size = (await stat(image.absolutePath)).size;
    if (size < 1 || size > 20 * 1024 * 1024 || total + size > 80 * 1024 * 1024) throw new TypeError('presentation_asset_budget_exceeded');
    const bytes = await readFile(image.absolutePath);
    if (bytes.length !== size) throw new TypeError('presentation_asset_changed');
    const metadata = inspectImageBuffer(bytes);
    if (metadata.mimeType !== 'image/png' && metadata.mimeType !== 'image/jpeg') throw new TypeError('presentation_asset_format_unsupported');
    total += bytes.length;
    const aspectRatio = metadata.width / metadata.height;
    if (aspectRatio < 0.01 || aspectRatio > 100) throw new TypeError('presentation_asset_dimensions_invalid');
    assets.push({ assetKey: `image-${index + 1}`, digest: createHash('sha256').update(bytes).digest('hex'), aspectRatio,
      data: `${metadata.mimeType};base64,${bytes.toString('base64')}` });
  }
  return assets;
}
