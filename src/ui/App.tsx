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

export function App() {
  const [activeItemId, setActiveItemId] = useState<NavigationItemId>(
    defaultNavigationItemId
  );
  const [activeSubItemId, setActiveSubItemId] =
    useState<SecondaryNavigationItemId>();
  const ActivePage = activeSubItemId
    ? pagesBySecondaryNavigationItem[activeSubItemId]
    : pagesByNavigationItem[activeItemId];

  function handleNavigate(itemId: NavigationItemId) {
    setActiveItemId(itemId);
    setActiveSubItemId(getSecondaryNavigationItems(itemId)[0]?.id);
  }

  function handleSecondaryNavigate(
    itemId: NavigationItemId,
    subItemId: SecondaryNavigationItemId
  ) {
    setActiveItemId(itemId);
    setActiveSubItemId(subItemId);
  }

  return (
    <AppLayout
      activeItemId={activeItemId}
      activeSubItemId={activeSubItemId}
      onNavigate={handleNavigate}
      onSecondaryNavigate={handleSecondaryNavigate}
    >
      {activeItemId === 'projects' && !activeSubItemId ? (
        <ProjectsPage onNavigate={handleNavigate} />
      ) : activeItemId === 'tasks' && !activeSubItemId ? (
        <TasksPage onNavigate={handleNavigate} />
      ) : activeItemId === 'library' && !activeSubItemId ? (
        <LibraryPage onNavigate={handleNavigate} />
      ) : activeSubItemId === 'quick-image' ? (
        <ImageQuickPage
          onNavigateToProfessional={() =>
            handleSecondaryNavigate('image-creation', 'professional-image')
          }
        />
      ) : activeSubItemId === 'image-understanding' ? (
        <ImageUnderstandingPage
          onNavigateToImageMode={(mode) =>
            handleSecondaryNavigate(
              'image-creation',
              mode === 'professional_image'
                ? 'professional-image'
                : mode === 'image_editing'
                  ? 'image-editing'
                  : 'image-to-prompt'
            )
          }
        />
      ) : (
        <ActivePage />
      )}
    </AppLayout>
  );
}
