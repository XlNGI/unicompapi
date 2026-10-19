import { useEffect, useRef, useState } from 'react';
import type { StorageProjectRemovalMode, StorageRemoveProjectDto } from '../shared/storage-ipc';
import { canSwitchProject, notifyProjectCatalogChanged, notifyProjectSessionChanged } from '../ui/project-session-events';
import { Button } from './Button';

export function ProjectRemovalDialog({ project, allowTrash, onCancel, onRemoved }: {
  readonly project: { readonly projectId: string; readonly projectName: string };
  readonly allowTrash: boolean;
  readonly onCancel: () => void;
  readonly onRemoved: (result: StorageRemoveProjectDto) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<StorageProjectRemovalMode>('forget');
  const [current, setCurrent] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const storage = window.unicomp?.storage;
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    let active = true;
    void storage?.getProjectSession().then(result => {
      if (active && result.ok) setCurrent(result.value?.projectId === project.projectId);
    }).catch(() => {});
    return () => { active = false; dialog?.close(); };
  }, [storage, project.projectId]);

  async function confirm() {
    if (!storage || pending.current) return;
    if (current && !canSwitchProject()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await storage.removeProject(project.projectId, mode);
      if (!result.ok) {
        setError(result.error.code === 'project_in_use'
          ? '请先关闭项目，再将文件移到回收站。'
          : '删除失败。请检查目录权限、未结束的任务，或选择仅移除记录后重试。');
        return;
      }
      if (result.value.sessionClosed) notifyProjectSessionChanged();
      notifyProjectCatalogChanged();
      onRemoved(result.value);
    } catch {
      setError('删除失败，请重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog aria-labelledby="project-removal-title" className="uc-project-removal" onCancel={event => {
      event.preventDefault();
      if (!pending.current) onCancel();
    }} ref={dialogRef}>
      <h2 id="project-removal-title">删除项目</h2>
      <p>“{project.projectName}”</p>
      <fieldset disabled={busy}>
        <legend>选择删除方式</legend>
        <label>
          <input checked={mode === 'forget'} name="project-removal-mode" onChange={() => setMode('forget')} type="radio" value="forget" />
          <span><strong>仅从列表移除</strong><small>保留本地文件，可通过“打开项目”重新加入。</small></span>
        </label>
        {allowTrash && (
          <label>
            <input checked={mode === 'trash'} disabled={current !== false} name="project-removal-mode" onChange={() => setMode('trash')} type="radio" value="trash" />
            <span><strong>同时移到系统回收站</strong><small>移走整个项目文件夹，包括作品和对话；请先关闭项目并结束任务。</small></span>
          </label>
        )}
      </fieldset>
      {current && <p>当前项目将关闭；选择回收站前请先取消并关闭项目。</p>}
      {!allowTrash && <p>项目当前无法读取，仅移除记录，不改动原目录。</p>}
      {error && <p className="uc-project-removal__error" role="alert">{error}</p>}
      <div className="uc-project-removal__actions">
        <Button autoFocus disabled={busy} onClick={onCancel} variant="ghost">取消</Button>
        <Button color="red" disabled={busy || current === undefined} onClick={() => void confirm()}>
          {busy ? '正在处理…' : mode === 'trash' ? '移到回收站' : '移除项目记录'}
        </Button>
      </div>
    </dialog>
  );
}
