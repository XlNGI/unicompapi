import { LuFileText } from 'react-icons/lu';
import { Button } from '../../components/Button';
import type { MessageDto } from '../../shared/chat-context-ipc';
import { retainedDocumentSummary } from '../../ui/chat-response-failure-notice';

interface RetainedDocumentCardProps {
  readonly result: NonNullable<MessageDto['retainedDocumentResult']>;
  readonly busy?: boolean;
  readonly onOpen: (workId: string) => void;
  readonly onOpenLibrary?: () => void;
}

export function RetainedDocumentCard({ result, busy, onOpen, onOpenLibrary }: RetainedDocumentCardProps) {
  return <section className="uc-chat-page__document-card" aria-label="已保留的 PPT 文件">
    <LuFileText aria-hidden="true" />
    <div className="uc-chat-page__document-card-main">
      <strong>{result.fileName}</strong>
      <small>{retainedDocumentSummary(result)}</small>
      <small>文件已校验并保存；本次任务的停止状态保留。</small>
    </div>
    <div className="uc-chat-page__document-card-actions">
      <Button disabled={busy} onClick={() => onOpen(result.workId)} title="用系统默认程序打开" variant="secondary">打开</Button>
      {onOpenLibrary ? <Button onClick={onOpenLibrary} title="在作品库中查看" variant="ghost">作品库</Button> : null}
    </div>
  </section>;
}
