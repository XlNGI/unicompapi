import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function ImageToVideoPage({
  preferredDraftId
}: {
  readonly preferredDraftId?: string;
}) {
  return (
    <VideoWorkbenchPage
      mode={videoCreationModes[2]}
      preferredDraftId={preferredDraftId}
    />
  );
}
