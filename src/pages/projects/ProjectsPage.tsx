import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { LuClapperboard, LuImagePlus } from 'react-icons/lu';
import { Input } from 'rsuite';
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
import { notifyProjectSessionChanged } from '../../ui/project-session-events';
import '../../styles/pages.css';

interface ProjectsPageProps {
  onNavigate?: (itemId: 'image-creation' | 'video-creation') => void;
}

function describeStorageError(code: StorageIpcErrorCode, _message: string) {
  if (code === 'invalid_project') return '项目损坏或格式无效。';
  if (code === 'project_create_failed') return '无法创建项目，所选位置可能只读。';
  if (code === 'project_open_failed') return '项目位置可能已失效或断盘。';
  if (code === 'storage_error') return '存储设备可能已断开。';
  return '操作失败，请重试。';
}

const projectTaskKindLabels: Readonly<Record<string, string>> = {
  image_generation: '图片生成',
  image_analysis: '图片识别',
  image_editing: '图片编辑',
  image_to_prompt: '图片转提示词',
  video_generation: '视频生成',
  video_editing: '视频编辑'
};

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
      notifyProjectSessionChanged();
      setMessage('项目已打开');
      await refreshDashboard();
    }
    setBusy(false);
  }

  async function handleOpenRecentProject(projectId: string) {
    if (!storage || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await storage.openRecentProject(projectId);
      if (!result.ok) {
        setMessage(describeStorageError(result.error.code, result.error.message));
      } else if (result.value.session) {
        setSession(result.value.session);
        notifyProjectSessionChanged();
        setMessage('项目已打开');
        await refreshDashboard();
      }
    } catch {
      setMessage('打开最近项目失败，请重试');
    } finally {
      setBusy(false);
    }
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
      notifyProjectSessionChanged();
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
      notifyProjectSessionChanged();
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
            <Input
              autoFocus
              id="project-name"
              maxLength={100}
              onChange={(value) => setProjectName(value)}
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
              <button data-entry-kind="image" onClick={() => handleCreationEntry('image-creation')} type="button">
                <span aria-hidden="true"><LuImagePlus /></span>
                <strong>图片创作</strong>
                <small>进入图片创作工具</small>
              </button>
              <button data-entry-kind="video" onClick={() => handleCreationEntry('video-creation')} type="button">
                <span aria-hidden="true"><LuClapperboard /></span>
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
                  <button
                    aria-current={session?.projectId === project.projectId ? 'true' : undefined}
                    aria-label={`打开项目 ${project.projectName}`}
                    className="uc-card uc-project-center__project-card"
                    disabled={busy || project.availability !== 'available'}
                    key={project.projectId}
                    onClick={() => void handleOpenRecentProject(project.projectId)}
                    title={project.availability === 'available'
                      ? `打开项目 ${project.projectName}`
                      : '项目位置已失效或存储设备未连接'}
                    type="button"
                  >
                    <StatusPill tone={project.availability === 'available' ? 'success' : 'warning'}>
                      {project.availability === 'available' ? '可用' : '失效 / 断盘'}
                    </StatusPill>
                    <h3>{project.projectName}</h3>
                    <p>最近打开：{new Date(project.lastOpenedAt).toLocaleString('zh-CN')}</p>
                  </button>
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
                      <strong>{projectTaskKindLabels[task.kind] ?? '其他任务'}</strong>
                      <span>{task.projectName}</span>
                      <StatusPill tone="info">{projectExecutionStateLabel(task.latestExecutionState)}</StatusPill>
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
                        {projectFileStateLabel(work.fileState)}
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

function projectExecutionStateLabel(state?: string): string {
  const labels: Readonly<Record<string, string>> = {
    created: '已创建', submitting: '正在提交', queued: '排队中',
    processing: '处理中', running: '执行中', completed: '已完成',
    failed: '失败', cancelled: '已取消', interrupted: '已中断'
  };
  return state ? labels[state] ?? '未知任务状态' : '尚未执行';
}

function projectFileStateLabel(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    pending: '等待写入', writing: '写入中', verifying: '校验中',
    available: '本地可用', missing: '文件丢失', read_only: '只读',
    disconnected: '存储已断开', corrupted: '文件损坏', deleted: '已删除'
  };
  return labels[state] ?? '未知文件状态';
}
