import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function VideoQuickPage({
  onNavigateToTextToVideo,
  onNavigateToImageToVideo,
  preferredDraftId
}: {
  readonly onNavigateToTextToVideo?: () => void;
  readonly onNavigateToImageToVideo?: (draftId: string) => void;
  readonly preferredDraftId?: string;
}) {
  return (
    <VideoWorkbenchPage
      mode={videoCreationModes[0]}
      onNavigateToImageToVideo={onNavigateToImageToVideo}
      onNavigateToTextToVideo={onNavigateToTextToVideo}
      preferredDraftId={preferredDraftId}
    />
  );
}
