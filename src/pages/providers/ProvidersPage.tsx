import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function ProvidersPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="providers-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="providers-page-title">模型与服务商</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">后续按服务商、连接和模型三层管理动态能力与本地安全凭证。</p>
      </header>
      <EmptyState title="还没有服务连接" description="当前不写死服务商或模型；连接与能力验证将在后续阶段分别实现。" icon="模" />
    </section>
  );
}
