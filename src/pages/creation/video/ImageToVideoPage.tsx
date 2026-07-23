import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function ImageToVideoPage() {
  return <VideoWorkbenchPage mode={videoCreationModes[2]} />;
}
