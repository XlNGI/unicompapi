import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export interface CreationModePageProps {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  icon: string;
}

export function CreationModePage({
  description,
  emptyDescription,
  emptyTitle,
  icon,
  title
}: CreationModePageProps) {
  const titleId = `${title}-page-title`;

  return (
    <section className="uc-page-skeleton" aria-labelledby={titleId}>
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id={titleId}>{title}</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">{description}</p>
      </header>
      <EmptyState title={emptyTitle} description={emptyDescription} icon={icon} />
    </section>
  );
}
