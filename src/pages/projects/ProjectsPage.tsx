import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function ProjectsPage() {
  const [session, setSession] = useState<
    { projectId: string; projectName: string } | undefined
  >();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const storage = window.unicomp?.storage;
    if (!storage) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void storage.getProjectSession().then((result) => {
      if (!active) return;
      if (result.ok) setSession(result.value);
      else setMessage(result.error.message);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);

  async function handleOpenProject() {
    const storage = window.unicomp?.storage;
    if (!storage || busy) return;
    setBusy(true);
    setMessage('');
    const result = await storage.openProject();
    if (result.ok) {
      setSession(result.value.session);
      setMessage(result.value.cancelled ? '已取消选择项目' : '项目已打开');
    } else {
      setMessage(result.error.message);
    }
    setBusy(false);
  }

  async function handleCloseProject() {
    const storage = window.unicomp?.storage;
    if (!storage || busy) return;
    setBusy(true);
    const result = await storage.closeProject();
    if (result.ok) {
      setSession(undefined);
      setMessage('项目已关闭');
    } else {
      setMessage(result.error.message);
    }
    setBusy(false);
  }

  return (
    <section className="uc-page-skeleton" aria-labelledby="projects-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="projects-page-title">项目</h1>
          <StatusPill tone={session ? 'success' : 'info'}>
            {session ? '项目已打开' : '本地项目'}
          </StatusPill>
        </div>
        <p className="uc-page-skeleton__description">集中管理本地项目，以及项目中的图片、视频、素材与上下文。</p>
      </header>
      {loading ? (
        <EmptyState
          busy
          role="status"
          title="正在读取项目状态"
          description="正在读取当前本地项目会话。"
          icon="载"
        />
      ) : session ? (
        <EmptyState
          title={session.projectName}
          description="当前项目已由主进程安全打开。项目路径不会暴露给渲染进程。"
          icon="项"
          status={<StatusPill tone="success">已打开</StatusPill>}
          action={
            <Button disabled={busy} onClick={handleCloseProject} variant="secondary">
              {busy ? '正在关闭…' : '关闭项目'}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="还没有打开的项目"
          description="从本机选择已有项目；项目清单验证成功后才会替换当前会话。"
          icon="项"
          action={
            <Button disabled={busy} onClick={handleOpenProject}>
              {busy ? '正在打开…' : '打开项目'}
            </Button>
          }
        />
      )}
      <p className="uc-page-skeleton__message" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
