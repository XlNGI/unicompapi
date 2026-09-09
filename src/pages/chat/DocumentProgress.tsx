import { LuCheck, LuLoaderCircle } from 'react-icons/lu';
import type { MessageDto } from '../../shared/chat-context-ipc';

export function DocumentProgress({ state = 'generating_content', detail }: {
  readonly state?: NonNullable<MessageDto['documentGenerationStatus']>['state'];
  readonly detail: string;
}) {
  const stages = ['生成内容', '检查结构', '排版与保存', '完成交付'];
  const step = ['generating_content', 'validating_outline', 'generating_file', 'completed'].indexOf(state);
  return <section className="uc-chat-document-progress" aria-label="文档制作进度">
    <p role="status" aria-live="polite">{detail}</p>
    {step >= 0 ? <ol>{stages.map((label, index) => <li key={label}
      className={index < step || state === 'completed' ? 'is-complete' : index === step ? 'is-current' : ''}
      aria-current={index === step ? 'step' : undefined}>
      {index < step || state === 'completed' ? <LuCheck aria-hidden="true" />
        : index === step ? <LuLoaderCircle aria-hidden="true" /> : <span aria-hidden="true">{index + 1}</span>}
      {label}
    </li>)}</ol> : null}
  </section>;
}
