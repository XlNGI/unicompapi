import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import { StateSystemPreview } from './StateSystemPreview';
import '../../styles/pages.css';

export function SettingsPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="settings-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="settings-page-title">本地设置</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">后续按冻结的十个分类管理本地、跨平台及高风险设置。</p>
      </header>
      <EmptyState title="设置分类将在后续接入" description="不支持的平台能力将动态隐藏；目录迁移、清理和重置等高风险操作必须确认。" icon="设" />
      <StateSystemPreview />
    </section>
  );
}
