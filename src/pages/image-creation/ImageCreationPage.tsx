import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function ImageCreationPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="image-creation-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="image-creation-page-title">图片创作</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">后续覆盖快速生图、专业生图、图片识别、图片编辑与图片转提示词。</p>
      </header>
      <EmptyState title="选择图片创作方式" description="当前只保留页面骨架；服务、模型、参数和费用将由真实能力动态提供。" icon="图" />
    </section>
  );
}
