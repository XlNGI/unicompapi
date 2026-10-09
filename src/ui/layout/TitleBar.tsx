import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  LuBell,
  LuCheck,
  LuChevronDown,
  LuFolderKanban,
  LuSettings
} from 'react-icons/lu';
import unicompMark from '../../assets/brand/unicomp-mark.png';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import type { StorageProjectSummaryDto } from '../../shared/storage-ipc';
import type { NavigationItemId } from '../navigation/navigationItems';
import {
  canSwitchProject,
  notifyProjectSessionChanged,
  PROJECT_SESSION_CHANGED_EVENT
} from '../project-session-events';
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
  const [projectId, setProjectId] = useState<string>();
  const [projects, setProjects] = useState<readonly StorageProjectSummaryDto[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuError, setMenuError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const switchingRef = useRef(false);

  useEffect(() => {
    let active = true;

    async function refreshProject() {
      if (!storage) return;
      const requestId = sessionRequestRef.current + 1;
      sessionRequestRef.current = requestId;
      const result = await storage.getProjectSession();
      if (!active || requestId !== sessionRequestRef.current || !result.ok) return;
      setProjectId(result.value?.projectId);
      setProjectName(result.value?.projectName ?? '尚未打开项目');
    }

    void refreshProject();
    window.addEventListener('focus', refreshProject);
    window.addEventListener(PROJECT_SESSION_CHANGED_EVENT, refreshProject);
    return () => {
      active = false;
      window.removeEventListener('focus', refreshProject);
      window.removeEventListener(PROJECT_SESSION_CHANGED_EVENT, refreshProject);
    };
  }, [storage]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setMenuError('');
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      setMenuError('');
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  async function refreshProjects() {
    if (!storage) return;
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    const result = await storage.listProjects();
    if (requestId !== listRequestRef.current) return;
    if (result.ok) setProjects(result.value);
    setProjectsLoaded(true);
  }

  function toggleMenu() {
    setMenuOpen((open) => {
      const next = !open;
      if (next) {
        setMenuError('');
        void refreshProjects();
      }
      return next;
    });
  }

  async function activateListedProject(project: StorageProjectSummaryDto) {
    if (!storage || switchingRef.current || project.availability !== 'available') return;
    if (project.projectId === projectId) {
      setMenuOpen(false);
      setMenuError('');
      return;
    }
    if (!canSwitchProject()) {
      setMenuOpen(false);
      setMenuError('');
      return;
    }
    switchingRef.current = true;
    setMenuError('');
    try {
      const result = await storage.openRecentProject(project.projectId);
      if (!result.ok) {
        setMenuError(result.error.message || '切换项目失败，请重试。');
        return;
      }
      if (!result.value.session) {
        setMenuError('切换项目失败，请重试。');
        return;
      }
      sessionRequestRef.current += 1;
      setProjectId(result.value.session.projectId);
      setProjectName(result.value.session.projectName);
      notifyProjectSessionChanged();
      setMenuOpen(false);
    } catch {
      setMenuError('切换项目失败，请重试。');
    } finally {
      switchingRef.current = false;
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? []
    );
    if (options.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  return (
    <header
      aria-label="应用标题栏"
      className={isMac ? 'title-bar title-bar--mac' : 'title-bar'}
    >
      <div className="title-bar__brand">
        <div
          aria-hidden="true"
          className="title-bar__brand-mark"
        >
          <img alt="" src={unicompMark} />
        </div>
        <span className="title-bar__brand-name">UniComp AI</span>
      </div>
      <div className="title-bar__context">
        <div className="title-bar__project-switch" ref={containerRef}>
          <button
            aria-controls="title-bar-project-menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`切换所属项目，当前为${projectName}`}
            className="title-bar__project"
            onClick={toggleMenu}
            ref={triggerRef}
            title={`所属项目：${projectName}`}
            type="button"
          >
            <LuFolderKanban aria-hidden="true" />
            <span>所属项目：{projectName}</span>
            <LuChevronDown aria-hidden="true" className="title-bar__project-chevron" />
          </button>
          {menuOpen ? (
            <div
              aria-label="所属项目"
              className="title-bar__project-menu uc-scrollbar"
              id="title-bar-project-menu"
              onKeyDown={handleMenuKeyDown}
              ref={menuRef}
              role="menu"
            >
              {projects.length === 0 ? (
                <p className="title-bar__project-empty">
                  {projectsLoaded ? '暂无项目' : '正在读取项目…'}
                </p>
              ) : projects.map((project) => {
                const current = project.projectId === projectId;
                return (
                  <button
                    aria-checked={current}
                    className="title-bar__project-option"
                    disabled={project.availability !== 'available'}
                    key={project.projectId}
                    onClick={() => void activateListedProject(project)}
                    role="menuitemradio"
                    title={project.availability === 'available' ? project.projectName : '项目当前不可用'}
                    type="button"
                  >
                    <LuFolderKanban aria-hidden="true" />
                    <span>{project.projectName}</span>
                    {current ? <LuCheck aria-hidden="true" /> : <span aria-hidden="true" />}
                  </button>
                );
              })}
              {menuError ? <p className="title-bar__project-error">{menuError}</p> : null}
            </div>
          ) : null}
        </div>
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
