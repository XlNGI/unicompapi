import type { ReactNode } from 'react';
import type {
  NavigationItemId,
  SecondaryNavigationItemId
} from '../navigation/navigationItems';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { useEffect, useId } from 'react';
import { useProjectStatus } from '../status/ProjectStatusContext';
import { TaskStatusDock } from './TaskStatusDock';

interface AppLayoutProps {
  activeItemId: NavigationItemId;
  activeSubItemId?: SecondaryNavigationItemId;
  children: ReactNode;
  onNavigate: (itemId: NavigationItemId) => void;
  onSecondaryNavigate: (
    itemId: NavigationItemId,
    subItemId: SecondaryNavigationItemId
  ) => void;
}

export function AppLayout({
  activeItemId,
  activeSubItemId,
  children,
  onNavigate,
  onSecondaryNavigate
}: AppLayoutProps) {
  const { register, unregister, status } = useProjectStatus();
  const sceneStatusId = useId();
  const sceneLabel = activeSubItemId
    ? ({
        'quick-image': '快速生图',
        'professional-image': '专业生图',
        'image-understanding': '图片识别',
        'image-editing': '图片编辑',
        'image-to-prompt': '图片转提示词',
        'quick-video': '快速视频',
        'text-to-video': '文生视频',
        'image-to-video': '图生视频',
        'video-editing': '视频编辑'
      } as Record<string, string>)[activeSubItemId]
    : ({
        projects: '项目',
        chat: '对话',
        'image-creation': '图片创作',
        'video-creation': '视频创作',
        tasks: '任务中心',
        library: '作品库',
        providers: '模型与服务商',
        settings: '本地设置'
      } as Record<string, string>)[activeItemId];
  useEffect(() => {
    register(sceneStatusId, {
      label: '项目状态',
      tone: 'neutral',
      content: `当前场景：${sceneLabel}。页面状态会在这里更新。`,
      priority: 0,
      role: 'status'
    });
    return () => unregister(sceneStatusId);
  }, [activeItemId, activeSubItemId, register, sceneLabel, sceneStatusId, unregister]);
  return (
    <div className="app-shell app-shell--compact">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <TitleBar onNavigate={onNavigate} />
      <div className="app-body">
        <Sidebar
          activeItemId={activeItemId}
          activeSubItemId={activeSubItemId}
          onNavigate={onNavigate}
          onSecondaryNavigate={onSecondaryNavigate}
        />
        <main
          id="main-content"
          tabIndex={-1}
          className={`workspace uc-scrollbar${activeItemId === 'chat' ? ' workspace--chat' : ''}${activeItemId === 'tasks' ? ' workspace--tasks' : ''}${activeSubItemId === 'video-editing' ? ' workspace--video-editing' : ''}`}
        >
          {children}
        </main>
        <TaskStatusDock fallbackStatus={status} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
