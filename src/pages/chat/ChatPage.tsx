import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import '../../styles/pages.css';

export function ChatPage() {
  return (
    <section className="uc-page-skeleton" aria-labelledby="chat-page-title">
      <header className="uc-page-skeleton__header">
        <div className="uc-page-skeleton__heading-row">
          <h1 className="uc-page-skeleton__title" id="chat-page-title">对话</h1>
          <StatusPill tone="info">阶段 1 骨架</StatusPill>
        </div>
        <p className="uc-page-skeleton__description">用于问答、分析与整理项目上下文；不会直接创建图片或视频任务。</p>
      </header>
      <EmptyState title="还没有对话" description="后续将在这里呈现对话记录、附件上下文和保存到项目的明确确认流程。" icon="对" />
    </section>
  );
}
