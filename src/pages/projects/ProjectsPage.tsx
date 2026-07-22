import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  StorageIpcErrorCode,
  StorageProjectSessionDto,
  StorageProjectSummaryDto,
  StorageReadModelIssueDto,
  StorageTaskSummaryDto,
  StorageWorkSummaryDto
} from '../../shared/storage-ipc';
import '../../styles/pages.css';

interface ProjectsPageProps {
  onNavigate?: (itemId: 'image-creation' | 'video-creation') => void;
}

function describeStorageError(code: StorageIpcErrorCode, message: string) {
  if (code === 'invalid_project') return `项目损坏或格式无效：${message}`;
  if (code === 'project_create_failed') return `无法创建项目，所选位置可能只读：${message}`;
  if (code === 'project_open_failed') return `项目位置可能已失效或断盘：${message}`;
  if (code === 'storage_error') return `存储设备可能已断开：${message}`;
  return `操作失败：${message}`;
}

export function ProjectsPage({ onNavigate }: ProjectsPageProps) {
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [projects, setProjects] = useState<readonly StorageProjectSummaryDto[]>([]);
  const [tasks, setTasks] = useState<readonly StorageTaskSummaryDto[]>([]);
  const [works, setWorks] = useState<readonly StorageWorkSummaryDto[]>([]);
  const [taskIssues, setTaskIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [workIssues, setWorkIssues] = useState<readonly StorageReadModelIssueDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [message, setMessage] = useState('');
  const storage = window.unicomp?.storage;

  useEffect(() => {
    let active = true;
    if (!storage) {
      setMessage('当前运行环境未连接桌面项目能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void Promise.all([
      storage.getProjectSession(),
      storage.listProjects(),
      storage.listTasks(),
      storage.listWorks()
    ])
      .then(([sessionResult, projectsResult, tasksResult, worksResult]) => {
        if (!active) return;
        if (sessionResult.ok) setSession(sessionResult.value);
        else setMessage(describeStorageError(sessionResult.error.code, sessionResult.error.message));
        if (projectsResult.ok) setProjects(projectsResult.value);
        else setMessage(describeStorageError(projectsResult.error.code, projectsResult.error.message));
        if (tasksResult.ok) {
          setTasks(tasksResult.value.items);
          setTaskIssues(tasksResult.value.issues);
        } else setMessage(describeStorageError(tasksResult.error.code, tasksResult.error.message));
        if (worksResult.ok) {
          setWorks(worksResult.value.items);
          setWorkIssues(worksResult.value.issues);
        } else setMessage(describeStorageError(worksResult.error.code, worksResult.error.message));
      })
      .catch(() => {
        if (active) setMessage('读取本地项目失败，请重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [storage]);

  async function refreshDashboard() {
    if (!storage) return;
    const [projectsResult, tasksResult, worksResult] = await Promise.all([
      storage.listProjects(),
      storage.listTasks(),
      storage.listWorks()
    ]);
    if (projectsResult.ok) setProjects(projectsResult.value);
    else setMessage(describeStorageError(projectsResult.error.code, projectsResult.error.message));
    if (tasksResult.ok) {
      setTasks(tasksResult.value.items);
      setTaskIssues(tasksResult.value.issues);
    } else setMessage(describeStorageError(tasksResult.error.code, tasksResult.error.message));
    if (worksResult.ok) {
      setWorks(worksResult.value.items);
      setWorkIssues(worksResult.value.issues);
    } else setMessage(describeStorageError(worksResult.error.code, worksResult.error.message));
  }

  async function handleOpenProject() {
    if (!storage || busy) return;
    setBusy(true);
    setMessage('');
    const result = await storage.openProject();
    if (!result.ok) setMessage(describeStorageError(result.error.code, result.error.message));
    else if (result.value.cancelled) setMessage('已取消选择项目');
    else if (result.value.session) {
      setSession(result.value.session);
      setMessage('项目已打开');
      await refreshDashboard();
    }
    setBusy(false);
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = projectName.trim();
    if (!storage || busy || !name) return;
    setBusy(true);
    setMessage('');
    const result = await storage.createProject(name);
    if (!result.ok) setMessage(describeStorageError(result.error.code, result.error.message));
    else if (result.value.cancelled) setMessage('已取消新建项目');
    else if (result.value.session) {
      setSession(result.value.session);
      setProjectName('');
      setCreating(false);
      setMessage('项目已创建');
      await refreshDashboard();
    }
    setBusy(false);
  }

  async function handleCloseProject() {
    if (!storage || busy) return;
    setBusy(true);
    const result = await storage.closeProject();
    if (result.ok) {
      setSession(undefined);
      setMessage('项目已关闭');
    } else setMessage(describeStorageError(result.error.code, result.error.message));
    setBusy(false);
  }

  function handleCreationEntry(itemId: 'image-creation' | 'video-creation') {
    if (!session) {
      setMessage('请先新建或打开项目，再开始创作');
      return;
    }
    onNavigate?.(itemId);
  }

  return (
    <section className="uc-project-center" aria-labelledby="projects-page-title">
      <header className="uc-project-center__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id="projects-page-title">项目</h1>
            <StatusPill tone={session ? 'success' : 'info'}>
              {session ? '项目已打开' : '本地项目'}
            </StatusPill>
          </div>
          <p className="uc-page-skeleton__description">
            集中管理本地项目，并从当前项目进入图片或视频创作。
          </p>
        </div>
        <div className="uc-project-center__actions">
          <Button disabled={!storage || busy} onClick={() => setCreating(true)}>
            新建项目
          </Button>
          <Button disabled={!storage || busy} onClick={handleOpenProject} variant="secondary">
            {busy ? '请稍候…' : '打开项目'}
          </Button>
        </div>
      </header>

      {creating && (
        <Card raised>
          <form className="uc-project-center__create-form" onSubmit={handleCreateProject}>
            <label htmlFor="project-name">项目名称</label>
            <input
              autoFocus
              id="project-name"
              maxLength={100}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="例如：产品宣传片"
              value={projectName}
            />
            <div className="uc-project-center__actions">
              <Button disabled={busy || !projectName.trim()} type="submit">
                {busy ? '正在创建…' : '选择文件夹并创建'}
              </Button>
              <Button disabled={busy} onClick={() => setCreating(false)} variant="ghost">
                取消
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <EmptyState
          busy
          role="status"
          title="正在读取项目状态"
          description="正在读取当前项目会话和最近项目。"
          icon="载"
        />
      ) : (
        <>
          <section className="uc-project-center__section" aria-labelledby="current-project-title">
            <div className="uc-project-center__section-heading">
              <h2 id="current-project-title">当前项目</h2>
            </div>
            {session ? (
              <Card className="uc-project-center__current" raised>
                <div>
                  <StatusPill tone="success">已打开</StatusPill>
                  <h3>{session.projectName}</h3>
                  <p>项目已由主进程安全打开，渲染进程不会获得项目路径。</p>
                </div>
                <Button disabled={busy} onClick={handleCloseProject} variant="secondary">
                  {busy ? '正在关闭…' : '关闭项目'}
                </Button>
              </Card>
            ) : (
              <EmptyState
                title="还没有打开的项目"
                description="新建项目或从本机选择已有项目后，才能创建任务和作品。"
                icon="项"
              />
            )}
          </section>

          <section className="uc-project-center__section" aria-labelledby="creation-entry-title">
            <div className="uc-project-center__section-heading">
              <h2 id="creation-entry-title">开始创作</h2>
              <p>{session ? `内容将保存到“${session.projectName}”` : '请先新建或打开项目'}</p>
            </div>
            <div className="uc-project-center__entry-grid">
              <button onClick={() => handleCreationEntry('image-creation')} type="button">
                <span aria-hidden="true">图</span>
                <strong>图片创作</strong>
                <small>进入图片创作工具</small>
              </button>
              <button onClick={() => handleCreationEntry('video-creation')} type="button">
                <span aria-hidden="true">影</span>
                <strong>视频创作</strong>
                <small>进入视频创作工具</small>
              </button>
            </div>
          </section>

          <section className="uc-project-center__section" aria-labelledby="recent-projects-title">
            <div className="uc-project-center__section-heading">
              <h2 id="recent-projects-title">最近项目</h2>
              <p>项目路径仅由主进程管理</p>
            </div>
            {projects.length === 0 ? (
              <EmptyState
                title="暂无最近项目"
                description="新建或成功打开项目后，它会出现在这里。"
                icon="近"
              />
            ) : (
              <div className="uc-project-center__project-grid">
                {projects.map((project) => (
                  <Card className="uc-project-center__project-card" key={project.projectId}>
                    <StatusPill tone={project.availability === 'available' ? 'success' : 'warning'}>
                      {project.availability === 'available' ? '可用' : '失效 / 断盘'}
                    </StatusPill>
                    <h3>{project.projectName}</h3>
                    <p>最近打开：{new Date(project.lastOpenedAt).toLocaleString('zh-CN')}</p>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <div className="uc-project-center__summary-grid">
            <Card>
              <h2>最近任务</h2>
              {taskIssues.map((issue) => (
                <p className="uc-project-center__issue" key={`${issue.projectId}-${issue.reason}`}>
                  {issue.projectName}：{issue.reason === 'unavailable' ? '项目失效或断盘' : '项目数据损坏'}
                </p>
              ))}
              {tasks.length === 0 ? (
                <p>当前没有可显示的项目任务。</p>
              ) : (
                <ul className="uc-project-center__summary-list">
                  {tasks.slice(0, 3).map((task) => (
                    <li key={task.taskId}>
                      <strong>{task.kind}</strong>
                      <span>{task.projectName}</span>
                      <StatusPill tone="info">{task.latestExecutionState ?? '尚未执行'}</StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2>最近作品</h2>
              {workIssues.map((issue) => (
                <p className="uc-project-center__issue" key={`${issue.projectId}-${issue.reason}`}>
                  {issue.projectName}：{issue.reason === 'unavailable' ? '项目失效或断盘' : '项目数据损坏'}
                </p>
              ))}
              {works.length === 0 ? (
                <p>当前没有已登记的本地作品。</p>
              ) : (
                <ul className="uc-project-center__summary-list">
                  {works.slice(0, 3).map((work) => (
                    <li key={work.workId}>
                      <strong>{work.name}</strong>
                      <span>{work.projectName}</span>
                      <StatusPill tone={work.fileState === 'available' ? 'success' : 'warning'}>
                        {work.fileState}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <p className="uc-project-center__message" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
