import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function LibraryPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="library-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="library-page-title">作品库</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">管理已写入本地并完成文件校验的正式作品与版本来源。</p>
      </header>
      <EmptyState title="还没有正式作品" description="远端结果只有下载、写入和本地校验成功后，才会登记为作品。" icon="作" />
    </section>
  );
}
