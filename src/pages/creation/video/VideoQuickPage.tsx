import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function VideoQuickPage({
  onNavigateToTextToVideo
}: {
  readonly onNavigateToTextToVideo?: () => void;
}) {
  return (
    <VideoWorkbenchPage
      mode={videoCreationModes[0]}
      onNavigateToTextToVideo={onNavigateToTextToVideo}
    />
  );
}
