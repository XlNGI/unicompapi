import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function VideoQuickPage({
  onNavigateToTextToVideo,
  onNavigateToImageToVideo
}: {
  readonly onNavigateToTextToVideo?: () => void;
  readonly onNavigateToImageToVideo?: (draftId: string) => void;
}) {
  return (
    <VideoWorkbenchPage
      mode={videoCreationModes[0]}
      onNavigateToImageToVideo={onNavigateToImageToVideo}
      onNavigateToTextToVideo={onNavigateToTextToVideo}
    />
  );
}
