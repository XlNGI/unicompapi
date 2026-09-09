import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function TextToVideoPage({
  preferredDraftId
}: {
  readonly preferredDraftId?: string;
}) {
  return (
    <VideoWorkbenchPage
      mode={videoCreationModes[1]}
      preferredDraftId={preferredDraftId}
    />
  );
}
