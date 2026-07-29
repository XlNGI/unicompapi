import { useEffect, useState } from 'react';
import {
  LuBell,
  LuChevronDown,
  LuFolderKanban,
  LuSettings
} from 'react-icons/lu';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import type { NavigationItemId } from '../navigation/navigationItems';
import { WindowControls } from './WindowControls';

export function TitleBar({
  onNavigate
}: {
  readonly onNavigate: (itemId: NavigationItemId) => void;
}) {
  const platform = window.unicomp?.platform;
  const storage = window.unicomp?.storage;
  const isMac = platform === 'darwin';
  const [projectName, setProjectName] = useState('尚未打开项目');

  useEffect(() => {
    let active = true;

    async function refreshProject() {
      if (!storage) return;
      const result = await storage.getProjectSession();
      if (active && result.ok) {
        setProjectName(result.value?.projectName ?? '尚未打开项目');
      }
    }

    void refreshProject();
    window.addEventListener('focus', refreshProject);
    return () => {
      active = false;
      window.removeEventListener('focus', refreshProject);
    };
  }, [storage]);

  return (
    <header
      aria-label="应用标题栏"
      className={isMac ? 'title-bar title-bar--mac' : 'title-bar'}
    >
      <div className="title-bar__brand">
        <div
          aria-hidden="true"
          className="title-bar__brand-mark"
          title="正式品牌 Logo 待接入"
        >
          U
        </div>
        <span className="title-bar__brand-name">UniComp AI</span>
      </div>
      <div className="title-bar__context">
        <button
          className="title-bar__project"
          onClick={() => onNavigate('projects')}
          title={`当前项目：${projectName}`}
          type="button"
        >
          <LuFolderKanban aria-hidden="true" />
          <span>当前项目：{projectName}</span>
          <LuChevronDown aria-hidden="true" />
        </button>
        <div className="title-bar__drag-region" aria-hidden="true" />
      </div>
      <div className="title-bar__actions">
        <button
          className="title-bar__utility"
          onClick={() => onNavigate('tasks')}
          type="button"
        >
          <LuBell aria-hidden="true" />
          <span>任务</span>
        </button>
        <button
          className="title-bar__utility"
          onClick={() => onNavigate('settings')}
          type="button"
        >
          <LuSettings aria-hidden="true" />
          <span>设置</span>
        </button>
        <ThemeSwitch />
        {platform === 'win32' ? <WindowControls /> : null}
      </div>
    </header>
  );
}
