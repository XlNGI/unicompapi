import { useState } from 'react';
import type { ComponentType } from 'react';
import { ChatPage } from '../pages/chat/ChatPage';
import { ImageEditingPage } from '../pages/creation/image/ImageEditingPage';
import { ImageProfessionalPage } from '../pages/creation/image/ImageProfessionalPage';
import { ImageQuickPage } from '../pages/creation/image/ImageQuickPage';
import { ImageToPromptPage } from '../pages/creation/image/ImageToPromptPage';
import { ImageUnderstandingPage } from '../pages/creation/image/ImageUnderstandingPage';
import { ImageToVideoPage } from '../pages/creation/video/ImageToVideoPage';
import { TextToVideoPage } from '../pages/creation/video/TextToVideoPage';
import { VideoEditingPage } from '../pages/creation/video/VideoEditingPage';
import { VideoQuickPage } from '../pages/creation/video/VideoQuickPage';
import { ImageCreationPage } from '../pages/image-creation/ImageCreationPage';
import { LibraryPage } from '../pages/library/LibraryPage';
import { ProjectsPage } from '../pages/projects/ProjectsPage';
import { ProvidersPage } from '../pages/providers/ProvidersPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { TasksPage } from '../pages/tasks/TasksPage';
import { VideoCreationPage } from '../pages/video-creation/VideoCreationPage';
import type { ImageWorkspaceDtoMode } from '../shared/image-workspace-ipc';
import type { VideoWorkspaceDtoMode } from '../shared/video-workspace-ipc';
import type { TaskReuseTarget } from '../shared/task-reuse';
import { AppLayout } from './layout/AppLayout';
import {
  defaultNavigationItemId,
  getSecondaryNavigationItems,
  type NavigationItemId,
  type SecondaryNavigationItemId
} from './navigation/navigationItems';

const pagesByNavigationItem: Record<NavigationItemId, ComponentType> = {
  chat: ChatPage,
  projects: ProjectsPage,
  'image-creation': ImageCreationPage,
  'video-creation': VideoCreationPage,
  tasks: TasksPage,
  library: LibraryPage,
  providers: ProvidersPage,
  settings: SettingsPage
};

const pagesBySecondaryNavigationItem: Record<
  SecondaryNavigationItemId,
  ComponentType
> = {
  'quick-image': ImageQuickPage,
  'professional-image': ImageProfessionalPage,
  'image-understanding': ImageUnderstandingPage,
  'image-editing': ImageEditingPage,
  'image-to-prompt': ImageToPromptPage,
  'quick-video': VideoQuickPage,
  'text-to-video': TextToVideoPage,
  'image-to-video': ImageToVideoPage,
  'video-editing': VideoEditingPage
};

const imageModeNavigationIds: Record<
  ImageWorkspaceDtoMode,
  SecondaryNavigationItemId
> = {
  quick_image: 'quick-image',
  professional_image: 'professional-image',
  image_understanding: 'image-understanding',
  image_editing: 'image-editing',
  image_to_prompt: 'image-to-prompt'
};

const videoModeNavigationIds: Record<
  VideoWorkspaceDtoMode,
  SecondaryNavigationItemId
> = {
  quick_video: 'quick-video',
  text_to_video: 'text-to-video',
  image_to_video: 'image-to-video'
};

