import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function TasksPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="tasks-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="tasks-page-title">任务中心</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">后续展示排队、处理、下载、校验和本地完成等真实执行状态。</p>
      </header>
      <EmptyState title="还没有任务" description="草稿不会出现在这里；只有最终确认后创建的真实任务才进入任务中心。" icon="任" />
    </section>
  );
}
