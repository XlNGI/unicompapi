import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function ProjectsPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="projects-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="projects-page-title">项目</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">集中管理本地项目，以及项目中的图片、视频、素材与上下文。</p>
      </header>
      <EmptyState title="还没有项目" description="后续将在这里呈现项目入口、最近创作和本地项目状态。" icon="项" />
    </section>
  );
}
