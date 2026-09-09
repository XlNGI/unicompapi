import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function VideoCreationPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="video-creation-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="video-creation-page-title">视频创作</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">后续覆盖快速视频、文生视频、图生视频与非破坏式基础编辑。</p>
      </header>
      <EmptyState title="选择视频创作方式" description="当前不创建任务；媒体能力、参数与执行状态将在后续阶段接入。" icon="视" />
    </section>
  );
}