export function App() {
  const [activeItemId, setActiveItemId] = useState<NavigationItemId>(
    defaultNavigationItemId
  );
  const [activeSubItemId, setActiveSubItemId] =
    useState<SecondaryNavigationItemId>();
  const [openedVideoDraftId, setOpenedVideoDraftId] = useState<string>();
  const [openedImageDraftId, setOpenedImageDraftId] = useState<string>();
  const [selectedChatConversationId, setSelectedChatConversationId] = useState<string>();
  const [selectedChatCandidateId, setSelectedChatCandidateId] = useState<string>();
  const ActivePage = activeSubItemId
    ? pagesBySecondaryNavigationItem[activeSubItemId]
    : pagesByNavigationItem[activeItemId];

  function handleNavigate(itemId: NavigationItemId) {
    setOpenedVideoDraftId(undefined);
    setOpenedImageDraftId(undefined);
    setActiveItemId(itemId);
    setActiveSubItemId(getSecondaryNavigationItems(itemId)[0]?.id);
  }

  function handleSecondaryNavigate(
    itemId: NavigationItemId,
    subItemId: SecondaryNavigationItemId
  ) {
    setOpenedVideoDraftId(undefined);
    setOpenedImageDraftId(undefined);
    setActiveItemId(itemId);
    setActiveSubItemId(subItemId);
  }

  function handleImageModeNavigate(mode: ImageWorkspaceDtoMode) {
    handleSecondaryNavigate('image-creation', imageModeNavigationIds[mode]);
  }

  function handleVideoDraftCreated(draftId: string) {
    setOpenedImageDraftId(undefined);
    setOpenedVideoDraftId(draftId);
    setActiveItemId('video-creation');
    setActiveSubItemId('image-to-video');
  }

  function handleReuseParameters(target: TaskReuseTarget) {
    if (target.mediaKind === 'video') {
      setOpenedImageDraftId(undefined);
      setOpenedVideoDraftId(target.draftId);
      setActiveItemId('video-creation');
      if (target.mode === 'video_editing') {
        setActiveSubItemId('video-editing');
        return;
      }
      setActiveSubItemId(
        videoModeNavigationIds[target.mode as VideoWorkspaceDtoMode] ?? 'quick-video'
      );
      return;
    }
    setOpenedVideoDraftId(undefined);
    setOpenedImageDraftId(target.draftId);
    setActiveItemId('image-creation');
    setActiveSubItemId(
      imageModeNavigationIds[target.mode as ImageWorkspaceDtoMode] ?? 'quick-image'
    );
  }

  return (
    <AppLayout
      activeItemId={activeItemId}
      activeSubItemId={activeSubItemId}
      onNavigate={handleNavigate}
      onSecondaryNavigate={handleSecondaryNavigate}
    >
      {activeItemId === 'chat' && !activeSubItemId ? (
        <ChatPage
          initialConversationId={selectedChatConversationId}
          initialCandidateId={selectedChatCandidateId}
          onConversationChange={setSelectedChatConversationId}
          onCandidateChange={setSelectedChatCandidateId}
        />
      ) : activeItemId === 'projects' && !activeSubItemId ? (
        <ProjectsPage onNavigate={handleNavigate} />
      ) : activeItemId === 'tasks' && !activeSubItemId ? (
        <TasksPage
          onNavigate={handleNavigate}
          onReuseParameters={handleReuseParameters}
        />
      ) : activeItemId === 'library' && !activeSubItemId ? (
        <LibraryPage onNavigate={handleNavigate} />
      ) : activeSubItemId === 'quick-image' ? (
        <ImageQuickPage
          onVideoDraftCreated={handleVideoDraftCreated}
          preferredDraftId={openedImageDraftId}
          onNavigateToProfessional={() =>
            handleSecondaryNavigate('image-creation', 'professional-image')
          }
        />
      ) : activeSubItemId === 'professional-image' ? (
        <ImageProfessionalPage
          onVideoDraftCreated={handleVideoDraftCreated}
          preferredDraftId={openedImageDraftId}
        />
      ) : activeSubItemId === 'image-understanding' ? (
        <ImageUnderstandingPage
          onNavigateToImageMode={handleImageModeNavigate}
          preferredDraftId={openedImageDraftId}
        />
      ) : activeSubItemId === 'image-editing' ? (
        <ImageEditingPage
          onNavigateToImageMode={handleImageModeNavigate}
          onVideoDraftCreated={handleVideoDraftCreated}
          preferredDraftId={openedImageDraftId}
        />
      ) : activeSubItemId === 'image-to-prompt' ? (
        <ImageToPromptPage
          onNavigateToImageMode={handleImageModeNavigate}
          preferredDraftId={openedImageDraftId}
        />
      ) : activeSubItemId === 'quick-video' ? (
        <VideoQuickPage
          preferredDraftId={openedVideoDraftId}
          onNavigateToImageToVideo={handleVideoDraftCreated}
          onNavigateToTextToVideo={() =>
            handleSecondaryNavigate('video-creation', 'text-to-video')
          }
        />
      ) : activeSubItemId === 'text-to-video' ? (
        <TextToVideoPage preferredDraftId={openedVideoDraftId} />
      ) : activeSubItemId === 'image-to-video' ? (
        <ImageToVideoPage preferredDraftId={openedVideoDraftId} />
      ) : activeSubItemId === 'video-editing' ? (
        <VideoEditingPage
          onNavigate={handleNavigate}
          preferredDraftId={openedVideoDraftId}
        />
      ) : (
        <ActivePage />
      )}
    </AppLayout>
  );
}
